'use strict'

/**
 * Decides whether a pull request has to run PHPStan.
 *
 * globToRegExp and decide are pure, so a test covers every branch of the decision. run reads the
 * environment the action manifest built, lists the pull request's files through the API and sets
 * the `run` output.
 */

/** The API stops listing a pull request's files at this many. */
const FILES_API_LIMIT = 3000

/**
 * Splits a multi-line input into its entries.
 *
 * @param {string} value Entries separated by whitespace.
 *
 * @returns {string[]} The entries, in the order given.
 */
function words(value) {
  return String(value ?? '')
    .split(/\s+/)
    .filter(Boolean)
}

/**
 * Turns a shell-style glob into a RegExp. `*` matches anything, `/` included, `?` one character and
 * `[...]` a set, which is what bash's `[[ $file == $glob ]]` does.
 *
 * @param {string} glob The glob.
 *
 * @returns {RegExp} A RegExp that matches the whole path.
 */
function globToRegExp(glob) {
  let source = ''

  for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index]

    if (char === '*') {
      source += '.*'
    } else if (char === '?') {
      source += '.'
    } else if (char === '[') {
      const close = glob.indexOf(']', index + 2)

      if (close === -1) {
        source += '\\['
      } else {
        const set = glob.slice(index + 1, close).replace(/^!/, '^').replace(/\\/g, '\\\\')
        source += `[${set}]`
        index = close
      }
    } else {
      source += char.replace(/[.+^${}()|\\\]]/g, '\\$&')
    }
  }

  return new RegExp(`^${source}$`, 's')
}

/**
 * Applies the rules to one event.
 *
 * @param {object}   options
 * @param {string}   options.eventName         The event that started the run.
 * @param {boolean}  options.draft             Whether the pull request is a draft.
 * @param {string}   options.headRef           The pull request's branch.
 * @param {string[]} options.skipDraftPrefixes Branch prefixes whose drafts skip the analysis.
 * @param {string[]} options.globs             The `changed-files` globs. None means always run.
 * @param {number}   options.changedCount      How many files the pull request changes.
 * @param {string}   options.caller            Path of the caller workflow file in its repository.
 * @param {Function} options.listFiles         Resolves to every file name the pull request touches,
 *                                             old names of renamed files included.
 *
 * @returns {Promise<{run: boolean, reason: string}>} The decision and the line to log for it.
 */
async function decide({ eventName, draft, headRef, skipDraftPrefixes, globs, changedCount, caller, listFiles }) {
  if (eventName !== 'pull_request') {
    return { run: true, reason: '' }
  }

  if (draft) {
    const prefix = skipDraftPrefixes.find((candidate) => headRef.startsWith(candidate))

    if (prefix !== undefined) {
      return { run: false, reason: `Draft pulls from ${prefix}* do not run until they are ready.` }
    }
  }

  if (globs.length === 0) {
    return { run: true, reason: '' }
  }

  // A bigger pull request cannot be judged from a list that stops short.
  if (changedCount >= FILES_API_LIMIT) {
    return {
      run: true,
      reason: `The pull request changes ${changedCount} files, more than the files API lists, so PHPStan runs.`,
    }
  }

  const patterns = globs.map(globToRegExp)

  for (const file of await listFiles()) {
    if (file === caller) {
      return { run: true, reason: `Matched: ${file} (the workflow itself)` }
    }

    if (patterns.some((pattern) => pattern.test(file))) {
      return { run: true, reason: `Matched: ${file}` }
    }
  }

  return { run: false, reason: 'No matching files changed, so PHPStan did not run.' }
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

  const { run: shouldRun, reason } = await decide({
    eventName: env.EVENT_NAME,
    draft: env.DRAFT === 'true',
    headRef: env.HEAD_REF ?? '',
    skipDraftPrefixes: words(env.INPUT_SKIP_DRAFT_PREFIXES),
    globs: words(env.INPUT_CHANGED_FILES),
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
    if (shouldRun) {
      core.info(reason)
    } else {
      core.notice(reason, { title: 'PHPStan' })
    }
  }

  core.setOutput('run', String(shouldRun))
}

module.exports = { run, decide, globToRegExp, words, FILES_API_LIMIT }
