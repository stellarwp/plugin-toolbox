'use strict'

/**
 * The directory an action works in, shared by the toolbox actions. Loaded by a path relative to each
 * action's directory, like versions.js.
 *
 * A composite action's steps run in the workspace, and a `uses:` step takes no `working-directory`,
 * so an action that reads a checkout made somewhere else (`source/`, as a workflow that keeps the
 * plugin apart from its own tooling does) takes the directory as an input.
 *
 * The value is the caller's own `with:`, written by whoever writes the workflow, so it carries the
 * same trust as the `ref` and `path` of the checkout step in the same job; it is not kept inside
 * the workspace. An absolute path is a legitimate case: a checkout in the runner's temp directory.
 */

const fs = require('node:fs')
const path = require('node:path')

/**
 * Reads the `working-directory` input: where the checkout is, relative to the workspace or absolute.
 *
 * @param {string} input The input value. Empty is the workspace itself.
 * @param {object} options
 * @param {string} options.base The workspace, the process's working directory by default.
 * @param {string} options.what What was not done, to close the error message.
 *
 * @throws {Error} When the directory does not exist, or is not a directory.
 *
 * @returns {string} The directory, as an absolute path.
 */
function readWorkingDirectory(input, { base = process.cwd(), what }) {
  const trimmed = String(input ?? '').trim()
  const dir = path.resolve(base, trimmed === '' ? '.' : trimmed)

  let stat
  try {
    stat = fs.statSync(dir)
  } catch {
    stat = null
  }

  if (!stat?.isDirectory()) {
    throw new Error(
      `working-directory '${trimmed}' is not a directory (${dir}). Pass the directory the repository is ` +
        `checked out in, relative to the workspace or absolute, or leave it empty for the workspace itself. ${what}`
    )
  }

  return dir
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

module.exports = { readWorkingDirectory, readCheckoutFile }
