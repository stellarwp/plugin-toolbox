'use strict'

/**
 * Decides whether a pull request changes files a workflow cares about.
 *
 * decide is pure, so a test covers every branch of the decision. run reads the environment the
 * action manifest built, lists the pull request's files through the API and sets the `changed`
 * output.
 */

const { globToRegExp } = require('../../lib/glob.js')
const { lines } = require('../../lib/inputs.js')

/** The API stops listing a pull request's files at this many. */
const FILES_API_LIMIT = 3000

/**
 * Applies the rules to one event.
 *
 * @param {object}   options
 * @param {string}   options.eventName         The event that started the run.
 * @param {string[]} options.globs             The `changed-files` globs. None means always run.
 * @param {number}   options.changedCount      How many files the pull request changes.
 * @param {string}   options.caller            Path of the caller workflow file in its repository.
 * @param {Function} options.listFiles         Resolves to every file name the pull request touches,
 *                                             old names of renamed files included.
 *
 * @returns {Promise<{changed: boolean, reason: string}>} The decision and the line to log for it.
 */
async function decide({ eventName, globs, changedCount, caller, listFiles }) {
  if (eventName !== 'pull_request') {
    return { changed: true, reason: '' }
  }

  if (globs.length === 0) {
    return { changed: true, reason: '' }
  }

  // A bigger pull request cannot be judged from a list that stops short.
  if (changedCount >= FILES_API_LIMIT) {
    return {
      changed: true,
      reason: `The pull request changes ${changedCount} files, more than the files API lists, so it counts as changed.`,
    }
  }

  const patterns = globs.map(globToRegExp)

  for (const file of await listFiles()) {
    if (file === caller) {
      return { changed: true, reason: `Matched: ${file} (the workflow itself)` }
    }

    if (patterns.some((pattern) => pattern.test(file))) {
      return { changed: true, reason: `Matched: ${file}` }
    }
  }

  return { changed: false, reason: 'No matching files changed, so nothing counts as changed.' }
}

/**
 * Reads the environment, decides and writes the `run` output.
 *
 * @param {object} github An Octokit, as actions/github-script supplies it.
 * @param {object} core   The @actions/core toolkit, for the log and the output.
 * @param {object} env    The environment the action manifest put its inputs in.
 *
 * @returns {Promise<void>} Resolves once the output is set.
 */
async function run({ github, core, env }) {
  const [owner, repo] = env.REPOSITORY.split('/')

  // In a called workflow this is the caller's file, whatever it is named.
  const caller = (env.WORKFLOW_REF ?? '').replace(`${env.REPOSITORY}/`, '').replace(/@.*$/, '')

  const { changed, reason } = await decide({
    eventName: env.EVENT_NAME,
    globs: lines(env.INPUT_CHANGED_FILES),
    changedCount: Number(env.PR_CHANGED_FILES || 0),
    caller,
    listFiles: async () => {
      const files = await github.paginate(github.rest.pulls.listFiles, {
        owner,
        repo,
        pull_number: Number(env.PR_NUMBER),
        per_page: 100,
      })

      return files.flatMap((file) => [file.filename, file.previous_filename].filter(Boolean))
    },
  })

  if (reason) {
    if (changed) {
      core.info(reason)
    } else {
      core.notice(reason, { title: 'Changed files' })
    }
  }

  core.setOutput('changed', String(changed))
}

module.exports = { run, decide, FILES_API_LIMIT }
