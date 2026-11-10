'use strict'

/**
 * Reading action inputs that several actions share. Loaded by a path relative to each action's
 * directory, like versions.js.
 */

/**
 * Reads a yes/no input.
 *
 * A caller workflow declares these as a `choice` of yes/no rather than a boolean: the packaging bot
 * only sends `yes` and `no` for choice inputs, and a boolean input would make it send `true`. The
 * action checks the value itself, so a dispatch by hand or by a tool gets the same refusal.
 *
 * @param {string} value The input value.
 * @param {string} input The input's name, for the message.
 * @param {string} what  What was not done, to close the message.
 *
 * @throws {Error} When it is neither `yes` nor `no`.
 *
 * @returns {boolean} True for `yes`.
 */
function readYesNo(value, input, what) {
  const trimmed = String(value ?? '')
    .trim()
    .toLowerCase()

  if (trimmed !== 'yes' && trimmed !== 'no') {
    throw new Error(`${input} '${String(value ?? '').trim()}' is not yes or no. ${what}`)
  }

  return trimmed === 'yes'
}

module.exports = { readYesNo }
