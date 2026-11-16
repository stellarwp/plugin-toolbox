'use strict'

/**
 * Decides whether a run is a draft pull request to skip.
 *
 * decide is pure, so a test covers every branch. run reads the environment the action manifest built
 * and sets the `skip` output.
 */

const { words } = require('../../lib/inputs.js')

/**
 * Applies the rule to one event.
 *
 * @param {object}   options
 * @param {string}   options.eventName The event that started the run.
 * @param {boolean}  options.draft     Whether the pull request is a draft.
 * @param {string}   options.headRef   The pull request's branch.
 * @param {string[]} options.prefixes  Branch prefixes whose drafts are skipped.
 *
 * @returns {{skip: boolean, reason: string}} The decision and the line to log for it.
 */
function decide({ eventName, draft, headRef, prefixes }) {
  if (eventName !== 'pull_request' || !draft) {
    return { skip: false, reason: '' }
  }

  const prefix = prefixes.find((candidate) => headRef.startsWith(candidate))

  if (prefix === undefined) {
    return { skip: false, reason: '' }
  }

  return { skip: true, reason: `Draft pulls from ${prefix}* wait until they are ready.` }
}

/**
 * Reads the environment, decides and writes the `skip` output.
 *
 * @param {object} core The @actions/core toolkit, for the log and the output.
 * @param {object} env  The environment the action manifest put its inputs in.
 *
 * @returns {void}
 */
function run({ core, env }) {
  const { skip, reason } = decide({
    eventName: env.EVENT_NAME,
    draft: env.DRAFT === 'true',
    headRef: env.HEAD_REF ?? '',
    prefixes: words(env.INPUT_PREFIXES),
  })

  if (reason) {
    core.notice(reason, { title: 'Skipped draft' })
  }

  core.setOutput('skip', String(skip))
}

module.exports = { run, decide }
