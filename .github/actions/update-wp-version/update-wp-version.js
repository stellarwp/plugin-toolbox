'use strict'

/**
 * Sets the WordPress version a plugin is tested up to and, when asked, the minimum it requires:
 * a version given, or the WordPress release two before the tested one.
 *
 * `Tested up to:` is set in readme.txt, and in the plugin file when it carries that header.
 * `Requires at least:` is set in readme.txt and in the plugin file. The plugin file is the single
 * root-level PHP file .puprc lists under `paths.versions`.
 *
 * Only an existing header is rewritten: a file without one is left as it is. `Tested up to` is
 * never lowered: a file at 7.1.4 stays there when 7.1 is asked for. Neither is `Requires at least`
 * when `min-version` is `auto`; a version given exactly is set as it is, lower or not. The action
 * writes files and commits nothing.
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

/** The WordPress.org endpoint that lists every WordPress release as a key, e.g. `7.0` or `7.0.9`. */
const STABLE_CHECK_URL = 'https://api.wordpress.org/core/stable-check/1.0/'

/** A release key of stable-check, whose first two parts are its major and minor version. */
const RELEASE_PATTERN = /^(\d+\.\d+)(\.\d+)*$/

/** The header that is never lowered. */
const TESTED = 'Tested up to'

/** The header `min-version` sets, never lowered when it is `auto`. */
const REQUIRES = 'Requires at least'

/** How many releases the minimum trails the tested version by. */
const RELEASES_BEHIND = 2

/**
 * Takes the major and minor parts of a version.
 *
 * @param {string} version A version, e.g. `7.1.5`.
 *
 * @returns {string} Its major and minor parts, e.g. `7.1`.
 */
function majorMinor(version) {
  return version.split('.').slice(0, 2).join('.')
}

/**
 * Looks up the latest WordPress release, major and minor only: the first offer of the WordPress.org
 * version check, so `7.1.5` gives `7.1`. WordPress.org reads `Tested up to` by major and minor, so
 * `7.1` covers every `7.1.x` release.
 *
 * @param {Function} fetchImpl What `fetch` to use; a test passes a stand-in.
 *
 * @throws {Error} When the request fails, or the answer holds no version such as 6.8 or 6.8.1.
 *
 * @returns {Promise<string>} The major and minor version, e.g. `7.1`.
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

  return majorMinor(version)
}

/**
 * Reads the `tested-up-to` input. Empty means the latest WordPress release, major and minor only.
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
 * Looks up the major and minor versions of every WordPress release, in order, from the
 * WordPress.org stable check.
 *
 * @param {Function} fetchImpl What `fetch` to use; a test passes a stand-in.
 *
 * @throws {Error} When the request fails, or the answer is not an object listing releases as keys.
 *
 * @returns {Promise<string[]>} The distinct major and minor versions, lowest first, e.g. `['6.9', '7.0']`.
 */
async function wordPressReleases(fetchImpl) {
  let body
  try {
    const response = await fetchImpl(STABLE_CHECK_URL)
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`)
    }
    body = await response.json()
  } catch (error) {
    throw new Error(
      `Looking up the WordPress releases failed (${error.message}). Pass min-version as a version and run this step again. ${WHAT}`
    )
  }

  const releases =
    body !== null && typeof body === 'object' && !Array.isArray(body)
      ? [...new Set(Object.keys(body).map((key) => key.match(RELEASE_PATTERN)?.[1]).filter(Boolean))]
      : []

  if (releases.length === 0) {
    throw new Error(
      `${STABLE_CHECK_URL} lists no WordPress releases. Pass min-version as a version and run this step again. ${WHAT}`
    )
  }

  return releases.sort(compareVersions)
}

/**
 * The minimum version for a tested one: the WordPress release two before it, major and minor only.
 *
 * The releases come from WordPress.org, so the count follows the versions WordPress shipped: two
 * before 7.0 is 6.8, and two before 2.0 is 1.2, as 1.5 came between them.
 *
 * @param {string}   tested    The tested version.
 * @param {Function} fetchImpl What `fetch` to use for the release list.
 *
 * @throws {Error} When the release list cannot be looked up, does not hold the tested major and
 *                 minor version, or holds fewer than two releases before it.
 *
 * @returns {Promise<string>} The minimum, e.g. 6.6 for 6.8.1.
 */
async function minimumFor(tested, fetchImpl) {
  const releases = await wordPressReleases(fetchImpl)
  const index = releases.indexOf(majorMinor(tested))

  if (index === -1) {
    throw new Error(
      `${majorMinor(tested)} is not a WordPress release ${STABLE_CHECK_URL} lists, so min-version auto has no minimum for it. Pass min-version as a version. ${WHAT}`
    )
  }

  if (index < RELEASES_BEHIND) {
    throw new Error(
      `${STABLE_CHECK_URL} lists fewer than two WordPress releases before ${majorMinor(tested)}, so min-version auto has no minimum for it. Pass min-version as a version. ${WHAT}`
    )
  }

  return releases[index - RELEASES_BEHIND]
}

/**
 * Reads the `min-version` input.
 *
 * @param {string}   value     The input value: empty, `auto`, or a version.
 * @param {string}   tested    The tested version, which `auto` counts back from and a version may not exceed.
 * @param {Function} fetchImpl What `fetch` to use for the release list `auto` counts back through.
 *
 * @throws {Error} When it is none of those, is a version above the tested one, or `auto` derives none.
 *
 * @returns {Promise<{minimum: string, auto: boolean}>} The minimum to set, empty to leave it, and
 *                                                      whether `auto` derived it.
 */
async function readMinVersion(value, tested, fetchImpl) {
  const min = String(value ?? '').trim()

  if (min === '') {
    return { minimum: '', auto: false }
  }

  if (min.toLowerCase() === 'auto') {
    return { minimum: await minimumFor(tested, fetchImpl), auto: true }
  }

  if (!VERSION_PATTERN.test(min)) {
    throw new Error(
      `min-version must be empty, auto, or a version like 6.9 or 6.9.1 with no zero-padded part, got '${min}'. ${WHAT}`
    )
  }

  if (compareVersions(min, tested) > 0) {
    throw new Error(`min-version ${min} is above the tested version ${tested}. ${WHAT}`)
  }

  return { minimum: min, auto: false }
}

/**
 * Finds the plugin file: the single root-level PHP file .puprc lists under `paths.versions`.
 *
 * @param {string}  cwd      The checkout.
 * @param {boolean} required Whether the file is needed. When it is not, an unusable .puprc is no error.
 *
 * @throws {Error} When the file is required and .puprc is missing or unusable, lists no root PHP
 *                 file or several, or lists one that is not a file.
 *
 * @returns {string|null} The file, relative to the checkout, or null when there is none to use.
 */
function readPluginFile(cwd, required) {
  const puprc = readCheckoutFile(cwd, '.puprc')
  if (puprc === null && required) {
    throw new Error(
      `min-version is set, so a .puprc listing the plugin file under paths.versions is needed; see this action's README. ${WHAT}`
    )
  }

  let files
  try {
    // A plugin file is listed once per regex, so the names are deduplicated. `./plugin.php` names
    // the same root file as `plugin.php`.
    files = [
      ...new Set(
        readVersionFiles(puprc, WHAT)
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
 * a header in `keep` is never lowered.
 *
 * @param {string}                 cwd     The checkout.
 * @param {string}                 file    The file, relative to it.
 * @param {Object<string, string>} headers The version per header name.
 * @param {Set<string>}            keep    The header names never to lower.
 *
 * @returns {{lines: string[], values: Object<string, string>, changed: boolean}} What happened to
 *          each header the file carries, the value each one holds afterwards, and whether the file
 *          was written.
 */
function setHeaders(cwd, file, headers, keep) {
  const before = readCheckoutFile(cwd, file)
  if (before === null) {
    return { lines: [], values: {}, changed: false }
  }

  let after = before
  const lines = []
  const values = {}

  for (const [name, version] of Object.entries(headers)) {
    // The line shape WordPress reads a header from: comment characters, the name, a colon. The
    // whole value up to the next space or `*/` is replaced, so `6.8-RC1` becomes `6.8`, and a
    // comment closed right after the value stays closed.
    const header = new RegExp(`^([ \\t/*#@]*${name}:[ \\t]*)((?:(?!\\*\\/)\\S)*)`, 'im')
    const current = after.match(header)?.[2]

    if (current === undefined) {
      continue
    }

    if (current === version) {
      values[name] = version
      lines.push(`${name} already at ${version}`)
    } else if (keep.has(name) && isAbove(current, version)) {
      values[name] = current
      lines.push(`${name} left at ${current}, which is above ${version}`)
    } else {
      values[name] = version
      after = after.replace(header, (match, lead) => `${lead}${version}`)
      lines.push(`${name} changed from ${current} to ${version}`)
    }
  }

  if (after !== before) {
    fs.writeFileSync(path.join(cwd, file), after)
  }

  return { lines, values, changed: after !== before }
}

/**
 * Runs the action.
 *
 * @param {object}   options
 * @param {object}   options.core      The @actions/core toolkit, for the log, the output and the summary.
 * @param {object}   options.env       The environment, holding the inputs as `INPUT_*`.
 * @param {string}   options.cwd       The workspace, the process's working directory by default.
 * @param {Function} options.fetchImpl What `fetch` to use for the WordPress.org lookups; a test passes a stand-in.
 *
 * @throws {Error} When an input is refused, the latest release or the release list cannot be looked
 *                 up, `auto` derives no minimum, or a minimum is asked for and .puprc does not name
 *                 the plugin file.
 *
 * @returns {Promise<void>} Resolves once the files, the outputs and the summary are written.
 */
async function runUpdateWpVersion({ core, env, cwd: workspace = process.cwd(), fetchImpl = globalThis.fetch }) {
  const tested = await readTestedUpTo(env.INPUT_TESTED_UP_TO, fetchImpl)
  const { minimum, auto } = await readMinVersion(env.INPUT_MIN_VERSION, tested, fetchImpl)
  const cwd = readWorkingDirectory(env.INPUT_WORKING_DIRECTORY, { base: workspace, what: WHAT })
  const pluginFile = readPluginFile(cwd, minimum !== '')

  // Everything is checked by now; the writes start here.
  const headers = { [TESTED]: tested, ...(minimum ? { [REQUIRES]: minimum } : {}) }
  const keep = new Set(auto ? [TESTED, REQUIRES] : [TESTED])
  const results = ['readme.txt', pluginFile]
    .filter((file) => file !== null)
    .map((file) => ({ file, ...setHeaders(cwd, file, headers, keep) }))
  const lines = results.flatMap(({ file, lines }) => lines.map((line) => `\`${file}\`: ${line}`))

  // The minimum the files hold afterwards. When readme.txt and the plugin file differ, which only
  // happens when `auto` kept a higher value in one of them, the higher one is reported: the plugin
  // cannot run on a version below it.
  const held = results
    .map(({ values }) => values[REQUIRES])
    .filter((value) => value !== undefined)
    .reduce((highest, value) => (highest === '' || isAbove(value, highest) ? value : highest), '')

  if (lines.length === 0) {
    core.warning('No file carries a header to set, so nothing was written.')
  }

  core.setOutput('min-version', held)
  core.setOutput('changed', String(results.some((result) => result.changed)))
  core.info(`Tested up to ${tested}, minimum ${held || 'unchanged'}.`)
  lines.forEach((line) => core.info(line.replaceAll('`', '')))
  await core.summary
    .addRaw(
      [
        '## Version Updates',
        `* Tested Up To: \`${tested}\``,
        `* Minimum Required Version: ${held ? `\`${held}\`` : 'Unchanged'}`,
        ...lines.map((line) => `* ${line}`),
      ].join('\n'),
      true
    )
    .write()
}

module.exports = { runUpdateWpVersion }
