'use strict'

const { describe, it } = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync } = require('node:child_process')

const {
  runMerge,
  runPublish,
  runPreflight,
  validateVersion,
  validateBranch,
  readPublish,
  authorizationHeader,
  gitAuthEnv,
  mergeMessage,
  isConflict,
  BOT_IDENTITY,
} = require('../../../.github/actions/release-merge/release-merge.js')
const { coreWithOutputs, recordedRealExec, recordingExec, octokitFor } = require('../../support/actions.js')

/**
 * Runs git in a directory and returns its trimmed output.
 *
 * @param {string}   dir  The directory to run in.
 * @param {string[]} args The git arguments.
 *
 * @returns {string} What git printed.
 */
function git(dir, ...args) {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

/**
 * Commits a file in a working copy.
 *
 * @param {string} dir      The working copy.
 * @param {string} name     The file, relative to it.
 * @param {string} contents What to write.
 * @param {string} message  The commit message.
 */
function commitFile(dir, name, contents, message) {
  fs.writeFileSync(path.join(dir, name), contents)
  git(dir, 'add', '-A')
  git(dir, 'commit', '--quiet', '-m', message)
}

/**
 * A remote repository with the three branches the action merges, as a plugin repository has them
 * after release prep: `main` at 4.16.0, `develop` ahead of it by one commit, and `release/M26.test`
 * holding the bump to 4.17.0.
 *
 * The remote is a bare repository on disk, so the action's fetches and pushes are real git against a
 * real remote, with no network.
 *
 * @param {object}  options
 * @param {boolean} options.baseConflicts    Also move `main` on the line the release changes, so
 *                                           merging the release into it conflicts.
 * @param {boolean} options.developConflicts Also move `develop` on that line, so merging `main` back
 *                                           into it conflicts.
 *
 * @returns {string} The bare repository.
 */
function remoteWith({ baseConflicts = false, developConflicts = false } = {}) {
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'release-merge-remote-'))
  const seed = fs.mkdtempSync(path.join(os.tmpdir(), 'release-merge-seed-'))

  git(bare, 'init', '--quiet', '--bare', '-b', 'main')

  git(seed, 'init', '--quiet', '-b', 'main')
  git(seed, 'config', 'user.name', 'Test')
  git(seed, 'config', 'user.email', 'test@example.com')
  commitFile(seed, 'plugin.php', 'Version: 4.16.0\n', 'Initial')

  git(seed, 'checkout', '--quiet', '-b', 'develop')
  commitFile(seed, 'develop.txt', 'work in progress\n', 'Develop moves on')
  if (developConflicts) {
    commitFile(seed, 'plugin.php', 'Version: 4.16.1-dev\n', 'Develop bumps its own version')
  }

  git(seed, 'checkout', '--quiet', '-b', 'release/M26.test', 'main')
  commitFile(seed, 'plugin.php', 'Version: 4.17.0\n', 'Prepare release/M26.test (4.17.0)')

  if (baseConflicts) {
    git(seed, 'checkout', '--quiet', 'main')
    commitFile(seed, 'plugin.php', 'Version: 4.16.0.1\n', 'Hotfix on main')
  }

  git(seed, 'remote', 'add', 'origin', bare)
  git(seed, 'push', '--quiet', 'origin', 'main', 'develop', 'release/M26.test')

  return bare
}

/**
 * The checkout the caller hands the action: a clone of the remote on its base branch, as
 * actions/checkout leaves it.
 *
 * @param {string}  bare    The remote.
 * @param {object}  options
 * @param {boolean} options.shallow Clone with `--depth 1`, the actions/checkout default.
 *
 * @returns {string} The checkout.
 */
function checkoutOf(bare, { shallow = false } = {}) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'release-merge-checkout-'))
  // A file:// URL rather than a path: git ignores --depth on a local-path clone.
  const args = ['clone', '--quiet', '--branch', 'main', ...(shallow ? ['--depth', '1'] : []), `file://${bare}`, work]

  execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })

  return work
}

/**
 * Tags a commit on the remote, as publishing a GitHub release does.
 *
 * @param {string} bare    The remote.
 * @param {string} version The tag.
 * @param {string} ref     The commit to tag, e.g. `main`.
 */
function tagRemote(bare, version, ref) {
  git(bare, 'tag', version, ref)
}

/**
 * The contents of a file on a branch of the remote.
 *
 * @param {string} bare   The remote.
 * @param {string} branch The branch.
 * @param {string} name   The file.
 *
 * @returns {string} Its contents.
 */
function fileOn(bare, branch, name) {
  return git(bare, 'show', `${branch}:${name}`)
}

/**
 * The environment the manifest hands the merge step, over the real one so that git is on the PATH.
 *
 * @param {object} overrides Inputs to change.
 *
 * @returns {object} The environment.
 */
function mergeEnv(overrides = {}) {
  return {
    ...process.env,
    INPUT_BRANCH: 'release/M26.test',
    INPUT_VERSION: '4.17.0',
    INPUT_BASE_BRANCH: 'main',
    INPUT_DEVELOP_BRANCH: 'develop',
    INPUT_TOKEN: 'test-token',
    GITHUB_REPOSITORY: 'stellarwp/plugin',
    GITHUB_SERVER_URL: 'https://github.com',
    ...overrides,
  }
}

/**
 * The environment the manifest hands the publish step.
 *
 * @param {object} overrides Inputs to change.
 *
 * @returns {object} The environment.
 */
function publishEnv(overrides = {}) {
  return {
    INPUT_VERSION: '4.17.0',
    INPUT_BASE_BRANCH: 'main',
    INPUT_PUBLISH: 'true',
    GITHUB_REPOSITORY: 'stellarwp/plugin',
    ...overrides,
  }
}

/** The repository paths the action reads and writes, as a real Octokit spells them. */
const API = {
  tag: '/repos/stellarwp/plugin/git/ref/tags%2F4.17.0',
  releaseByTag: '/repos/stellarwp/plugin/releases/tags/4.17.0',
  notes: '/repos/stellarwp/plugin/releases/generate-notes',
  releases: '/repos/stellarwp/plugin/releases',
}

const RELEASE_URL = 'https://github.com/stellarwp/plugin/releases/tag/4.17.0'

/** Rules under which the version has never been tagged, the common case. */
const UNTAGGED = []

/** Rules under which the version is tagged and its release published, as a retry finds. */
const PUBLISHED = [
  { method: 'GET', path: API.tag, body: { ref: 'refs/tags/4.17.0', object: { sha: 'abc' } } },
  { method: 'GET', path: API.releaseByTag, body: { html_url: RELEASE_URL } },
]

/**
 * Each call as `command arg arg…`, for asserting the order the action worked in.
 *
 * @param {object[]} calls The calls an exec recorded.
 *
 * @returns {string[]} One line per call.
 */
function sequence(calls) {
  return calls.map((call) => [call.command, ...call.args].join(' '))
}

/**
 * Each request as `METHOD path`, for asserting what the action asked the API.
 *
 * @param {object[]} requests The requests recordingFetch recorded.
 *
 * @returns {string[]} One line per request.
 */
function requested(requests) {
  return requests.map((request) => `${request.method} ${request.path}`)
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

  describe('readPublish', () => {
    it('reads an empty input and `true` as publish, the default', () => {
      assert.strictEqual(readPublish(''), true)
      assert.strictEqual(readPublish('true'), true)
      assert.strictEqual(readPublish(' TRUE '), true)
    })

    it('reads `false` as merge only', () => {
      assert.strictEqual(readPublish('false'), false)
    })

    it('refuses anything else, showing the two values', () => {
      assert.throws(() => readPublish('yes'), /publish 'yes'.*true.*false/s)
    })
  })

  describe('the git credentials', () => {
    it('builds the header actions/checkout would have stored, for the token', () => {
      const expected = Buffer.from('x-access-token:test-token').toString('base64')

      assert.strictEqual(authorizationHeader('test-token'), `AUTHORIZATION: basic ${expected}`)
    })

    it('hands the header to git through its environment, scoped to the server', () => {
      const env = gitAuthEnv('test-token', 'https://github.com')

      assert.deepStrictEqual(env, {
        GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
        GIT_CONFIG_VALUE_0: authorizationHeader('test-token'),
      })
    })

    it('scopes the header to a GitHub Enterprise server when the run is on one', () => {
      assert.strictEqual(
        gitAuthEnv('t', 'https://github.example.com/').GIT_CONFIG_KEY_0,
        'http.https://github.example.com/.extraheader'
      )
    })
  })

  describe('mergeMessage', () => {
    it('names what was merged into what', () => {
      assert.strictEqual(mergeMessage('release/M26.test', 'main'), 'Merge release/M26.test into main')
    })
  })

  describe('isConflict', () => {
    it('recognises the lines git prints on a conflict', () => {
      assert.strictEqual(
        isConflict({
          exitCode: 1,
          stdout: 'Auto-merging plugin.php\nCONFLICT (content): Merge conflict in plugin.php\nAutomatic merge failed; fix conflicts and then commit the result.\n',
          stderr: '',
        }),
        true
      )
    })

    it('does not read any other merge failure as a conflict', () => {
      assert.strictEqual(isConflict({ exitCode: 128, stdout: '', stderr: 'fatal: not something we can merge\n' }), false)
      assert.strictEqual(isConflict({ exitCode: 0, stdout: 'Already up to date.\n', stderr: '' }), false)
    })
  })

  describe('runPreflight', () => {
    it('finds nothing when the version was never tagged', async () => {
      const { github, requests } = await octokitFor(UNTAGGED)

      const result = await runPreflight({ github, owner: 'stellarwp', repo: 'plugin', version: '4.17.0' })

      assert.deepStrictEqual(result, { tagged: false, releaseUrl: null })
      assert.deepStrictEqual(requested(requests), [`GET ${API.tag}`])
    })

    it('finds the published release when the tag exists, so a retry can go on', async () => {
      const { github, requests } = await octokitFor(PUBLISHED)

      const result = await runPreflight({ github, owner: 'stellarwp', repo: 'plugin', version: '4.17.0' })

      assert.deepStrictEqual(result, { tagged: true, releaseUrl: RELEASE_URL })
      assert.deepStrictEqual(requested(requests), [`GET ${API.tag}`, `GET ${API.releaseByTag}`])
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
    it('merges the release into the base, the base back into develop, and pushes both', async (t) => {
      const bare = remoteWith()
      const cwd = checkoutOf(bare)
      const { github } = await octokitFor(UNTAGGED)
      const { core, outputs, summary } = await coreWithOutputs(t)
      const { exec } = await recordedRealExec()

      await runMerge({ github, core, exec, env: mergeEnv(), cwd })

      assert.strictEqual(fileOn(bare, 'main', 'plugin.php'), 'Version: 4.17.0')
      assert.strictEqual(fileOn(bare, 'develop', 'plugin.php'), 'Version: 4.17.0')
      assert.strictEqual(fileOn(bare, 'develop', 'develop.txt'), 'work in progress')
      assert.strictEqual(git(bare, 'log', '-1', '--format=%s', 'main'), 'Merge release/M26.test into main')
      assert.strictEqual(git(bare, 'log', '-1', '--format=%s', 'develop'), 'Merge main back into develop (release/M26.test)')
      assert.strictEqual(git(bare, 'log', '-1', '--format=%an <%ae>', 'main'), `${BOT_IDENTITY.name} <${BOT_IDENTITY.email}>`)
      // A merge commit, never a fast-forward, so the release shows as one in the history.
      assert.strictEqual(git(bare, 'rev-list', '--merges', '--count', 'main'), '1')

      assert.deepStrictEqual(outputs(), {
        branch: 'release/M26.test',
        version: '4.17.0',
        'base-branch': 'main',
        'develop-branch': 'develop',
        conflict: '',
      })
      assert.match(summary(), /release\/M26\.test.*main.*develop/s)
    })

    it('leaves the checkout on the merged base, for the steps that build from it', async (t) => {
      const bare = remoteWith()
      const cwd = checkoutOf(bare)
      const { github } = await octokitFor(UNTAGGED)
      const { core } = await coreWithOutputs(t)
      const { exec } = await recordedRealExec()

      await runMerge({ github, core, exec, env: mergeEnv(), cwd })

      assert.strictEqual(git(cwd, 'symbolic-ref', '--short', 'HEAD'), 'main')
      assert.strictEqual(git(cwd, 'rev-parse', 'HEAD'), git(bare, 'rev-parse', 'main'))
      assert.strictEqual(git(cwd, 'status', '--porcelain'), '')
    })

    it('hands the token to git only for the fetch and the pushes, through the environment', async (t) => {
      const bare = remoteWith()
      const cwd = checkoutOf(bare)
      const { github } = await octokitFor(UNTAGGED)
      const { core } = await coreWithOutputs(t)
      const { exec, calls } = await recordedRealExec()

      await runMerge({ github, core, exec, env: mergeEnv(), cwd })

      const remote = calls.filter((call) => /^(fetch|push)$/.test(call.args[0]))
      const local = calls.filter((call) => !/^(fetch|push)$/.test(call.args[0]))

      assert.strictEqual(remote.length, 3)
      for (const call of remote) {
        assert.strictEqual(call.options.env.GIT_CONFIG_VALUE_0, authorizationHeader('test-token'))
      }
      for (const call of local) {
        assert.strictEqual(call.options.env?.GIT_CONFIG_COUNT, undefined, sequence([call])[0])
      }
      // Nothing was written to the checkout's config either: git exits 1 on a key that is not set.
      assert.throws(() => git(cwd, 'config', '--local', '--get-all', 'http.https://github.com/.extraheader'))
    })

    it('does nothing on a retry after a late failure: the merges are no-ops and the pushes are empty', async (t) => {
      const bare = remoteWith()
      const first = checkoutOf(bare)
      const { github } = await octokitFor(UNTAGGED)
      const { core } = await coreWithOutputs(t)
      const { exec } = await recordedRealExec()

      await runMerge({ github, core, exec, env: mergeEnv(), cwd: first })
      const main = git(bare, 'rev-parse', 'main')
      const develop = git(bare, 'rev-parse', 'develop')
      // The publish step then tagged the merge, so the retry finds the tag with its release.
      tagRemote(bare, '4.17.0', 'main')
      const published = await octokitFor(PUBLISHED)

      const second = checkoutOf(bare)
      const retry = await coreWithOutputs(t)
      await runMerge({ github: published.github, core: retry.core, exec, env: mergeEnv(), cwd: second })

      assert.strictEqual(git(bare, 'rev-parse', 'main'), main)
      assert.strictEqual(git(bare, 'rev-parse', 'develop'), develop)
      assert.match(retry.logged(), /main already has release\/M26\.test/)
      assert.strictEqual(retry.outputs().conflict, '')
    })

    it('says so when the release is already published from this branch, so the publish step is expected to skip it', async (t) => {
      const bare = remoteWith()
      // A run that merged and published, then failed in a later step of the caller.
      tagRemote(bare, '4.17.0', 'release/M26.test')
      const cwd = checkoutOf(bare)
      const { github } = await octokitFor(PUBLISHED)
      const { core, logged } = await coreWithOutputs(t)
      const { exec } = await recordedRealExec()

      await runMerge({ github, core, exec, env: mergeEnv(), cwd })

      assert.match(logged(), /4\.17\.0 is already published.*publish step will skip it/s)
      assert.strictEqual(fileOn(bare, 'develop', 'plugin.php'), 'Version: 4.17.0')
    })

    it('refuses a published version whose tag does not contain the branch: the branch was not bumped', async (t) => {
      const bare = remoteWith()
      // 4.17.0 was released from main before this branch was cut, and the branch still says 4.17.0.
      tagRemote(bare, '4.17.0', 'main')
      const cwd = checkoutOf(bare)
      const main = git(bare, 'rev-parse', 'main')
      const develop = git(bare, 'rev-parse', 'develop')
      const { github } = await octokitFor(PUBLISHED)
      const { core } = await coreWithOutputs(t)
      const { exec, calls } = await recordedRealExec()

      await assert.rejects(
        runMerge({ github, core, exec, env: mergeEnv(), cwd }),
        /tag 4\.17\.0 already exists and does not contain release\/M26\.test.*new version.*Nothing was merged/s
      )

      assert.strictEqual(git(bare, 'rev-parse', 'main'), main)
      assert.strictEqual(git(bare, 'rev-parse', 'develop'), develop)
      // `git -c user.name=… merge --no-ff` is the merge; merge-base is only the ancestry check.
      assert.ok(!sequence(calls).some((line) => / merge --no-ff |^git push/.test(line)), sequence(calls).join('\n'))
    })

    it('prints the MERGE_CONFLICT marker and pushes nothing when the release conflicts with the base', async (t) => {
      const bare = remoteWith({ baseConflicts: true })
      const cwd = checkoutOf(bare)
      const main = git(bare, 'rev-parse', 'main')
      const develop = git(bare, 'rev-parse', 'develop')
      const { github } = await octokitFor(UNTAGGED)
      const { core, outputs, logged } = await coreWithOutputs(t)
      const { exec, calls } = await recordedRealExec()

      await assert.rejects(
        runMerge({ github, core, exec, env: mergeEnv(), cwd }),
        /release\/M26\.test into main stopped on a conflict.*Nothing was pushed to main/s
      )

      // The marker opens a line of its own: that is what the dashboard's detector anchors on.
      assert.match(logged(), /^MERGE_CONFLICT: .*release\/M26\.test.*main/m)
      assert.strictEqual(outputs().conflict, 'main')
      assert.strictEqual(git(bare, 'rev-parse', 'main'), main)
      assert.strictEqual(git(bare, 'rev-parse', 'develop'), develop)
      assert.ok(!sequence(calls).some((line) => line.startsWith('git push')), 'nothing was pushed')
      // The conflicted merge was abandoned, so the checkout is usable afterwards.
      assert.strictEqual(git(cwd, 'status', '--porcelain'), '')
      assert.throws(() => git(cwd, 'rev-parse', '--verify', '--quiet', 'MERGE_HEAD'))
    })

    it('prints the marker and leaves develop untouched when the base conflicts with develop', async (t) => {
      const bare = remoteWith({ developConflicts: true })
      const cwd = checkoutOf(bare)
      const develop = git(bare, 'rev-parse', 'develop')
      const { github } = await octokitFor(UNTAGGED)
      const { core, outputs, logged } = await coreWithOutputs(t)
      const { exec } = await recordedRealExec()

      await assert.rejects(
        runMerge({ github, core, exec, env: mergeEnv(), cwd }),
        /main into develop stopped on a conflict.*Nothing was pushed to develop/s
      )

      assert.match(logged(), /^MERGE_CONFLICT: .*main.*develop/m)
      assert.strictEqual(outputs().conflict, 'develop')
      // The release did reach the base: a retry finds that merge done and only redoes develop.
      assert.strictEqual(fileOn(bare, 'main', 'plugin.php'), 'Version: 4.17.0')
      assert.strictEqual(git(bare, 'rev-parse', 'develop'), develop)
      assert.strictEqual(git(cwd, 'status', '--porcelain'), '')
    })

    it('fetches the full history first when the caller made a shallow checkout', async (t) => {
      const bare = remoteWith()
      const cwd = checkoutOf(bare, { shallow: true })
      assert.strictEqual(git(cwd, 'rev-parse', '--is-shallow-repository'), 'true')
      const { github } = await octokitFor(UNTAGGED)
      const { core } = await coreWithOutputs(t)
      const { exec, calls } = await recordedRealExec()

      await runMerge({ github, core, exec, env: mergeEnv(), cwd })

      assert.ok(sequence(calls).some((line) => line.startsWith('git fetch --unshallow')), sequence(calls).join('\n'))
      assert.strictEqual(fileOn(bare, 'develop', 'plugin.php'), 'Version: 4.17.0')
    })

    it('refuses a tag without a release before touching git', async (t) => {
      const bare = remoteWith()
      const cwd = checkoutOf(bare)
      const { github } = await octokitFor([PUBLISHED[0]])
      const { core } = await coreWithOutputs(t)
      const { exec, calls } = await recordedRealExec()

      await assert.rejects(runMerge({ github, core, exec, env: mergeEnv(), cwd }), /no published release/)

      assert.ok(!sequence(calls).some((line) => /^git (fetch|push|checkout)| merge --no-ff /.test(line)), sequence(calls).join('\n'))
    })

    it('refuses a branch name git would refuse, before asking the API anything', async (t) => {
      const { github, requests } = await octokitFor(UNTAGGED)
      const { core } = await coreWithOutputs(t)
      const { exec } = recordingExec([{ command: 'git', args: /^check-ref-format .*release\/bad\.\.name/, exitCode: 1 }, { command: 'git' }])

      await assert.rejects(
        runMerge({ github, core, exec, env: mergeEnv({ INPUT_BRANCH: 'release/bad..name' }), cwd: os.tmpdir() }),
        /'release\/bad\.\.name' is not a valid branch name/
      )

      assert.deepStrictEqual(requests, [])
    })

    it('refuses the same branch twice, which would merge a branch into itself', async (t) => {
      const { github } = await octokitFor(UNTAGGED)
      const { core } = await coreWithOutputs(t)
      const { exec, calls } = recordingExec([{ command: 'git' }])

      await assert.rejects(
        runMerge({ github, core, exec, env: mergeEnv({ INPUT_DEVELOP_BRANCH: 'main' }), cwd: os.tmpdir() }),
        /base-branch and develop-branch are both 'main'/
      )
      assert.deepStrictEqual(calls, [])
    })

    it('fails when GITHUB_REPOSITORY is missing, since it does not know whose tags to read', async (t) => {
      const { github } = await octokitFor(UNTAGGED)
      const { core } = await coreWithOutputs(t)
      const { exec } = recordingExec([{ command: 'git' }])

      await assert.rejects(
        runMerge({ github, core, exec, env: mergeEnv({ GITHUB_REPOSITORY: '' }), cwd: os.tmpdir() }),
        /GITHUB_REPOSITORY is not set/
      )
    })
  })

  describe('runPublish', () => {
    it('publishes the release on the base, titled with the version, with generated notes', async (t) => {
      const { github, requests } = await octokitFor([
        { method: 'POST', path: API.notes, body: { name: '4.17.0', body: '## What changed\n* Fix (#12)' } },
        { method: 'POST', path: API.releases, status: 201, body: { html_url: RELEASE_URL } },
      ])
      const { core, outputs, summary } = await coreWithOutputs(t)

      await runPublish({ github, core, env: publishEnv() })

      assert.deepStrictEqual(requested(requests), [`GET ${API.releaseByTag}`, `POST ${API.notes}`, `POST ${API.releases}`])
      assert.deepStrictEqual(requests[1].body, { tag_name: '4.17.0', target_commitish: 'main' })
      assert.deepStrictEqual(requests[2].body, {
        tag_name: '4.17.0',
        target_commitish: 'main',
        name: '4.17.0',
        body: '## What changed\n* Fix (#12)',
      })
      assert.deepStrictEqual(outputs(), { published: 'true', 'release-url': RELEASE_URL })
      assert.match(summary(), /Published.*4\.17\.0/s)
    })

    it('skips a release that already exists, so a retry succeeds', async (t) => {
      const { github, requests } = await octokitFor([PUBLISHED[1]])
      const { core, outputs, logged } = await coreWithOutputs(t)

      await runPublish({ github, core, env: publishEnv() })

      assert.deepStrictEqual(requested(requests), [`GET ${API.releaseByTag}`])
      assert.deepStrictEqual(outputs(), { published: 'skipped', 'release-url': RELEASE_URL })
      assert.match(logged(), /4\.17\.0 is already published/)
    })

    it('publishes nothing when publish is false, and says so', async (t) => {
      const { github, requests } = await octokitFor([])
      const { core, outputs, logged } = await coreWithOutputs(t)

      await runPublish({ github, core, env: publishEnv({ INPUT_PUBLISH: 'false' }) })

      assert.deepStrictEqual(requests, [])
      assert.deepStrictEqual(outputs(), { published: 'false', 'release-url': '' })
      assert.match(logged(), /publish is false/)
    })

    it('fails on an API error reading the release rather than publishing twice', async (t) => {
      const { github } = await octokitFor([{ method: 'GET', path: API.releaseByTag, status: 500, body: { message: 'boom' } }])
      const { core } = await coreWithOutputs(t)

      await assert.rejects(runPublish({ github, core, env: publishEnv() }), /Reading the release for 4\.17\.0 failed.*500/s)
    })

    it('refuses a publish value that is neither true nor false', async (t) => {
      const { github, requests } = await octokitFor([])
      const { core } = await coreWithOutputs(t)

      await assert.rejects(runPublish({ github, core, env: publishEnv({ INPUT_PUBLISH: 'yes' }) }), /publish 'yes'/)
      assert.deepStrictEqual(requests, [])
    })
  })
})
