'use strict'

/**
 * Sets the WordPress version a plugin is tested up to and, when asked, the minimum it requires:
 * a version given, or two minor versions behind the tested one.
 *
 * `Tested up to:` is set in readme.txt, and in the plugin file when it carries that header.
 * `Requires at least:` is set in readme.txt and in the plugin file. The plugin file is the single
 * root-level PHP file .puprc lists under `paths.versions`.
 *
 * Only an existing header is rewritten: a file without one is left as it is. `Tested up to` is
 * never lowered: a file at 7.1.4 stays there when 7.1 is asked for. The action writes files and
 * commits nothing.
 *
 * runUpdateWpVersion checks every input and the .puprc before it writes any file.
 */

const fs = require('node:fs')
const path = require('node:path')

const { readVersionFiles } = require('../../lib/puprc.js')
const { compareVersions } = require('../../lib/versions.js')
const { readWorkingDirectory, readCheckoutFile } = require('../../lib/workspace.js')

/** What was not done, to close every error message. */
const WHAT = 'No file was changed.'

/** A WordPress version: two or three numeric parts, none zero-padded, so 6.010 is never read as 6.10. */
const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)(\.(0|[1-9]\d*))?$/

/** A PHP file at the root of the checkout. */
const ROOT_PHP = /^[^/\\]+\.php$/

/** The WordPress.org endpoint whose first offer is the latest WordPress release. */
const VERSION_CHECK_URL = 'https://api.wordpress.org/core/version-check/1.7/'

/** The header that is never lowered. */
const TESTED = 'Tested up to'

/** How many minor versions the minimum trails the tested version by. */
const MINORS_BEHIND = 2

/**
 * Looks up the latest WordPress release: the first offer of the WordPress.org version check.
 *
 * @param {Function} fetchImpl What `fetch` to use; a test passes a stand-in.
 *
 * @throws {Error} When the request fails, or the answer holds no version such as 6.8 or 6.8.1.
 *
 * @returns {Promise<string>} The version.
 */
async function latestWordPress(fetchImpl) {
  let body
  try {
    const response = await fetchImpl(VERSION_CHECK_URL)
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`)
    }
    body = await response.json()
  } catch (error) {
    throw new Error(
      `Looking up the latest WordPress release failed (${error.message}). Pass tested-up-to and run this step again. ${WHAT}`
    )
  }

  // The version is written into the plugin's files, so an answer of any other shape is refused.
  const version = body?.offers?.[0]?.version
  if (typeof version !== 'string' || !VERSION_PATTERN.test(version)) {
    throw new Error(
      `The latest WordPress release has no usable version in ${VERSION_CHECK_URL}. Pass tested-up-to and run this step again. ${WHAT}`
    )
  }

  return version
}

/**
 * Reads the `tested-up-to` input. Empty means the latest WordPress release.
 *
 * @param {string}   value     The input value.
 * @param {Function} fetchImpl What `fetch` to use for the latest release.
 *
 * @throws {Error} When it is not a version such as 6.8 or 6.8.1, or it is empty and the latest
 *                 release cannot be looked up.
 *
 * @returns {Promise<string>} The version.
 */
async function readTestedUpTo(value, fetchImpl) {
  const version = String(value ?? '').trim()

  if (version === '') {
    return latestWordPress(fetchImpl)
  }

  if (!VERSION_PATTERN.test(version)) {
    throw new Error(
      `tested-up-to must look like 6.8 or 6.8.1, with no zero-padded part, got '${version}'. ${WHAT}`
    )
  }

  return version
}

/**
 * The minimum version for a tested one: two minors behind, major and minor only.
 *
 * WordPress runs each major from x.0 to x.9 and then moves to the next (2.9, 3.0, ... 6.9, 7.0),
 * so two minors behind 7.0 is 6.8 and two behind 7.1 is 6.9.
 *
 * @param {string} tested The tested version.
 *
 * @throws {Error} When the minimum would fall below 1.0.
 *
 * @returns {string} The minimum, e.g. 6.6 for 6.8.1.
 */
function minimumFor(tested) {
  const [major, minor] = tested.split('.').map(Number)

  if (minor >= MINORS_BEHIND) {
    return `${major}.${minor - MINORS_BEHIND}`
  }

  if (major === 0) {
    throw new Error(
      `Cannot derive a minimum version two minors behind ${tested}; pass min-version as a version. ${WHAT}`
    )
  }

  return `${major - 1}.${minor - MINORS_BEHIND + 10}`
}

/**
 * Reads the `min-version` input.
 *
 * @param {string} value  The input value: empty, `auto`, or a version.
 * @param {string} tested The tested version, which `auto` counts back from and a version may not exceed.
 *
 * @throws {Error} When it is none of those, is a version above the tested one, or `auto` derives none.
 *
 * @returns {string} The minimum to set, or an empty string to leave it.
 */
function readMinVersion(value, tested) {
  const min = String(value ?? '').trim()

  if (min === '') {
    return ''
  }

  if (min.toLowerCase() === 'auto') {
    return minimumFor(tested)
  }

  if (!VERSION_PATTERN.test(min)) {
    throw new Error(
      `min-version must be empty, auto, or a version like 6.9 or 6.9.1 with no zero-padded part, got '${min}'. ${WHAT}`
    )
  }

  if (compareVersions(min, tested) > 0) {
    throw new Error(`min-version ${min} is above the tested version ${tested}. ${WHAT}`)
  }

  return min
}

/**
 * Finds the plugin file: the single root-level PHP file .puprc lists under `paths.versions`.
 *
 * @param {string}  cwd      The checkout.
 * @param {boolean} required Whether the file is needed. When it is not, an unusable .puprc is no error.
 *
 * @throws {Error} When the file is required and .puprc is unusable, lists no root PHP file or
 *                 several, or lists one that is not a file.
 *
 * @returns {string|null} The file, relative to the checkout, or null when there is none to use.
 */
function readPluginFile(cwd, required) {
  let files
  try {
    // A plugin file is listed once per regex, so the names are deduplicated. `./plugin.php` names
    // the same root file as `plugin.php`.
    files = [
      ...new Set(
        readVersionFiles(readCheckoutFile(cwd, '.puprc'), WHAT)
          .map((entry) => entry.file.replace(/^\.\//, ''))
          .filter((file) => ROOT_PHP.test(file))
      ),
    ]
  } catch (error) {
    if (required) {
      throw error
    }

    return null
  }

  const isFile = files.length === 1 && fs.statSync(path.join(cwd, files[0]), { throwIfNoEntry: false })?.isFile()

  if (isFile) {
    return files[0]
  }

  if (!required) {
    return null
  }

  const got = files.length === 0 ? 'none' : files.map((file) => `'${file}'`).join(', ')

  throw new Error(
    `.puprc must list exactly one root PHP file under paths.versions, got ${got}` +
      `${files.length === 1 ? ', which is not a file' : ''}. The minimum version is set in that file. ${WHAT}`
  )
}

/**
 * Whether a header's current value is above the version to set, so setting it would lower it.
 *
 * Only the leading numeric parts count: `7.1.4` is above `7.1`, and `6.8-RC1` is not above `6.8`.
 * A value with no numeric part, such as `trunk`, is never above.
 *
 * @param {string} current The value in the file.
 * @param {string} version The version to set.
 *
 * @returns {boolean} True when the current value is the higher version.
 */
function isAbove(current, version) {
  const numeric = current.match(/^\d+(\.\d+)*/)?.[0]

  return numeric !== undefined && compareVersions(numeric, version) > 0
}

/**
 * Sets headers in a file of the checkout. Only the first line carrying each header changes, so a
 * version quoted further down is left alone. A header the file does not carry is not added, and
 * `Tested up to` is never lowered.
 *
 * @param {string}                 cwd     The checkout.
 * @param {string}                 file    The file, relative to it.
 * @param {Object<string, string>} headers The version per header name.
 *
 * @returns {{lines: string[], changed: boolean}} What happened to each header the file carries, and
 *                                                whether the file was written.
 */
function setHeaders(cwd, file, headers) {
  const before = readCheckoutFile(cwd, file)
  if (before === null) {
    return { lines: [], changed: false }
  }

  let after = before
  const lines = []

  for (const [name, version] of Object.entries(headers)) {
    // The line shape WordPress reads a header from: comment characters, the name, a colon. The
    // whole value up to the next space is replaced, so `6.8-RC1` becomes `6.8`, not `6.8-RC1`.
    const header = new RegExp(`^([ \\t/*#@]*${name}:[ \\t]*)(\\S*)`, 'im')
    const current = after.match(header)?.[2]

    if (current === undefined) {
      continue
    }

    if (current === version) {
      lines.push(`${name} already at ${version}`)
    } else if (name === TESTED && isAbove(current, version)) {
      lines.push(`${name} left at ${current}, which is above ${version}`)
    } else {
      after = after.replace(header, (match, lead) => `${lead}${version}`)
      lines.push(`${name} changed from ${current} to ${version}`)
    }
  }

  if (after !== before) {
    fs.writeFileSync(path.join(cwd, file), after)
  }

  return { lines, changed: after !== before }
}

/**
 * Runs the action.
 *
 * @param {object}   options
 * @param {object}   options.core      The @actions/core toolkit, for the log, the output and the summary.
 * @param {object}   options.env       The environment, holding the inputs as `INPUT_*`.
 * @param {string}   options.cwd       The workspace, the process's working directory by default.
 * @param {Function} options.fetchImpl What `fetch` to use for the latest release; a test passes a stand-in.
 *
 * @throws {Error} When an input is refused, the latest release cannot be looked up, `auto` derives
 *                 no minimum, or a minimum is asked for and .puprc does not name the plugin file.
 *
 * @returns {Promise<void>} Resolves once the files, the outputs and the summary are written.
 */
async function runUpdateWpVersion({ core, env, cwd: workspace = process.cwd(), fetchImpl = globalThis.fetch }) {
  const tested = await readTestedUpTo(env.INPUT_TESTED_UP_TO, fetchImpl)
  const minimum = readMinVersion(env.INPUT_MIN_VERSION, tested)
  const cwd = readWorkingDirectory(env.INPUT_WORKING_DIRECTORY, { base: workspace, what: WHAT })
  const pluginFile = readPluginFile(cwd, minimum !== '')

  // Everything is checked by now; the writes start here.
  const headers = { [TESTED]: tested, ...(minimum ? { 'Requires at least': minimum } : {}) }
  const results = ['readme.txt', pluginFile]
    .filter((file) => file !== null)
    .map((file) => ({ file, ...setHeaders(cwd, file, headers) }))
  const lines = results.flatMap(({ file, lines }) => lines.map((line) => `\`${file}\`: ${line}`))

  if (lines.length === 0) {
    core.warning('No file carries a header to set, so nothing was written.')
  }

  core.setOutput('min-version', minimum)
  core.setOutput('changed', String(results.some((result) => result.changed)))
  core.info(`Tested up to ${tested}, minimum ${minimum || 'unchanged'}.`)
  lines.forEach((line) => core.info(line.replaceAll('`', '')))
  await core.summary
    .addRaw(
      [
        '## Version Updates',
        `* Tested Up To: \`${tested}\``,
        `* Minimum Required Version: ${minimum ? `\`${minimum}\`` : 'Unchanged'}`,
        ...lines.map((line) => `* ${line}`),
      ].join('\n'),
      true
    )
    .write()
}

module.exports = { runUpdateWpVersion }
