'use strict'

/**
 * Reads of the GitHub API shared by the toolbox actions, through the Octokit actions/github-script
 * supplies. Loaded by a path relative to each action's directory, like versions.js.
 */

/**
 * Reads `GITHUB_REPOSITORY` as owner and name.
 *
 * @param {object} env  The environment.
 * @param {string} what What was not done, to close the message, e.g. `Nothing was merged.`
 *
 * @throws {Error} When it is not set.
 *
 * @returns {{owner: string, repo: string}} The repository.
 */
function readRepository(env, what) {
  const [owner, repo] = String(env.GITHUB_REPOSITORY || '').split('/')

  if (!owner || !repo) {
    throw new Error(`GITHUB_REPOSITORY is not set, so the action does not know which repository to work on. ${what}`)
  }

  return { owner, repo }
}

/**
 * Whether an Octokit error is the API saying a thing does not exist.
 *
 * @param {Error} error The error.
 *
 * @returns {boolean} True for a 404.
 */
function isNotFound(error) {
  return error?.status === 404
}

/**
 * Reads a tag of the repository.
 *
 * @param {object} options
 * @param {object} options.github  The Octokit github-script supplies.
 * @param {string} options.owner   The repository owner.
 * @param {string} options.repo    The repository name.
 * @param {string} options.version The tag, a version.
 * @param {string} options.what    What was not done, to close the error message.
 *
 * @throws {Error} When the read fails for any reason but 404, so an API error is never taken for an
 *                 absent tag.
 *
 * @returns {Promise<boolean>} Whether the tag exists.
 */
async function tagExists({ github, owner, repo, version, what }) {
  try {
    await github.rest.git.getRef({ owner, repo, ref: `tags/${version}` })

    return true
  } catch (error) {
    if (isNotFound(error)) {
      return false
    }

    throw new Error(`Reading tag ${version} failed (HTTP ${error.status}): ${error.message}. ${what}`)
  }
}

module.exports = { readRepository, isNotFound, tagExists }
