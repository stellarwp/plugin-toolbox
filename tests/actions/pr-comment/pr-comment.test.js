'use strict'

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { describe, it } = require('node:test')
const assert = require('node:assert')

const {
  run,
  findComment,
  createComment,
  updateComment,
  deleteComment,
  upsertComment,
  readBody,
  checkMarker,
  MAX_COMMENT_LENGTH,
} = require('../../../.github/actions/pr-comment/pr-comment.js')
const { actionsFor, octokitFor } = require('../../support/actions.js')

const REPO = { owner: 'example-org', repo: 'my-plugin' }
const MARKER = '<!-- my-check:example-org/my-plugin -->'

/** The comments of pull request 12, and one comment by id. */
const COMMENTS = '/repos/example-org/my-plugin/issues/12/comments?per_page=100'
const COMMENT = (id) => `/repos/example-org/my-plugin/issues/comments/${id}`

/** A `link` header that points at a second page. */
const NEXT_PAGE = {
  link: '<https://api.github.com/repos/example-org/my-plugin/issues/12/comments?per_page=100&page=2>; rel="next"',
}

/**
 * Each request as `METHOD path`, for asserting the order the action worked in.
 *
 * @param {object[]} requests The requests recordingFetch recorded.
 *
 * @returns {string[]} One `METHOD path` per request, in the order they were sent.
 */
function sequence(requests) {
  return requests.map((request) => `${request.method} ${request.path}`)
}

/**
 * The environment the action manifest builds from its inputs.
 *
 * @param {object} inputs Input values by their INPUT_ name, without the prefix.
 *
 * @returns {object} The env to hand to run().
 */
function envFor(inputs = {}) {
  const env = { GITHUB_REPOSITORY: 'example-org/my-plugin', INPUT_ISSUE_NUMBER: '12' }

  for (const [name, value] of Object.entries(inputs)) {
    env[`INPUT_${name}`] = value
  }

  return env
}

describe('pr-comment', () => {
  describe('checkMarker', () => {
    it('refuses an empty or blank marker, which would match every comment', () => {
      assert.throws(() => checkMarker(''), /marker is empty/)
      assert.throws(() => checkMarker('   '), /marker is empty/)
      assert.throws(() => checkMarker(undefined), /marker is empty/)
    })

    it('refuses a marker with a line break', () => {
      assert.throws(() => checkMarker('<!-- a -->\n<!-- b -->'), /line break/)
    })
  })

  describe('readBody', () => {
    it('reads the body from a string', () => {
      assert.equal(readBody({ body: 'hello', bodyFile: '' }), 'hello')
    })

    it('reads the body from a file', () => {
      const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pr-comment-')), 'body.md')
      fs.writeFileSync(file, 'from a file\n')

      assert.equal(readBody({ body: '', bodyFile: file }), 'from a file\n')
    })

    it('fails on a missing file and names it', () => {
      assert.throws(() => readBody({ body: '', bodyFile: '/nowhere/body.md' }), /\/nowhere\/body\.md/)
    })

    it('refuses both a body and a file', () => {
      assert.throws(() => readBody({ body: 'a', bodyFile: 'b.md' }), /not both/)
    })

    it('refuses neither a body nor a file', () => {
      assert.throws(() => readBody({ body: '', bodyFile: '' }), /no comment text/)
    })
  })

  describe('findComment', () => {
    it('finds the comment that starts with the marker', async () => {
      const { github } = await octokitFor([
        {
          method: 'GET',
          path: COMMENTS,
          body: [
            { id: 1, body: 'a person wrote this' },
            { id: 2, body: `${MARKER}\nthe sticky comment` },
          ],
        },
      ])

      const found = await findComment({ github, ...REPO, issue: 12, marker: MARKER })

      assert.equal(found.id, 2)
    })

    it('finds it on a later page', async () => {
      const { github, requests } = await octokitFor([
        {
          method: 'GET',
          path: /\/issues\/12\/comments\?/,
          responses: [
            { body: [{ id: 1, body: 'first page' }], headers: NEXT_PAGE },
            { body: [{ id: 2, body: `${MARKER}\non the second page` }] },
          ],
        },
      ])

      const found = await findComment({ github, ...REPO, issue: 12, marker: MARKER })

      assert.equal(found.id, 2)
      assert.equal(requests.length, 2)
    })

    it('stops reading pages once a page has a match', async () => {
      const { github, requests } = await octokitFor([
        {
          method: 'GET',
          path: /\/issues\/12\/comments\?/,
          responses: [
            { body: [{ id: 1, body: `${MARKER}\nold` }], headers: NEXT_PAGE },
            { body: [{ id: 2, body: `${MARKER}\nnewer copy` }] },
          ],
        },
      ])

      const found = await findComment({ github, ...REPO, issue: 12, marker: MARKER })

      assert.equal(found.id, 1)
      assert.equal(requests.length, 1, 'the second page was never read')
    })

    it('ignores a comment that only quotes the marker', async () => {
      const { github } = await octokitFor([
        { method: 'GET', path: COMMENTS, body: [{ id: 1, body: `> ${MARKER}\nquoted by a person` }] },
      ])

      assert.equal(await findComment({ github, ...REPO, issue: 12, marker: MARKER }), null)
    })

    it('ignores a comment that holds the marker on a later line', async () => {
      const { github } = await octokitFor([
        { method: 'GET', path: COMMENTS, body: [{ id: 1, body: `text\n${MARKER}` }] },
      ])

      assert.equal(await findComment({ github, ...REPO, issue: 12, marker: MARKER }), null)
    })

    it('skips a comment with no body', async () => {
      const { github } = await octokitFor([
        { method: 'GET', path: COMMENTS, body: [{ id: 1, body: null }, { id: 2, body: `${MARKER}\nok` }] },
      ])

      const found = await findComment({ github, ...REPO, issue: 12, marker: MARKER })

      assert.equal(found.id, 2)
    })

    it('returns the oldest match when there are two', async () => {
      const { github } = await octokitFor([
        {
          method: 'GET',
          path: COMMENTS,
          body: [
            { id: 7, body: `${MARKER}\nolder` },
            { id: 9, body: `${MARKER}\nnewer` },
          ],
        },
      ])

      const found = await findComment({ github, ...REPO, issue: 12, marker: MARKER })

      assert.equal(found.id, 7)
    })

    it('returns null when no comment matches', async () => {
      const { github } = await octokitFor([{ method: 'GET', path: COMMENTS, body: [{ id: 1, body: 'other' }] }])

      assert.equal(await findComment({ github, ...REPO, issue: 12, marker: MARKER }), null)
    })

    it('refuses an empty marker before calling the API', async () => {
      const { github, requests } = await octokitFor([])

      await assert.rejects(findComment({ github, ...REPO, issue: 12, marker: '' }), /marker is empty/)
      assert.equal(requests.length, 0)
    })

    it('fails on an API error rather than reading it as no comment', async () => {
      const { github, requests } = await octokitFor([
        { method: 'GET', path: COMMENTS, status: 500, body: { message: 'Server Error' } },
      ])

      await assert.rejects(upsertComment({ github, ...REPO, issue: 12, marker: MARKER, body: 'text' }))
      assert.deepEqual(sequence(requests), [`GET ${COMMENTS}`])
    })
  })

  describe('createComment', () => {
    it("posts the body to the issue's comments", async () => {
      const { github, requests } = await octokitFor([
        { method: 'POST', path: '/repos/example-org/my-plugin/issues/12/comments', body: { id: 5, html_url: 'https://x/5' } },
      ])

      const comment = await createComment({ github, ...REPO, issue: 12, body: 'hello' })

      assert.deepEqual(comment, { id: 5, url: 'https://x/5' })
      assert.deepEqual(requests[0].body, { body: 'hello' })
    })

    it('adds the marker as the first line when the body lacks it', async () => {
      const { github, requests } = await octokitFor([
        { method: 'POST', path: '/repos/example-org/my-plugin/issues/12/comments', body: { id: 5 } },
      ])

      await createComment({ github, ...REPO, issue: 12, body: 'hello', marker: MARKER })

      assert.equal(requests[0].body.body, `${MARKER}\nhello`)
    })

    it('refuses an empty body before calling the API', async () => {
      const { github, requests } = await octokitFor([])

      await assert.rejects(createComment({ github, ...REPO, issue: 12, body: '  \n' }), /body is empty/)
      assert.equal(requests.length, 0)
    })

    it('refuses a body longer than GitHub accepts before calling the API', async () => {
      const { github, requests } = await octokitFor([])
      const body = 'x'.repeat(MAX_COMMENT_LENGTH + 1)

      await assert.rejects(createComment({ github, ...REPO, issue: 12, body }), /65537 characters/)
      assert.equal(requests.length, 0)
    })
  })

  describe('updateComment', () => {
    it('patches the comment by id with the new body', async () => {
      const { github, requests } = await octokitFor([
        { method: 'PATCH', path: COMMENT(42), body: { id: 42, html_url: 'https://x/42' } },
      ])

      const comment = await updateComment({ github, ...REPO, id: 42, body: 'new text' })

      assert.deepEqual(comment, { id: 42, url: 'https://x/42' })
      assert.deepEqual(requests[0].body, { body: 'new text' })
    })

    it('keeps a body that already starts with the marker as it is', async () => {
      const { github, requests } = await octokitFor([{ method: 'PATCH', path: COMMENT(42), body: { id: 42 } }])

      await updateComment({ github, ...REPO, id: 42, body: `${MARKER}\nnew`, marker: MARKER })

      assert.equal(requests[0].body.body, `${MARKER}\nnew`)
    })
  })

  describe('deleteComment', () => {
    it('deletes the comment by id', async () => {
      const { github, requests } = await octokitFor([{ method: 'DELETE', path: COMMENT(42), status: 204 }])

      const result = await deleteComment({ github, ...REPO, id: 42 })

      assert.deepEqual(result, { deleted: true })
      assert.deepEqual(sequence(requests), [`DELETE ${COMMENT(42)}`])
    })

    it('reports a comment that is already gone as not deleted', async () => {
      const { github } = await octokitFor([])

      assert.deepEqual(await deleteComment({ github, ...REPO, id: 42 }), { deleted: false })
    })

    it('fails on a refused delete', async () => {
      const { github } = await octokitFor([
        { method: 'DELETE', path: COMMENT(42), status: 403, body: { message: 'Forbidden' } },
      ])

      await assert.rejects(deleteComment({ github, ...REPO, id: 42 }), /Forbidden/)
    })
  })

  describe('upsertComment', () => {
    it('replaces the comment that starts with the marker, even on a later page', async () => {
      const { github, requests } = await octokitFor([
        {
          method: 'GET',
          path: /\/issues\/12\/comments\?/,
          responses: [
            { body: [{ id: 1, body: 'other' }], headers: NEXT_PAGE },
            { body: [{ id: 5, body: `${MARKER}\nold` }] },
          ],
        },
        { method: 'PATCH', path: COMMENT(5), body: { id: 5, html_url: 'https://x/5' } },
      ])

      const comment = await upsertComment({ github, ...REPO, issue: 12, marker: MARKER, body: `${MARKER}\nnew` })

      assert.deepEqual(comment, { id: 5, url: 'https://x/5', created: false })
      assert.equal(requests.at(-1).method, 'PATCH')
      assert.equal(requests.filter((request) => request.method === 'POST').length, 0)
    })

    it('creates a comment when none starts with the marker', async () => {
      const { github, requests } = await octokitFor([
        { method: 'GET', path: COMMENTS, body: [{ id: 1, body: 'other' }] },
        { method: 'POST', path: '/repos/example-org/my-plugin/issues/12/comments', body: { id: 6, html_url: 'https://x/6' } },
      ])

      const comment = await upsertComment({ github, ...REPO, issue: 12, marker: MARKER, body: 'text' })

      assert.deepEqual(comment, { id: 6, url: 'https://x/6', created: true })
      assert.equal(requests.at(-1).body.body, `${MARKER}\ntext`)
    })

    it('refuses an empty marker before calling the API', async () => {
      const { github, requests } = await octokitFor([])

      await assert.rejects(upsertComment({ github, ...REPO, issue: 12, marker: '', body: 'text' }), /marker is empty/)
      assert.equal(requests.length, 0)
    })

    it('refuses an empty body before searching', async () => {
      const { github, requests } = await octokitFor([])

      await assert.rejects(upsertComment({ github, ...REPO, issue: 12, marker: MARKER, body: '' }), /body is empty/)
      assert.equal(requests.length, 0)
    })
  })

  describe('run', () => {
    it('upserts by default and sets the outputs', async (t) => {
      const { github, core, outputs } = await actionsFor(t, [
        { method: 'GET', path: COMMENTS, body: [] },
        { method: 'POST', path: '/repos/example-org/my-plugin/issues/12/comments', body: { id: 6, html_url: 'https://x/6' } },
      ])

      await run({ github, core, env: envFor({ MARKER, BODY: 'text' }) })

      assert.deepEqual(outputs(), { outcome: 'created', 'comment-id': '6', 'comment-url': 'https://x/6' })
    })

    it('updates when the marker is found', async (t) => {
      const { github, core, outputs } = await actionsFor(t, [
        { method: 'GET', path: COMMENTS, body: [{ id: 5, body: `${MARKER}\nold` }] },
        { method: 'PATCH', path: COMMENT(5), body: { id: 5, html_url: 'https://x/5' } },
      ])

      await run({ github, core, env: envFor({ MARKER, BODY: 'new' }) })

      assert.equal(outputs().outcome, 'updated')
      assert.equal(outputs()['comment-id'], '5')
    })

    it('reads the body from body-file', async (t) => {
      const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pr-comment-')), 'body.md')
      fs.writeFileSync(file, `${MARKER}\nfrom a file`)

      const { github, core, requests } = await actionsFor(t, [
        { method: 'GET', path: COMMENTS, body: [] },
        { method: 'POST', path: '/repos/example-org/my-plugin/issues/12/comments', body: { id: 6 } },
      ])

      await run({ github, core, env: envFor({ MARKER, BODY_FILE: file }) })

      assert.equal(requests.at(-1).body.body, `${MARKER}\nfrom a file`)
    })

    it('finds without writing', async (t) => {
      const { github, core, outputs, requests } = await actionsFor(t, [
        { method: 'GET', path: COMMENTS, body: [{ id: 5, body: `${MARKER}\nx`, html_url: 'https://x/5' }] },
      ])

      await run({ github, core, env: envFor({ OPERATION: 'find', MARKER }) })

      assert.equal(outputs().outcome, 'found')
      assert.equal(outputs()['comment-url'], 'https://x/5')
      assert.deepEqual(sequence(requests), [`GET ${COMMENTS}`])
    })

    it('reports not-found from find without failing', async (t) => {
      const { github, core, outputs } = await actionsFor(t, [{ method: 'GET', path: COMMENTS, body: [] }])

      await run({ github, core, env: envFor({ OPERATION: 'find', MARKER }) })

      assert.equal(outputs().outcome, 'not-found')
      assert.equal(outputs()['comment-id'], '')
    })

    it('deletes by marker', async (t) => {
      const { github, core, outputs, requests } = await actionsFor(t, [
        { method: 'GET', path: COMMENTS, body: [{ id: 5, body: `${MARKER}\nx` }] },
        { method: 'DELETE', path: COMMENT(5), status: 204 },
      ])

      await run({ github, core, env: envFor({ OPERATION: 'delete', MARKER }) })

      assert.equal(outputs().outcome, 'deleted')
      assert.deepEqual(sequence(requests), [`GET ${COMMENTS}`, `DELETE ${COMMENT(5)}`])
    })

    it('deletes by comment-id without listing comments', async (t) => {
      const { github, core, outputs, requests } = await actionsFor(t, [
        { method: 'DELETE', path: COMMENT(5), status: 204 },
      ])

      await run({ github, core, env: envFor({ OPERATION: 'delete', COMMENT_ID: '5', ISSUE_NUMBER: '' }) })

      assert.equal(outputs().outcome, 'deleted')
      assert.deepEqual(sequence(requests), [`DELETE ${COMMENT(5)}`])
    })

    it('reports not-found from delete without failing', async (t) => {
      const { github, core, outputs } = await actionsFor(t, [{ method: 'GET', path: COMMENTS, body: [] }])

      await run({ github, core, env: envFor({ OPERATION: 'delete', MARKER }) })

      assert.equal(outputs().outcome, 'not-found')
    })

    it('fails update when there is nothing to update', async (t) => {
      const { github, core } = await actionsFor(t, [{ method: 'GET', path: COMMENTS, body: [] }])

      await assert.rejects(run({ github, core, env: envFor({ OPERATION: 'update', MARKER, BODY: 'x' }) }), /no comment to update/)
    })

    it('creates a second comment with the create operation', async (t) => {
      const { github, core, outputs, requests } = await actionsFor(t, [
        { method: 'POST', path: '/repos/example-org/my-plugin/issues/12/comments', body: { id: 8 } },
      ])

      await run({ github, core, env: envFor({ OPERATION: 'create', BODY: 'one more' }) })

      assert.equal(outputs().outcome, 'created')
      assert.deepEqual(sequence(requests), ['POST /repos/example-org/my-plugin/issues/12/comments'])
    })

    it('refuses an unknown operation before calling the API', async (t) => {
      const { github, core, requests } = await actionsFor(t, [])

      await assert.rejects(run({ github, core, env: envFor({ OPERATION: 'remove' }) }), /Unknown operation 'remove'/)
      assert.equal(requests.length, 0)
    })

    it('refuses to upsert without an issue number', async (t) => {
      const { github, core, requests } = await actionsFor(t, [])

      await assert.rejects(
        run({ github, core, env: envFor({ MARKER, BODY: 'x', ISSUE_NUMBER: '' }) }),
        /No pull request or issue number/
      )
      assert.equal(requests.length, 0)
    })

    it('refuses an issue number that is not a number', async (t) => {
      const { github, core } = await actionsFor(t, [])

      await assert.rejects(run({ github, core, env: envFor({ MARKER, BODY: 'x', ISSUE_NUMBER: '12abc' }) }), /whole number/)
    })

    it('explains a 403 as a read-only token', async (t) => {
      const { github, core } = await actionsFor(t, [
        { method: 'GET', path: COMMENTS, body: [] },
        { method: 'POST', path: '/repos/example-org/my-plugin/issues/12/comments', status: 403, body: { message: 'Resource not accessible by integration' } },
      ])

      await assert.rejects(
        run({ github, core, env: envFor({ MARKER, BODY: 'x' }) }),
        /token cannot write comments on #12.*fork.*pull-requests: write.*Resource not accessible/s
      )
    })

    it('does not call a refused read a refused write', async (t) => {
      const { github, core } = await actionsFor(t, [
        { method: 'GET', path: COMMENTS, status: 403, body: { message: 'API rate limit exceeded' } },
      ])

      await assert.rejects(
        run({ github, core, env: envFor({ MARKER, BODY: 'x' }) }),
        (error) => /rate limit/.test(error.message) && !/cannot write/.test(error.message)
      )
    })

    it('writes to the repository it was given', async (t) => {
      const { github, core, requests } = await actionsFor(t, [
        { method: 'GET', path: '/repos/other-org/other-plugin/issues/12/comments?per_page=100', body: [] },
        { method: 'POST', path: '/repos/other-org/other-plugin/issues/12/comments', body: { id: 3 } },
      ])

      await run({ github, core, env: envFor({ MARKER, BODY: 'x', REPOSITORY: 'other-org/other-plugin' }) })

      assert.equal(requests.at(-1).path, '/repos/other-org/other-plugin/issues/12/comments')
    })
  })
})
