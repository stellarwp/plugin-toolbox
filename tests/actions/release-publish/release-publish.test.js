'use strict'

const { describe, it } = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const {
  runPublish,
  validateVersion,
  readTarget,
  resolveTarget,
  readTitle,
  readNotesFile,
  readFiles,
  makeLatest,
  previousVersion,
  DRAFT_MARK,
} = require('../../../.github/actions/release-publish/release-publish.js')
const { coreWithOutputs, octokitFor } = require('../../support/actions.js')

/** The commit release-merge hands over as `base-sha`. */
const SHA = '0123456789abcdef0123456789abcdef01234567'

/** The repository paths the action reads and writes, as a real Octokit spells them. */
const API = {
  tag: '/repos/stellarwp/plugin/git/ref/tags%2F4.17.0',
  releaseByTag: '/repos/stellarwp/plugin/releases/tags/4.17.0',
  latest: '/repos/stellarwp/plugin/releases/latest',
  branch: '/repos/stellarwp/plugin/branches/main',
  notes: '/repos/stellarwp/plugin/releases/generate-notes',
  releases: '/repos/stellarwp/plugin/releases',
  list: '/repos/stellarwp/plugin/releases?per_page=100',
  release: '/repos/stellarwp/plugin/releases/77',
  assets: /^https:\/\/uploads\.github\.com\/repos\/stellarwp\/plugin\/releases\/77\/assets\?name=/,
}

const RELEASE_URL = 'https://github.com/stellarwp/plugin/releases/tag/4.17.0'

/** The releases the repository has, as the list endpoint sends them: 4.16.0 is the latest. */
const RELEASES = [
  { id: 60, tag_name: '4.16.0', draft: false },
  { id: 59, tag_name: '4.15.2', draft: false },
]

/** The rules of the common case: no tag, no release yet, a lower latest, notes generated. */
const FRESH = [
  { method: 'POST', path: API.notes, body: { name: '4.17.0', body: '## What changed\n* Fix (#12)' } },
  { method: 'GET', path: API.latest, body: { tag_name: '4.16.0' } },
  { method: 'GET', path: API.list, body: RELEASES },
]

/**
 * The environment the manifest hands the script.
 *
 * @param {object} overrides Inputs to change.
 *
 * @returns {object} The environment.
 */
function publishEnv(overrides = {}) {
  return {
    INPUT_VERSION: '4.17.0',
    INPUT_TARGET: SHA,
    INPUT_TITLE: '',
    INPUT_NOTES_FILE: '',
    INPUT_FILES: '',
    GITHUB_REPOSITORY: 'stellarwp/plugin',
    ...overrides,
  }
}

/**
 * A checkout holding the files a test names.
 *
 * @param {object} files Name to contents.
 *
 * @returns {string} The directory.
 */
function checkoutWith(files = {}) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'release-publish-'))
  for (const [name, contents] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(cwd, name)), { recursive: true })
    fs.writeFileSync(path.join(cwd, name), contents)
  }

  return cwd
}

/**
 * Each request as `METHOD path`, for asserting what the action asked the API.
 *
 * @param {object[]} requests The requests recordingFetch recorded.
 *
 * @returns {string[]} One line per request.
 */
function requested(requests) {
  // The upload URL comes from the `{?name,label}` template, which leaves a trailing `&` for the
  // empty label.
  return requests.map((request) => `${request.method} ${request.path.replace(/^https:\/\/uploads\.github\.com/, 'uploads:').replace(/&$/, '')}`)
}

describe('release-publish', () => {
  describe('validateVersion', () => {
    it('closes its message with what was not done', () => {
      assert.strictEqual(validateVersion(' 4.17.0 '), '4.17.0')
      assert.throws(() => validateVersion('4.17.0-beta.1'), /not a version this action can release.*Nothing was published/s)
      assert.throws(() => validateVersion(''), /No version was given.*Nothing was published/s)
    })
  })

  describe('readTarget', () => {
    it('takes a hash or a branch name, never a ref or nothing', () => {
      assert.strictEqual(readTarget(` ${SHA} `), SHA)
      assert.strictEqual(readTarget('main'), 'main')
      assert.throws(() => readTarget(''), /No target was given.*base-sha/s)
      assert.throws(() => readTarget('refs/heads/main'), /not a ref/)
    })
  })

  describe('resolveTarget', () => {
    it('returns a hash as it is, without asking the API', async () => {
      const { github, requests } = await octokitFor([])

      assert.strictEqual(await resolveTarget({ github, owner: 'stellarwp', repo: 'plugin', target: SHA }), SHA)
      assert.deepStrictEqual(requests, [])
    })

    it('resolves a branch name to its tip', async () => {
      const { github } = await octokitFor([{ method: 'GET', path: API.branch, body: { commit: { sha: SHA } } }])

      assert.strictEqual(await resolveTarget({ github, owner: 'stellarwp', repo: 'plugin', target: 'main' }), SHA)
    })

    it('refuses a name that is neither a hash nor a branch', async () => {
      const { github } = await octokitFor([])

      await assert.rejects(
        resolveTarget({ github, owner: 'stellarwp', repo: 'plugin', target: 'nope' }),
        /'nope' is not a commit hash, and the repository has no branch by that name/
      )
    })
  })

  describe('readTitle', () => {
    it('is the version unless a title was given', () => {
      assert.strictEqual(readTitle('', '4.17.0'), '4.17.0')
      assert.strictEqual(readTitle(' Maintenance Release 4.17.0 ', '4.17.0'), 'Maintenance Release 4.17.0')
    })
  })

  describe('readNotesFile', () => {
    it('reads the file from the checkout, and names it when it is missing', () => {
      const cwd = checkoutWith({ 'notes.md': '* Fixed a thing\n' })

      assert.strictEqual(readNotesFile('', cwd), null)
      assert.strictEqual(readNotesFile('notes.md', cwd), '* Fixed a thing\n')
      assert.throws(() => readNotesFile('missing.md', cwd), /notes file missing\.md could not be read.*Nothing was published/s)
    })
  })

  describe('readFiles', () => {
    it('lists one asset per line, each checked to be a file in the checkout', () => {
      const cwd = checkoutWith({ 'build/plugin.zip': 'zip', 'readme.txt': 'readme' })

      assert.deepStrictEqual(readFiles('', cwd), [])
      assert.deepStrictEqual(
        readFiles('\nbuild/plugin.zip\n  readme.txt \n', cwd).map(({ name, size }) => ({ name, size })),
        [
          { name: 'plugin.zip', size: 3 },
          { name: 'readme.txt', size: 6 },
        ]
      )
      assert.throws(() => readFiles('build/plugin.zip\nbuild', cwd), /^Error: build, listed in files, is not a file/)
      assert.throws(() => readFiles('missing.zip', cwd), /missing\.zip, listed in files, is not a file.*Nothing was published/s)
    })
  })

  describe('previousVersion', () => {
    it('picks the highest published version below the one released, for a hotfix on an older line too', () => {
      const releases = [
        { tag_name: '2.1.46', draft: false },
        { tag_name: '2.1.38.2', draft: false },
        { tag_name: '2.1.38.1', draft: false },
        { tag_name: '2.1.38.3', draft: true },
        { tag_name: 'v2.0.0', draft: false },
        { tag_name: '2.1.40', draft: false },
      ]

      assert.strictEqual(previousVersion('2.1.38.3', releases), '2.1.38.2')
      assert.strictEqual(previousVersion('2.1.47', releases), '2.1.46')
      assert.strictEqual(previousVersion('2.1.41', releases), '2.1.40')
    })

    it('finds nothing below the first release, or among drafts and tags that are not plain versions', () => {
      assert.strictEqual(previousVersion('1.0.0', [{ tag_name: '1.1.0', draft: false }]), null)
      assert.strictEqual(previousVersion('2.0.0', [{ tag_name: '1.9.0', draft: true }, { tag_name: 'v1.8.0', draft: false }]), null)
      assert.strictEqual(previousVersion('2.0.0', []), null)
    })
  })

  describe('makeLatest', () => {
    it('keeps "Latest" on a newer release when an older line gets a hotfix', () => {
      assert.strictEqual(makeLatest('4.17.0', null), 'true')
      assert.strictEqual(makeLatest('4.17.0', '4.16.0'), 'true')
      assert.strictEqual(makeLatest('4.17.0', '4.17.0.1'), 'false')
      assert.strictEqual(makeLatest('4.16.1', '4.17.0'), 'false')
      // A latest whose tag is not a plain version is not compared.
      assert.strictEqual(makeLatest('4.16.1', 'v4.17.0'), 'true')
    })
  })

  describe('runPublish', () => {
    it('publishes the release at the commit, titled with the version, with generated notes', async (t) => {
      const { github, requests } = await octokitFor([...FRESH, { method: 'POST', path: API.releases, status: 201, body: { id: 77, html_url: RELEASE_URL } }])
      const { core, outputs, summary } = await coreWithOutputs(t)

      await runPublish({ github, core, env: publishEnv(), cwd: checkoutWith() })

      assert.deepStrictEqual(requested(requests), [
        `GET ${API.releaseByTag}`,
        `GET ${API.tag}`,
        `GET ${API.latest}`,
        `GET ${API.list}`,
        `POST ${API.notes}`,
        `POST ${API.releases}`,
        // The tag, read again once the release exists: it has to point at the commit asked for.
        `GET ${API.tag}`,
      ])
      // The notes start at the published version right below this one, chosen here rather than
      // left to GitHub.
      assert.deepStrictEqual(requests[4].body, { tag_name: '4.17.0', target_commitish: SHA, previous_tag_name: '4.16.0' })
      assert.deepStrictEqual(requests[5].body, {
        tag_name: '4.17.0',
        target_commitish: SHA,
        name: '4.17.0',
        body: '## What changed\n* Fix (#12)',
        make_latest: 'true',
      })
      assert.deepStrictEqual(outputs(), { published: 'true', 'release-url': RELEASE_URL, sha: SHA })
      assert.match(summary(), /Published release 4\.17\.0 at `0123456`/)
    })

    it('leaves the start of the notes to GitHub when no published release is below the version', async (t) => {
      const { github, requests } = await octokitFor([
        { method: 'POST', path: API.notes, body: { body: 'first' } },
        { method: 'GET', path: API.latest, status: 404, body: { message: 'Not Found' } },
        { method: 'GET', path: API.list, body: [{ id: 1, tag_name: '4.17.0', draft: true }] },
        { method: 'POST', path: API.releases, status: 201, body: { id: 77, html_url: RELEASE_URL } },
      ])
      const { core, logged } = await coreWithOutputs(t)

      await runPublish({ github, core, env: publishEnv(), cwd: checkoutWith() })

      const notes = requests.find((request) => request.path === API.notes)
      assert.deepStrictEqual(notes.body, { tag_name: '4.17.0', target_commitish: SHA })
      assert.match(logged(), /No published release is below this version/)
    })

    it('fails when the releases cannot be listed, rather than guessing where the notes start', async (t) => {
      const { github, requests } = await octokitFor([
        { method: 'GET', path: API.latest, body: { tag_name: '4.16.0' } },
        { method: 'GET', path: API.list, status: 500, body: { message: 'boom' } },
      ])
      const { core } = await coreWithOutputs(t)

      await assert.rejects(runPublish({ github, core, env: publishEnv(), cwd: checkoutWith() }), /Listing the releases failed \(HTTP 500\).*Nothing was published/s)
      assert.ok(!requested(requests).some((line) => line.startsWith('POST')), 'nothing is created')
    })

    it('publishes at the tip of a branch given as target, with the title and the notes file', async (t) => {
      const cwd = checkoutWith({ 'notes.md': '= 4.17.0 =\n* Fixed a thing\n' })
      const { github, requests } = await octokitFor([
        { method: 'GET', path: API.branch, body: { commit: { sha: SHA } } },
        { method: 'GET', path: API.latest, body: { tag_name: '4.16.0' } },
        { method: 'GET', path: API.list, body: RELEASES },
        { method: 'POST', path: API.releases, status: 201, body: { id: 77, html_url: RELEASE_URL } },
      ])
      const { core } = await coreWithOutputs(t)

      await runPublish({
        github,
        core,
        env: publishEnv({ INPUT_TARGET: 'main', INPUT_TITLE: 'Maintenance Release 4.17.0', INPUT_NOTES_FILE: 'notes.md' }),
        cwd,
      })

      // No generated notes were asked for: the file is the body.
      assert.ok(!requested(requests).includes(`POST ${API.notes}`))
      assert.deepStrictEqual(requests.find((request) => request.method === 'POST' && request.path === API.releases).body, {
        tag_name: '4.17.0',
        target_commitish: SHA,
        name: 'Maintenance Release 4.17.0',
        body: '= 4.17.0 =\n* Fixed a thing\n',
        make_latest: 'true',
      })
    })

    it('does not take "Latest" from a newer release when it is a hotfix on an older line', async (t) => {
      const { github, requests } = await octokitFor([
        { method: 'POST', path: API.notes, body: { body: 'notes' } },
        { method: 'GET', path: API.latest, body: { tag_name: '4.18.0' } },
        { method: 'GET', path: API.list, body: [{ id: 61, tag_name: '4.18.0', draft: false }, ...RELEASES] },
        { method: 'POST', path: API.releases, status: 201, body: { id: 77, html_url: RELEASE_URL } },
      ])
      const { core, logged } = await coreWithOutputs(t)

      await runPublish({ github, core, env: publishEnv(), cwd: checkoutWith() })

      assert.strictEqual(requests.find((request) => request.method === 'POST' && request.path === API.releases).body.make_latest, 'false')
      assert.match(logged(), /below the current latest release/)
      // The notes start at the release below the hotfix, not at the newer 4.18.0.
      assert.strictEqual(requests.find((request) => request.path === API.notes).body.previous_tag_name, '4.16.0')
    })

    it('takes "Latest" when the repository has no release yet', async (t) => {
      const { github, requests } = await octokitFor([
        { method: 'POST', path: API.notes, body: { body: 'notes' } },
        { method: 'GET', path: API.list, body: [] },
        { method: 'POST', path: API.releases, status: 201, body: { id: 77, html_url: RELEASE_URL } },
      ])
      const { core } = await coreWithOutputs(t)

      await runPublish({ github, core, env: publishEnv(), cwd: checkoutWith() })

      assert.strictEqual(requests.find((request) => request.method === 'POST' && request.path === API.releases).body.make_latest, 'true')
    })

    it('uploads the files to a draft and publishes it last, so the release is never public without them', async (t) => {
      const cwd = checkoutWith({ 'build/plugin.zip': 'PK zip bytes', 'plugin.pot': 'msgid' })
      const { github, requests } = await octokitFor([
        ...FRESH,
        { method: 'POST', path: API.releases, status: 201, body: { id: 77, html_url: RELEASE_URL, upload_url: 'https://uploads.github.com/repos/stellarwp/plugin/releases/77/assets{?name,label}' } },
        { method: 'POST', path: API.assets, status: 201, body: { id: 1 } },
        { method: 'PATCH', path: API.release, body: { id: 77, html_url: RELEASE_URL } },
      ])
      const { core, outputs, summary, logged } = await coreWithOutputs(t)

      await runPublish({ github, core, env: publishEnv({ INPUT_FILES: 'build/plugin.zip\nplugin.pot\n' }), cwd })

      assert.deepStrictEqual(requested(requests), [
        `GET ${API.releaseByTag}`,
        `GET ${API.tag}`,
        `GET ${API.latest}`,
        `GET ${API.list}`,
        `POST ${API.notes}`,
        `POST ${API.releases}`,
        'POST uploads:/repos/stellarwp/plugin/releases/77/assets?name=plugin.zip',
        'POST uploads:/repos/stellarwp/plugin/releases/77/assets?name=plugin.pot',
        // The tag, read again before the draft is published: one made meanwhile would take over.
        `GET ${API.tag}`,
        `PATCH ${API.release}`,
      ])
      // Created as a draft, marked as the action's in its name, with no make_latest yet: that is
      // decided when it is published, and the mark comes off then.
      assert.deepStrictEqual(requests[5].body, {
        tag_name: '4.17.0',
        target_commitish: SHA,
        name: `4.17.0${DRAFT_MARK}`,
        body: '## What changed\n* Fix (#12)',
        draft: true,
      })
      assert.strictEqual(String(requests[6].body), 'PK zip bytes')
      assert.deepStrictEqual(requests[9].body, { draft: false, name: '4.17.0', make_latest: 'true' })
      assert.deepStrictEqual(outputs(), { published: 'true', 'release-url': RELEASE_URL, sha: SHA })
      assert.match(logged(), /Attached plugin\.zip.*Attached plugin\.pot/s)
      assert.match(summary(), /with `plugin\.zip`, `plugin\.pot`/)
    })

    it('deletes the draft when an upload fails, leaving no release and no tag', async (t) => {
      const cwd = checkoutWith({ 'build/plugin.zip': 'zip' })
      const { github, requests } = await octokitFor([
        ...FRESH,
        { method: 'POST', path: API.releases, status: 201, body: { id: 77, html_url: RELEASE_URL } },
        { method: 'POST', path: API.assets, status: 502, body: { message: 'bad gateway' } },
        { method: 'DELETE', path: API.release, status: 204, body: {} },
      ])
      const { core, outputs } = await coreWithOutputs(t)

      await assert.rejects(
        runPublish({ github, core, env: publishEnv({ INPUT_FILES: 'build/plugin.zip' }), cwd }),
        /Uploading plugin\.zip to the release failed \(HTTP 502\).*draft was deleted and no tag was made.*Nothing was published/s
      )

      assert.deepStrictEqual(requested(requests).slice(-2), ['POST uploads:/repos/stellarwp/plugin/releases/77/assets?name=plugin.zip', `DELETE ${API.release}`])
      assert.deepStrictEqual(outputs(), {})
    })

    it('deletes the draft and refuses when the tag appeared while the files were uploading', async (t) => {
      // The tag is absent at the first check and present before the draft is published: someone
      // made it meanwhile. Publishing would attach the release to that commit.
      const cwd = checkoutWith({ 'build/plugin.zip': 'zip' })
      const { github, requests } = await octokitFor([
        {
          method: 'GET',
          path: API.tag,
          responses: [
            { status: 404, body: { message: 'Not Found' } },
            { body: { ref: 'refs/tags/4.17.0', object: { sha: 'abcabcabcabcabcabcabcabcabcabcabcabcabca', type: 'commit' } } },
          ],
        },
        ...FRESH,
        { method: 'POST', path: API.releases, status: 201, body: { id: 77, html_url: RELEASE_URL } },
        { method: 'POST', path: API.assets, status: 201, body: { id: 1 } },
        { method: 'DELETE', path: API.release, status: 204, body: {} },
      ])
      const { core, outputs } = await coreWithOutputs(t)

      await assert.rejects(
        runPublish({ github, core, env: publishEnv({ INPUT_FILES: 'build/plugin.zip' }), cwd }),
        /The tag 4\.17\.0 was created at abcabca.* while the files were uploading.*not 0123456.*The draft was deleted and no tag was made.*Nothing was published/s
      )

      assert.deepStrictEqual(requested(requests).slice(-2), [`GET ${API.tag}`, `DELETE ${API.release}`])
      assert.ok(!requested(requests).includes(`PATCH ${API.release}`), 'the draft is never published')
      assert.deepStrictEqual(outputs(), {})
    })

    it('fails naming the commit when a tag made between the check and the publish took the release', async (t) => {
      // Without files there is no draft: the release is public by the time the tag is read again.
      const { github, requests } = await octokitFor([
        {
          method: 'GET',
          path: API.tag,
          responses: [
            { status: 404, body: { message: 'Not Found' } },
            { body: { ref: 'refs/tags/4.17.0', object: { sha: 'abcabcabcabcabcabcabcabcabcabcabcabcabca', type: 'commit' } } },
          ],
        },
        ...FRESH,
        { method: 'POST', path: API.releases, status: 201, body: { id: 77, html_url: RELEASE_URL } },
      ])
      const { core, outputs, summary } = await coreWithOutputs(t)

      await assert.rejects(
        runPublish({ github, core, env: publishEnv(), cwd: checkoutWith() }),
        /The tag 4\.17\.0 was created at abcabca.* between the check and the publish.*not to 0123456.*The release is public at https:\/\/github\.com\/stellarwp\/plugin\/releases\/tag\/4\.17\.0: delete it and the tag/s
      )

      assert.strictEqual(requested(requests).at(-1), `GET ${API.tag}`)
      assert.deepStrictEqual(outputs(), {})
      assert.match(summary(), /published at `abcabca`, not at `0123456`/)
    })

    it('deletes the draft when publishing it fails, as when a tag ruleset refuses the tag', async (t) => {
      const cwd = checkoutWith({ 'build/plugin.zip': 'zip' })
      const { github, requests } = await octokitFor([
        ...FRESH,
        { method: 'POST', path: API.releases, status: 201, body: { id: 77, html_url: RELEASE_URL } },
        { method: 'POST', path: API.assets, status: 201, body: { id: 1 } },
        { method: 'PATCH', path: API.release, status: 422, body: { message: 'Tag creation is blocked by a ruleset' } },
        { method: 'DELETE', path: API.release, status: 204, body: {} },
      ])
      const { core, outputs } = await coreWithOutputs(t)

      await assert.rejects(
        runPublish({ github, core, env: publishEnv({ INPUT_FILES: 'build/plugin.zip' }), cwd }),
        /Publishing the draft failed \(HTTP 422\): Tag creation is blocked.*The draft was deleted and no tag was made.*Nothing was published/s
      )

      assert.deepStrictEqual(requested(requests).slice(-2), [`PATCH ${API.release}`, `DELETE ${API.release}`])
      assert.deepStrictEqual(outputs(), {})
    })

    it('says where to delete the draft by hand when deleting it fails too', async (t) => {
      const cwd = checkoutWith({ 'build/plugin.zip': 'zip' })
      const { github } = await octokitFor([
        ...FRESH,
        { method: 'POST', path: API.releases, status: 201, body: { id: 77, html_url: RELEASE_URL } },
        { method: 'POST', path: API.assets, status: 502, body: { message: 'bad gateway' } },
        { method: 'DELETE', path: API.release, status: 500, body: { message: 'boom' } },
      ])
      const { core } = await coreWithOutputs(t)

      await assert.rejects(
        runPublish({ github, core, env: publishEnv({ INPUT_FILES: 'build/plugin.zip' }), cwd }),
        /Uploading plugin\.zip.*The draft could not be deleted \(HTTP 500\): delete it by hand at https:\/\/github\.com\/stellarwp\/plugin\/releases\/tag\/4\.17\.0\. No tag was made/s
      )
    })

    it('leaves alone a draft of the version a person made by hand', async (t) => {
      // Same tag name, no mark: someone is writing the notes for 4.17.0 in the GitHub UI.
      const theirs = { id: 69, tag_name: '4.17.0', name: '4.17.0', draft: true, html_url: 'https://github.com/stellarwp/plugin/releases/untagged-theirs' }
      const { github, requests } = await octokitFor([
        { method: 'POST', path: API.notes, body: { body: 'notes' } },
        { method: 'GET', path: API.latest, body: { tag_name: '4.16.0' } },
        { method: 'GET', path: API.list, body: [theirs, ...RELEASES] },
        { method: 'POST', path: API.releases, status: 201, body: { id: 77, html_url: RELEASE_URL } },
      ])
      const { core, outputs } = await coreWithOutputs(t)

      await runPublish({ github, core, env: publishEnv(), cwd: checkoutWith() })

      assert.ok(!requested(requests).some((line) => line.startsWith('DELETE')), 'nothing is deleted')
      assert.strictEqual(outputs().published, 'true')
    })

    it('deletes a draft of the version left behind by an earlier run before publishing', async (t) => {
      // A run cancelled while uploading leaves its draft, named with the mark; getReleaseByTag does
      // not return drafts.
      const stale = { id: 70, tag_name: '4.17.0', name: `4.17.0${DRAFT_MARK}`, draft: true, html_url: 'https://github.com/stellarwp/plugin/releases/untagged-abc' }
      const { github, requests } = await octokitFor([
        { method: 'POST', path: API.notes, body: { body: 'notes' } },
        { method: 'GET', path: API.latest, body: { tag_name: '4.16.0' } },
        { method: 'GET', path: API.list, body: [stale, ...RELEASES] },
        { method: 'DELETE', path: '/repos/stellarwp/plugin/releases/70', status: 204, body: {} },
        { method: 'POST', path: API.releases, status: 201, body: { id: 77, html_url: RELEASE_URL } },
      ])
      const { core, outputs, logged } = await coreWithOutputs(t)

      await runPublish({ github, core, env: publishEnv(), cwd: checkoutWith() })

      assert.deepStrictEqual(requested(requests).slice(4), ['DELETE /repos/stellarwp/plugin/releases/70', `POST ${API.notes}`, `POST ${API.releases}`, `GET ${API.tag}`])
      assert.match(logged(), /Deleted a draft of 4\.17\.0 left behind by an earlier run/)
      assert.strictEqual(outputs().published, 'true')
    })

    it('warns and goes on when a draft left behind cannot be deleted', async (t) => {
      const stale = { id: 70, tag_name: '4.17.0', name: `4.17.0${DRAFT_MARK}`, draft: true, html_url: 'https://github.com/stellarwp/plugin/releases/untagged-abc' }
      const { github } = await octokitFor([
        { method: 'POST', path: API.notes, body: { body: 'notes' } },
        { method: 'GET', path: API.latest, body: { tag_name: '4.16.0' } },
        { method: 'GET', path: API.list, body: [stale] },
        { method: 'DELETE', path: '/repos/stellarwp/plugin/releases/70', status: 403, body: { message: 'forbidden' } },
        { method: 'POST', path: API.releases, status: 201, body: { id: 77, html_url: RELEASE_URL } },
      ])
      const { core, outputs, logged } = await coreWithOutputs(t)

      await runPublish({ github, core, env: publishEnv(), cwd: checkoutWith() })

      assert.match(logged(), /::warning::A draft of 4\.17\.0 left behind by an earlier run could not be deleted \(HTTP 403\): delete it by hand at https:\/\/github\.com\/stellarwp\/plugin\/releases\/untagged-abc/)
      assert.strictEqual(outputs().published, 'true')
    })

    it('refuses a missing file before creating anything', async (t) => {
      const { github, requests } = await octokitFor(FRESH)
      const { core } = await coreWithOutputs(t)

      await assert.rejects(
        runPublish({ github, core, env: publishEnv({ INPUT_FILES: 'build/plugin.zip' }), cwd: checkoutWith() }),
        /build\/plugin\.zip, listed in files, is not a file/
      )
      assert.deepStrictEqual(requests, [])
    })

    it('skips a release that already exists, so a retry succeeds', async (t) => {
      const { github, requests } = await octokitFor([{ method: 'GET', path: API.releaseByTag, body: { html_url: RELEASE_URL } }])
      const { core, outputs, logged } = await coreWithOutputs(t)

      await runPublish({ github, core, env: publishEnv(), cwd: checkoutWith() })

      assert.deepStrictEqual(requested(requests), [`GET ${API.releaseByTag}`])
      assert.deepStrictEqual(outputs(), { published: 'skipped', 'release-url': RELEASE_URL, sha: '' })
      assert.match(logged(), /4\.17\.0 is already published/)
    })

    it('refuses a tag that exists without a release, rather than releasing whatever it points at', async (t) => {
      const { github, requests } = await octokitFor([{ method: 'GET', path: API.tag, body: { ref: 'refs/tags/4.17.0', object: { sha: 'abc' } } }])
      const { core } = await coreWithOutputs(t)

      await assert.rejects(runPublish({ github, core, env: publishEnv(), cwd: checkoutWith() }), /tag 4\.17\.0 already exists, but there is no published release/)
      assert.deepStrictEqual(requested(requests), [`GET ${API.releaseByTag}`, `GET ${API.tag}`])
    })

    it('fails on an API error reading the release rather than publishing twice', async (t) => {
      const { github } = await octokitFor([{ method: 'GET', path: API.releaseByTag, status: 500, body: { message: 'boom' } }])
      const { core } = await coreWithOutputs(t)

      await assert.rejects(runPublish({ github, core, env: publishEnv(), cwd: checkoutWith() }), /Reading the release for 4\.17\.0 failed.*500.*Nothing was published/s)
    })

    it('refuses a wrong version or an empty target before asking the API anything', async (t) => {
      const { github, requests } = await octokitFor([])
      const { core } = await coreWithOutputs(t)

      await assert.rejects(runPublish({ github, core, env: publishEnv({ INPUT_VERSION: 'v4.17.0' }), cwd: checkoutWith() }), /not a version this action can release/)
      await assert.rejects(runPublish({ github, core, env: publishEnv({ INPUT_TARGET: '' }), cwd: checkoutWith() }), /No target was given/)
      await assert.rejects(runPublish({ github, core, env: publishEnv({ GITHUB_REPOSITORY: '' }), cwd: checkoutWith() }), /GITHUB_REPOSITORY is not set/)
      assert.deepStrictEqual(requests, [])
    })
  })
})
