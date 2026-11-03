'use strict'

/**
 * Finds, creates, updates and deletes the comments of a pull request or an issue.
 *
 * A comment that a workflow keeps up to date is found by a hidden marker: its first line, such as
 * `<!-- my-check:example-org/my-plugin -->`. Every function takes an Octokit, so another action's
 * script can require this file and pass the client github-script gave it, and a test can pass a
 * real Octokit with the network replaced.
 *
 * run() is the entry point this action's manifest calls.
 */

const fs = require('node:fs')

/** GitHub refuses a comment body longer than this. */
const MAX_COMMENT_LENGTH = 65536

const OPERATIONS = ['upsert', 'create', 'update', 'delete', 'find']

/**
 * Checks a marker before it is used to pick a comment.
 *
 * An empty marker would match every comment, so an update or a delete could hit a comment a person
 * wrote. A marker with a line break could never be the first line.
 *
 * @param {string} marker The hidden first line.
 *
 * @throws {Error} When it is empty or holds a line break.
 *
 * @returns {string} The marker, as given.
 */
function checkMarker(marker) {
  const value = String(marker ?? '')

  if (value.trim() === '') {
    throw new Error('The marker is empty. It would match every comment, so nothing is changed.')
  }

  if (/[\r\n]/.test(value)) {
    throw new Error('The marker holds a line break. It has to fit on the first line of the comment.')
  }

  return value
}

/**
 * Puts the marker on the first line, unless the body already starts with it.
 *
 * @param {string} body   The comment text.
 * @param {string} marker The hidden first line, or empty for none.
 *
 * @returns {string} The body the next search will find.
 */
function withMarker(body, marker) {
  return marker && !body.startsWith(marker) ? `${marker}\n${body}` : body
}

/**
 * Checks a body before it is sent, so a mistake fails here and not as a 422 from the API.
 *
 * @param {string} body The comment text.
 *
 * @throws {Error} When it is blank or longer than GitHub accepts.
 *
 * @returns {string} The body.
 */
function checkBody(body) {
  if (String(body ?? '').trim() === '') {
    throw new Error('The comment body is empty. GitHub refuses an empty comment.')
  }

  if (body.length > MAX_COMMENT_LENGTH) {
    throw new Error(`The comment would be ${body.length} characters, and GitHub takes at most ${MAX_COMMENT_LENGTH}.`)
  }

  return body
}

/**
 * The text to send: the body with the marker on its first line, checked.
 *
 * @param {string} body   The comment text.
 * @param {string} marker The hidden first line, or empty for none.
 *
 * @throws {Error} When the marker or the body is not valid.
 *
 * @returns {string} The text to send.
 */
function prepareBody(body, marker) {
  const first = String(marker ?? '') === '' ? '' : checkMarker(marker)

  // The blank check looks at the body alone: with the marker in front, an empty body would pass and
  // post a comment that holds nothing but the marker.
  checkBody(body)

  return checkBody(withMarker(String(body), first))
}

/**
 * Reads the comment text from the string input or from the file input.
 *
 * @param {object} options
 * @param {string} options.body     The `body` input.
 * @param {string} options.bodyFile The `body-file` input.
 *
 * @throws {Error} When both or neither are given, or the file cannot be read.
 *
 * @returns {string} The comment text.
 */
function readBody({ body, bodyFile }) {
  const hasBody = String(body ?? '') !== ''
  const hasFile = String(bodyFile ?? '') !== ''

  if (hasBody && hasFile) {
    throw new Error('Give the comment as `body` or as `body-file`, not both.')
  }

  if (!hasBody && !hasFile) {
    throw new Error('There is no comment text. Give `body` or `body-file`.')
  }

  if (hasBody) {
    return String(body)
  }

  try {
    return fs.readFileSync(bodyFile, 'utf8')
  } catch (error) {
    throw new Error(`Could not read the comment text from '${bodyFile}': ${error.message}`)
  }
}

/**
 * Finds the first comment whose body starts with the marker.
 *
 * Found by its first line only, not by author, so it is still found when the caller passes a token
 * other than the workflow's own. Pages are read until one has a match, so a long pull request
 * costs only the pages up to the comment.
 *
 * @param {object} options
 * @param {object} options.github An Octokit.
 * @param {string} options.owner  Repository owner.
 * @param {string} options.repo   Repository name.
 * @param {number} options.issue  Pull request or issue number.
 * @param {string} options.marker The first line to look for.
 *
 * @throws {Error} When the marker is empty, or the API call fails.
 *
 * @returns {Promise<object|null>} The comment as the API returns it, or null.
 */
async function findComment({ github, owner, repo, issue, marker }) {
  checkMarker(marker)

  const pages = github.paginate.iterator(github.rest.issues.listComments, {
    owner,
    repo,
    issue_number: issue,
    per_page: 100,
  })

  for await (const { data } of pages) {
    const found = data.find((comment) => typeof comment.body === 'string' && comment.body.startsWith(marker))

    if (found) {
      return found
    }
  }

  return null
}

/**
 * Adds a comment.
 *
 * @param {object} options
 * @param {object} options.github An Octokit.
 * @param {string} options.owner  Repository owner.
 * @param {string} options.repo   Repository name.
 * @param {number} options.issue  Pull request or issue number.
 * @param {string} options.body   The comment text.
 * @param {string} options.marker The hidden first line to write when the body lacks it, or empty.
 *
 * @throws {Error} On a bad marker or body, or a failed API call.
 *
 * @returns {Promise<{id: number, url: string}>} The new comment.
 */
async function createComment({ github, owner, repo, issue, body, marker = '' }) {
  const { data } = await github.rest.issues.createComment({
    owner,
    repo,
    issue_number: issue,
    body: prepareBody(body, marker),
  })

  return { id: data.id, url: data.html_url }
}

/**
 * Replaces the text of a comment.
 *
 * @param {object} options
 * @param {object} options.github An Octokit.
 * @param {string} options.owner  Repository owner.
 * @param {string} options.repo   Repository name.
 * @param {number} options.id     The comment.
 * @param {string} options.body   The new text.
 * @param {string} options.marker The hidden first line to write when the body lacks it, or empty.
 *
 * @throws {Error} On a bad marker or body, or a failed API call.
 *
 * @returns {Promise<{id: number, url: string}>} The comment.
 */
async function updateComment({ github, owner, repo, id, body, marker = '' }) {
  const { data } = await github.rest.issues.updateComment({
    owner,
    repo,
    comment_id: id,
    body: prepareBody(body, marker),
  })

  return { id: data.id, url: data.html_url }
}

/**
 * Replaces the comment that starts with the marker, or creates one.
 *
 * @param {object} options
 * @param {object} options.github An Octokit.
 * @param {string} options.owner  Repository owner.
 * @param {string} options.repo   Repository name.
 * @param {number} options.issue  Pull request or issue number.
 * @param {string} options.marker The first line to look for, and to write.
 * @param {string} options.body   The new body.
 *
 * @throws {Error} On a bad marker or body, or a failed API call.
 *
 * @returns {Promise<{id: number, url: string, created: boolean}>} The comment, and whether it is new.
 */
async function upsertComment({ github, owner, repo, issue, marker, body }) {
  checkMarker(marker)
  // Checked before the search, so a bad body costs no request.
  prepareBody(body, marker)

  const existing = await findComment({ github, owner, repo, issue, marker })

  if (existing) {
    return { ...(await updateComment({ github, owner, repo, id: existing.id, body, marker })), created: false }
  }

  return { ...(await createComment({ github, owner, repo, issue, body, marker })), created: true }
}

/**
 * Deletes a comment. A comment that is already gone is not an error, so a repeated run succeeds.
 *
 * @param {object} options
 * @param {object} options.github An Octokit.
 * @param {string} options.owner  Repository owner.
 * @param {string} options.repo   Repository name.
 * @param {number} options.id     The comment.
 *
 * @throws {Error} When the API call fails with anything but a 404.
 *
 * @returns {Promise<{deleted: boolean}>} Whether a comment was deleted.
 */
async function deleteComment({ github, owner, repo, id }) {
  try {
    await github.rest.issues.deleteComment({ owner, repo, comment_id: id })
  } catch (error) {
    if (error.status !== 404) {
      throw error
    }

    return { deleted: false }
  }

  return { deleted: true }
}

/**
 * Reads an input that has to be a whole number above zero, or is empty.
 *
 * @param {string} name  The input's name, for the message.
 * @param {string} value The input's value.
 *
 * @throws {Error} When it is set but is not a whole number above zero.
 *
 * @returns {number|null} The number, or null when the input is empty.
 */
function readNumber(name, value) {
  const text = String(value ?? '').trim()

  if (text === '') {
    return null
  }

  if (!/^[0-9]{1,15}$/.test(text) || Number(text) === 0) {
    throw new Error(`\`${name}\` must be a whole number above zero, not '${text}'.`)
  }

  return Number(text)
}

/**
 * Says what a 403 means here, and keeps GitHub's own words at the end.
 *
 * @param {Error}  error  What the API call threw.
 * @param {string} target What was being written, for the message.
 *
 * @returns {Error} A clearer error for a 403, the same error for anything else.
 */
function explain(error, target) {
  // Only a refused write. A 403 on the read that lists comments is a missing read permission or a
  // rate limit, and "cannot write" would send the reader the wrong way.
  if (error.status !== 403 || !['POST', 'PATCH', 'DELETE'].includes(error.request?.method)) {
    return error
  }

  return new Error(
    `The token cannot write comments on ${target}. On a pull request from a fork the token is ` +
      'read-only: grant `pull-requests: write` (or `issues: write` for an issue), or skip this step ' +
      `for forks. GitHub said: ${error.message}`
  )
}

/**
 * Does the operation the inputs name and writes the action's outputs.
 *
 * @param {object} github An Octokit, as actions/github-script supplies it.
 * @param {object} core   The @actions/core toolkit, for the log and the outputs.
 * @param {object} env    The environment the action manifest put its inputs in.
 *
 * @throws {Error} On a bad input, or a failed API call.
 *
 * @returns {Promise<void>} Resolves once the outputs are set.
 */
async function run({ github, core, env }) {
  const operation = String(env.INPUT_OPERATION ?? '').trim() || 'upsert'

  if (!OPERATIONS.includes(operation)) {
    throw new Error(`Unknown operation '${operation}'. Use ${OPERATIONS.join(', ')}.`)
  }

  const [owner, repo] = String(env.INPUT_REPOSITORY || env.GITHUB_REPOSITORY || '').split('/')
  const marker = String(env.INPUT_MARKER ?? '')
  const issue = readNumber('issue-number', env.INPUT_ISSUE_NUMBER)
  const commentId = readNumber('comment-id', env.INPUT_COMMENT_ID)
  const target = issue ? `#${issue}` : `comment ${commentId}`

  // The comment to act on, found by its marker unless the caller gave its id.
  const locate = async () => {
    if (commentId) {
      return { id: commentId }
    }

    if (!issue) {
      throw new Error('No pull request or issue number. Pass `issue-number`, or run on a `pull_request` event.')
    }

    return findComment({ github, owner, repo, issue, marker })
  }

  const needIssue = () => {
    if (!issue) {
      throw new Error('No pull request or issue number. Pass `issue-number`, or run on a `pull_request` event.')
    }
  }

  const done = (result, comment) => {
    // Not `result`: actions/github-script sets an output of that name itself after the script ends,
    // which would replace this one with an empty value. action.yml maps `outcome` to `result`.
    core.setOutput('outcome', result)
    core.setOutput('comment-id', comment?.id ?? '')
    core.setOutput('comment-url', comment?.url ?? comment?.html_url ?? '')
  }

  try {
    switch (operation) {
      case 'find': {
        needIssue()
        const found = await findComment({ github, owner, repo, issue, marker })
        core.info(found ? `Found comment ${found.id} on ${target}.` : `No comment on ${target} starts with the marker.`)
        done(found ? 'found' : 'not-found', found)
        break
      }

      case 'create': {
        needIssue()
        const body = readBody({ body: env.INPUT_BODY, bodyFile: env.INPUT_BODY_FILE })
        const comment = await createComment({ github, owner, repo, issue, body, marker })
        core.info(`Created comment ${comment.id} on ${target}.`)
        done('created', comment)
        break
      }

      case 'upsert': {
        needIssue()
        const body = readBody({ body: env.INPUT_BODY, bodyFile: env.INPUT_BODY_FILE })
        const comment = await upsertComment({ github, owner, repo, issue, marker, body })
        core.info(`${comment.created ? 'Created' : 'Updated'} comment ${comment.id} on ${target}.`)
        done(comment.created ? 'created' : 'updated', comment)
        break
      }

      case 'update': {
        const body = readBody({ body: env.INPUT_BODY, bodyFile: env.INPUT_BODY_FILE })
        const existing = await locate()

        if (!existing) {
          throw new Error(`There is no comment to update: none on ${target} starts with the marker.`)
        }

        const comment = await updateComment({ github, owner, repo, id: existing.id, body, marker })
        core.info(`Updated comment ${comment.id}.`)
        done('updated', comment)
        break
      }

      case 'delete': {
        const existing = await locate()
        const { deleted } = existing ? await deleteComment({ github, owner, repo, id: existing.id }) : { deleted: false }

        core.info(deleted ? `Deleted comment ${existing.id}.` : 'There was no comment to delete.')
        done(deleted ? 'deleted' : 'not-found', deleted ? { id: existing.id } : null)
        break
      }
    }
  } catch (error) {
    throw explain(error, target)
  }
}

module.exports = {
  run,
  findComment,
  createComment,
  updateComment,
  deleteComment,
  upsertComment,
  readBody,
  checkMarker,
  MAX_COMMENT_LENGTH,
  OPERATIONS,
}
