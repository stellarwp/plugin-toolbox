'use strict'

/**
 * Running pup, shared by the toolbox actions. Loaded by a path relative to each action's directory,
 * like versions.js.
 *
 * This is the one place that knows how pup is distributed: a `pup.phar` asset on each GitHub
 * release, run on the runner's PHP. `pup-version` is resolved here (a pinned release, or `latest`
 * through the API), the release is checked for the asset, the phar is downloaded into the runner's
 * temp directory, and the actions get back a `pup(args)` function. When the TypeScript line of pup
 * publishes a distribution, this file changes and the actions run it without an edit of their own.
 * What this file hides is the distribution, not the CLI: a command or a flag renamed in pup still
 * means a change in the actions that call it.
 */

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { runOrFail } = require('./exec.js')

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
 * @param {string}          options.what      What was not done, to close the error message.
 *
 * @throws {Error} When the latest release cannot be read.
 *
 * @returns {Promise<string>} The release tag to download from.
 */
async function resolvePupRelease({ version, token, fetchImpl, what = 'Nothing was changed.' }) {
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
      `Reading the latest pup release failed (HTTP ${response.status}). Pass a pinned pup-version and run this step again. ${what}`
    )
  }

  // The tag goes into a download URL and a temp file path, and a missing one would surface
  // as a 404 on …/download/undefined/pup.phar, which the distribution check would report as
  // a release that does not exist. A broken API response must fail here, naming the API, so
  // the tag is validated before it is used.
  const tag = (await response.json()).tag_name
  if (typeof tag !== 'string' || !PUP_VERSION_PATTERN.test(tag)) {
    throw new Error(
      `The latest pup release has no usable tag. Pass a pinned pup-version and run this step again. ${what}`
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
 * asset means the PHP build the actions run. A release without one (1.2.3 and 0.0.1 among the
 * published ones, and the TypeScript line once it ships) cannot be run from here yet.
 *
 * The checks are HEAD requests against the asset URL and, when that is missing, the release page,
 * not the releases API, so a pinned `pup-version` stays free of API calls and rate limits. The
 * second request tells a release without a phar from a release that does not exist, which a
 * mistyped pin produces.
 *
 * @param {object}   options
 * @param {object}   options.exec    The @actions/exec toolkit.
 * @param {string}   options.release The resolved pup release tag.
 * @param {string}   options.what    What was not done, to close the error message.
 *
 * @throws {Error} When the release does not exist, or a check itself fails and the run cannot
 *                 tell which path to take.
 *
 * @returns {Promise<'phar'|'ts'>} The distribution the release carries: `ts` for any release
 *          without a phar, the old ones included, since that is the path they take.
 */
async function resolvePupDistribution({ exec, release, what = 'Nothing was changed.' }) {
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
      throw new Error(`pup ${release} is not a release: check pup-version for a typo. ${what}`)
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
 * The error for a release that exists but publishes no phar.
 *
 * The TypeScript line publishes no phar, and nothing can call it yet: a composite action's `uses:`
 * references resolve when the JOB is set up, not when the step runs, so a manifest cannot carry its
 * action behind a condition, and calling it straight from the script needs a published distribution
 * first. Until one exists, a phar-less release fails with an error naming the pin to use instead.
 *
 * @param {string} release The pup release tag.
 * @param {string} what    What was not done, to close the error message.
 *
 * @returns {Error} The error.
 */
function noPharError(release, what) {
  return new Error(
    `pup ${release} publishes no pup.phar asset, so this action cannot run it. Pin pup-version to a ` +
      `release that ships one, such as 2.0.0. ${what}`
  )
}

/**
 * Where the phar of a pup release lives on the runner: its temp directory, so it never ends up in
 * the checkout or in a commit, and the same path for every action of the job, so one download
 * serves them all.
 *
 * @param {object} env     The step environment, for RUNNER_TEMP.
 * @param {string} release The resolved pup release tag.
 *
 * @returns {string} The path.
 */
function pharPath(env, release) {
  return path.join(env.RUNNER_TEMP || os.tmpdir(), `pup-${release}.phar`)
}

/**
 * Whether a phar an earlier step downloaded is there to reuse. An empty file is not: it is what a
 * download that was cut off leaves.
 *
 * @param {string} phar The path.
 *
 * @returns {boolean} True for a file with content.
 */
function pharExists(phar) {
  try {
    return fs.statSync(phar).size > 0
  } catch {
    return false
  }
}

/**
 * Downloads the phar of a pup release into the runner's temp directory, unless an earlier step of
 * the job already did. A download that fails leaves no file behind, so the next step does not
 * reuse half a phar.
 *
 * @param {object} options
 * @param {object} options.exec    The @actions/exec toolkit.
 * @param {object} options.env     The step environment, for RUNNER_TEMP.
 * @param {string} options.release The resolved pup release tag.
 * @param {object} options.core    The @actions/core toolkit, to say when the phar is reused.
 *
 * @throws {Error} When the download fails.
 *
 * @returns {Promise<string>} The path of the phar.
 */
async function downloadPhar({ exec, env, release, core }) {
  const phar = pharPath(env, release)

  if (pharExists(phar)) {
    core?.info(`Reusing pup ${release}, downloaded by an earlier step of this job.`)

    return phar
  }

  try {
    await runOrFail(exec, 'curl', ['-fsSL', '--retry', '3', '-o', phar, pupDownloadUrl(release)], {}, `Downloading pup ${release}`)
  } catch (error) {
    fs.rmSync(phar, { force: true })

    throw error
  }

  return phar
}

/**
 * The function the actions run pup through: `pup(['package', version], { cwd })`.
 *
 * The phar runs on the runner's PHP, with the arguments as a list and no shell, and with PHP's
 * notices and deprecations sent to stderr: the stdout of a command whose output an action reads
 * (`get-version`, `zip-name`) then holds only what pup printed, and the log of every other command
 * shows both streams as before. This is the one place that knows pup is PHP.
 *
 * @param {object} exec The @actions/exec toolkit.
 * @param {string} phar Path to the downloaded pup.phar.
 *
 * @returns {Function} `pup(args, options, what)`: runs pup with `args` and the @actions/exec
 *          `options`, and fails with pup's output when it exits non-zero; `what` opens that
 *          message, `pup <first argument>` by default. Resolves to what pup printed to stdout.
 */
function pupRunner(exec, phar) {
  return (args, options = {}, what = `pup ${args[0]}`) =>
    runOrFail(exec, 'php', ['-d', 'display_errors=stderr', phar, ...args], options, what)
}

/**
 * Resolves, checks and downloads pup, and hands back the function to run it: everything an action
 * does before its first pup command.
 *
 * @param {object}   options
 * @param {object}   options.exec       The @actions/exec toolkit.
 * @param {object}   options.env        The step environment: INPUT_PUP_VERSION, INPUT_TOKEN and
 *                                      RUNNER_TEMP.
 * @param {object}   options.core       The @actions/core toolkit, for the log.
 * @param {Function} options.fetchImpl  What `fetch` to use for `latest`; a test passes a stand-in.
 * @param {string}   options.what       What was not done, to close each error message.
 *
 * @throws {Error} When `pup-version` is not a release number, the release cannot be resolved, does
 *                 not exist or publishes no phar, or the download fails.
 *
 * @returns {Promise<{release: string, pup: Function}>} The release that runs and the function to
 *          run it with, as pupRunner builds it.
 */
async function setupPup({ exec, env, core, fetchImpl = globalThis.fetch, what = 'Nothing was changed.' }) {
  const release = await resolvePupRelease({
    version: validatePupVersion(env.INPUT_PUP_VERSION),
    token: env.INPUT_TOKEN || '',
    fetchImpl,
    what,
  })

  // A phar already on the runner is proof enough that the release ships one: the check of the
  // release page is for the first download of the job.
  if (!pharExists(pharPath(env, release)) && (await resolvePupDistribution({ exec, release, what })) !== 'phar') {
    throw noPharError(release, what)
  }

  const phar = await downloadPhar({ exec, env, release, core })

  return { release, pup: pupRunner(exec, phar) }
}

/**
 * The last non-empty line of a command's output, where `pup get-version` and `pup zip-name` print
 * their answer after any PHP notice.
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

module.exports = {
  PUP_VERSION_PATTERN,
  validatePupVersion,
  resolvePupRelease,
  pupDownloadUrl,
  pupReleaseUrl,
  resolvePupDistribution,
  noPharError,
  pharPath,
  pharExists,
  downloadPhar,
  pupRunner,
  setupPup,
  lastLine,
}
