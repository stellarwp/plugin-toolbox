'use strict'

const { describe, it } = require('node:test')
const assert = require('node:assert')

const { moveTags, parseTagNames, run } = require('../../../.github/actions/move-git-tags/move.js')
const { actionsFor } = require('../../support/actions.js')

const REPO = { owner: 'stellarwp', repo: 'plugin-toolbox' }

/** The repository paths this action writes, as a real Octokit spells them. */
const REF = {
  read: (tag) => `/repos/stellarwp/plugin-toolbox/git/ref/tags%2F${tag}`,
  update: (tag) => `/repos/stellarwp/plugin-toolbox/git/refs/tags%2F${tag}`,
  create: '/repos/stellarwp/plugin-toolbox/git/refs',
}

/**
 * Rules that answer the existence check for `existing` and accept every write.
 *
 * A tag not in `existing` falls through to the default 404, which is what the action reads as "not
 * there yet".
 *
 * @param {string[]} existing Tag names that already have a ref.
 * @param {string}   base     Repository path the requests go to.
 * @returns {object[]} Rules for recordingFetch.
 */
function rulesFor(existing = [], base = '/repos/stellarwp/plugin-toolbox') {
  return [
    ...existing.map((tag) => ({
      method: 'GET',
      path: `${base}/git/ref/tags%2F${tag}`,
      body: { ref: `refs/tags/${tag}` },
    })),
    { method: 'PATCH', path: /\/git\/refs\/tags%2F/, body: {} },
    { method: 'POST', path: `${base}/git/refs`, body: {} },
  ]
}

/**
 * Each request as `METHOD path`, for asserting the order the action worked in.
 *
 * @param {object[]} requests The requests recordingFetch recorded.
 * @returns {string[]} One `METHOD path` per request, in the order they were sent.
 */
function sequence(requests) {
  return requests.map((request) => `${request.method} ${request.path}`)
}

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
    it('reads each ref from the single-ref endpoint, not the prefix one', async (t) => {
      // git/ref answers 404 for a missing ref. git/refs matches by prefix, so it would answer for
      // tags/v1 whenever a v1.0.0 tag exists, and no tag would ever look missing.
      const { github, requests, core } = await actionsFor(t, rulesFor(['v1']))

      await moveTags({ github, core, ...REPO, names: ['v1'], sha: 'abc123' })

      assert.equal(requests[0].method, 'GET')
      assert.equal(requests[0].path, '/repos/stellarwp/plugin-toolbox/git/ref/tags%2Fv1')
    })

    it('repoints an existing tag with a forced update, and creates a missing one', async (t) => {
      const { github, requests, core } = await actionsFor(t, rulesFor(['v1']))

      const result = await moveTags({
        github,
        core,
        ...REPO,
        names: ['v1', 'v1.2'],
        sha: 'abc123',
      })

      assert.deepEqual(result, { created: ['v1.2'], moved: ['v1'] })
      assert.deepEqual(sequence(requests), [
        `GET ${REF.read('v1')}`,
        `PATCH ${REF.update('v1')}`,
        `GET ${REF.read('v1.2')}`,
        `POST ${REF.create}`,
      ])
    })

    it('sends the sha and force on an update, and the full ref on a creation', async (t) => {
      const { github, requests, core } = await actionsFor(t, rulesFor(['v1']))

      await moveTags({
        github,
        core,
        ...REPO,
        names: ['v1', 'v1.2'],
        sha: 'abc123',
      })

      const [, update, , create] = requests

      assert.deepEqual(update.body, { sha: 'abc123', force: true })
      assert.deepEqual(create.body, { ref: 'refs/tags/v1.2', sha: 'abc123' })
    })

    it('writes to the repository it was given', async (t) => {
      const base = '/repos/another-owner/another-repo'
      const { github, requests, core } = await actionsFor(t, rulesFor([], base))

      await moveTags({
        github,
        core,
        owner: 'another-owner',
        repo: 'another-repo',
        names: ['v9'],
        sha: 'abc123',
      })

      assert.ok(
        requests.every((request) => request.path.startsWith('/repos/another-owner/another-repo/')),
        `every request went to the given repository, got ${JSON.stringify(sequence(requests))}`
      )
    })

    it('fails on a refused update rather than retrying it as a creation', async (t) => {
      // A 403 from a protected tag must not be read as "does not exist yet", which is what an
      // update-then-create-on-failure fallback would do.
      const { github, requests, core } = await actionsFor(t, [
        { method: 'GET', path: REF.read('v1'), body: { ref: 'refs/tags/v1' } },
        { method: 'PATCH', path: /\/git\/refs\/tags%2F/, status: 403, body: { message: 'Forbidden' } },
      ])

      await assert.rejects(
        moveTags({ github, core, ...REPO, names: ['v1'], sha: 'abc123' }),
        /Forbidden/
      )

      assert.ok(!sequence(requests).some((call) => call.startsWith('POST')), 'nothing was created')
    })

    it('does not treat a failure other than 404 as a missing tag', async (t) => {
      const { github, requests, core } = await actionsFor(t, [
        { method: 'GET', path: /\/git\/ref\//, status: 401, body: { message: 'Bad credentials' } },
      ])

      await assert.rejects(
        moveTags({ github, core, ...REPO, names: ['v1'], sha: 'abc123' }),
        /Bad credentials/
      )

      assert.equal(requests.length, 1, 'it stopped at the failed read')
    })
  })

  describe('run', () => {
    it('succeeds on an empty tag list without sending a request', async (t) => {
      const { github, requests, core, outputs } = await actionsFor(t)

      await run({
        github,
        core,
        env: { INPUT_TAGS: '', GITHUB_REPOSITORY: 'stellarwp/plugin-toolbox', GITHUB_SHA: 'abc123' },
      })

      assert.deepEqual(requests, [])
      assert.deepEqual(outputs(), { created: '', moved: '' })
    })

    it('defaults the sha and repository to the workflow it is running in', async (t) => {
      const { github, requests, core, outputs } = await actionsFor(t, rulesFor([]))

      await run({
        github,
        core,
        env: {
          INPUT_TAGS: 'v2',
          GITHUB_REPOSITORY: 'stellarwp/plugin-toolbox',
          GITHUB_SHA: 'feed456',
        },
      })

      assert.deepEqual(sequence(requests), [`GET ${REF.read('v2')}`, `POST ${REF.create}`])
      assert.equal(requests[1].body.sha, 'feed456')
      assert.deepEqual(outputs(), { created: 'v2', moved: '' })
    })

    it('prefers the sha and repository it is given', async (t) => {
      const rules = rulesFor(['v2'], '/repos/stellarwp/other')
      const { github, requests, core, outputs } = await actionsFor(t, rules)

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

      assert.deepEqual(sequence(requests), [
        '/repos/stellarwp/other/git/ref/tags%2Fv2',
        '/repos/stellarwp/other/git/refs/tags%2Fv2',
      ].map((path, i) => `${['GET', 'PATCH'][i]} ${path}`))
      assert.equal(requests[1].body.sha, 'chosen1')
      assert.deepEqual(outputs(), { created: '', moved: 'v2' })
    })

    it('moves a release tag alongside the floating tags, to a commit made later', async (t) => {
      /**
       * The pattern a repo with a build step uses: resolve the floating tags from the released tag,
       * build and commit, then point the release tag and the floating tags at the build commit. The
       * release tag is just another name to this action, and the sha is an input rather than the
       * commit the workflow started on.
       */
      const { github, requests, core, outputs } = await actionsFor(t, rulesFor(['v1.2.3', 'v1']))

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

      assert.deepEqual(sequence(requests), [
        `GET ${REF.read('v1.2.3')}`,
        `PATCH ${REF.update('v1.2.3')}`,
        `GET ${REF.read('v1')}`,
        `PATCH ${REF.update('v1')}`,
        `GET ${REF.read('v1.2')}`,
        `POST ${REF.create}`,
      ])
      const writes = requests.filter((request) => request.body)

      assert.ok(
        writes.every((request) => request.body.sha === 'bui1dc0mmit'),
        'every write used the build commit, not the released one'
      )
      assert.deepEqual(outputs(), { created: 'v1.2', moved: 'v1.2.3 v1' })
    })
  })
})

