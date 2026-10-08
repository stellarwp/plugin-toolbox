'use strict'

/**
 * Prepares a release branch: bumps the version, replaces the TBD placeholders, and commits and
 * pushes what the changelog step wrote alongside them.
 *
 * The action runs in two github-script steps with the changelogger action between them, so there
 * are two entry points. runPrepare validates everything and runs pup; runCommit commits and pushes.
 * The functions they are built from are pure, apart from the reads of .puprc and package.json and
 * the commands run through `exec`, so a test can pass a stand-in and assert the calls.
 */

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

/**
 * Three or four numeric parts. It is what the stellarwp changelog versioning accepts, minus its
 * blind spot: it reads an empty part as 0, so it would take 2.1..21. A version of this shape is
 * also always a valid tag name.
 */
const VERSION_PATTERN = /^\d+\.\d+\.\d+(\.\d+)?$/

/** A pup release number, which goes into the download URL. */
const PUP_VERSION_PATTERN = /^\d+\.\d+\.\d+$/

/** A calendar date as the changelog writing strategies expect it. */
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/

/** The identity of the bot GitHub shows for commits made with the default token. */
const COMMIT_AUTHOR = {
  name: 'github-actions[bot]',
  email: '41898282+github-actions[bot]@users.noreply.github.com',
}

/**
 * Checks the version to prepare.
 *
 * @param {string} version The `version` input.
 *
 * @throws {Error} When it is empty, or not three or four numeric parts.
 *
 * @returns {string} The version, without surrounding whitespace.
 */
function validateVersion(version) {
  const trimmed = String(version ?? '').trim()

  if (trimmed === '') {
    throw new Error(
      'No version was given. The run was dispatched without one, which is what a release with no ' +
        "version set sends: set the release's version and run this step again. Nothing was changed."
    )
  }

  if (!VERSION_PATTERN.test(trimmed)) {
    throw new Error(
      `'${trimmed}' is not a version this action can prepare. It takes three or four numeric ` +
        'parts, such as 4.17.0 or 4.17.0.1. A pre-release such as 4.17.0-beta.1 is not supported, ' +
        'because the stellarwp changelog versioning rejects it. Nothing was changed.'
    )
  }

  return trimmed
}

/**
 * Works out the date to write in the changelog.
 *
 * The changelogger action writes the date exactly as it is given: `today` would land in the
 * changelog as the word, and an empty value as an empty date. So both are resolved here.
 *
 * @param {string} date The `date` input: empty, `today`, or YYYY-MM-DD.
 * @param {Date}   now  The current time, for tests.
 *
 * @throws {Error} When it is anything else, or not a real calendar date.
 *
 * @returns {string} The date as YYYY-MM-DD, today's in UTC for an empty value or `today`.
 */
function resolveDate(date, now = new Date()) {
  const trimmed = String(date ?? '').trim()

  if (trimmed === '' || trimmed.toLowerCase() === 'today') {
    return now.toISOString().slice(0, 10)
  }

  // A real date round-trips through Date unchanged; 2026-02-30 comes back as March 2nd. One out of
  // range, such as 2026-13-45, is no date at all and would make toISOString throw, so Date.parse
  // rules it out first.
  const isRealDate =
    DATE_PATTERN.test(trimmed) &&
    !Number.isNaN(Date.parse(trimmed)) &&
    new Date(`${trimmed}T00:00:00Z`).toISOString().slice(0, 10) === trimmed

  if (!isRealDate) {
    throw new Error(
      `'${trimmed}' is not a date. Pass YYYY-MM-DD, or leave it empty or 'today' for today's date ` +
        'in UTC. Nothing was changed.'
    )
  }

  return trimmed
}

/**
 * Checks the shape of the branch to push to. Whether git accepts the name is checked by git, in
 * runPrepare.
 *
 * @param {string} ref The `ref` input.
 *
 * @throws {Error} When it is empty or a full ref.
 *
 * @returns {string} The branch name, without surrounding whitespace.
 */
function validateRef(ref) {
  const trimmed = String(ref ?? '').trim()

  if (trimmed === '') {
    throw new Error('No ref was given: pass the release branch to prepare, e.g. release/4.17.0.')
  }

  // The push writes refs/heads/<ref>, so a full ref would create a branch named refs/heads/….
  if (trimmed.startsWith('refs/')) {
    throw new Error(
      `Refusing to prepare '${trimmed}': pass the branch name, e.g. ` +
        `'${trimmed.replace(/^refs\/heads\//, '')}'.`
    )
  }

  return trimmed
}

/**
 * Checks the pup release to download.
 *
 * @param {string} version The `pup-version` input.
 *
 * @throws {Error} When it is not a release number.
 *
 * @returns {string} The version.
 */
function validatePupVersion(version) {
  const trimmed = String(version ?? '').trim()

  if (!PUP_VERSION_PATTERN.test(trimmed)) {
    throw new Error(`pup-version '${trimmed}' is not a pup release number, such as 2.0.0.`)
  }

  return trimmed
}

/**
 * Reads what the action needs from the repository's .puprc.
 *
 * pup itself does not fail on a missing or broken .puprc: it reads either as empty, bumps nothing
 * and exits 0. So the file is checked here, before pup runs, and a release branch is never pushed
 * with the version left as it was.
 *
 * @param {string|null} text The contents of .puprc, or null when there is none.
 *
 * @throws {Error} When there is no .puprc, it is not JSON, or it declares no version files.
 *
 * @returns {{tbdDirs: string[]|null}} The directories the TBD check declares, or null when it
 *          declares none and pup falls back to its default.
 */
function readPuprc(text) {
  if (text === null) {
    throw new Error(
      'No .puprc in the repository. The version files to bump come from its paths.versions, so ' +
        "the action needs one; see the action's README. Nothing was changed."
    )
  }

  let config
  try {
    config = JSON.parse(text)
  } catch (error) {
    throw new Error(
      `.puprc is not valid JSON (${error.message}). pup would read it as empty and bump nothing. ` +
        'Nothing was changed.'
    )
  }

  const versions = config?.paths?.versions
  if (!Array.isArray(versions) || versions.length === 0) {
    throw new Error(
      '.puprc has no paths.versions, so pup has no version to bump. List each file and the regex ' +
        "that finds its version; see the action's README. Nothing was changed."
    )
  }

  const dirs = config?.checks?.tbd?.dirs

  return { tbdDirs: Array.isArray(dirs) ? dirs : null }
}

/**
 * Whether package.json configures the changelogger. Without that section the changelogger falls
 * back to its defaults, which write a keepachangelog `changelog.md` with semver versioning.
 *
 * @param {string|null} text The contents of package.json, or null when there is none.
 *
 * @returns {boolean} True when it has a `changelogger` section.
 */
function hasChangeloggerConfig(text) {
  if (text === null) {
    return false
  }

  try {
    return Boolean(JSON.parse(text)?.changelogger)
  } catch {
    return false
  }
}

/**
 * Where a pup release's phar is published.
 *
 * @param {string} version A pup release number, already validated.
 *
 * @returns {string} The download URL.
 */
function pupDownloadUrl(version) {
  return `https://github.com/stellarwp/pup/releases/download/${version}/pup.phar`
}

/**
 * The pup commands that prepare a version, in the order they run.
 *
 * @param {string} phar    Path to the downloaded pup.phar.
 * @param {string} version The version to prepare, already validated.
 *
 * @returns {{command: string, args: string[]}[]} The version bump, then the TBD replacement.
 */
function pupCommands(phar, version) {
  return [
    { command: 'php', args: [phar, 'replace-version', version] },
    { command: 'php', args: [phar, 'replace-tbd', version] },
  ]
}

/**
 * The basic credential git sends for a token, as actions/checkout builds it.
 *
 * @param {string} token The token.
 *
 * @returns {string} base64 of `x-access-token:<token>`.
 */
function basicCredential(token) {
  return Buffer.from(`x-access-token:${token}`).toString('base64')
}

/**
 * The environment that hands git the token for one push.
 *
 * git reads GIT_CONFIG_COUNT and the numbered KEY/VALUE pairs as extra config for that one
 * process. The token therefore never sits on a command line, which the log echoes, and is never
 * written to .git/config, where a later step could read it. That is what lets a caller check out
 * with `persist-credentials: false`.
 *
 * A checkout that does persist its credentials puts its own header under the same key, and git
 * sends every value of it: two Authorization headers, which GitHub refuses with a 400. An empty
 * value resets the key's list, so the first entry clears whatever the checkout left and only this
 * token is sent.
 *
 * @param {string} token     The token, or empty to leave authentication to the checkout.
 * @param {string} serverUrl The GitHub server, e.g. https://github.com.
 *
 * @returns {object} The variables to add to git's environment; none without a token.
 */
function pushEnv(token, serverUrl) {
  if (!token) {
    return {}
  }

  const key = `http.${serverUrl.replace(/\/+$/, '')}/.extraheader`

  return {
    GIT_CONFIG_COUNT: '2',
    GIT_CONFIG_KEY_0: key,
    GIT_CONFIG_VALUE_0: '',
    GIT_CONFIG_KEY_1: key,
    GIT_CONFIG_VALUE_1: `AUTHORIZATION: basic ${basicCredential(token)}`,
  }
}

/**
 * The message of the commit the action pushes.
 *
 * @param {string} ref     The release branch.
 * @param {string} version The version prepared.
 *
 * @returns {string} The commit message.
 */
function commitMessage(ref, version) {
  return `Prepare ${ref} (${version})`
}

/**
 * Reads a file of the checkout.
 *
 * @param {string} cwd  The checkout.
 * @param {string} name The file, relative to it.
 *
 * @throws {Error} When it exists but cannot be read.
 *
 * @returns {string|null} The contents, or null when the file does not exist.
 */
function readCheckoutFile(cwd, name) {
  try {
    return fs.readFileSync(path.join(cwd, name), 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') {
      return null
    }

    throw error
  }
}

/**
 * Runs a command and fails with its output when it exits non-zero.
 *
 * @param {object}   exec    The @actions/exec toolkit.
 * @param {string}   command The program.
 * @param {string[]} args    Its arguments.
 * @param {object}   options Options for @actions/exec.
 * @param {string}   what    What the command does, to open the error message.
 *
 * @throws {Error} When the command exits non-zero, holding what it printed.
 *
 * @returns {Promise<string>} What the command printed to stdout.
 */
async function runOrFail(exec, command, args, options, what) {
  const result = await exec.getExecOutput(command, args, { ...options, ignoreReturnCode: true })

  if (result.exitCode !== 0) {
    const output = [result.stdout, result.stderr].map((text) => text.trim()).filter(Boolean)

    throw new Error(`${what} failed (exit code ${result.exitCode}):\n${output.join('\n')}`)
  }

  return result.stdout
}

/**
 * Validates the inputs, then bumps the version and replaces the TBDs with pup.
 *
 * Every check runs before anything is written, so a wrong version, date or ref, a checkout that is
 * not on the release branch, or a repository without a usable .puprc, fails with the branch
 * untouched.
 *
 * @param {object} core The @actions/core toolkit, for the log and the outputs.
 * @param {object} exec The @actions/exec toolkit.
 * @param {object} env  The environment the action manifest put its inputs in.
 * @param {string} cwd  The checkout, the working directory by default.
 *
 * @throws {Error} When an input is wrong, .puprc is unusable, or the download or pup fails.
 *
 * @returns {Promise<void>} Resolves once pup has run and the outputs are set.
 */
async function runPrepare({ core, exec, env, cwd = process.cwd() }) {
  const version = validateVersion(env.INPUT_VERSION)
  const date = resolveDate(env.INPUT_DATE)
  const ref = validateRef(env.INPUT_REF)
  const pupVersion = validatePupVersion(env.INPUT_PUP_VERSION)

  const refCheck = await exec.getExecOutput('git', ['check-ref-format', `refs/heads/${ref}`], {
    cwd,
    ignoreReturnCode: true,
    silent: true,
  })
  if (refCheck.exitCode !== 0) {
    throw new Error(`'${ref}' is not a valid branch name. Nothing was changed.`)
  }

  // The push writes HEAD to refs/heads/<ref>. From any other branch that the release branch is an
  // ancestor of, git would accept it as a fast-forward and carry that branch's commits into the
  // release, so the checkout has to be on the release branch itself.
  const head = await exec.getExecOutput('git', ['symbolic-ref', '--quiet', '--short', 'HEAD'], {
    cwd,
    ignoreReturnCode: true,
    silent: true,
  })
  const branch = head.exitCode === 0 ? head.stdout.trim() : ''
  if (branch !== ref) {
    throw new Error(
      `The checkout is on ${branch ? `'${branch}'` : 'a detached commit'}, not on '${ref}'. Check ` +
        'out the release branch before this action, e.g. actions/checkout with `ref`. Nothing was ' +
        'changed.'
    )
  }

  const { tbdDirs } = readPuprc(readCheckoutFile(cwd, '.puprc'))

  if (!tbdDirs) {
    core.warning(
      '.puprc declares no checks.tbd.dirs, so pup replaces TBDs under src/ only, its default. ' +
        'Declare the directories that hold @since TBD tags to cover the rest.'
    )
  }

  if (!hasChangeloggerConfig(readCheckoutFile(cwd, 'package.json'))) {
    core.warning(
      'package.json has no changelogger section, so the changelog step uses the changelogger ' +
        'defaults: a keepachangelog changelog.md with semver versioning.'
    )
  }

  const phar = path.join(env.RUNNER_TEMP || os.tmpdir(), `pup-${pupVersion}.phar`)

  await runOrFail(
    exec,
    'curl',
    ['-fsSL', '--retry', '3', '-o', phar, pupDownloadUrl(pupVersion)],
    {},
    `Downloading pup ${pupVersion}`
  )

  for (const { command, args } of pupCommands(phar, version)) {
    await runOrFail(exec, command, args, { cwd }, `pup ${args[1]}`)
  }

  core.setOutput('version', version)
  core.setOutput('date', date)
  core.setOutput('ref', ref)
}

/**
 * Commits whatever the preparation changed and pushes it to the release branch.
 *
 * When nothing changed, which is what re-preparing a version that is already on the branch finds,
 * it neither commits nor pushes, and succeeds.
 *
 * @param {object} core The @actions/core toolkit, for the log, the outputs and the summary.
 * @param {object} exec The @actions/exec toolkit.
 * @param {object} env  The environment the action manifest put its inputs in.
 * @param {string} cwd  The checkout, the working directory by default.
 *
 * @throws {Error} When a git command fails, the push included.
 *
 * @returns {Promise<void>} Resolves once the commit is pushed, or found unnecessary.
 */
async function runCommit({ core, exec, env, cwd = process.cwd() }) {
  const ref = validateRef(env.INPUT_REF)
  const version = validateVersion(env.INPUT_VERSION)
  const message = commitMessage(ref, version)
  const token = env.INPUT_TOKEN || ''

  if (token) {
    core.setSecret(token)
    core.setSecret(basicCredential(token))
  }

  await runOrFail(exec, 'git', ['add', '--all'], { cwd }, 'Staging the changes')

  const staged = await runOrFail(
    exec,
    'git',
    ['diff', '--cached', '--name-only'],
    { cwd, silent: true },
    'Listing the changes'
  )
  const files = staged.split('\n').filter(Boolean)

  if (files.length === 0) {
    core.info(`Nothing changed: ${ref} already holds ${version}. Nothing was committed or pushed.`)
    core.setOutput('commit', '')
    core.setOutput('files', '')
    await core.summary
      .addRaw(`Nothing to commit: \`${ref}\` already holds ${version}.`, true)
      .write()

    return
  }

  await runOrFail(
    exec,
    'git',
    [
      '-c',
      `user.name=${COMMIT_AUTHOR.name}`,
      '-c',
      `user.email=${COMMIT_AUTHOR.email}`,
      'commit',
      '--quiet',
      '-m',
      message,
    ],
    { cwd },
    'Committing the changes'
  )

  const commit = (
    await runOrFail(exec, 'git', ['rev-parse', 'HEAD'], { cwd, silent: true }, 'Reading the commit')
  ).trim()

  await runOrFail(
    exec,
    'git',
    ['push', 'origin', `HEAD:refs/heads/${ref}`],
    { cwd, env: { ...env, ...pushEnv(token, env.GITHUB_SERVER_URL || 'https://github.com') } },
    `Pushing to ${ref}`
  )

  core.info(`Pushed ${commit} to ${ref}.`)
  core.setOutput('commit', commit)
  core.setOutput('files', files.join('\n'))
  // A Markdown list rather than addList, whose HTML list would show the backticks literally.
  await core.summary
    .addRaw(`Pushed \`${commit.slice(0, 7)}\` "${message}" to \`${ref}\`:\n\n`)
    .addRaw(files.map((file) => `- \`${file}\``).join('\n'), true)
    .write()
}

module.exports = {
  runPrepare,
  runCommit,
  validateVersion,
  resolveDate,
  validateRef,
  validatePupVersion,
  readPuprc,
  hasChangeloggerConfig,
  pupDownloadUrl,
  pupCommands,
  basicCredential,
  pushEnv,
  commitMessage,
  VERSION_PATTERN,
}
