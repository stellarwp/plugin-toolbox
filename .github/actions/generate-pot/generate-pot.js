'use strict'

/**
 * Generates a plugin's POT file with `wp i18n make-pot`, and says whether its strings changed.
 *
 * runGeneratePot validates the inputs, downloads a pinned wp-cli phar into the runner's temp
 * directory and checks its sha512, runs make-pot on the runner's PHP, then compares the POT with
 * the one git tracks. The commands run through `exec`, so a test can pass stand-ins and assert the
 * calls.
 */

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { runOrFail } = require('../../lib/exec.js')
const { downloadPhar } = require('../../lib/phar.js')
const { readPluginHeader } = require('../../lib/plugin-header.js')
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
 * The header fields make-pot stamps on every run: the time, the plugin version and its own version.
 * A POT that differs in these only holds the same strings.
 */
const STAMPED_HEADERS = ['POT-Creation-Date', 'Project-Id-Version', 'X-Generator']

/**
 * The comment lines that change without a string changing: the `# Copyright (C) <year>` line of the
 * header entry, and the `#:` references, which name a file and line of each string.
 */
const COPYRIGHT = '# Copyright '
const REFERENCE = '#:'

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
 * Where the POT goes when `pot-path` is empty: `<Domain Path>/<Text Domain>.pot` under `source-path`,
 * read from the plugin's main file at the top of `source-path`. The `domain` input stands in for the
 * `Text Domain` header.
 *
 * @param {string} cwd        The checkout.
 * @param {string} sourcePath The `source-path` input.
 * @param {string} domain     The `domain` input; empty reads the `Text Domain` header.
 *
 * @throws {Error} When there is no plugin file, or it has no `Domain Path`, or no `Text Domain` and
 *                 the `domain` input is empty.
 *
 * @returns {string} The path, relative to the checkout.
 */
function defaultPotPath(cwd, sourcePath, domain) {
  const header = readPluginHeader(path.resolve(cwd, sourcePath))

  if (header === null) {
    throw new Error(
      `pot-path is empty and no PHP file at the top of '${sourcePath}' has a Plugin Name header to read the ` +
        `Text Domain and Domain Path from. Pass pot-path, such as lang/my-plugin.pot. ${WHAT}`
    )
  }

  const textDomain = domain || header.textDomain
  if (textDomain === null) {
    throw new Error(`pot-path is empty and ${header.file} has no Text Domain header. Pass domain or pot-path. ${WHAT}`)
  }
  if (header.domainPath === null) {
    throw new Error(`pot-path is empty and ${header.file} has no Domain Path header. Pass pot-path. ${WHAT}`)
  }

  return path.posix.join(sourcePath.split(path.sep).join('/'), header.domainPath, `${textDomain}.pot`)
}

/**
 * Reads the `pot-path` input: where the POT is written, relative to the checkout. Empty takes the
 * path from the plugin header.
 *
 * @param {string} value      The input value.
 * @param {string} cwd        The checkout.
 * @param {string} sourcePath The `source-path` input.
 * @param {string} domain     The `domain` input.
 *
 * @throws {Error} When it is empty and the plugin header does not give a path, or the path is
 *                 absolute or leads outside the checkout.
 *
 * @returns {string} The path: the input as given, or the one read from the plugin header.
 */
function readPotPath(value, cwd, sourcePath, domain) {
  const trimmed = String(value ?? '').trim() || defaultPotPath(cwd, sourcePath, domain)

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
 * Makes a checkout path relative to the scanned directory: make-pot matches `--exclude` against
 * paths relative to `source-path`. A line without a `/` other than a trailing one, or one whose
 * first part holds a `*`, such as a leading `**`, is kept as it is. Any other line is read as a path
 * from the checkout root and made relative to the scanned directory.
 *
 * make-pot drops a leading `/` and matches an exclusion at any depth, so the result is not anchored
 * either: `admin` also leaves out `modules/admin`. There is no `--exclude` form that matches only at
 * the top of the scanned directory.
 *
 * @param {string}  line     The `.distignore` line or submodule path.
 * @param {string}  base     The scanned directory, relative to the checkout; empty for the checkout.
 * @param {boolean} anchored True for a submodule path, which is always from the checkout root.
 *
 * @returns {string|null} The exclusion, or null for a path outside the scanned directory.
 */
function rebaseExclude(line, base, anchored) {
  const trimmed = line.replace(/^\/+|\/+$/g, '')

  const anyDepth = !line.startsWith('/') && (!trimmed.includes('/') || trimmed.split('/')[0].includes('*'))

  if (base === '' || (!anchored && anyDepth)) {
    return line
  }

  return trimmed.startsWith(`${base}/`) ? trimmed.slice(base.length + 1) : null
}

/**
 * The paths `.gitattributes` marks `export-ignore`, which a zip leaves out like the `.distignore`
 * lines. A line that unsets the attribute, `-export-ignore` or `!export-ignore`, is skipped.
 *
 * @param {string|null} text The contents of `.gitattributes`.
 *
 * @returns {string[]} The paths, as written.
 */
function readExportIgnores(text) {
  return readLines(text)
    .map((line) => line.split(/\s+/))
    .filter(([, ...attributes]) => attributes.includes('export-ignore'))
    .map(([pattern]) => pattern)
}

/**
 * What make-pot leaves out: the `.distignore` lines, the `export-ignore` paths of `.gitattributes`,
 * the git submodule paths and the `exclude` input, in that order, each once. The first three are
 * paths from the checkout, made relative to `source-path`; the ones outside it are dropped. The
 * `exclude` input is passed as given.
 *
 * A submodule has its own text domain and its own POT, and a checkout with submodules would fold
 * its strings in.
 *
 * @param {string} cwd        The checkout.
 * @param {string} sourcePath The `source-path` input.
 * @param {string} extra      The `exclude` input.
 *
 * @returns {string[]} The exclusions.
 */
function readExcludes(cwd, sourcePath, extra) {
  const base = path.relative(cwd, path.resolve(cwd, sourcePath)).split(path.sep).join('/')
  const submodules = [...(readCheckoutFile(cwd, '.gitmodules') ?? '').matchAll(/^\s*path\s*=\s*(.+?)\s*$/gm)].map(
    (match) => rebaseExclude(match[1], base, true)
  )
  const distignore = [
    ...readLines(readCheckoutFile(cwd, '.distignore')),
    ...readExportIgnores(readCheckoutFile(cwd, '.gitattributes')),
  ].map((line) => rebaseExclude(line, base, false))

  return [...new Set([...distignore, ...submodules, ...readLines(extra)].filter((exclude) => exclude !== null))]
}

/**
 * Puts the pinned wp-cli phar in the runner's temp directory, so it never ends up in the checkout,
 * and checks its sha512. A phar an earlier step of the job downloaded is reused, and checked again.
 * A failed download or a wrong checksum leaves no file behind.
 *
 * @param {object} options
 * @param {object} options.core  The @actions/core toolkit, to say when the phar is reused.
 * @param {object} options.exec  The @actions/exec toolkit.
 * @param {object} options.env   The step environment, for RUNNER_TEMP.
 * @param {object} options.wpCli The release and its checksum.
 *
 * @throws {Error} When the download fails or the checksum does not match.
 *
 * @returns {Promise<string>} The path of the phar.
 */
function setupWpCli({ core, exec, env, wpCli }) {
  const { version, sha512 } = wpCli

  return downloadPhar({
    exec,
    phar: path.join(env.RUNNER_TEMP || os.tmpdir(), `wp-cli-${version}.phar`),
    url: `https://github.com/wp-cli/wp-cli/releases/download/v${version}/wp-cli-${version}.phar`,
    label: `wp-cli ${version}`,
    sha512,
    what: WHAT,
    core,
  })
}

/**
 * A POT without the lines that change when no string does: the stamped header fields and the
 * Copyright line, read from the header entry only, the first block before a blank line, so a
 * translation entry that holds a header name keeps it; and the `#:` references of every entry.
 *
 * @param {string} pot The POT's contents.
 *
 * @returns {string} The contents without those lines.
 */
function withoutStampedLines(pot) {
  const normalized = pot.replace(/\r\n/g, '\n')
  const end = normalized.indexOf('\n\n')
  const header = end === -1 ? normalized : normalized.slice(0, end)
  const kept = header
    .split('\n')
    .filter((line) => !line.startsWith(COPYRIGHT) && !STAMPED_HEADERS.some((field) => line.startsWith(`"${field}:`)))

  return [...kept, ...normalized.slice(header.length).split('\n')]
    .filter((line) => !line.startsWith(REFERENCE))
    .join('\n')
}

/**
 * Whether the POT's strings changed, against the file git tracks. A tracked POT that differs in
 * the stamped header fields, the Copyright line and the `#:` references only is put back as it was,
 * so a second run leaves nothing to commit.
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

  const before = await runOrFail(exec, 'git', ['show', `:./${potPath}`], options, 'git show')
  const after = fs.readFileSync(path.join(cwd, potPath), 'utf8')

  if (withoutStampedLines(before) !== withoutStampedLines(after)) {
    return true
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
  const sourcePath = String(env.INPUT_SOURCE_PATH ?? '').trim() || '.'
  const domain = String(env.INPUT_DOMAIN ?? '').trim()
  const potPath = readPotPath(env.INPUT_POT_PATH, cwd, sourcePath, domain)
  const headers = readHeaders(env.INPUT_HEADERS)
  const excludes = readExcludes(cwd, sourcePath, env.INPUT_EXCLUDE)

  const phar = await setupWpCli({ core, exec, env, wpCli })

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
