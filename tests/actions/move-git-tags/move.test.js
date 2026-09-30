'use strict'

const test = require('node:test')
const assert = require('node:assert')

const { moveTags, parseTagNames, run } = require('../../../.github/actions/move-git-tags/move.js')

/** An Octokit stand-in. `existing` are the tag names that already have a ref. */
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

test('parseTagNames splits on spaces and newlines', () => {
  assert.deepEqual(parseTagNames('v1 v1.2'), ['v1', 'v1.2'])
  assert.deepEqual(parseTagNames('v1\nv1.2\n'), ['v1', 'v1.2'])
  assert.deepEqual(parseTagNames(''), [])
  assert.deepEqual(parseTagNames('   '), [])
  assert.deepEqual(parseTagNames(undefined), [])
})

test('parseTagNames refuses anything that is not a plain tag name', () => {
  assert.throws(() => parseTagNames('refs/tags/v1'), /pass the tag name, e\.g\. 'v1'/)
  assert.throws(() => parseTagNames('../../evil'), /not a plain tag name/)
  assert.throws(() => parseTagNames('-v1'), /not a plain tag name/)
  assert.throws(() => parseTagNames('.hidden'), /not a plain tag name/)
  assert.throws(() => parseTagNames('v1..2'), /not a plain tag name/)
  assert.throws(() => parseTagNames('v1;rm'), /not a plain tag name/)
})

test('a missing tag is created and an existing one is repointed', async () => {
  const github = fakeGithub({ existing: ['v1'] })
  const core = fakeCore()

  const result = await moveTags({
    github,
    core,
    owner: 'stellarwp',
    repo: 'plugin-toolbox',
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

test('a refused update fails the job rather than being retried as a creation', async () => {
  // A 403 from a protected tag must not be read as "does not exist yet", which is what an
  // update-then-create-on-failure fallback would do.
  const github = fakeGithub({ existing: ['v1'], failUpdateWith: 403 })

  await assert.rejects(
    moveTags({
      github,
      core: fakeCore(),
      owner: 'stellarwp',
      repo: 'plugin-toolbox',
      names: ['v1'],
      sha: 'abc123',
    }),
    /Forbidden/
  )

  assert.ok(!github.calls.some((call) => call.startsWith('createRef')), 'nothing was created')
})

test('an error other than 404 from the existence check is not swallowed', async () => {
  const github = fakeGithub()
  github.rest.git.getRef = async () => {
    const error = new Error('Bad credentials')
    error.status = 401

    throw error
  }

  await assert.rejects(
    moveTags({
      github,
      core: fakeCore(),
      owner: 'stellarwp',
      repo: 'plugin-toolbox',
      names: ['v1'],
      sha: 'abc123',
    }),
    /Bad credentials/
  )
})

test('an empty tag list succeeds and writes empty outputs', async () => {
  const github = fakeGithub()
  const core = fakeCore()

  await run({
    github,
    core,
    env: { INPUT_TAGS: '', GITHUB_REPOSITORY: 'stellarwp/plugin-toolbox', GITHUB_SHA: 'abc123' },
  })

  assert.deepEqual(github.calls, [], 'no API call was made')
  assert.deepEqual(core.outputs, { created: '', moved: '' })
})

test('run defaults the sha and repository to the workflow it is running in', async () => {
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

test('run prefers the sha and repository it is given', async () => {
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

test('a release tag moves alongside the floating tags, to a commit made later', async () => {
  /**
   * The pattern a repo with a build step uses: resolve the floating tags from the released tag,
   * build and commit, then point the release tag and the floating tags at the build commit. The
   * release tag is just another name to this action, and the sha is an input rather than the commit
   * the workflow started on.
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

