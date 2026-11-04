'use strict'

/**
 * Installs pup and runs it, for every action that needs it.
 *
 * pup is a PHP archive published with each of its GitHub releases. This file resolves a release,
 * checks that it ships a phar, downloads the phar into the runner's temp directory and runs it
 * through `php`, so an action never depends on a copy of pup in the repository it runs on. The
 * answers it reads back, the version and the zip name, come from the last line pup printed, so a
 * PHP notice printed before it never ends up in the value.
 *
 * The action manifest runs `run` through actions/github-script. Another action's script calls the
 * functions it needs: see this action's README. They take the `exec` toolkit as an argument, so a
 * test passes a stand-in and asserts the commands.
 */

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { lastLine, runOrFail } = require('../../lib/commands.js')

/** The pup release used when none is asked for. */
const DEFAULT_PUP_VERSION = '2.0.0'

/** The values `read` can ask for after pup is installed. */
const READ_VALUES = ['', 'version', 'zip-name']

/** A pup release number, which goes into the download URL. */
const PUP_VERSION_PATTERN = /^\d+\.\d+\.\d+$/


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
 * Where the phar of a pup release is kept for the rest of the job.
 *
 * @param {object} env     The environment, for RUNNER_TEMP.
 * @param {string} release The resolved pup release tag.
 *
 * @returns {string} The path.
 */
function pharPath(env, release) {
  return path.join(env.RUNNER_TEMP || os.tmpdir(), `pup-${release}.phar`)
}

/**
 * Whether a usable phar is already in place, from an earlier step of the same job.
 *
 * @param {string} phar The path of the phar.
 *
 * @returns {boolean} True when the file exists and is not empty.
 */
function pharExists(phar) {
  try {
    return fs.statSync(phar).size > 0
  } catch {
    return false
  }
}

/**
 * Downloads the phar of a pup release, unless it is already in place.
 *
 * A download that fails leaves nothing behind, so a later step never takes half a file for a phar.
 *
 * @param {object} options
 * @param {object} options.exec    The @actions/exec toolkit.
 * @param {string} options.release The resolved pup release tag.
 * @param {string} options.phar    Where to put it.
 *
 * @throws {Error} When the download fails, holding what curl printed.
 *
 * @returns {Promise<boolean>} True when it downloaded, false when the phar was already there.
 */
async function downloadPhar({ exec, release, phar }) {
  if (pharExists(phar)) {
    return false
  }

  try {
    await runOrFail(
      exec,
      'curl',
      ['-fsSL', '--retry', '3', '-o', phar, pupDownloadUrl(release)],
      {},
      `Downloading pup ${release}`
    )
  } catch (error) {
    fs.rmSync(phar, { force: true })

    throw error
  }

  return true
}

/**
 * Runs a pup command with PHP and returns what it printed.
 *
 * PHP notices go to stderr (`display_errors=stderr`), so stdout holds the answer.
 *
 * @param {object}   options
 * @param {object}   options.exec   The @actions/exec toolkit.
 * @param {string}   options.phar   Path to pup.phar.
 * @param {string[]} options.args   The pup command and its arguments, e.g. `['get-version', '--dev']`.
 * @param {string}   options.cwd    The checkout pup runs in, the working directory by default.
 *
 * @throws {Error} When pup exits non-zero, holding what it printed.
 *
 * @returns {Promise<string>} What pup printed to stdout.
 */
async function runPup({ exec, phar, args, cwd = process.cwd() }) {
  return runOrFail(
    exec,
    'php',
    ['-d', 'display_errors=stderr', phar, ...args],
    { cwd, silent: true },
    `pup ${args[0]}`
  )
}

/**
 * Asks pup for the version the repository is at: `pup get-version`, or `pup get-version --dev` for
 * the development build version, which has the commit in it.
 *
 * @param {object}  options
 * @param {object}  options.exec The @actions/exec toolkit.
 * @param {string}  options.phar Path to pup.phar.
 * @param {string}  options.cwd  The checkout.
 * @param {boolean} options.dev  Ask for the development build version.
 *
 * @throws {Error} When pup fails or prints no version.
 *
 * @returns {Promise<string>} The version, the last line pup printed.
 */
async function getVersion({ exec, phar, cwd, dev = false }) {
  const printed = await runPup({ exec, phar, cwd, args: dev ? ['get-version', '--dev'] : ['get-version'] })
  const version = lastLine(printed)

  if (version === '') {
    throw new Error('pup get-version printed no version.')
  }

  return version
}

/**
 * Asks pup for the name of the zip it makes for a version, without `.zip`.
 *
 * @param {object} options
 * @param {object} options.exec    The @actions/exec toolkit.
 * @param {string} options.phar    Path to pup.phar.
 * @param {string} options.cwd     The checkout.
 * @param {string} options.version The version, as getVersion returns it.
 *
 * @throws {Error} When the version is empty, or pup fails or prints no name.
 *
 * @returns {Promise<string>} The zip's name, the last line pup printed.
 */
async function zipName({ exec, phar, cwd, version }) {
  if (String(version ?? '').trim() === '') {
    throw new Error('pup zip-name needs a version.')
  }

  const name = lastLine(await runPup({ exec, phar, cwd, args: ['zip-name', String(version)] }))

  if (name === '') {
    throw new Error('pup zip-name printed no name.')
  }

  return name
}

/**
 * Installs pup: resolves the release, checks that it ships a phar and puts the phar in place.
 *
 * A phar that an earlier step of the job downloaded is reused, and a pinned release then needs no
 * network call at all.
 *
 * @param {object}   options
 * @param {object}   options.core      The @actions/core toolkit, for the log.
 * @param {object}   options.exec      The @actions/exec toolkit.
 * @param {string}   options.version   The `pup-version` input: a release number or `latest`. Empty
 *                                     uses DEFAULT_PUP_VERSION.
 * @param {string}   options.token     The token for the `latest` lookup, possibly empty.
 * @param {object}   options.env       The environment, for RUNNER_TEMP.
 * @param {Function} options.fetchImpl What `fetch` to use; a test passes a stand-in.
 *
 * @throws {Error} When the version is not a release number, the release does not exist or ships no
 *                 phar, or the download fails.
 *
 * @returns {Promise<{release: string, phar: string}>} The release tag, and the path of its phar.
 */
async function installPup({ core, exec, version, token, env, fetchImpl = globalThis.fetch }) {
  const pupVersion = validatePupVersion(String(version ?? '').trim() === '' ? DEFAULT_PUP_VERSION : version)
  const release = await resolvePupRelease({ version: pupVersion, token: token || '', fetchImpl })
  const phar = pharPath(env, release)

  if (pharExists(phar)) {
    core.info(`Reusing pup ${release} at ${phar}.`)

    return { release, phar }
  }

  const distribution = await resolvePupDistribution({ exec, release })
  if (distribution !== 'phar') {
    throw new Error(
      `pup ${release} publishes no pup.phar asset, so this action cannot run it. Pin pup-version to ` +
        `a release that ships one, such as ${DEFAULT_PUP_VERSION}.`
    )
  }

  await downloadPhar({ exec, release, phar })
  core.info(`Downloaded pup ${release} to ${phar}.`)

  return { release, phar }
}

/**
 * The entry point of the action manifest: installs pup, then reads the version and the zip name
 * when it is asked to.
 *
 * Inputs come from INPUT_PUP_VERSION, INPUT_TOKEN, INPUT_READ (empty, `version` or `zip-name`) and
 * INPUT_DEV (`true` or `false`, for the development build version). Outputs: `phar`, `release`,
 * and `version` and `zip-name` when asked for.
 *
 * @param {object}   options
 * @param {object}   options.core      The @actions/core toolkit.
 * @param {object}   options.exec      The @actions/exec toolkit.
 * @param {object}   options.env       The environment the action manifest put its inputs in.
 * @param {string}   options.cwd       The checkout pup reads the version from, the working directory
 *                                     by default.
 * @param {Function} options.fetchImpl What `fetch` to use; a test passes a stand-in.
 *
 * @throws {Error} When an input is wrong, pup cannot be installed, or pup fails.
 *
 * @returns {Promise<void>} Resolves once the outputs are set.
 */
async function run({ core, exec, env, cwd = process.cwd(), fetchImpl = globalThis.fetch }) {
  const read = String(env.INPUT_READ ?? '').trim()
  if (!READ_VALUES.includes(read)) {
    throw new Error(`read '${read}' is not one of: version, zip-name, or empty.`)
  }

  const devInput = String(env.INPUT_DEV ?? '').trim().toLowerCase()
  if (!['', 'true', 'false'].includes(devInput)) {
    throw new Error(`dev '${env.INPUT_DEV}' is not true or false.`)
  }
  const dev = devInput === 'true'

  const { release, phar } = await installPup({
    core,
    exec,
    version: env.INPUT_PUP_VERSION,
    token: env.INPUT_TOKEN,
    env,
    fetchImpl,
  })
  core.setOutput('phar', phar)
  core.setOutput('release', release)

  if (read === '') {
    return
  }

  const version = await getVersion({ exec, phar, cwd, dev })
  core.setOutput('version', version)

  if (read === 'zip-name') {
    core.setOutput('zip-name', await zipName({ exec, phar, cwd, version }))
  }
}

module.exports = {
  run,
  installPup,
  downloadPhar,
  runPup,
  getVersion,
  zipName,
  pharPath,
  validatePupVersion,
  resolvePupRelease,
  resolvePupDistribution,
  pupDownloadUrl,
  pupReleaseUrl,
  DEFAULT_PUP_VERSION,
}
