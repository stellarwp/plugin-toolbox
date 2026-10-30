'use strict'

/**
 * Running commands through @actions/exec, shared by the toolbox actions. Loaded by a path relative to
 * each action's directory, like versions.js.
 */

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

module.exports = { runOrFail }
