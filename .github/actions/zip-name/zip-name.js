'use strict'

/**
 * Resolves the name of the zip a build will produce, without building it: the version the checkout
 * holds, the pre-release suffix for a QA build, and the slug pup gives the zip.
 *
 * The name is known before the build so a caller can ask the S3 bucket whether that zip already
 * exists and skip the build, which is how the Slack packaging bot works today. release-zip then
 * builds the version this action resolved.
 *
 * runZipName validates the inputs, reads the .puprc, runs pup through the shared lib, and sets the
 * outputs. The functions it is built from are pure, apart from the reads of the checkout and the
 * commands run through `exec`, so a test can pass stand-ins and assert the calls.
 */

const { runOrFail } = require('../../lib/exec.js')
const { readYesNo: readYesNoInput } = require('../../lib/inputs.js')
const { readVersionFiles } = require('../../lib/puprc.js')
const { setupPup, lastLine } = require('../../lib/pup.js')
const { readWorkingDirectory, readCheckoutFile } = require('../../lib/workspace.js')

/** What was not done, to close every error message. */
const WHAT = 'No zip name was resolved.'

/** The pre-release labels a QA build is named with, in the order PHP's version_compare orders them. */
const PRERELEASE_LABELS = ['dev', 'alpha', 'beta', 'rc']

/** A build sequence number: digits from 1, no leading zero. */
const SEQUENCE_PATTERN = /^[1-9]\d*$/

/**
 * The two git commands pup's DevSuffix.php runs for `pup get-version --dev`: the committer
 * timestamp of HEAD and its 8-character hash. The action runs the same two, so a `dev` name is the
 * one pup would give the same commit.
 */
const DEV_SUFFIX_COMMANDS = [
  ['show', '-s', '--format=%ct', 'HEAD'],
  ['rev-parse', '--short=8', 'HEAD'],
]

/**
 * Reads a yes/no input: the shared rule, with this action's closing line.
 *
 * @param {string} value The input value.
 * @param {string} input The input's name, for the message.
 *
 * @throws {Error} When it is neither `yes` nor `no`.
 *
 * @returns {boolean} True for `yes`.
 */
function readYesNo(value, input) {
  return readYesNoInput(value, input, WHAT)
}

/**
 * Reads the `prerelease` input: the label a QA build is named with.
 *
 * @param {string} value The input value. Empty means `dev`, what every QA build was named until now.
 *
 * @throws {Error} When it is not one of the labels.
 *
 * @returns {string} The label.
 */
function readPrerelease(value) {
  const trimmed = String(value ?? '')
    .trim()
    .toLowerCase()

  if (trimmed === '') {
    return 'dev'
  }

  if (!PRERELEASE_LABELS.includes(trimmed)) {
    const accepted = new Intl.ListFormat('en', { type: 'disjunction' }).format(PRERELEASE_LABELS)

    throw new Error(`prerelease '${String(value ?? '').trim()}' is not ${accepted}. ${WHAT}`)
  }

  return trimmed
}

/**
 * Reads the `sequence` input: the number of a build numbered by hand, `rc-2`.
 *
 * @param {string} value The input value. Empty leaves the build to the commit's timestamp and hash.
 *
 * @throws {Error} When it is not digits from 1 without a leading zero.
 *
 * @returns {string|null} The number as given, or null for an empty value.
 */
function readSequence(value) {
  const trimmed = String(value ?? '').trim()

  if (trimmed === '') {
    return null
  }

  if (!SEQUENCE_PATTERN.test(trimmed)) {
    throw new Error(
      `sequence '${trimmed}' is not a build number: pass digits from 1, such as 2, with no leading zero, ` +
        `or leave it empty for the commit's timestamp and hash. ${WHAT}`
    )
  }

  return trimmed
}

/**
 * The suffix a QA build's version carries, hyphens throughout as pup writes them.
 *
 * `dev` with no sequence is `-dev-<timestamp>-<hash>`, the string DevSuffix.php builds, so a default
 * build is named as before. The other labels take its place; a sequence replaces the timestamp and
 * the hash. In PHP's version_compare, `-`, `.` and `_` are the same separator and
 * `dev < alpha < beta < RC < final`, so every suffixed version sorts below the release it precedes.
 *
 * @param {string}      label     The pre-release label.
 * @param {string|null} sequence  The build number, or null.
 * @param {string}      timestamp The committer timestamp of HEAD.
 * @param {string}      hash      The 8-character hash of HEAD.
 *
 * @returns {string} The suffix, hyphen first.
 */
function buildSuffix(label, sequence, timestamp, hash) {
  return sequence === null ? `-${label}-${timestamp}-${hash}` : `-${label}-${sequence}`
}

/** The start of anything that can be a version: two or more numeric parts, such as `4.19`. */
const VERSION_START = /^\d+(\.\d+)+/

/**
 * Reads the version pup printed: its last line, which has to be a version.
 *
 * `pup get-version` prints `unknown` when the regex of the first version file matches nothing, and
 * exits 0; the action fails on it, since a zip named `give.unknown.zip` helps nobody. A regex that
 * matches the wrong thing prints that thing instead, `TBD` or `v4.19.0`, so the line has to start
 * with numeric parts. What follows them is not checked: the regex of `.puprc` defines the version.
 *
 * @param {string} output What pup printed.
 *
 * @throws {Error} When the line is empty, `unknown`, or does not start with two numeric parts.
 *
 * @returns {string} The version.
 */
function readPrintedVersion(output) {
  const version = lastLine(output)

  if (version === '' || version === 'unknown') {
    throw new Error(
      `pup get-version read no version from the first file .puprc lists under paths.versions` +
        `${version === '' ? '' : ` (it printed '${version}')`}. Check the file and its regex. ${WHAT}`
    )
  }

  if (!VERSION_START.test(version)) {
    throw new Error(
      `pup get-version printed '${version}', which is not a version: it has to start with two or more ` +
        `numeric parts, such as 4.19.0. Check the regex of the first file .puprc lists under ` +
        `paths.versions. ${WHAT}`
    )
  }

  return version
}

/**
 * Reads the committer timestamp and the short hash of HEAD, with the commands DevSuffix.php runs.
 *
 * @param {object} exec The @actions/exec toolkit.
 * @param {string} cwd  The checkout.
 *
 * @throws {Error} When git fails: a checkout without a commit, or no checkout at all.
 *
 * @returns {Promise<[string, string]>} The timestamp and the hash.
 */
async function readCommitStamp(exec, cwd) {
  const printed = []
  for (const args of DEV_SUFFIX_COMMANDS) {
    printed.push((await runOrFail(exec, 'git', args, { cwd, silent: true }, `git ${args[0]}`)).trim())
  }

  return [printed[0], printed[1]]
}

/**
 * Validates the inputs, reads the version the checkout holds, builds the suffix and asks pup for
 * the zip name.
 *
 * Every input check and the .puprc read run before pup is downloaded, so a wrong `production`,
 * `prerelease` or `sequence`, a `working-directory` that is not there, or a repository without a
 * usable .puprc, fails with nothing downloaded and nothing run. `expected-version` is checked once
 * the version is read, before the suffix is built.
 *
 * `production` is the master switch: with `yes`, `prerelease` and `sequence` are ignored with a
 * warning, never refused, so a form filled in by habit still produces the clean zip.
 *
 * @param {object}   options
 * @param {object}   options.core      The @actions/core toolkit, for the log and the outputs.
 * @param {object}   options.exec      The @actions/exec toolkit.
 * @param {object}   options.env       The environment the action manifest put its inputs in.
 * @param {string}   options.cwd       The workspace, the process's working directory by default;
 *                                     `working-directory` is resolved against it.
 * @param {Function} options.fetchImpl What `fetch` to use for `latest`; a test passes a stand-in.
 *
 * @throws {Error} When an input is wrong, .puprc is unusable, the pup release cannot be run, pup
 *                 fails, the version is missing or not the expected one, or pup names the zip
 *                 unexpectedly.
 *
 * @returns {Promise<void>} Resolves once the outputs are set.
 */
async function runZipName({ core, exec, env, cwd: workspace = process.cwd(), fetchImpl = globalThis.fetch }) {
  const production = readYesNo(env.INPUT_PRODUCTION, 'production')
  // production is the master switch: a production build ignores prerelease and sequence whatever
  // they hold, so a form filled in by habit, or with a typo, never holds up a production zip. They
  // are read, and refused when wrong, on a QA build only.
  const prerelease = production ? 'dev' : readPrerelease(env.INPUT_PRERELEASE)
  const sequence = production ? null : readSequence(env.INPUT_SEQUENCE)
  const expected = String(env.INPUT_EXPECTED_VERSION ?? '').trim()
  const cwd = readWorkingDirectory(env.INPUT_WORKING_DIRECTORY, { base: workspace, what: WHAT })

  // Only the check: pup reads the files itself. A .puprc pup would read as empty is refused here,
  // before pup is downloaded.
  readVersionFiles(readCheckoutFile(cwd, '.puprc'), WHAT)

  if (production) {
    // The raw values, since they were not read: the warning names what the form carried.
    const rawPrerelease = String(env.INPUT_PRERELEASE ?? '').trim()
    const rawSequence = String(env.INPUT_SEQUENCE ?? '').trim()
    const ignored = [
      rawPrerelease !== '' && rawPrerelease.toLowerCase() !== 'dev' ? `prerelease '${rawPrerelease}'` : null,
      rawSequence !== '' ? `sequence '${rawSequence}'` : null,
    ]
      .filter(Boolean)
      .join(' and ')

    if (ignored !== '') {
      core.warning(
        `production is yes, so ${ignored} ${ignored.includes(' and ') ? 'are' : 'is'} ignored: a production ` +
          'build is the clean <slug>.<version>.zip. Set production to no for a pre-release build.'
      )
    }
  }

  const { pup, release } = await setupPup({ exec, env, core, fetchImpl, what: WHAT })

  const baseVersion = readPrintedVersion(
    await pup(['get-version'], { cwd, silent: true })
  )

  if (expected !== '' && expected !== baseVersion) {
    // core.info prints a plain line: the marker has to open an output line to count, where the
    // release dashboard looks for it.
    core.info(`VERSION_MISMATCH: expected ${expected}, but the version files hold ${baseVersion}.`)
    throw new Error(
      `The version files hold ${baseVersion}, not the expected ${expected}. The ref built is not the ` +
        `one prepared for ${expected}, or the preparation did not run. ${WHAT}`
    )
  }

  let suffix = ''
  if (!production) {
    // A numbered build needs nothing from the commit.
    const [timestamp, hash] = sequence === null ? await readCommitStamp(exec, cwd) : []
    suffix = buildSuffix(prerelease, sequence, timestamp, hash)
  }

  const version = `${baseVersion}${suffix}`
  const zipName = lastLine(await pup(['zip-name', version], { cwd, silent: true }))

  // pup appends `.<version>` to the slug from zip_name or composer.json. Anything else means the
  // name is not what the S3 check and the upload will look for, so it is refused here.
  if (zipName === '' || !zipName.endsWith(`.${version}`)) {
    throw new Error(
      `pup zip-name printed '${zipName}', not a name ending in .${version}. Check zip_name in .puprc, or ` +
        `the name in composer.json. ${WHAT}`
    )
  }

  core.info(`Version ${version}, zip ${zipName}.zip`)
  core.setOutput('base-version', baseVersion)
  core.setOutput('version', version)
  core.setOutput('zip-name', zipName)
  core.setOutput('prerelease', production ? '' : prerelease)
  // The release `latest` resolved to, so release-zip runs the same pup, not a newer one published
  // in between, and reuses the phar.
  core.setOutput('pup-release', release)
}

module.exports = {
  runZipName,
  readYesNo,
  readPrerelease,
  readSequence,
  readPrintedVersion,
  buildSuffix,
  PRERELEASE_LABELS,
  DEV_SUFFIX_COMMANDS,
}
