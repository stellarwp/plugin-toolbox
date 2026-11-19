'use strict'

/**
 * Downloads a PHP tool's phar into the runner's temp directory, shared by the toolbox actions.
 * Loaded by a path relative to each action's directory, like versions.js.
 *
 * The phar never lands in the checkout, so it is never part of a commit, and a later step of the
 * same job reuses the download instead of fetching it again.
 */

const crypto = require('node:crypto')
const fs = require('node:fs')

const { runOrFail } = require('./exec.js')

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
 * Downloads a phar to `phar`, unless an earlier step of the job already did. With `sha512`, the
 * file is checked on every call, the reused one too. A download that fails or does not match
 * leaves no file behind, so the next step does not run half a phar or a different one.
 *
 * @param {object} options
 * @param {object} options.exec   The @actions/exec toolkit.
 * @param {string} options.phar   Where the phar goes, in the runner's temp directory.
 * @param {string} options.url    Where it is downloaded from.
 * @param {string} options.label  The tool and its release, e.g. `pup 2.0.0`, for the log and the errors.
 * @param {string} options.sha512 The phar's expected sha512, hex. Empty skips the check.
 * @param {string} options.what   What was not done, to close the checksum error.
 * @param {object} options.core   The @actions/core toolkit, to say when the phar is reused.
 *
 * @throws {Error} When the download fails, or the phar does not match `sha512`.
 *
 * @returns {Promise<string>} The path of the phar.
 */
async function downloadPhar({ exec, phar, url, label, sha512 = '', what = '', core }) {
  try {
    if (pharExists(phar)) {
      core?.info(`Reusing ${label}, downloaded by an earlier step of this job.`)
    } else {
      await runOrFail(exec, 'curl', ['-fsSL', '--retry', '3', '-o', phar, url], {}, `Downloading ${label}`)
    }

    if (sha512 !== '') {
      const actual = crypto.createHash('sha512').update(fs.readFileSync(phar)).digest('hex')

      if (actual !== sha512) {
        throw new Error(`The ${label} phar does not match its sha512: expected ${sha512}, got ${actual}. ${what}`.trim())
      }
    }
  } catch (error) {
    fs.rmSync(phar, { force: true })

    throw error
  }

  return phar
}

module.exports = { pharExists, downloadPhar }
