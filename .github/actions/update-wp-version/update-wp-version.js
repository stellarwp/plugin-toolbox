'use strict'

/**
 * Sets the WordPress version a plugin is tested up to and, when asked, the minimum it requires:
 * two minor versions behind the tested one.
 *
 * `Tested up to:` is set in readme.txt, and in the plugin file when it carries that header.
 * `Requires at least:` is set in readme.txt and in the plugin file. The plugin file is the single
 * root-level PHP file .puprc lists under `paths.versions`.
 *
 * Only an existing header is rewritten: a file without one is left as it is. The action writes
 * files and commits nothing.
 *
 * runUpdateWpVersion checks every input and the .puprc before it writes any file.
 */

const fs = require('node:fs')
const path = require('node:path')

const { readYesNo } = require('../../lib/inputs.js')
const { readVersionFiles } = require('../../lib/puprc.js')
const { readWorkingDirectory, readCheckoutFile } = require('../../lib/workspace.js')

/** What was not done, to close every error message. */
const WHAT = 'No file was changed.'

/** A WordPress version: two or three numeric parts, none zero-padded, so 6.010 is never read as 6.10. */
const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)(\.(0|[1-9]\d*))?$/

/** A PHP file at the root of the checkout. */
const ROOT_PHP = /^[^/\\]+\.php$/

/** How many minor versions the minimum trails the tested version by. */
const MINORS_BEHIND = 2

/**
 * Reads the `tested-up-to` input.
 *
 * @param {string} value The input value.
 *
 * @throws {Error} When it is not a version such as 6.8 or 6.8.1.
 *
 * @returns {string} The version.
 */
function readTestedUpTo(value) {
  const version = String(value ?? '').trim()

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
 * WordPress publishes no mapping from x.0 back into the previous major, so 7.0 and 7.1 have no
 * derived minimum.
 *
 * @param {string} tested The tested version.
 *
 * @throws {Error} When the minor would go below zero.
 *
 * @returns {string} The minimum, e.g. 6.6 for 6.8.1.
 */
function minimumFor(tested) {
  const [major, minor] = tested.split('.').map(Number)

  if (minor - MINORS_BEHIND < 0) {
    throw new Error(
      `Cannot derive a minimum version two minors behind ${tested}; set it by hand. ${WHAT}`
    )
  }

  return `${major}.${minor - MINORS_BEHIND}`
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
    // A plugin file is listed once per regex, so the names are deduplicated.
    files = [
      ...new Set(
        readVersionFiles(readCheckoutFile(cwd, '.puprc'), WHAT)
          .map((entry) => entry.file)
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
 * Sets headers in a file of the checkout. Only the first line carrying each header changes, so a
 * version quoted further down is left alone. A header the file does not carry is not added.
 *
 * @param {string}                 cwd     The checkout.
 * @param {string}                 file    The file, relative to it.
 * @param {Object<string, string>} headers The version per header name.
 *
 * @returns {boolean} True when the file carries at least one of the headers.
 */
function setHeaders(cwd, file, headers) {
  const before = readCheckoutFile(cwd, file)
  if (before === null) {
    return false
  }

  let after = before
  let found = false

  for (const [name, version] of Object.entries(headers)) {
    // The line shape WordPress reads a header from: comment characters, the name, a colon.
    const header = new RegExp(`^([ \\t/*#@]*${name}:[ \\t]*)[0-9.]*`, 'im')

    if (header.test(after)) {
      found = true
      after = after.replace(header, (match, lead) => `${lead}${version}`)
    }
  }

  if (after !== before) {
    fs.writeFileSync(path.join(cwd, file), after)
  }

  return found
}

/**
 * Runs the action.
 *
 * @param {object} options
 * @param {object} options.core The @actions/core toolkit, for the log, the output and the summary.
 * @param {object} options.env  The environment, holding the inputs as `INPUT_*`.
 * @param {string} options.cwd  The workspace, the process's working directory by default.
 *
 * @throws {Error} When an input is refused, no minimum can be derived, or the minimum is asked for
 *                 and .puprc does not name the plugin file.
 *
 * @returns {Promise<void>} Resolves once the files, the output and the summary are written.
 */
async function runUpdateWpVersion({ core, env, cwd: workspace = process.cwd() }) {
  const tested = readTestedUpTo(env.INPUT_TESTED_UP_TO)
  const updateMin = readYesNo(env.INPUT_UPDATE_MIN_VERSION, 'update-min-version', WHAT)
  const cwd = readWorkingDirectory(env.INPUT_WORKING_DIRECTORY, { base: workspace, what: WHAT })
  const minimum = updateMin ? minimumFor(tested) : ''
  const pluginFile = readPluginFile(cwd, updateMin)

  // Everything is checked by now; the writes start here.
  const headers = { 'Tested up to': tested, ...(updateMin ? { 'Requires at least': minimum } : {}) }
  const updated = ['readme.txt', pluginFile].filter((file) => file !== null && setHeaders(cwd, file, headers))

  if (updated.length === 0) {
    core.warning('No file carries a header to set, so nothing was written.')
  }

  core.setOutput('min-version', minimum)
  core.info(`Tested up to ${tested}, minimum ${updateMin ? minimum : 'unchanged'}.`)
  await core.summary
    .addRaw(
      [
        '## Version Updates',
        `* Tested Up To: \`${tested}\``,
        `* Minimum Required Version: ${updateMin ? `\`${minimum}\`` : 'Unchanged'}`,
        ...updated.map((file) => `* Updated \`${file}\``),
      ].join('\n'),
      true
    )
    .write()
}

module.exports = { runUpdateWpVersion }
