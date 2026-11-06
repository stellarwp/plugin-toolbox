'use strict'

/**
 * Builds and packages a version of the plugin with pup: `pup build`, `pup check`, `pup i18n`, then
 * `pup package <version>`, from the root of the checkout. The version is the one zip-name resolved,
 * suffix included: pup writes it into the version files inside the zip and leaves the checkout as
 * it was.
 *
 * runZip validates the inputs, reads the .puprc, runs pup through the shared lib and sets the
 * outputs. The functions it is built from are pure, apart from the reads of the checkout and the
 * commands run through `exec`, so a test can pass stand-ins and assert the calls.
 */

const fs = require('node:fs')
const path = require('node:path')

const { runOrFail } = require('../../lib/exec.js')
const { readYesNo: readYesNoInput } = require('../../lib/inputs.js')
const { readVersionFiles } = require('../../lib/puprc.js')
const { setupPup, lastLine } = require('../../lib/pup.js')
const { readWorkingDirectory, readCheckoutFile } = require('../../lib/workspace.js')

/** What was not done, to close every error message. */
const WHAT = 'No zip was built.'

/**
 * Reads the version to build, refusing an empty one.
 *
 * @param {string} version The `version` input.
 *
 * @throws {Error} When it is empty.
 *
 * @returns {string} The version, without surrounding whitespace.
 */
function readVersion(version) {
  const trimmed = String(version ?? '').trim()

  if (trimmed === '') {
    throw new Error(
      `No version was given: pass the version the zip carries, the \`version\` output of zip-name. ${WHAT}`
    )
  }

  return trimmed
}

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
 * Reads the commands to run after `pup build`: the text as given, or nothing when it is blank.
 *
 * @param {string} value The `after-build` input.
 *
 * @returns {string} The commands, or an empty string when there are none.
 */
function readAfterBuild(value) {
  return String(value ?? '').trim() === '' ? '' : String(value)
}

/**
 * Runs the after-build commands in the checkout, the way a `run:` step would: bash with `-e` and
 * `pipefail`, so the first command that fails fails the step, and with the step's environment.
 *
 * @param {object} exec     The @actions/exec toolkit.
 * @param {string} commands The shell script.
 * @param {string} cwd      The checkout.
 *
 * @throws {Error} When the script exits non-zero, holding what it printed.
 *
 * @returns {Promise<string>} What the script printed to stdout.
 */
function runAfterBuild(exec, commands, cwd) {
  return runOrFail(exec, 'bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', commands], { cwd }, 'The after-build commands')
}

/**
 * The pup commands a build runs, in order.
 *
 * `pup check` runs strict on a production build, so a `TBD` left behind or a version conflict fails
 * it, and with `--dev` on a QA build, where the same findings are warnings: the mode pup gives each
 * check's `fail_method_dev`. `pup i18n` downloads the finished translations; `pup package` writes
 * the version into the files `.puprc` lists, syncs the files `.distignore` or `.distfiles` keep into
 * `.pup-zip`, zips them and restores the files.
 *
 * @param {object}  options
 * @param {string}  options.version    The version to package.
 * @param {boolean} options.production Whether `pup check` runs strict.
 * @param {boolean} options.check      Whether `pup check` runs at all.
 * @param {boolean} options.i18n       Whether `pup i18n` runs.
 *
 * @returns {string[][]} The arguments of each pup command.
 */
function pupCommands({ version, production, check, i18n }) {
  const commands = [['build']]

  if (check) {
    commands.push(production ? ['check'] : ['check', '--dev'])
  }
  if (i18n) {
    commands.push(['i18n'])
  }
  commands.push(['package', version])

  return commands
}

/**
 * Validates the inputs, then builds and packages the version with pup.
 *
 * Every input check and the .puprc read run before pup is downloaded. The `after-build` commands,
 * when there are any, run between `pup build` and the commands that follow it, so a file they
 * write (a POT generated from the built assets, say) is checked and packaged. A pup command or the
 * after-build script that fails fails the step with its output, and nothing after it runs.
 * `COMPOSER_AUTH`, when the caller's step sets it, reaches the build commands through the
 * environment, as every variable does.
 *
 * @param {object}   options
 * @param {object}   options.core      The @actions/core toolkit, for the log and the outputs.
 * @param {object}   options.exec      The @actions/exec toolkit.
 * @param {object}   options.env       The environment the action manifest put its inputs in.
 * @param {string}   options.cwd       The workspace, the process's working directory by default;
 *                                     `working-directory` is resolved against it.
 * @param {Function} options.fetchImpl What `fetch` to use for `latest`; a test passes a stand-in.
 *
 * @throws {Error} When an input is wrong, .puprc is unusable, the pup release cannot be run, a pup
 *                 command fails, or the zip pup reported is not in the checkout.
 *
 * @returns {Promise<void>} Resolves once the zip exists and the outputs are set.
 */
async function runZip({ core, exec, env, cwd: workspace = process.cwd(), fetchImpl = globalThis.fetch }) {
  const version = readVersion(env.INPUT_VERSION)
  const production = readYesNo(env.INPUT_PRODUCTION, 'production')
  const check = readYesNo(env.INPUT_CHECK, 'check')
  const i18n = readYesNo(env.INPUT_I18N, 'i18n')
  const afterBuild = readAfterBuild(env.INPUT_AFTER_BUILD)
  const cwd = readWorkingDirectory(env.INPUT_WORKING_DIRECTORY, { base: workspace, what: WHAT })

  // Only the check: pup reads the files itself. A .puprc pup would read as empty is refused here,
  // before pup is downloaded.
  readVersionFiles(readCheckoutFile(cwd, '.puprc'), WHAT)

  const { pup } = await setupPup({ exec, env, core, fetchImpl, what: WHAT })

  const [build, ...rest] = pupCommands({ version, production, check, i18n })

  await pup(build, { cwd })
  if (afterBuild !== '') {
    await runAfterBuild(exec, afterBuild, cwd)
  }
  for (const args of rest) {
    await pup(args, { cwd })
  }

  // The name pup gave the zip, from the same rules package used, rather than a guess from here.
  const zipName = lastLine(await pup(['zip-name', version], { cwd, silent: true, noticesToStderr: true }))
  const zipPath = path.join(cwd, `${zipName}.zip`)

  if (zipName === '' || !fs.existsSync(zipPath)) {
    throw new Error(
      `pup package finished but ${zipName === '' ? 'pup zip-name printed no name' : `${zipName}.zip is not in the checkout`}. ` +
        `Check zip_name in .puprc, or the name in composer.json. ${WHAT}`
    )
  }

  core.info(`Built ${zipName}.zip`)
  core.setOutput('zip-name', zipName)
  core.setOutput('zip-path', zipPath)
}

module.exports = { runZip, readVersion, readYesNo, readAfterBuild, pupCommands }
