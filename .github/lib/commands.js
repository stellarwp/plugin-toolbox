'use strict'

/**
 * Helpers for running a command through the @actions/exec toolkit that several actions share.
 */

/**
 * The last non-empty line of a command's output, where `pup get-version` prints the version after any
 * PHP notice.
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

/**
 * Runs a command and fails with its output when it exits non-zero.
 *
 * @param {object}   exec    The @actions/exec toolkit.
 * @param {string}   command The program.
 * @param {string[]} args    Its arguments.
 * @param {object}   options Options for @actions/exec.
 * @param {string}   what    What the command does, to open the error message.
 *
 * @throws {Error} When the command exits non-zero, holding what it printed.
 *
 * @returns {Promise<string>} What the command printed to stdout.
 */
async function runOrFail(exec, command, args, options, what) {
  const result = await exec.getExecOutput(command, args, { ...options, ignoreReturnCode: true })

  if (result.exitCode !== 0) {
    const output = [result.stdout, result.stderr].map((text) => text.trim()).filter(Boolean)

    throw new Error(`${what} failed (exit code ${result.exitCode}):\n${output.join('\n')}`)
  }

  return result.stdout
}

module.exports = { lastLine, runOrFail }
