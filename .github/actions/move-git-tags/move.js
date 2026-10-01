'use strict'

/**
 * Creates or moves git tags so that they point at a commit.
 *
 * parseTagNames is pure and holds the validation. moveTags takes an Octokit and does the writing,
 * so a test can pass a stand-in and assert the calls.
 */

/** A plain tag name: no spaces, no leading dash or dot, nothing that could reshape a request. */
const PLAIN_TAG_NAME = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/

/**
 * Splits the `tags` input and checks every name.
 *
 * @param {string} tags Tag names separated by spaces or newlines.
 * @returns {string[]} The names, in the order given.
 * @throws {Error} When a name is not a plain tag name.
 */
function parseTagNames(tags) {
  const names = String(tags ?? '')
    .trim()
    .split(/\s+/)
    .filter(Boolean)

  for (const name of names) {
    // A full ref would otherwise be written as a tag literally named refs/tags/v1.
    if (name.startsWith('refs/')) {
      throw new Error(`Refusing to write '${name}': pass the tag name, e.g. '${name.split('/').pop()}'.`)
    }

    if (!PLAIN_TAG_NAME.test(name) || name.includes('..')) {
      throw new Error(`Refusing to write '${name}': it is not a plain tag name.`)
    }
  }

  return names
}

/**
 * Points each tag at a commit, creating the ones that do not exist.
 *
 * The ref is read first rather than trying an update and creating on failure. An update also fails
 * for a token without permission or a protected tag, and treating that as "does not exist yet"
 * would report a refused write as a successful creation. getRef is the single-ref endpoint, which
 * answers 404 for a missing ref; the matching-refs endpoint matches by prefix instead, and would
 * answer for `tags/v1` whenever a v1.0.0 tag exists.
 *
 * The refs are written through the API rather than by pushing, so a tag name never disappears for a
 * moment, which is what keeps a GitHub Release attached to it.
 *
 * @param {object}   github An Octokit, as actions/github-script supplies it.
 * @param {object}   core   The @actions/core toolkit, for the log.
 * @param {string}   owner  The repository owner.
 * @param {string}   repo   The repository name.
 * @param {string[]} names  The tag names to point at `sha`, already validated.
 * @param {string}   sha    The commit the tags should point at.
 * @returns {Promise<{created: string[], moved: string[]}>} Which names were created, and which
 *                                                          already existed and were repointed.
 * @throws {Error} When a write fails, or a read fails with anything but a 404.
 */
async function moveTags({ github, core, owner, repo, names, sha }) {
  const created = []
  const moved = []

  for (const name of names) {
    let exists = true

    try {
      // getRef takes the ref without its `refs/` prefix; createRef takes the full ref below.
      await github.rest.git.getRef({ owner, repo, ref: `tags/${name}` })
    } catch (error) {
      if (error.status !== 404) {
        throw error
      }

      exists = false
    }

    if (exists) {
      await github.rest.git.updateRef({ owner, repo, ref: `tags/${name}`, sha, force: true })
      core.info(`Moved ${name} to ${sha}.`)
      moved.push(name)
    } else {
      await github.rest.git.createRef({ owner, repo, ref: `refs/tags/${name}`, sha })
      core.info(`Created ${name} at ${sha}.`)
      created.push(name)
    }
  }

  return { created, moved }
}

/**
 * Moves the tags named by the inputs and writes the action's outputs.
 *
 * @param {object} github An Octokit, as actions/github-script supplies it.
 * @param {object} core   The @actions/core toolkit, for the log and the outputs.
 * @param {object} env    The environment the action manifest put its inputs in.
 * @returns {Promise<void>} Resolves once every tag has been written and the outputs are set.
 * @throws {Error} When a tag name is not a plain tag name, or a write fails.
 */
async function run({ github, core, env }) {
  const repository = env.INPUT_REPOSITORY || env.GITHUB_REPOSITORY
  const [owner, repo] = repository.split('/')
  const sha = env.INPUT_SHA || env.GITHUB_SHA
  const names = parseTagNames(env.INPUT_TAGS)

  // An empty list succeeds, so a caller feeding this another step's output needs no `if:` of
  // its own.
  if (names.length === 0) {
    core.info('No tags to move.')
    core.setOutput('created', '')
    core.setOutput('moved', '')

    return
  }

  const { created, moved } = await moveTags({ github, core, owner, repo, names, sha })

  core.setOutput('created', created.join(' '))
  core.setOutput('moved', moved.join(' '))
}

module.exports = { run, moveTags, parseTagNames, PLAIN_TAG_NAME }
