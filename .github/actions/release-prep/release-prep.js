'use strict'

/**
 * Prepares a release branch: bumps the version, replaces the TBD placeholders, and commits what the
 * changelog step wrote alongside them to the branch, through the GitHub API.
 *
 * The action runs in two github-script steps with the changelogger action between them, so there
 * are two entry points. runPrepare validates everything and runs pup; runCommit lists the changes
 * with git and creates the commit with the Octokit github-script supplies. The functions they are
 * built from are pure, apart from the reads of the checkout, the commands run through `exec` and
 * the API calls, so a test can pass stand-ins and assert the calls and the requests.
 */

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync } = require('node:child_process')

const { compareVersions } = require('../../lib/versions.js')

/**
 * Three or four numeric parts, the shape the stellarwp changelog versioning accepts. That strategy
 * also accepts an empty part (it reads it as 0, so it would take 2.1..21); this pattern rejects
 * that. A version of this shape is also always a valid tag name.
 */
const STELLARWP_VERSION_PATTERN = /^\d+\.\d+\.\d+(\.\d+)?$/

/**
 * A semver version as semver.org defines it: MAJOR.MINOR.PATCH, an optional pre-release and
 * optional build metadata. The changelogger's semver strategy validates with the semver package,
 * which also takes a leading `v`; this pattern does not, because the version goes into the version
 * files and the tag as it is given.
 */
const SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+(?:[0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/

/** The numeric start of a version, which is what the branch-version comparison reads. */
const NUMERIC_PREFIX = /^\d+(\.\d+)*/

/** A pup release number, which goes into the download URL. */
const PUP_VERSION_PATTERN = /^\d+\.\d+\.\d+$/

/** A calendar date as the changelog writing strategies expect it. */
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/

/** The git modes of a regular file, the only kind of change the action uploads. */
const BLOB_MODES = new Set(['100644', '100755'])

/**
 * Reads the version input, refusing an empty one.
 *
 * @param {string} version The `version` input.
 *
 * @throws {Error} When it is empty.
 *
 * @returns {string} The version, without surrounding whitespace.
 */
function readVersion(version) {
  const trimmed = String(version ?? '').trim()

  if (trimmed === '') {
    throw new Error(
      'No version was given. The run was dispatched without one, which is what a release with no ' +
        "version set sends: set the release's version and run this step again. Nothing was changed."
    )
  }

  return trimmed
}

/**
 * Checks the version to prepare against the versioning strategy the repository's changelogger
 * configures, so the action refuses what the changelog step would refuse, before pup has run.
 *
 * @param {string}                           version  The `version` input.
 * @param {'stellarwp'|'semver'|'custom'}    strategy The strategy readChangeloggerStrategy read.
 *
 * @throws {Error} When it is empty, or not a version the strategy accepts. A custom strategy
 *                 validates on its own, in the changelog step.
 *
 * @returns {string} The version, without surrounding whitespace.
 */
function validateVersion(version, strategy) {
  const trimmed = readVersion(version)

  if (strategy === 'stellarwp' && !STELLARWP_VERSION_PATTERN.test(trimmed)) {
    throw new Error(
      `'${trimmed}' is not a version this action can prepare. It takes three or four numeric ` +
        'parts, such as 4.17.0 or 4.17.0.1. A pre-release such as 4.17.0-beta.1 is not supported, ' +
        'because the stellarwp changelog versioning rejects it. Nothing was changed.'
    )
  }

  if (strategy === 'semver' && !SEMVER_PATTERN.test(trimmed)) {
    throw new Error(
      `'${trimmed}' is not a version this action can prepare. The changelogger validates it as ` +
        'semver: MAJOR.MINOR.PATCH with an optional pre-release, such as 4.17.0 or 4.17.0-beta.1, ' +
        'and no leading v. Nothing was changed.'
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
 * The prefixes a branch has to start with when `branch-prefixes` is not set: the names the
 * consumers give their release branches (`bucket/` is LearnDash's).
 */
const DEFAULT_BRANCH_PREFIXES = ['release/', 'hotfix/', 'bucket/']

/**
 * Reads the `branch-prefixes` input: the branch names the action agrees to commit to.
 *
 * The input is a JSON array in a string, `'["release/", "hotfix/"]'`, because an action input is
 * always a string. An empty input keeps the default list, so a dispatch input left blank and
 * passed through keeps the check on. An empty array turns the check off.
 *
 * @param {string} input The input: a JSON array of prefixes, or empty.
 *
 * @throws {Error} When it is anything but a JSON array of non-empty strings.
 *
 * @returns {string[]} The prefixes, without surrounding whitespace; the default list for an empty
 *                     input. Empty for `[]`, which turns the check off.
 */
function readBranchPrefixes(input) {
  const trimmed = String(input ?? '').trim()

  if (trimmed === '') {
    return DEFAULT_BRANCH_PREFIXES
  }

  let parsed
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    parsed = undefined
  }

  const prefixes = Array.isArray(parsed)
    ? parsed.map((prefix) => (typeof prefix === 'string' ? prefix.trim() : ''))
    : null

  if (prefixes === null || prefixes.includes('')) {
    throw new Error(
      `branch-prefixes '${trimmed}' is not a JSON array of prefixes, such as '["release/", "hotfix/"]'. ` +
        'Pass [] to turn the check off. Nothing was changed.'
    )
  }

  return prefixes
}

/**
 * Checks the branch to commit to: its shape, and that it is one of the branches the action agrees
 * to commit to. Whether git accepts the name is checked by git, in runPrepare.
 *
 * The action commits to the branch it is given, with write access, so a dispatch by hand with the
 * wrong name would put a version bump on develop. A prefix is matched literally: `release/` takes
 * `release/4.20.0`, and `release` takes `release-4.x` and `releases/x` as well.
 *
 * @param {string}   branch   The `branch` input.
 * @param {string[]} prefixes The prefixes `branch` may start with. An empty list checks nothing.
 *
 * @throws {Error} When it is empty, a full ref, or outside the prefixes.
 *
 * @returns {string} The branch name, without surrounding whitespace.
 */
function validateBranch(branch, prefixes = []) {
  const trimmed = String(branch ?? '').trim()

  if (trimmed === '') {
    throw new Error('No branch was given: pass the release branch to prepare, e.g. release/M26.jigglypuff.')
  }

  // The commit updates refs/heads/<branch>, so a full ref would name a branch refs/heads/….
  if (trimmed.startsWith('refs/')) {
    throw new Error(
      `Refusing to prepare '${trimmed}': pass the branch name, e.g. ` +
        `'${trimmed.replace(/^refs\/heads\//, '')}'.`
    )
  }

  if (prefixes.length > 0 && !prefixes.some((prefix) => trimmed.startsWith(prefix))) {
    const accepted = new Intl.ListFormat('en', { type: 'disjunction' }).format(prefixes)

    throw new Error(
      `Refusing to prepare '${trimmed}': it does not start with ${accepted}. The action only ` +
        'commits to a release branch; pass the branch to prepare, or set branch-prefixes to a JSON ' +
        'array of the prefixes the repository uses. Nothing was changed.'
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

  if (trimmed.toLowerCase() !== 'latest' && !PUP_VERSION_PATTERN.test(trimmed)) {
    throw new Error(`pup-version '${trimmed}' is not a pup release number, such as 2.0.0, or 'latest'.`)
  }

  return trimmed
}

/**
 * Resolves the `pup-version` input to a concrete pup release.
 *
 * A pinned release number is used as it is: resolvePupDistribution checks it against the
 * release page, so there is no API call for the common case. `latest` asks the GitHub API for
 * the newest release, authenticated with the action token when the caller passes one, so the
 * runner's shared unauthenticated quota is not spent.
 *
 * @param {object}          options
 * @param {string}          options.version   The validated `pup-version` input.
 * @param {string}          options.token     The action token, possibly empty.
 * @param {Function}        options.fetchImpl What `fetch` to use; a test passes a stand-in.
 *
 * @throws {Error} When the latest release cannot be read.
 *
 * @returns {Promise<string>} The release tag to download from.
 */
async function resolvePupRelease({ version, token, fetchImpl }) {
  if (version.toLowerCase() !== 'latest') {
    return version
  }

  const headers = {}
  if (token) {
    headers.authorization = `Bearer ${token}`
  }

  const response = await fetchImpl('https://api.github.com/repos/stellarwp/pup/releases/latest', {
    headers,
  })

  if (!response.ok) {
    throw new Error(
      `Reading the latest pup release failed (HTTP ${response.status}). Pass a pinned pup-version and run this step again. Nothing was changed.`
    )
  }

  // The tag goes into a download URL and a temp file path, and a missing one would surface
  // as a 404 on …/download/undefined/pup.phar, which the distribution check would report as
  // a release that does not exist. A broken API response must fail here, naming the API, so
  // the tag is validated before it is used.
  const tag = (await response.json()).tag_name
  if (typeof tag !== 'string' || !PUP_VERSION_PATTERN.test(tag)) {
    throw new Error(
      'The latest pup release has no usable tag. Pass a pinned pup-version and run this step ' +
        'again. Nothing was changed.'
    )
  }

  return tag
}

/**
 * Reads what the action needs from the repository's .puprc.
 *
 * pup itself does not fail on a missing or broken .puprc: it reads either as empty, bumps nothing
 * and exits 0. So the file is checked here, before pup runs, and a release branch never gets a commit
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
 * Reads which versioning strategy the changelogger will validate the version with.
 *
 * The changelogger reads `changelogger.versioning` from package.json and falls back to `semver`
 * without the section, without the file, or when the file is not JSON; it loads a `.js` or `.ts`
 * value as a custom strategy with its own validation, and fails on any other value before it looks
 * at the changes, so that case fails here, before pup has run.
 *
 * @param {string|null} text The contents of package.json, or null when there is none.
 *
 * @throws {Error} When `versioning` is a value the changelogger does not know.
 *
 * @returns {{strategy: 'stellarwp'|'semver'|'custom', versioning: string, configured: boolean}}
 *          The strategy, the `versioning` value it came from, and whether package.json has a
 *          `changelogger` section at all.
 */
function readChangeloggerStrategy(text) {
  let section = null

  if (text !== null) {
    try {
      section = JSON.parse(text)?.changelogger ?? null
    } catch {
      section = null
    }
  }

  if (!section) {
    return { strategy: 'semver', versioning: 'semver', configured: false }
  }

  const versioning = (typeof section === 'object' ? section.versioning : undefined) ?? 'semver'

  if (versioning === 'stellarwp' || versioning === 'semver') {
    return { strategy: versioning, versioning, configured: true }
  }

  if (typeof versioning === 'string' && /\.(js|ts)$/.test(versioning)) {
    return { strategy: 'custom', versioning, configured: true }
  }

  throw new Error(
    `package.json sets changelogger.versioning to '${versioning}', which is not a versioning ` +
      'strategy the changelogger knows: use stellarwp, semver, or a .js or .ts file. The changelog ' +
      'step would fail on it. Nothing was changed.'
  )
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
 * The page of a pup release, which answers 404 when the release does not exist.
 *
 * @param {string} version A pup release number, already validated.
 *
 * @returns {string} The release page URL.
 */
function pupReleaseUrl(version) {
  return `https://github.com/stellarwp/pup/releases/tag/${version}`
}

/**
 * Sends a HEAD request and reports whether the URL exists.
 *
 * @param {object} exec The @actions/exec toolkit.
 * @param {string} url  The URL to check.
 *
 * @returns {Promise<{exists: boolean, missing: boolean, result: object}>} Whether it answered
 *          200, whether it answered 404, and curl's result for anything else.
 */
async function headExists(exec, url) {
  const result = await exec.getExecOutput('curl', ['-fsSI', url], {
    ignoreReturnCode: true,
    silent: true,
  })

  // curl -f answers a 404 with exit code 22 and the status in stderr.
  return {
    exists: result.exitCode === 0,
    missing: result.exitCode === 22 && /404/.test(result.stderr),
    result,
  }
}

/**
 * Which distribution a pup release carries, decided by looking at the release itself: a `pup.phar`
 * asset means the PHP build the action runs. A release without one (1.2.3 and 0.0.1 among the
 * published ones, and the TypeScript line once it ships) cannot be run from here yet.
 *
 * The checks are HEAD requests against the asset URL and, when that is missing, the release page,
 * not the releases API, so a pinned `pup-version` stays free of API calls and rate limits. The
 * second request tells a release without a phar from a release that does not exist, which a
 * mistyped pin produces.
 *
 * @param {object}   exec    The @actions/exec toolkit.
 * @param {string}   release The resolved pup release tag.
 *
 * @throws {Error} When the release does not exist, or a check itself fails and the run cannot
 *                 tell which path to take.
 *
 * @returns {Promise<'phar'|'ts'>} The distribution the release carries: `ts` for any release
 *          without a phar, the old ones included, since that is the path they take.
 */
async function resolvePupDistribution({ exec, release }) {
  const asset = await headExists(exec, pupDownloadUrl(release))

  if (asset.exists) {
    return 'phar'
  }

  if (asset.missing) {
    const page = await headExists(exec, pupReleaseUrl(release))

    if (page.exists) {
      return 'ts'
    }

    if (page.missing) {
      throw new Error(`pup ${release} is not a release: check pup-version for a typo. Nothing was changed.`)
    }

    throw checkFailed(release, page.result)
  }

  throw checkFailed(release, asset.result)
}

/**
 * The error for a release check that neither succeeded nor answered 404.
 *
 * @param {string} release The pup release tag.
 * @param {object} result  What curl returned.
 *
 * @returns {Error} The error, holding what curl printed.
 */
function checkFailed(release, result) {
  const output = [result.stdout, result.stderr].map((text) => text.trim()).filter(Boolean)

  return new Error(
    `Checking the pup ${release} release failed (exit code ${result.exitCode}):\n` + output.join('\n')
  )
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
 * Reads the changes `git diff --cached --raw --no-renames -z` lists.
 *
 * Each entry is `:<previous mode> <mode> <previous sha> <sha> <status>`, NUL, the path, NUL. The
 * raw format carries the modes, which the tree entries need and `--name-status` drops, and the
 * staged blob's sha, which the upload reads the content from; `--no-abbrev` keeps that sha full.
 * `--no-renames` keeps a rename as its deletion and addition, since the tree takes one entry per
 * path; `-z` keeps a path with a space or a quote intact.
 *
 * @param {string} output What git printed.
 *
 * @returns {{path: string, status: string, mode: string, previousMode: string, blob: string}[]}
 *          The changes, in the order git lists them.
 */
function parseRawDiff(output) {
  const fields = String(output ?? '').split('\0')
  const changes = []

  for (let i = 0; i + 1 < fields.length; i += 2) {
    const header = fields[i]
    if (!header.startsWith(':')) {
      continue
    }

    const [previousMode, mode, , blob, status] = header.slice(1).split(' ')
    changes.push({ path: fields[i + 1], status, mode, previousMode, blob })
  }

  return changes
}

/**
 * The message of the commit the action creates.
 *
 * @param {string} branch  The release branch.
 * @param {string} version The version prepared.
 *
 * @returns {string} The commit message.
 */
function commitMessage(branch, version) {
  return `Prepare ${branch} (${version})`
}

/**
 * The last non-empty line of a command's output, where `pup get-version` prints the version after any
 * PHP notice.
 *
 * @param {string} output What the command printed.
 *
 * @returns {string} The line, trimmed, or an empty string.
 */
function lastLine(output) {
  return (
    String(output ?? '')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .at(-1) ?? ''
  )
}

/**
 * Reads the version `pup get-version` printed: the numeric part of its last line, so a suffix such as
 * -beta.1 is ignored and a PHP notice printed before it is skipped.
 *
 * @param {string} output What pup printed.
 *
 * @returns {string|null} The version, or null when the line holds no numeric version, such as `dev`.
 */
function readCurrentVersion(output) {
  return numericPrefix(lastLine(output))
}

/**
 * The numeric start of a version: 4.17.0 for 4.17.0-beta.1, the whole of 4.17.0.1.
 *
 * @param {string} version A version.
 *
 * @returns {string|null} The numeric start, or null when the version does not start with a number.
 */
function numericPrefix(version) {
  const match = NUMERIC_PREFIX.exec(version)

  return match ? match[0] : null
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
 * not on the release branch, a repository without a usable .puprc or with a changelogger versioning
 * the changelogger does not know, or a version lower than the one the branch already has, fails
 * with the branch untouched. The version is checked the way the changelog step will check it: by
 * the versioning strategy package.json configures.
 *
 * @param {object}   core      The @actions/core toolkit, for the log and the outputs.
 * @param {object}   exec      The @actions/exec toolkit.
 * @param {object}   env       The environment the action manifest put its inputs in.
 * @param {string}   cwd       The checkout, the working directory by default.
 * @param {Function} fetchImpl What `fetch` to use; a test passes a stand-in.
 *
 * @throws {Error} When an input is wrong, .puprc or the changelogger versioning is unusable, the
 *                 pup release does not exist, or the download or pup fails.
 *
 * @returns {Promise<void>} Resolves once pup has run and the outputs are set.
 */
async function runPrepare({ core, exec, env, cwd = process.cwd(), fetchImpl = globalThis.fetch }) {
  const changelogger = readChangeloggerStrategy(readCheckoutFile(cwd, 'package.json'))
  const version = validateVersion(env.INPUT_VERSION, changelogger.strategy)
  const date = resolveDate(env.INPUT_DATE)
  const branch = validateBranch(env.INPUT_BRANCH, readBranchPrefixes(env.INPUT_BRANCH_PREFIXES))
  const pupVersion = validatePupVersion(env.INPUT_PUP_VERSION)

  const refCheck = await exec.getExecOutput('git', ['check-ref-format', `refs/heads/${branch}`], {
    cwd,
    ignoreReturnCode: true,
    silent: true,
  })
  if (refCheck.exitCode !== 0) {
    throw new Error(`'${branch}' is not a valid branch name. Nothing was changed.`)
  }

  // The commit's parent is the checkout's HEAD and it lands on refs/heads/<branch>. From any other
  // branch that the release branch is an ancestor of, GitHub would accept it as a fast-forward and
  // carry that branch's commits into the release, so the checkout has to be on the release branch.
  const head = await exec.getExecOutput('git', ['symbolic-ref', '--quiet', '--short', 'HEAD'], {
    cwd,
    ignoreReturnCode: true,
    silent: true,
  })
  const headBranch = head.exitCode === 0 ? head.stdout.trim() : ''
  if (headBranch !== branch) {
    throw new Error(
      `The checkout is on ${headBranch ? `'${headBranch}'` : 'a detached commit'}, not on '${branch}'. ` +
        'Check out the release branch before this action, e.g. actions/checkout with `ref`. Nothing ' +
        'was changed.'
    )
  }

  const { tbdDirs } = readPuprc(readCheckoutFile(cwd, '.puprc'))

  if (!tbdDirs) {
    core.warning(
      '.puprc declares no checks.tbd.dirs, so pup replaces TBDs under src/ only, its default. ' +
        'Declare the directories that hold @since TBD tags to cover the rest.'
    )
  }

  if (!changelogger.configured) {
    core.warning(
      'package.json has no changelogger section, so the changelog step uses the changelogger ' +
        'defaults: a keepachangelog changelog.md with semver versioning.'
    )
  } else if (changelogger.strategy === 'custom') {
    core.warning(
      `package.json names a custom versioning strategy (${changelogger.versioning}), so the ` +
        "action did not check the version's shape. The changelog step validates it with that strategy."
    )
  }

  const pupRelease = await resolvePupRelease({
    version: pupVersion,
    token: env.INPUT_TOKEN || '',
    fetchImpl,
  })
  const distribution = await resolvePupDistribution({ exec, release: pupRelease })
  core.setOutput('distribution', distribution)

  if (distribution === 'phar') {
    await runPrepareWithPhar({ core, exec, cwd, env, pharRelease: pupRelease, version, branch })
  } else {
    // The TypeScript line publishes no phar, and nothing can call it yet: a composite action's
    // `uses:` references resolve when the JOB is set up, not when the step runs, so the manifest
    // cannot carry its action behind a condition, and calling it straight from the script needs
    // a published distribution first. Until one exists, a phar-less release fails here with an
    // error naming the pin to use instead. The branch-version check in runPrepareWithPhar is
    // part of the phar path — the TS contract does not define it yet.
    throw new Error(
      `pup ${pupRelease} publishes no pup.phar asset, so this action cannot run it. Pin ` +
        'pup-version to a release that ships one, such as 2.0.0. Nothing was changed.'
    )
  }

  core.setOutput('version', version)
  core.setOutput('date', date)
  core.setOutput('branch', branch)
}

/**
 * Runs the preparation with the phar a pup release publishes: downloads it, checks the version
 * the branch already has, then bumps the version and replaces the TBDs.
 *
 * @param {object}   options
 * @param {object}   options.core        The @actions/core toolkit.
 * @param {object}   options.exec        The @actions/exec toolkit.
 * @param {string}   options.cwd         The checkout.
 * @param {object}   options.env         The step environment, for RUNNER_TEMP.
 * @param {string}   options.pharRelease The resolved pup release tag.
 * @param {string}   options.version     The version to prepare, validated.
 * @param {string}   options.branch      The release branch, validated.
 *
 * @returns {Promise<void>} Resolves once pup has run.
 */
async function runPrepareWithPhar({ core, exec, cwd, env, pharRelease, version, branch }) {
  const phar = path.join(env.RUNNER_TEMP || os.tmpdir(), `pup-${pharRelease}.phar`)

  await runOrFail(
    exec,
    'curl',
    ['-fsSL', '--retry', '3', '-o', phar, pupDownloadUrl(pharRelease)],
    {},
    `Downloading pup ${pharRelease}`
  )

  // A version lower than the one the branch already has would bump it backwards: a wrong version, or
  // the wrong branch. The same version is fine, it is what re-running a preparation finds. When pup
  // finds no version at all it exits non-zero, which fails here as replace-version would.
  const printed = await runOrFail(
    exec,
    'php',
    ['-d', 'display_errors=stderr', phar, 'get-version'],
    { cwd, silent: true },
    'pup get-version'
  )
  const current = readCurrentVersion(printed)
  // Only the numeric start is compared: 4.17.0-beta.1 counts as 4.17.0, which compareVersions
  // reads; a pre-release of the version the branch holds is still that version.
  const numeric = numericPrefix(version)

  if (current === null) {
    core.warning(
      `The version files hold \`${lastLine(printed)}\`, which is not a numeric version, so ` +
        `${version} was not checked against it.`
    )
  } else if (numeric === null) {
    core.warning(
      `${version} holds no numeric version, so it was not checked against the ${current} the ` +
        'branch has.'
    )
  } else if (compareVersions(numeric, current) < 0) {
    throw new Error(
      `Refusing to prepare ${version}: ${branch} already has ${current}, a later version. Check the ` +
        'version and the release branch. Nothing was changed.'
    )
  }

  for (const { command, args } of pupCommands(phar, version)) {
    await runOrFail(exec, command, args, { cwd }, `pup ${args[1]}`)
  }
}

/**
 * Commits whatever the preparation changed to the release branch, through the GitHub API.
 *
 * The changes are listed with git, then sent as blobs and a tree built on the checkout's own tree,
 * a commit whose parent is the checkout's own head, and a ref update that is not forced: when the
 * branch moved after the checkout, GitHub refuses the update as it would refuse a push, and the
 * checkout's files are never written over newer ones. The checkout itself is left as it was: its
 * HEAD stays on the commit it had, with the changes in the working tree.
 *
 * When nothing changed, which is what re-preparing a version that is already on the branch finds,
 * it calls nothing and succeeds.
 *
 * @param {object} github An Octokit, as actions/github-script supplies it, authenticated with the
 *                        action's token.
 * @param {object} core   The @actions/core toolkit, for the log, the outputs and the summary.
 * @param {object} exec   The @actions/exec toolkit.
 * @param {object} env    The environment the action manifest put its inputs in.
 * @param {string} cwd    The checkout, the working directory by default.
 *
 * @throws {Error} When a git command or an API call fails, a change is not a regular file, or
 *                 GitHub refuses the ref update.
 *
 * @returns {Promise<void>} Resolves once the commit is on the branch, or found unnecessary.
 */
async function runCommit({ github, core, exec, env, cwd = process.cwd() }) {
  // The prepare step validated the branch against branch-prefixes and the version against the
  // changelogger strategy; its outputs are what the manifest hands this step, so only the shape
  // of the branch and an empty version are checked here.
  const branch = validateBranch(env.INPUT_BRANCH)
  const version = readVersion(env.INPUT_VERSION)
  const message = commitMessage(branch, version)
  const [owner, repo] = String(env.GITHUB_REPOSITORY || '').split('/')

  if (!owner || !repo) {
    throw new Error(
      'GITHUB_REPOSITORY is not set, so the action does not know which repository to commit to. ' +
        'Nothing was committed.'
    )
  }

  await runOrFail(exec, 'git', ['add', '--all'], { cwd }, 'Staging the changes')

  const raw = await runOrFail(
    exec,
    'git',
    ['diff', '--cached', '--raw', '--no-renames', '--no-abbrev', '-z'],
    { cwd, silent: true },
    'Listing the changes'
  )
  const changes = parseRawDiff(raw)
  const files = changes.map((change) => change.path)

  if (changes.length === 0) {
    core.info(`Nothing changed: ${branch} already holds ${version}. Nothing was committed.`)
    core.setOutput('commit', '')
    core.setOutput('files', '')
    await core.summary
      .addRaw(`Nothing to commit: \`${branch}\` already holds ${version}.`, true)
      .write()

    return
  }

  for (const change of changes) {
    if (change.status !== 'D' && !BLOB_MODES.has(change.mode)) {
      throw new Error(
        `${change.path} has mode ${change.mode}, which this action does not commit: only regular ` +
          'files are uploaded. Nothing was committed.'
      )
    }
  }

  const [head, baseTree] = (
    await runOrFail(
      exec,
      'git',
      ['rev-parse', 'HEAD', 'HEAD^{tree}'],
      { cwd, silent: true },
      'Reading the checkout head'
    )
  )
    .trim()
    .split('\n')

  const tree = []
  for (const change of changes) {
    if (change.status === 'D') {
      tree.push({ path: change.path, mode: change.previousMode, type: 'blob', sha: null })
      continue
    }

    // The content comes from the staged blob, not the file on disk: what git staged is what a
    // local commit would carry, and filters (.gitattributes normalization, an LFS pointer) can
    // make the two differ. cat-file reads the blob as bytes, so a binary arrives byte for byte.
    const { data: blob } = await github.rest.git.createBlob({
      owner,
      repo,
      content: execFileSync('git', ['cat-file', 'blob', change.blob], { cwd, maxBuffer: Infinity }).toString('base64'),
      encoding: 'base64',
    })
    tree.push({ path: change.path, mode: change.mode, type: 'blob', sha: blob.sha })
  }

  const { data: newTree } = await github.rest.git.createTree({ owner, repo, base_tree: baseTree, tree })
  // No author or committer: the commit belongs to the token's identity, github-actions[bot] for the
  // default token, and GitHub signs it.
  const { data: commit } = await github.rest.git.createCommit({
    owner,
    repo,
    message,
    tree: newTree.sha,
    parents: [head],
  })

  try {
    await github.rest.git.updateRef({ owner, repo, ref: `heads/${branch}`, sha: commit.sha })
  } catch (error) {
    if (error.status === 422) {
      throw new Error(
        `GitHub refused to update ${branch} (${error.message}): the branch moved after the ` +
          'checkout, or no longer exists. Run the step again on a fresh checkout. Nothing was ' +
          'committed to the branch.'
      )
    }

    throw error
  }

  core.info(`Committed ${commit.sha} to ${branch}.`)
  core.setOutput('commit', commit.sha)
  core.setOutput('files', files.join('\n'))
  // A Markdown list rather than addList, whose HTML list would show the backticks literally.
  await core.summary
    .addRaw(`Committed \`${commit.sha.slice(0, 7)}\` "${message}" to \`${branch}\`:\n\n`)
    .addRaw(files.map((file) => `- \`${file}\``).join('\n'), true)
    .write()
}

module.exports = {
  runPrepare,
  runCommit,
  readVersion,
  validateVersion,
  resolveDate,
  readBranchPrefixes,
  validateBranch,
  validatePupVersion,
  resolvePupRelease,
  resolvePupDistribution,
  readPuprc,
  readChangeloggerStrategy,
  pupDownloadUrl,
  pupReleaseUrl,
  pupCommands,
  parseRawDiff,
  commitMessage,
  compareVersions,
  readCurrentVersion,
  STELLARWP_VERSION_PATTERN,
  SEMVER_PATTERN,
}
