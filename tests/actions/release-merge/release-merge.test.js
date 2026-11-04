'use strict'

const { describe, it } = require('node:test')
const assert = require('node:assert')

const {
  runMerge,
  runPreflight,
  validateVersion,
  validateBranch,
  readHead,
  mergeMessage,
  isConflict,
} = require('../../../.github/actions/release-merge/release-merge.js')
const { coreWithOutputs, octokitFor } = require('../../support/actions.js')

/**
 * The environment the manifest hands the merge step.
 *
 * @param {object} overrides Inputs to change.
 *
 * @returns {object} The environment.
 */
function mergeEnv(overrides = {}) {
  return {
    INPUT_BRANCH: 'release/M26.test',
    INPUT_VERSION: '4.17.0',
    INPUT_BASE_BRANCH: 'main',
    INPUT_DEVELOP_BRANCH: 'develop',
    GITHUB_REPOSITORY: 'stellarwp/plugin',
    ...overrides,
  }
}

/** The .puprc of the fixture: the plugin header and the readme's Stable tag hold the version. */
const PUPRC = {
  paths: {
    versions: [
      { file: 'plugin.php', regex: '(Version: )(.+)' },
      { file: 'readme.txt', regex: '(Stable tag: )(.+)' },
    ],
  },
}

/** The tips of the three branches, as a plugin repository has them after release prep. */
const TIP = {
  'release/M26.test': 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  main: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  develop: 'cccccccccccccccccccccccccccccccccccccccc',
}

/** The merge commits GitHub answers with: the release on main, then main on develop. */
const MERGED = {
  main: 'dddddddddddddddddddddddddddddddddddddddd',
  develop: 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
}

/** The commit a published 4.17.0 is tagged at, and the tag object of an annotated one. */
const TAG_COMMIT = 'ffffffffffffffffffffffffffffffffffffffff'
const TAG_OBJECT = '1111111111111111111111111111111111111111'

const REPO = '/repos/stellarwp/plugin'

/** The repository paths the action reads and writes, as a real Octokit spells them. */
const API = {
  tag: `${REPO}/git/ref/tags%2F4.17.0`,
  tagObject: `${REPO}/git/tags/${TAG_OBJECT}`,
  releaseByTag: `${REPO}/releases/tags/4.17.0`,
  branch: (name) => `${REPO}/branches/${encodeURIComponent(name)}`,
  // The files are read at the release branch's tip, the commit, not at the branch by name.
  file: (name, ref = TIP['release/M26.test']) => `${REPO}/contents/${name}?ref=${encodeURIComponent(ref)}`,
  compare: (sha, ref = TIP['release/M26.test']) => `${REPO}/compare/${encodeURIComponent(`${ref}...${sha}`)}`,
  merges: `${REPO}/merges`,
}

const RELEASE_URL = 'https://github.com/stellarwp/plugin/releases/tag/4.17.0'

/** Rules under which the version is tagged and its release published, as a retry finds. */
const PUBLISHED = [
  { method: 'GET', path: API.tag, body: { ref: 'refs/tags/4.17.0', object: { sha: TAG_COMMIT, type: 'commit' } } },
  { method: 'GET', path: API.releaseByTag, body: { html_url: RELEASE_URL } },
]

/**
 * Rules for the branches the action reads: each answers with its tip.
 *
 * @param {string[]} names The branches the repository has.
 *
 * @returns {object[]} One rule per branch.
 */
function branches(names = Object.keys(TIP)) {
  return names.map((name) => ({ method: 'GET', path: API.branch(name), body: { name, commit: { sha: TIP[name] } } }))
}

/**
 * Rules for the files the action reads from the release branch, as the contents endpoint sends
 * them. A file set to null is absent: no rule, so the read answers 404.
 *
 * @param {object} contents File name to contents; the fixture's defaults hold 4.17.0 everywhere.
 *
 * @returns {object[]} One rule per present file.
 */
function files(contents = {}) {
  const all = {
    '.puprc': JSON.stringify(PUPRC),
    'plugin.php': 'Version: 4.17.0\n',
    'readme.txt': 'Stable tag: 4.17.0\n',
    ...contents,
  }

  return Object.entries(all)
    .filter(([, body]) => body !== null)
    .map(([name, body]) => ({
      method: 'GET',
      path: API.file(name),
      body: { type: 'file', path: name, encoding: 'base64', content: Buffer.from(body).toString('base64') },
    }))
}

/** What the merge endpoint answers: a merge commit, nothing to merge, or a refusal. */
const MERGE = {
  main: { status: 201, body: { sha: MERGED.main } },
  develop: { status: 201, body: { sha: MERGED.develop } },
  done: { status: 204 },
  conflict: { status: 409, body: { message: 'Merge conflict' } },
  moved: { status: 409, body: { message: 'Base branch was modified. Review and try the merge again.' } },
}

/**
 * The rule for the merge endpoint, answering each request with the next entry.
 *
 * @param {object[]} responses What each merge request is answered with, in order.
 *
 * @returns {object} The rule.
 */
function merges(responses) {
  return { method: 'POST', path: API.merges, responses }
}

/**
 * The rules of the common case: no tag, three branches, a prepared release branch, both merges made.
 *
 * @param {object}   options
 * @param {object[]} options.tag      Rules for the tag and release reads; none for an untagged version.
 * @param {string[]} options.branches The branches the repository has.
 * @param {object}   options.files    Files of the release branch to change from the fixture.
 * @param {object[]} options.merges   What the merge requests are answered with.
 * @param {object[]} options.extra    Any other rule.
 *
 * @returns {object[]} The rules.
 */
function repositoryWith({
  tag = [],
  branches: names = Object.keys(TIP),
  files: contents = {},
  merges: answers = [MERGE.main, MERGE.develop],
  extra = [],
} = {}) {
  return [...tag, ...branches(names), ...files(contents), merges(answers), ...extra]
}

/**
 * Each request as `METHOD path`, for asserting what the action asked the API and in which order.
 *
 * @param {object[]} requests The requests recordingFetch recorded.
 *
 * @returns {string[]} One line per request.
 */
function requested(requests) {
  return requests.map((request) => `${request.method} ${request.path}`)
}

/**
 * The bodies of the merge requests, in order.
 *
 * @param {object[]} requests The requests recordingFetch recorded.
 *
 * @returns {object[]} `{base, head, commit_message}` per merge asked for.
 */
function mergesAsked(requests) {
  return requests.filter((request) => request.method === 'POST' && request.path === API.merges).map((request) => request.body)
}

describe('release-merge', () => {
  describe('validateVersion', () => {
    it('accepts three or four numeric parts, the shape the dashboard publishes', () => {
      assert.strictEqual(validateVersion('4.17.0'), '4.17.0')
      assert.strictEqual(validateVersion('4.17.0.1'), '4.17.0.1')
    })

    it('reads the version without surrounding whitespace', () => {
      assert.strictEqual(validateVersion(' 4.17.0\n'), '4.17.0')
    })

    it('refuses an empty version, saying the run was dispatched without one', () => {
      assert.throws(() => validateVersion(''), /No version was given.*Nothing was merged/s)
      assert.throws(() => validateVersion(undefined), /No version was given/)
    })

    it('refuses a pre-release, a leading v and fewer than three parts', () => {
      for (const version of ['4.17.0-beta.1', 'v4.17.0', '4.17', '4.17.0.1.2', '4..0']) {
        assert.throws(() => validateVersion(version), /three or four numeric parts.*Nothing was merged/s, version)
      }
    })
  })

  describe('validateBranch', () => {
    it('takes an empty value only for an optional input, as develop-branch is', () => {
      assert.strictEqual(validateBranch('', 'develop-branch', { optional: true }), null)
      assert.strictEqual(validateBranch('  ', 'develop-branch', { optional: true }), null)
      assert.strictEqual(validateBranch('develop', 'develop-branch', { optional: true }), 'develop')
      assert.throws(() => validateBranch('', 'base-branch'), /No base-branch was given/)
    })

    it('accepts a branch name', () => {
      assert.strictEqual(validateBranch(' release/M26.test ', 'branch'), 'release/M26.test')
    })

    it('refuses an empty branch, naming the input', () => {
      assert.throws(() => validateBranch('', 'develop-branch'), /develop-branch.*Nothing was merged/s)
    })

    it('refuses a full ref, naming the branch to pass instead', () => {
      assert.throws(() => validateBranch('refs/heads/main', 'base-branch'), /pass the branch name.*'main'/s)
    })
  })

  describe('readHead', () => {
    it('reads a full commit hash, lower-cased, and an empty value as no check', () => {
      assert.strictEqual(readHead(` ${TIP.main.toUpperCase()} `), TIP.main)
      assert.strictEqual(readHead(''), null)
      assert.strictEqual(readHead(undefined), null)
    })

    it('refuses anything but a full hash: a branch name would be read at run time again', () => {
      for (const value of ['main', 'aaaaaaa', 'refs/heads/main', `${TIP.main}0`]) {
        assert.throws(() => readHead(value), /is not a full commit hash.*github\.sha.*Nothing was merged/s, value)
      }
    })
  })

  describe('mergeMessage', () => {
    it('names what was merged into what', () => {
      assert.strictEqual(mergeMessage('release/M26.test', 'main'), 'Merge release/M26.test into main')
    })
  })

  describe('isConflict', () => {
    it('recognises the 409 GitHub answers a conflicting merge with', () => {
      assert.strictEqual(isConflict({ status: 409, message: 'Merge conflict' }), true)
    })

    it('does not read the 409 for a base that moved, or any other failure, as a conflict', () => {
      assert.strictEqual(isConflict({ status: 409, message: 'Base branch was modified. Review and try the merge again.' }), false)
      assert.strictEqual(isConflict({ status: 404, message: 'Base does not exist' }), false)
      assert.strictEqual(isConflict({ status: 422, message: 'Validation Failed' }), false)
    })
  })

  describe('runPreflight', () => {
    it('finds nothing when the version was never tagged', async () => {
      const { github, requests } = await octokitFor([])

      const result = await runPreflight({ github, owner: 'stellarwp', repo: 'plugin', version: '4.17.0' })

      assert.deepStrictEqual(result, { tagged: false, tagSha: null, releaseUrl: null })
      assert.deepStrictEqual(requested(requests), [`GET ${API.tag}`])
    })

    it('finds the published release and the tagged commit when the tag exists, so a retry can go on', async () => {
      const { github, requests } = await octokitFor(PUBLISHED)

      const result = await runPreflight({ github, owner: 'stellarwp', repo: 'plugin', version: '4.17.0' })

      assert.deepStrictEqual(result, { tagged: true, tagSha: TAG_COMMIT, releaseUrl: RELEASE_URL })
      assert.deepStrictEqual(requested(requests), [`GET ${API.tag}`, `GET ${API.releaseByTag}`])
    })

    it('reads the commit behind an annotated tag, since the ref points at the tag object', async () => {
      const { github, requests } = await octokitFor([
        { method: 'GET', path: API.tag, body: { ref: 'refs/tags/4.17.0', object: { sha: TAG_OBJECT, type: 'tag' } } },
        { method: 'GET', path: API.tagObject, body: { sha: TAG_OBJECT, object: { sha: TAG_COMMIT, type: 'commit' } } },
        PUBLISHED[1],
      ])

      const result = await runPreflight({ github, owner: 'stellarwp', repo: 'plugin', version: '4.17.0' })

      assert.strictEqual(result.tagSha, TAG_COMMIT)
      assert.deepStrictEqual(requested(requests), [`GET ${API.tag}`, `GET ${API.tagObject}`, `GET ${API.releaseByTag}`])
    })

    it('refuses a tag that exists without a published release, before anything is merged', async () => {
      const { github } = await octokitFor([PUBLISHED[0]])

      await assert.rejects(
        runPreflight({ github, owner: 'stellarwp', repo: 'plugin', version: '4.17.0' }),
        /tag 4\.17\.0 already exists.*no published release.*Nothing was merged/s
      )
    })

    it('fails on an API error rather than reading it as an absent tag', async () => {
      const { github } = await octokitFor([{ method: 'GET', path: API.tag, status: 500, body: { message: 'boom' } }])

      await assert.rejects(
        runPreflight({ github, owner: 'stellarwp', repo: 'plugin', version: '4.17.0' }),
        /Reading tag 4\.17\.0 failed.*500/s
      )
    })
  })

  describe('runMerge', () => {
    it('merges the release into the base, then the merged commit back into develop, as two merge commits', async (t) => {
      const { github, requests } = await octokitFor(repositoryWith())
      const { core, outputs, summary } = await coreWithOutputs(t)

      await runMerge({ github, core, env: mergeEnv() })

      assert.deepStrictEqual(requested(requests), [
        `GET ${API.tag}`,
        `GET ${API.branch('release/M26.test')}`,
        `GET ${API.branch('main')}`,
        `GET ${API.branch('develop')}`,
        `GET ${API.file('.puprc')}`,
        `GET ${API.file('plugin.php')}`,
        `GET ${API.file('readme.txt')}`,
        `POST ${API.merges}`,
        `POST ${API.merges}`,
      ])
      assert.deepStrictEqual(mergesAsked(requests), [
        // The tip the version check read, not the branch by name: what was checked is what is merged.
        { base: 'main', head: TIP['release/M26.test'], commit_message: 'Merge release/M26.test into main' },
        // The commit just made on main, not main by name: develop gets exactly what is released.
        { base: 'develop', head: MERGED.main, commit_message: 'Merge main back into develop (release/M26.test)' },
      ])
      assert.deepStrictEqual(outputs(), {
        branch: 'release/M26.test',
        version: '4.17.0',
        'base-branch': 'main',
        // The merge commit: what the caller checks out, builds from and tags.
        'base-sha': MERGED.main,
        'develop-branch': 'develop',
        conflict: '',
      })
      assert.match(summary(), /merged `release\/M26\.test` into `main`, merged `main` into `develop`/)
    })

    it('checks, compares and merges the tip it read, so a commit pushed to the branch meanwhile is not merged', async (t) => {
      // The branch by name answers with a later commit that holds another version, as a push between
      // the tip read and the merge would leave it. Nothing the action does may reach it.
      const pushed = '9999999999999999999999999999999999999999'
      const byName = ['.puprc', 'plugin.php', 'readme.txt'].map((name) => ({
        method: 'GET',
        path: API.file(name, 'release/M26.test'),
        body: {
          type: 'file',
          path: name,
          encoding: 'base64',
          content: Buffer.from(name === '.puprc' ? JSON.stringify(PUPRC) : 'Version: 4.18.0\nStable tag: 4.18.0\n').toString('base64'),
        },
      }))
      const { github, requests } = await octokitFor(
        repositoryWith({
          tag: PUBLISHED,
          extra: [
            ...byName,
            { method: 'GET', path: API.compare(TAG_COMMIT), body: { status: 'ahead' } },
            { method: 'GET', path: API.compare(TAG_COMMIT, 'release/M26.test'), body: { status: 'diverged' } },
            { method: 'GET', path: API.branch('release/M26.test'), body: { commit: { sha: pushed } } },
          ],
        })
      )
      const { core } = await coreWithOutputs(t)

      await runMerge({ github, core, env: mergeEnv() })

      const tip = TIP['release/M26.test']
      assert.deepStrictEqual(
        requested(requests).filter((line) => line.includes('/contents/') || line.includes('/compare/')),
        [
          `GET ${API.file('.puprc', tip)}`,
          `GET ${API.file('plugin.php', tip)}`,
          `GET ${API.file('readme.txt', tip)}`,
          `GET ${API.compare(TAG_COMMIT, tip)}`,
        ],
        'every read names the tip, never the branch'
      )
      assert.strictEqual(mergesAsked(requests)[0].head, tip, 'the merge takes the tip that was checked')
      assert.ok(!JSON.stringify(requests).includes(pushed), 'the later commit is never read or merged')
    })

    it('merges when head is the commit the branch is at', async (t) => {
      const { github, requests } = await octokitFor(repositoryWith())
      const { core, outputs } = await coreWithOutputs(t)

      await runMerge({ github, core, env: mergeEnv({ INPUT_HEAD: TIP['release/M26.test'] }) })

      assert.strictEqual(mergesAsked(requests).length, 2)
      assert.strictEqual(outputs()['base-sha'], MERGED.main)
    })

    it('refuses a branch that moved after the run started, before reading a file or merging', async (t) => {
      // The run was started at `head`; a push during the wait for approval moved the branch to TIP.
      const head = '9999999999999999999999999999999999999999'
      const { github, requests } = await octokitFor(repositoryWith())
      const { core, outputs } = await coreWithOutputs(t)

      await assert.rejects(
        runMerge({ github, core, env: mergeEnv({ INPUT_HEAD: head }) }),
        /release\/M26\.test is at aaaa.*, not at 9999.*, the commit this run was started on.*Start the deploy again.*Nothing was merged/s
      )

      assert.deepStrictEqual(requested(requests), [`GET ${API.tag}`, `GET ${API.branch('release/M26.test')}`])
      assert.deepStrictEqual(mergesAsked(requests), [])
      assert.deepStrictEqual(outputs(), {})
    })

    it('refuses a head that is not a full commit hash before asking the API anything', async (t) => {
      const { github, requests } = await octokitFor(repositoryWith())
      const { core } = await coreWithOutputs(t)

      await assert.rejects(runMerge({ github, core, env: mergeEnv({ INPUT_HEAD: 'release/M26.test' }) }), /head 'release\/m26\.test' is not a full commit hash/)
      assert.deepStrictEqual(requests, [])
    })

    it('merges only into the base when develop-branch is empty, for a repository without develop', async (t) => {
      const { github, requests } = await octokitFor(repositoryWith({ branches: ['release/M26.test', 'main'], merges: [MERGE.main] }))
      const { core, outputs, summary, logged } = await coreWithOutputs(t)

      await runMerge({ github, core, env: mergeEnv({ INPUT_DEVELOP_BRANCH: '' }) })

      assert.ok(!requested(requests).some((line) => line.includes('develop')), requested(requests).join('\n'))
      assert.strictEqual(mergesAsked(requests).length, 1)
      assert.strictEqual(outputs()['base-sha'], MERGED.main)
      assert.strictEqual(outputs()['develop-branch'], '')
      assert.strictEqual(outputs().conflict, '')
      assert.match(logged(), /develop-branch is empty/)
      assert.match(summary(), /no develop branch/)
    })

    it('does nothing on a retry after a late failure: both merges answer already merged', async (t) => {
      // The publish step tagged the first run's merge commit, so the retry finds the tag with its
      // release, and main's tip is that commit.
      const { github, requests } = await octokitFor(
        repositoryWith({
          tag: [
            { method: 'GET', path: API.tag, body: { ref: 'refs/tags/4.17.0', object: { sha: MERGED.main, type: 'commit' } } },
            PUBLISHED[1],
          ],
          merges: [MERGE.done, MERGE.done],
          extra: [{ method: 'GET', path: API.compare(MERGED.main), body: { status: 'ahead' } }],
        }).map((rule) => (rule.path === API.branch('main') ? { ...rule, body: { name: 'main', commit: { sha: MERGED.main } } } : rule))
      )
      const { core, outputs, logged } = await coreWithOutputs(t)

      await runMerge({ github, core, env: mergeEnv() })

      assert.strictEqual(mergesAsked(requests).length, 2)
      assert.match(logged(), /main already has release\/M26\.test: nothing to merge/)
      assert.match(logged(), /develop already has main: nothing to merge/)
      assert.strictEqual(outputs().conflict, '')
      // Nothing was merged, so the commit to publish at is the base's tip, the one holding the release.
      assert.strictEqual(outputs()['base-sha'], MERGED.main)
      // The second merge still asks for that commit, which develop already has.
      assert.strictEqual(mergesAsked(requests)[1].head, MERGED.main)
    })

    it('says so when the release is already published from this branch, so the publish has nothing to do', async (t) => {
      const { github, requests } = await octokitFor(
        repositoryWith({
          tag: PUBLISHED,
          extra: [{ method: 'GET', path: API.compare(TAG_COMMIT), body: { status: 'ahead' } }],
        })
      )
      const { core, logged } = await coreWithOutputs(t)

      await runMerge({ github, core, env: mergeEnv() })

      assert.match(logged(), /4\.17\.0 is already published \(.*releases\/tag\/4\.17\.0\) from release\/M26\.test: nothing to publish again/)
      assert.ok(requested(requests).includes(`GET ${API.compare(TAG_COMMIT)}`), requested(requests).join('\n'))
      assert.strictEqual(mergesAsked(requests).length, 2)
    })

    it('refuses a published version whose tag does not contain the branch: the branch was not bumped', async (t) => {
      // 4.17.0 was released from main before this branch was cut, and the branch still says 4.17.0.
      const { github, requests } = await octokitFor(
        repositoryWith({
          tag: PUBLISHED,
          extra: [{ method: 'GET', path: API.compare(TAG_COMMIT), body: { status: 'diverged' } }],
        })
      )
      const { core } = await coreWithOutputs(t)

      await assert.rejects(
        runMerge({ github, core, env: mergeEnv() }),
        /tag 4\.17\.0 already exists and does not contain release\/M26\.test.*new version.*Nothing was merged/s
      )

      assert.deepStrictEqual(mergesAsked(requests), [])
    })

    it('prints the MERGE_CONFLICT marker and merges nothing when the release conflicts with the base', async (t) => {
      const { github, requests } = await octokitFor(repositoryWith({ merges: [MERGE.conflict] }))
      const { core, outputs, logged } = await coreWithOutputs(t)

      await assert.rejects(
        runMerge({ github, core, env: mergeEnv() }),
        /release\/M26\.test into main stopped on a conflict.*Nothing was merged into main/s
      )

      // The marker opens a line of its own: that is what the dashboard's detector anchors on.
      assert.match(logged(), /^MERGE_CONFLICT: .*release\/M26\.test.*main/m)
      assert.strictEqual(outputs().conflict, 'main')
      assert.strictEqual(mergesAsked(requests).length, 1, 'develop was never asked for')
    })

    it('prints the marker and names develop when the merged base conflicts with develop', async (t) => {
      const { github, requests } = await octokitFor(repositoryWith({ merges: [MERGE.main, MERGE.conflict] }))
      const { core, outputs, logged } = await coreWithOutputs(t)

      await assert.rejects(
        runMerge({ github, core, env: mergeEnv() }),
        /main into develop stopped on a conflict.*merges already done are kept.*Nothing was merged into develop/s
      )

      assert.match(logged(), /^MERGE_CONFLICT: .*main.*develop/m)
      assert.strictEqual(outputs().conflict, 'develop')
      // The release did reach the base: a retry finds that merge done and only redoes develop.
      assert.deepStrictEqual(mergesAsked(requests).map((merge) => merge.base), ['main', 'develop'])
    })

    it('fails without the marker when GitHub refuses the merge because the base moved', async (t) => {
      const { github } = await octokitFor(repositoryWith({ merges: [MERGE.moved] }))
      const { core, outputs, logged } = await coreWithOutputs(t)

      await assert.rejects(
        runMerge({ github, core, env: mergeEnv() }),
        /main moved while the merge was being made.*Base branch was modified.*Run this step again/s
      )

      assert.doesNotMatch(logged(), /MERGE_CONFLICT/)
      assert.strictEqual(outputs().conflict, undefined)
    })

    it('refuses a version the branch does not hold, naming the file, before merging anything', async (t) => {
      const { github, requests } = await octokitFor(repositoryWith())
      const { core } = await coreWithOutputs(t)

      await assert.rejects(
        runMerge({ github, core, env: mergeEnv({ INPUT_VERSION: '4.18.0' }) }),
        /release\/M26\.test holds 4\.17\.0 in plugin\.php, not 4\.18\.0.*prepared with.*Nothing was merged/s
      )

      assert.deepStrictEqual(mergesAsked(requests), [])
    })

    it('checks every version file .puprc lists, so a half-prepared branch is refused too', async (t) => {
      const { github, requests } = await octokitFor(repositoryWith({ files: { 'readme.txt': 'Stable tag: 4.16.0\n' } }))
      const { core } = await coreWithOutputs(t)

      await assert.rejects(runMerge({ github, core, env: mergeEnv() }), /release\/M26\.test holds 4\.16\.0 in readme\.txt, not 4\.17\.0/)
      assert.deepStrictEqual(mergesAsked(requests), [])
    })

    it("reads the version files at the release branch's tip, not from the base", async (t) => {
      const { github, requests } = await octokitFor(repositoryWith())
      const { core } = await coreWithOutputs(t)

      await runMerge({ github, core, env: mergeEnv() })

      const reads = requests.filter((request) => request.path.startsWith(`${REPO}/contents/`))
      assert.strictEqual(reads.length, 3)
      assert.ok(reads.every((request) => request.path.endsWith(`?ref=${TIP['release/M26.test']}`)), requested(reads).join('\n'))
    })

    it('refuses a branch whose version file does not match the .puprc regex', async (t) => {
      const { github } = await octokitFor(repositoryWith({ files: { 'readme.txt': 'No stable tag here\n' } }))
      const { core } = await coreWithOutputs(t)

      await assert.rejects(
        runMerge({ github, core, env: mergeEnv() }),
        /readme\.txt on release\/M26\.test holds no version.*\(Stable tag: \)\(\.\+\)/s
      )
    })

    it('names the file when the .puprc regex is not one JavaScript accepts', async (t) => {
      const puprc = { paths: { versions: [{ file: 'plugin.php', regex: '(Version: )(?<' }] } }
      const { github, requests } = await octokitFor(repositoryWith({ files: { '.puprc': JSON.stringify(puprc) } }))
      const { core } = await coreWithOutputs(t)

      await assert.rejects(
        runMerge({ github, core, env: mergeEnv() }),
        /regex \.puprc gives for plugin\.php \(\(Version: \)\(\?<\) is not one JavaScript accepts.*Nothing was merged/s
      )
      assert.deepStrictEqual(mergesAsked(requests), [])
    })

    it('refuses a branch whose version file is missing, naming it', async (t) => {
      const { github } = await octokitFor(repositoryWith({ files: { 'readme.txt': null } }))
      const { core } = await coreWithOutputs(t)

      await assert.rejects(
        runMerge({ github, core, env: mergeEnv() }),
        /readme\.txt, which \.puprc lists under paths\.versions, is not on release\/M26\.test/
      )
    })

    it('refuses a branch without a .puprc, since the version it holds cannot be read', async (t) => {
      const { github } = await octokitFor(repositoryWith({ files: { '.puprc': null } }))
      const { core } = await coreWithOutputs(t)

      await assert.rejects(runMerge({ github, core, env: mergeEnv() }), /No \.puprc on the branch.*Nothing was merged/s)
    })

    it('refuses a branch the repository does not have, before reading a file or merging', async (t) => {
      const { github, requests } = await octokitFor(repositoryWith({ branches: ['main', 'develop'] }))
      const { core } = await coreWithOutputs(t)

      await assert.rejects(
        runMerge({ github, core, env: mergeEnv() }),
        /'release\/M26\.test' is not a branch of stellarwp\/plugin\. Nothing was merged/
      )

      assert.deepStrictEqual(requested(requests), [`GET ${API.tag}`, `GET ${API.branch('release/M26.test')}`])
    })

    it('refuses a tag without a release before reading any branch', async (t) => {
      const { github, requests } = await octokitFor(repositoryWith({ tag: [PUBLISHED[0]] }))
      const { core } = await coreWithOutputs(t)

      await assert.rejects(runMerge({ github, core, env: mergeEnv() }), /no published release/)

      assert.deepStrictEqual(requested(requests), [`GET ${API.tag}`, `GET ${API.releaseByTag}`])
    })

    it('refuses the same branch twice, which would merge a branch into itself, before asking the API anything', async (t) => {
      const { github, requests } = await octokitFor(repositoryWith())
      const { core } = await coreWithOutputs(t)

      await assert.rejects(
        runMerge({ github, core, env: mergeEnv({ INPUT_DEVELOP_BRANCH: 'main' }) }),
        /base-branch and develop-branch are both 'main'/
      )
      await assert.rejects(runMerge({ github, core, env: mergeEnv({ INPUT_BRANCH: 'develop' }) }), /'develop' is also the develop branch/)
      assert.deepStrictEqual(requests, [])
    })

    it('fails when GITHUB_REPOSITORY is missing, since it does not know whose branches to merge', async (t) => {
      const { github, requests } = await octokitFor(repositoryWith())
      const { core } = await coreWithOutputs(t)

      await assert.rejects(runMerge({ github, core, env: mergeEnv({ GITHUB_REPOSITORY: '' }) }), /GITHUB_REPOSITORY is not set/)
      assert.deepStrictEqual(requests, [])
    })
  })
})
