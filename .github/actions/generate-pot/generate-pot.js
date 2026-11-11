'use strict'

/**
 * Generates a plugin's POT file with `wp i18n make-pot`, and says whether its strings changed.
 *
 * runGeneratePot validates the inputs, downloads a pinned wp-cli phar into the runner's temp
 * directory and checks its sha512, runs make-pot on the runner's PHP, then compares the POT with
 * the one git tracks. The commands run through `exec`, so a test can pass stand-ins and assert the
 * calls.
 */

const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { runOrFail } = require('../../lib/exec.js')
const { pharExists } = require('../../lib/pup.js')
const { readWorkingDirectory, readCheckoutFile } = require('../../lib/workspace.js')

/** What was not done, to close every error message. */
const WHAT = 'No POT was generated.'

/**
 * The wp-cli release that runs make-pot, and the sha512 of its phar. A release with its checksum,
 * not the newest build: the phar runs in jobs that hold a token. Bump both together.
 */
const WP_CLI = {
  version: '2.12.0',
  sha512:
    'be928f6b8ca1e8dfb9d2f4b75a13aa4aee0896f8a9a0a1c45cd5d2c98605e6172e6d014dda2e27f88c98befc16c040cbb2bd1bfa121510ea5cdf5f6a30fe8832',
}

/**
 * The header lines make-pot stamps on every run: the time, the plugin version and its own version.
 * A POT that differs in these only holds the same strings.
 */
const STAMPED_HEADERS = ['POT-Creation-Date:', 'Project-Id-Version:', 'X-Generator:']

/**
 * Splits a multi-line value into its lines, trimmed, without the empty ones and the `#` comments.
 *
 * @param {string|null} text The value: an input, or a file's contents.
 *
 * @returns {string[]} The lines.
 */
function readLines(text) {
  return String(text ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'))
}

/**
 * Reads the `pot-path` input: where the POT is written, relative to the checkout.
 *
 * @param {string} value The input value.
 * @param {string} cwd   The checkout.
 *
 * @throws {Error} When it is empty, absolute, or leads outside the checkout.
 *
 * @returns {string} The path, as given.
 */
function readPotPath(value, cwd) {
  const trimmed = String(value ?? '').trim()

  if (trimmed === '') {
    throw new Error(`pot-path is empty. Pass where the POT is written, such as lang/my-plugin.pot. ${WHAT}`)
  }

  const relative = path.relative(cwd, path.resolve(cwd, trimmed))
  if (path.isAbsolute(trimmed) || relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(
      `pot-path '${trimmed}' is not a path inside the checkout. Pass it relative to the checkout, such as ` +
        `lang/my-plugin.pot. ${WHAT}`
    )
  }

  return trimmed
}

/**
 * Reads the `headers` input: the POT headers to set, as a JSON object of strings.
 *
 * @param {string} value The input value. Empty sets no header.
 *
 * @throws {Error} When it is not JSON, or not an object whose values are all strings.
 *
 * @returns {string|null} The object as compact JSON, or null for an empty value.
 */
function readHeaders(value) {
  const trimmed = String(value ?? '').trim()

  if (trimmed === '') {
    return null
  }

  let headers
  try {
    headers = JSON.parse(trimmed)
  } catch (error) {
    throw new Error(`headers is not valid JSON (${error.message}). ${WHAT}`)
  }

  if (
    headers === null ||
    typeof headers !== 'object' ||
    Array.isArray(headers) ||
    Object.values(headers).some((header) => typeof header !== 'string')
  ) {
    throw new Error(
      `headers is not a JSON object of strings, such as {"Report-Msgid-Bugs-To": "https://example.com"}. ${WHAT}`
    )
  }

  return JSON.stringify(headers)
}

/**
 * What make-pot leaves out: the `.distignore` lines, the git submodule paths and the `exclude`
 * input, in that order, each once.
 *
 * A submodule has its own text domain and its own POT, and a checkout with submodules would fold
 * its strings in.
 *
 * @param {string} cwd   The checkout.
 * @param {string} extra The `exclude` input.
 *
 * @returns {string[]} The exclusions.
 */
function readExcludes(cwd, extra) {
  const submodules = [...(readCheckoutFile(cwd, '.gitmodules') ?? '').matchAll(/^\s*path\s*=\s*(.+?)\s*$/gm)].map(
    (match) => match[1]
  )

  return [...new Set([...readLines(readCheckoutFile(cwd, '.distignore')), ...submodules, ...readLines(extra)])]
}

/**
 * Puts the pinned wp-cli phar in the runner's temp directory, so it never ends up in the checkout,
 * and checks its sha512. A phar an earlier step of the job downloaded is reused, and checked again.
 * A failed download or a wrong checksum leaves no file behind.
 *
 * @param {object} options
 * @param {object} options.exec  The @actions/exec toolkit.
 * @param {object} options.env   The step environment, for RUNNER_TEMP.
 * @param {object} options.wpCli The release and its checksum.
 *
 * @throws {Error} When the download fails or the checksum does not match.
 *
 * @returns {Promise<string>} The path of the phar.
 */
async function setupWpCli({ exec, env, wpCli }) {
  const { version, sha512 } = wpCli
  const phar = path.join(env.RUNNER_TEMP || os.tmpdir(), `wp-cli-${version}.phar`)

  try {
    if (!pharExists(phar)) {
      const url = `https://github.com/wp-cli/wp-cli/releases/download/v${version}/wp-cli-${version}.phar`

      await runOrFail(exec, 'curl', ['-fsSL', '--retry', '3', '-o', phar, url], {}, `Downloading wp-cli ${version}`)
    }

    const actual = crypto.createHash('sha512').update(fs.readFileSync(phar)).digest('hex')
    if (actual !== sha512) {
      throw new Error(`The wp-cli ${version} phar does not match its sha512: expected ${sha512}, got ${actual}. ${WHAT}`)
    }
  } catch (error) {
    fs.rmSync(phar, { force: true })

    throw error
  }

  return phar
}

/**
 * Whether the POT's strings changed, against the file git tracks. A tracked POT that differs in
 * the stamped headers only is put back as it was, so a second run leaves nothing to commit.
 *
 * @param {object} exec    The @actions/exec toolkit.
 * @param {string} cwd     The checkout.
 * @param {string} potPath The POT, relative to the checkout.
 *
 * @throws {Error} When git fails: the directory is not a git checkout.
 *
 * @returns {Promise<boolean>} True when the POT is new or its strings changed.
 */
async function stringsChanged(exec, cwd, potPath) {
  const options = { cwd, silent: true }
  const tracked = await runOrFail(exec, 'git', ['ls-files', '--', potPath], options, 'git ls-files')

  if (tracked.trim() === '') {
    return true
  }

  const diff = await exec.getExecOutput(
    'git',
    ['diff', '--quiet', ...STAMPED_HEADERS.map((header) => `-I${header}`), '--', potPath],
    { ...options, ignoreReturnCode: true }
  )

  if (diff.exitCode === 1) {
    return true
  }

  if (diff.exitCode !== 0) {
    throw new Error(`git diff failed (exit code ${diff.exitCode}):\n${diff.stderr.trim()}`)
  }

  await runOrFail(exec, 'git', ['checkout', '--', potPath], options, 'git checkout')

  return false
}

/**
 * Validates the inputs, runs make-pot and sets the outputs.
 *
 * Every input is checked before the phar is downloaded, and the phar is checked before it runs.
 *
 * @param {object} options
 * @param {object} options.core  The @actions/core toolkit, for the log and the outputs.
 * @param {object} options.exec  The @actions/exec toolkit.
 * @param {object} options.env   The environment the action manifest put its inputs in.
 * @param {string} options.cwd   The workspace, the process's working directory by default;
 *                               `working-directory` is resolved against it.
 * @param {object} options.wpCli The wp-cli release and its checksum; a test passes a stand-in.
 *
 * @throws {Error} When an input is wrong, the phar cannot be downloaded or fails its checksum,
 *                 make-pot fails or writes no file, or git fails.
 *
 * @returns {Promise<void>} Resolves once the outputs are set.
 */
async function runGeneratePot({ core, exec, env, cwd: workspace = process.cwd(), wpCli = WP_CLI }) {
  const cwd = readWorkingDirectory(env.INPUT_WORKING_DIRECTORY, { base: workspace, what: WHAT })
  const potPath = readPotPath(env.INPUT_POT_PATH, cwd)
  const sourcePath = String(env.INPUT_SOURCE_PATH ?? '').trim() || '.'
  const domain = String(env.INPUT_DOMAIN ?? '').trim()
  const headers = readHeaders(env.INPUT_HEADERS)
  const excludes = readExcludes(cwd, env.INPUT_EXCLUDE)

  const phar = await setupWpCli({ exec, env, wpCli })

  const args = ['i18n', 'make-pot', sourcePath, potPath, '--skip-audit']
  if (domain !== '') {
    args.push(`--domain=${domain}`)
  }
  if (headers !== null) {
    args.push(`--headers=${headers}`)
  }
  if (excludes.length > 0) {
    args.push(`--exclude=${excludes.join(',')}`)
  }

  // The arguments are a list and there is no shell, so an input is never part of a command line.
  await runOrFail(exec, 'php', ['-d', 'xdebug.mode=off', phar, ...args], { cwd }, 'wp i18n make-pot')

  if (!fs.existsSync(path.join(cwd, potPath))) {
    throw new Error(`wp i18n make-pot wrote no file at ${potPath}. Check source-path and pot-path. ${WHAT}`)
  }

  const changed = await stringsChanged(exec, cwd, potPath)

  core.info(changed ? `The strings of ${potPath} changed.` : `No string changed since the last ${potPath}.`)
  core.setOutput('pot-path', potPath)
  core.setOutput('changed', changed ? 'yes' : 'no')
}

module.exports = { runGeneratePot, WP_CLI }
