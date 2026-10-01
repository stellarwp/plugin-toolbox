'use strict'

const { describe, it } = require('node:test')
const assert = require('node:assert')

const { moveTags, parseTagNames, run } = require('../../../.github/actions/move-git-tags/move.js')

/**
 * A fake of the `github` argument that actions/github-script passes to the script: an Octokit
 * client. Only the three `rest.git` methods move.js calls are implemented.
 *
 * Every call is recorded in `calls` in the order it was made, so a test asserts the requests the
 * action would have sent rather than the value it returned. `getRef` throws a 404 for a tag that is
 * not in `existing`, which is the signal move.js reads to choose between creating and repointing.
 *
 * @param {string[]} existing       Tag names that already have a ref, so `getRef` finds them.
 * @param {number}   failUpdateWith HTTP status for `updateRef` to throw instead of succeeding, for
 *                                  the protected-tag and missing-permission cases.
 * @returns {{calls: string[], rest: {git: object}}} The client, plus the calls it recorded.
 */
function fakeGithub({ existing = [], failUpdateWith } = {}) {
  const calls = []

  const notFound = () => {
    const error = new Error('Not Found')
    error.status = 404

    throw error
  }

  return {
    calls,
    rest: {
      git: {
        async getRef({ ref }) {
          calls.push(`getRef ${ref}`)

          return existing.includes(ref.replace(/^tags\//, '')) ? { data: {} } : notFound()
        },
        async updateRef({ ref, sha, force }) {
          calls.push(`updateRef ${ref} -> ${sha} force=${force}`)

          if (failUpdateWith) {
            const error = new Error('Forbidden')
            error.status = failUpdateWith

            throw error
          }
        },
        async createRef({ ref, sha }) {
          calls.push(`createRef ${ref} -> ${sha}`)
        },
      },
    },
  }
}

/**
 * A fake of the `core` argument that actions/github-script passes to the script: the @actions/core
 * toolkit. Only the methods move.js calls are implemented.
 *
 * The real `setOutput` appends to the file named by GITHUB_OUTPUT, and the log methods write
 * workflow commands to stdout. This collects both in memory instead, so a test reads `outputs` to
 * assert what the step would have handed to later steps, and `messages` for what it would have
 * logged.
 *
 * @returns {{outputs: object, messages: string[], info: Function, notice: Function,
 *            warning: Function, setOutput: Function}}
 */
function fakeCore() {
  const outputs = {}
  const messages = []

  return {
    outputs,
    messages,
    info: (message) => messages.push(message),
    notice: (message) => messages.push(message),
    warning: (message) => messages.push(message),
    setOutput: (name, value) => {
      outputs[name] = value
    },
  }
}

const REPO = { owner: 'stellarwp', repo: 'plugin-toolbox' }

describe('move-git-tags', () => {
  describe('parseTagNames', () => {
    it('splits on spaces and on newlines', () => {
      assert.deepEqual(parseTagNames('v1 v1.2'), ['v1', 'v1.2'])
      assert.deepEqual(parseTagNames('v1\nv1.2\n'), ['v1', 'v1.2'])
    })

    it('reads an empty or missing value as no tags', () => {
      assert.deepEqual(parseTagNames(''), [])
      assert.deepEqual(parseTagNames('   '), [])
      assert.deepEqual(parseTagNames(undefined), [])
    })

    it('refuses a full ref, naming the tag to pass instead', () => {
      assert.throws(() => parseTagNames('refs/tags/v1'), /pass the tag name, e\.g\. 'v1'/)
    })

    it('refuses a name that could reshape a request', () => {
      assert.throws(() => parseTagNames('../../evil'), /not a plain tag name/)
      assert.throws(() => parseTagNames('v1..2'), /not a plain tag name/)
      assert.throws(() => parseTagNames('v1;rm'), /not a plain tag name/)
    })

    it('refuses a name starting with a dash or a dot', () => {
      assert.throws(() => parseTagNames('-v1'), /not a plain tag name/)
      assert.throws(() => parseTagNames('.hidden'), /not a plain tag name/)
    })
  })

  describe('moveTags', () => {
    it('creates a tag that does not exist and repoints one that does', async () => {
      const github = fakeGithub({ existing: ['v1'] })

      const result = await moveTags({
        github,
        core: fakeCore(),
        ...REPO,
        names: ['v1', 'v1.2'],
        sha: 'abc123',
      })

      assert.deepEqual(result, { created: ['v1.2'], moved: ['v1'] })
      assert.deepEqual(github.calls, [
        'getRef tags/v1',
        'updateRef tags/v1 -> abc123 force=true',
        'getRef tags/v1.2',
        'createRef refs/tags/v1.2 -> abc123',
      ])
    })

    it('fails on a refused update rather than retrying it as a creation', async () => {
      // A 403 from a protected tag must not be read as "does not exist yet", which is what an
      // update-then-create-on-failure fallback would do.
      const github = fakeGithub({ existing: ['v1'], failUpdateWith: 403 })

      await assert.rejects(
        moveTags({ github, core: fakeCore(), ...REPO, names: ['v1'], sha: 'abc123' }),
        /Forbidden/
      )

      assert.ok(!github.calls.some((call) => call.startsWith('createRef')), 'nothing was created')
    })

    it('does not treat an error other than 404 as a missing tag', async () => {
      const github = fakeGithub()
      github.rest.git.getRef = async () => {
        const error = new Error('Bad credentials')
        error.status = 401

        throw error
      }

      await assert.rejects(
        moveTags({ github, core: fakeCore(), ...REPO, names: ['v1'], sha: 'abc123' }),
        /Bad credentials/
      )
    })
  })

  describe('run', () => {
    it('succeeds on an empty tag list without calling the API', async () => {
      const github = fakeGithub()
      const core = fakeCore()

      await run({
        github,
        core,
        env: { INPUT_TAGS: '', GITHUB_REPOSITORY: 'stellarwp/plugin-toolbox', GITHUB_SHA: 'abc123' },
      })

      assert.deepEqual(github.calls, [])
      assert.deepEqual(core.outputs, { created: '', moved: '' })
    })

    it('defaults the sha and repository to the workflow it is running in', async () => {
      const github = fakeGithub({ existing: [] })
      const core = fakeCore()

      await run({
        github,
        core,
        env: {
          INPUT_TAGS: 'v2',
          GITHUB_REPOSITORY: 'stellarwp/plugin-toolbox',
          GITHUB_SHA: 'feed456',
        },
      })

      assert.deepEqual(github.calls, ['getRef tags/v2', 'createRef refs/tags/v2 -> feed456'])
      assert.deepEqual(core.outputs, { created: 'v2', moved: '' })
    })

    it('prefers the sha and repository it is given', async () => {
      const github = fakeGithub({ existing: ['v2'] })
      const core = fakeCore()

      await run({
        github,
        core,
        env: {
          INPUT_TAGS: 'v2',
          INPUT_SHA: 'chosen1',
          INPUT_REPOSITORY: 'stellarwp/other',
          GITHUB_REPOSITORY: 'stellarwp/plugin-toolbox',
          GITHUB_SHA: 'feed456',
        },
      })

      assert.deepEqual(github.calls, ['getRef tags/v2', 'updateRef tags/v2 -> chosen1 force=true'])
      assert.deepEqual(core.outputs, { created: '', moved: 'v2' })
    })

    it('moves a release tag alongside the floating tags, to a commit made later', async () => {
      /**
       * The pattern a repo with a build step uses: resolve the floating tags from the released tag,
       * build and commit, then point the release tag and the floating tags at the build commit. The
       * release tag is just another name to this action, and the sha is an input rather than the
       * commit the workflow started on.
       */
      const github = fakeGithub({ existing: ['v1.2.3', 'v1'] })
      const core = fakeCore()

      await run({
        github,
        core,
        env: {
          INPUT_TAGS: 'v1.2.3 v1 v1.2',
          INPUT_SHA: 'bui1dc0mmit',
          GITHUB_REPOSITORY: 'stellarwp/plugin-toolbox',
          GITHUB_SHA: 'thereleasedcommit',
        },
      })

      assert.deepEqual(github.calls, [
        'getRef tags/v1.2.3',
        'updateRef tags/v1.2.3 -> bui1dc0mmit force=true',
        'getRef tags/v1',
        'updateRef tags/v1 -> bui1dc0mmit force=true',
        'getRef tags/v1.2',
        'createRef refs/tags/v1.2 -> bui1dc0mmit',
      ])
      assert.deepEqual(core.outputs, { created: 'v1.2', moved: 'v1.2.3 v1' })
    })
  })
})
