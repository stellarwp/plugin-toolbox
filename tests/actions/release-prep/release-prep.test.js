'use strict'

const { describe, it } = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const {
  runPrepare,
  runCommit,
  validateVersion,
  resolveDate,
  validateBranch,
  validatePupVersion,
  readPuprc,
  readChangeloggerStrategy,
  readVersion,
  pupDownloadUrl,
  pupReleaseUrl,
  pupCommands,
  parseRawDiff,
  commitMessage,
  compareVersions,
  readCurrentVersion,
} = require('../../../.github/actions/release-prep/release-prep.js')
const { coreWithOutputs, recordingExec, octokitFor } = require('../../support/actions.js')

/** A .puprc that bumps the plugin header and replaces TBDs under src/. */
const PUPRC = {
  paths: { versions: [{ file: 'plugin.php', regex: '(Version: )(.+)' }] },
  checks: { tbd: { dirs: ['src'] } },
}

/** A package.json with a changelogger config, as a repository using the stellarwp format has. */
const PACKAGE_JSON = { changelogger: { versioning: 'stellarwp', changesDir: 'changelog' } }

/** Today in UTC, the way the action resolves an empty or `today` date. */
const TODAY = new Date().toISOString().slice(0, 10)

/**
 * A temporary directory holding the given files, standing in for the checked-out repository.
 *
 * @param {object} files Each relative path mapped to its contents. An object is written as JSON.
 *
 * @returns {string} The directory.
 */
function checkoutWith(files = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'release-prep-'))

  for (const [name, contents] of Object.entries(files)) {
    const text = typeof contents === 'string' ? contents : JSON.stringify(contents)
    fs.writeFileSync(path.join(dir, name), text)
  }

  return dir
}

/**
 * The environment the manifest hands the prepare step, over a valid set of inputs.
 *
 * @param {object} overrides Inputs to change.
 *
 * @returns {object} The environment.
 */
function prepareEnv(overrides = {}) {
  return {
    INPUT_BRANCH: 'release/M26.jigglypuff',
    INPUT_VERSION: '4.17.0',
    INPUT_DATE: '',
    INPUT_PUP_VERSION: '2.0.0',
    RUNNER_TEMP: '/runner/temp',
    ...overrides,
  }
}

/**
 * Rules under which every command the prepare step runs succeeds.
 *
 * @param {object[]} before Rules that take precedence, to make one command fail.
 *
 * @returns {object[]} Rules for recordingExec.
 */
function allSucceed(before = []) {
  return [
    ...before,
    { command: 'git', args: /^check-ref-format / },
    { command: 'git', args: /^symbolic-ref /, stdout: 'release/M26.jigglypuff\n' },
    { command: 'curl' },
    { command: 'php', args: /get-version$/, stdout: '4.16.0\n' },
    { command: 'php', stdout: 'ok' },
  ]
}

/**
 * Each call as `command arg arg…`, for asserting the order the action worked in.
 *
 * @param {object[]} calls The calls recordingExec recorded.
 *
 * @returns {string[]} One line per call.
 */
function sequence(calls) {
  return calls.map((call) => [call.command, ...call.args].join(' '))
}

/**
 * Runs git in a directory and returns its trimmed output.
 *
 * @param {string}   dir  The directory to run in.
 * @param {string[]} args The git arguments.
 *
 * @returns {string} What git printed.
 */
function git(dir, ...args) {
  const { execFileSync } = require('node:child_process')

  return execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim()
}

/** The bytes of a small binary file, which a text upload would corrupt. */
const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff])

/**
 * A checkout of a release branch: one commit holding a version file, an executable, a binary and a
 * pending changelog entry.
 *
 * The commit step runs real git against it to list the changes, and sends the commit itself to an
 * Octokit whose network is a stand-in, so a test asserts the requests the API would have received.
 *
 * @param {string} branch The release branch the checkout is on.
 *
 * @returns {string} The checkout.
 */
function checkoutOn(branch) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'release-prep-git-'))

  git(work, 'init', '--quiet', '-b', branch)
  git(work, 'config', 'user.name', 'Test')
  git(work, 'config', 'user.email', 'test@example.com')
  fs.mkdirSync(path.join(work, 'bin'))
  fs.mkdirSync(path.join(work, 'changelog'))
  fs.writeFileSync(path.join(work, 'plugin.php'), 'Version: 4.16.0\n')
  fs.writeFileSync(path.join(work, 'bin', 'tool.sh'), '#!/bin/sh\n', { mode: 0o755 })
  fs.writeFileSync(path.join(work, 'logo.png'), PNG_BYTES)
  fs.writeFileSync(path.join(work, 'changelog', 'entry.yaml'), 'type: fix\n')
  git(work, 'add', '-A')
  git(work, 'commit', '--quiet', '-m', 'Initial')

  return work
}

/** The repository paths the commit step writes, as a real Octokit spells them. */
const API = {
  blobs: '/repos/stellarwp/plugin/git/blobs',
  trees: '/repos/stellarwp/plugin/git/trees',
  commits: '/repos/stellarwp/plugin/git/commits',
  ref: '/repos/stellarwp/plugin/git/refs/heads%2Frelease%2FM26.jigglypuff',
}

/**
 * Rules under which every API write succeeds, each blob getting a sha of its own.
 *
 * @param {object[]} before Rules that take precedence, to make one write fail.
 *
 * @returns {object[]} Rules for recordingFetch.
 */
function apiAccepts(before = []) {
  return [
    ...before,
    {
      method: 'POST',
      path: API.blobs,
      responses: [1, 2, 3, 4, 5].map((n) => ({ body: { sha: `blob-${n}` } })),
    },
    { method: 'POST', path: API.trees, body: { sha: 'tree-new' } },
    { method: 'POST', path: API.commits, body: { sha: 'commit-new' } },
    { method: 'PATCH', path: API.ref, body: { object: { sha: 'commit-new' } } },
  ]
}

/**
 * Each request as `METHOD path`, for asserting the order the commit step worked in.
 *
 * @param {object[]} requests The requests recordingFetch recorded.
 *
 * @returns {string[]} One line per request.
 */
function requested(requests) {
  return requests.map((request) => `${request.method} ${request.path}`)
}

/**
 * The real @actions/exec, wrapped to record each call and what it printed.
 *
 * What a command prints is sent to a buffer of its own rather than to stdout, where the test runner
 * reports results: that covers the `[command]` line @actions/exec echoes, so a test can assert what
 * a run would have shown in the log.
 *
 * @returns {Promise<{exec: object, calls: object[], printed: Function}>} The wrapper, the calls it
 *          recorded, and a reader for everything the commands printed.
 */
async function recordedRealExec() {
  const { Writable } = require('node:stream')
  const real = await import('@actions/exec')
  const calls = []
  const chunks = []
  const sink = new Writable({
    write(chunk, encoding, callback) {
      chunks.push(String(chunk))
      callback()
    },
  })

  const getExecOutput = (command, args = [], options = {}) => {
    calls.push({ command, args, options })

    return real.getExecOutput(command, args, { ...options, outStream: sink, errStream: sink })
  }

  return { exec: { getExecOutput }, calls, printed: () => chunks.join('') }
}

/**
 * The environment the manifest hands the commit step.
 *
 * @param {object} overrides Inputs to change.
 *
 * @returns {object} The environment, over the real one so that git is on the PATH.
 */
function commitEnv(overrides = {}) {
  return {
    ...process.env,
    INPUT_BRANCH: 'release/M26.jigglypuff',
    INPUT_VERSION: '4.17.0',
    GITHUB_REPOSITORY: 'stellarwp/plugin',
    ...overrides,
  }
}

describe('release-prep', () => {
  describe('validateVersion', () => {
    it('accepts three or four numeric parts under the stellarwp strategy', () => {
      assert.equal(validateVersion('4.17.0', 'stellarwp'), '4.17.0')
      assert.equal(validateVersion('4.17.0.1', 'stellarwp'), '4.17.0.1')
    })

    it('reads the version without surrounding whitespace', () => {
      assert.equal(validateVersion(' 4.17.0\n', 'stellarwp'), '4.17.0')
      assert.equal(readVersion(' 4.17.0\n'), '4.17.0')
    })

    it('refuses an empty version, saying the run was dispatched without one', () => {
      // A release dispatcher that has no version for the release sends an empty one.
      for (const empty of ['', '   ', undefined]) {
        for (const strategy of ['stellarwp', 'semver', 'custom']) {
          assert.throws(() => validateVersion(empty, strategy), /No version was given.*Nothing was changed/s)
        }
        assert.throws(() => readVersion(empty), /No version was given.*Nothing was changed/s)
      }
    })

    it('refuses a pre-release under stellarwp, which that versioning rejects', () => {
      assert.throws(
        () => validateVersion('4.17.0-beta.1', 'stellarwp'),
        /'4\.17\.0-beta\.1' is not a version this action can prepare.*pre-release/s
      )
    })

    it('refuses anything but three or four numeric parts under stellarwp', () => {
      // 2.1..21 matters most: the changelogger reads the empty part as 0 and would accept it.
      for (const version of ['4.17', '4.17.0.1.2', '2.1..21', 'v4.17.0', '4.17.x', '4.17.0.']) {
        assert.throws(() => validateVersion(version, 'stellarwp'), /not a version this action can prepare/)
      }
    })

    it('accepts a semver version, pre-release and build included, under semver', () => {
      for (const version of ['4.17.0', '4.17.0-beta.1', '4.17.0-rc.1+build.5', '0.1.0']) {
        assert.equal(validateVersion(version, 'semver'), version)
      }
    })

    it('refuses a fourth part, a leading v and an empty part under semver', () => {
      // The semver package behind the changelogger takes v4.17.0; the version goes into the
      // version files and the tag as given, so the action does not.
      for (const version of ['4.17.0.1', 'v4.17.0', '2.1..21', '04.17.0', '4.17', '4.17.0-']) {
        assert.throws(() => validateVersion(version, 'semver'), /not a version this action can prepare.*semver/s)
      }
    })

    it('checks only that the version is not empty under a custom strategy', () => {
      for (const version of ['M26.1', '4.17.0.1', '4.17.0-beta.1']) {
        assert.equal(validateVersion(version, 'custom'), version)
      }
    })
  })

  describe('resolveDate', () => {
    const now = new Date('2026-10-06T23:30:00-05:00')

    it('reads an empty date and `today` as today in UTC', () => {
      // 23:30 in UTC-5 is already the 7th in UTC.
      assert.equal(resolveDate('', now), '2026-10-07')
      assert.equal(resolveDate(undefined, now), '2026-10-07')
      assert.equal(resolveDate('today', now), '2026-10-07')
      assert.equal(resolveDate(' Today ', now), '2026-10-07')
    })

    it('passes a YYYY-MM-DD date through', () => {
      assert.equal(resolveDate('2026-10-06', now), '2026-10-06')
    })

    it('refuses anything that is not a real YYYY-MM-DD date', () => {
      for (const date of ['ontem', 'yesterday', '06/10/2026', '2026-10-6', '2026-02-30', '2026-13-45']) {
        assert.throws(() => resolveDate(date, now), /is not a date.*Nothing was changed/s)
      }
    })
  })

  describe('validateBranch', () => {
    it('accepts a branch name', () => {
      assert.equal(validateBranch('release/M26.jigglypuff'), 'release/M26.jigglypuff')
    })

    it('refuses an empty ref', () => {
      assert.throws(() => validateBranch(''), /No branch was given/)
    })

    it('refuses a full ref, naming the branch to pass instead', () => {
      assert.throws(
        () => validateBranch('refs/heads/release/M26.jigglypuff'),
        /pass the branch name, e\.g\. 'release\/M26\.jigglypuff'/
      )
    })
  })

  describe('validatePupVersion', () => {
    it('accepts a release number, which goes into the download URL', () => {
      assert.equal(validatePupVersion('2.0.0'), '2.0.0')
    })

    it('accepts latest', () => {
      assert.equal(validatePupVersion('latest'), 'latest')
    })

    it('refuses anything else', () => {
      for (const version of ['', '2.0.0/../../x', '2.0']) {
        assert.throws(() => validatePupVersion(version), /pup-version/)
      }
    })
  })

  describe('readPuprc', () => {
    it('returns the TBD directories the file declares', () => {
      assert.deepEqual(readPuprc(JSON.stringify(PUPRC)), { tbdDirs: ['src'] })
    })

    it('returns no TBD directories when the file declares none', () => {
      const { checks, ...withoutChecks } = PUPRC

      assert.deepEqual(readPuprc(JSON.stringify(withoutChecks)), { tbdDirs: null })
    })

    it('refuses a missing file, which pup would treat as an empty one', () => {
      assert.throws(() => readPuprc(null), /No \.puprc.*Nothing was changed/s)
    })

    it('refuses a file that is not JSON, which pup would also treat as empty', () => {
      assert.throws(() => readPuprc('{ "paths": '), /\.puprc is not valid JSON/)
    })

    it('refuses a file with no version files to bump', () => {
      assert.throws(() => readPuprc('{}'), /no paths\.versions/)
      assert.throws(() => readPuprc('{"paths":{"versions":[]}}'), /no paths\.versions/)
    })
  })

  describe('readChangeloggerStrategy', () => {
    it('reads the strategy the changelogger section configures', () => {
      assert.deepEqual(readChangeloggerStrategy(JSON.stringify(PACKAGE_JSON)), {
        strategy: 'stellarwp',
        versioning: 'stellarwp',
        configured: true,
      })
      assert.deepEqual(readChangeloggerStrategy('{"changelogger":{"versioning":"semver"}}'), {
        strategy: 'semver',
        versioning: 'semver',
        configured: true,
      })
    })

    it('falls back to semver without a section, a file or valid JSON, as the changelogger does', () => {
      for (const text of ['{"name":"x"}', null, 'not json']) {
        assert.deepEqual(readChangeloggerStrategy(text), {
          strategy: 'semver',
          versioning: 'semver',
          configured: false,
        })
      }
    })

    it('reads a section without a versioning key as semver, the changelogger default', () => {
      assert.deepEqual(readChangeloggerStrategy('{"changelogger":{"changesDir":"changelog"}}'), {
        strategy: 'semver',
        versioning: 'semver',
        configured: true,
      })
    })

    it('reads a .js or .ts file as a custom strategy', () => {
      for (const file of ['bin/versioning.js', 'bin/versioning.ts']) {
        assert.deepEqual(readChangeloggerStrategy(`{"changelogger":{"versioning":"${file}"}}`), {
          strategy: 'custom',
          versioning: file,
          configured: true,
        })
      }
    })

    it('refuses a strategy the changelogger does not know, which would fail the changelog step', () => {
      for (const versioning of ['foo', '']) {
        assert.throws(
          () => readChangeloggerStrategy(`{"changelogger":{"versioning":"${versioning}"}}`),
          /is not a versioning strategy the changelogger knows.*Nothing was changed/s
        )
      }
    })
  })

  describe('the pup commands', () => {
    it('downloads the pinned release', () => {
      assert.equal(
        pupDownloadUrl('2.0.0'),
        'https://github.com/stellarwp/pup/releases/download/2.0.0/pup.phar'
      )
    })

    it('checks the release page when the phar is missing', () => {
      assert.equal(pupReleaseUrl('2.0.0'), 'https://github.com/stellarwp/pup/releases/tag/2.0.0')
    })

    it('bumps the version files, then replaces the TBDs', () => {
      assert.deepEqual(pupCommands('/tmp/pup.phar', '4.17.0'), [
        { command: 'php', args: ['/tmp/pup.phar', 'replace-version', '4.17.0'] },
        { command: 'php', args: ['/tmp/pup.phar', 'replace-tbd', '4.17.0'] },
      ])
    })
  })

  describe('parseRawDiff', () => {
    it('reads each change with its modes, status, blob and path from the NUL-separated raw diff', () => {
      const raw =
        ':100644 100644 1111111 2222222 M\0plugin.php\0' +
        ':000000 100644 0000000 3333333 A\0changelog.txt\0' +
        ':100644 000000 4444444 0000000 D\0changelog/entry.yaml\0' +
        ':100644 100755 5555555 5555555 M\0bin/tool.sh\0'

      assert.deepEqual(parseRawDiff(raw), [
        { path: 'plugin.php', status: 'M', mode: '100644', previousMode: '100644', blob: '2222222' },
        { path: 'changelog.txt', status: 'A', mode: '100644', previousMode: '000000', blob: '3333333' },
        { path: 'changelog/entry.yaml', status: 'D', mode: '000000', previousMode: '100644', blob: '0000000' },
        { path: 'bin/tool.sh', status: 'M', mode: '100755', previousMode: '100644', blob: '5555555' },
      ])
    })

    it('reads an empty diff as no changes', () => {
      assert.deepEqual(parseRawDiff(''), [])
    })
  })

  describe('compareVersions', () => {
    it('orders versions by their numeric parts, a missing part counting as 0', () => {
      assert.equal(compareVersions('4.17.0', '4.18.0'), -1)
      assert.equal(compareVersions('4.18.0', '4.17.9'), 1)
      assert.equal(compareVersions('4.18.0', '4.18.0'), 0)
      assert.equal(compareVersions('4.18.0', '4.18.0.0'), 0)
      assert.equal(compareVersions('4.18.0.1', '4.18.0'), 1)
      assert.equal(compareVersions('4.10.0', '4.9.0'), 1)
    })
  })

  describe('readCurrentVersion', () => {
    it('reads the version pup prints, ignoring anything before it', () => {
      assert.equal(readCurrentVersion('4.18.0\n'), '4.18.0')
      assert.equal(readCurrentVersion('PHP Deprecated: something\n4.18.0.1\n'), '4.18.0.1')
    })

    it('reads the numeric part of a version with a suffix', () => {
      assert.equal(readCurrentVersion('4.19.0-beta.1\n'), '4.19.0')
    })

    it('returns null when pup could not read a version', () => {
      assert.equal(readCurrentVersion('unknown\n'), null)
      assert.equal(readCurrentVersion(''), null)
    })
  })

  describe('commitMessage', () => {
    it('names the branch and the version', () => {
      assert.equal(commitMessage('release/M26.jigglypuff', '4.17.0'), 'Prepare release/M26.jigglypuff (4.17.0)')
    })
  })

  describe('runPrepare', () => {
    it('checks the ref, downloads pup, bumps the versions and then replaces the TBDs', async (t) => {
      const { core, outputs } = await coreWithOutputs(t)
      const { exec, calls } = recordingExec(allSucceed())
      const cwd = checkoutWith({ '.puprc': PUPRC, 'package.json': PACKAGE_JSON })

      await runPrepare({ core, exec, env: prepareEnv(), cwd })

      const phar = '/runner/temp/pup-2.0.0.phar'
      assert.deepEqual(sequence(calls), [
        'git check-ref-format refs/heads/release/M26.jigglypuff',
        'git symbolic-ref --quiet --short HEAD',
        'curl -fsSI https://github.com/stellarwp/pup/releases/download/2.0.0/pup.phar',
        `curl -fsSL --retry 3 -o ${phar} https://github.com/stellarwp/pup/releases/download/2.0.0/pup.phar`,
        `php -d display_errors=stderr ${phar} get-version`,
        `php ${phar} replace-version 4.17.0`,
        `php ${phar} replace-tbd 4.17.0`,
      ])
      assert.ok(
        calls.filter((call) => call.command === 'php').every((call) => call.options.cwd === cwd),
        'pup runs in the checkout'
      )
      assert.deepEqual(outputs(), {
        version: '4.17.0',
        date: TODAY,
        branch: 'release/M26.jigglypuff',
        distribution: 'phar',
      })
    })

    it('hands the changelog step a date it can write, never `today`', async (t) => {
      const { core, outputs } = await coreWithOutputs(t)
      const { exec } = recordingExec(allSucceed())
      const cwd = checkoutWith({ '.puprc': PUPRC, 'package.json': PACKAGE_JSON })

      await runPrepare({ core, exec, env: prepareEnv({ INPUT_DATE: 'today' }), cwd })
      assert.equal(outputs().date, TODAY)
    })

    it('passes a given date through', async (t) => {
      const { core, outputs } = await coreWithOutputs(t)
      const { exec } = recordingExec(allSucceed())
      const cwd = checkoutWith({ '.puprc': PUPRC, 'package.json': PACKAGE_JSON })

      await runPrepare({ core, exec, env: prepareEnv({ INPUT_DATE: '2026-10-06' }), cwd })
      assert.equal(outputs().date, '2026-10-06')
    })

    it('stops before running anything when the version, the date or pup-version is wrong', async (t) => {
      const cases = [
        [{ INPUT_VERSION: '' }, /No version was given/],
        [{ INPUT_VERSION: '4.17.0-beta.1' }, /not a version this action can prepare/],
        [{ INPUT_VERSION: '2.1..21' }, /not a version this action can prepare/],
        [{ INPUT_DATE: 'ontem' }, /is not a date/],
        [{ INPUT_BRANCH: '' }, /No branch was given/],
      ]

      for (const [overrides, message] of cases) {
        const { core, outputs } = await coreWithOutputs(t)
        const { exec, calls } = recordingExec(allSucceed())
        const cwd = checkoutWith({ '.puprc': PUPRC, 'package.json': PACKAGE_JSON })

        await assert.rejects(runPrepare({ core, exec, env: prepareEnv(overrides), cwd }), message)
        assert.deepEqual(calls, [], `nothing ran for ${JSON.stringify(overrides)}`)
        assert.deepEqual(outputs(), {})
      }
    })

    it('stops before downloading pup when the branch is not a valid name', async (t) => {
      const { core } = await coreWithOutputs(t)
      const { exec, calls } = recordingExec(
        allSucceed([{ command: 'git', args: /^check-ref-format /, exitCode: 1 }])
      )
      const cwd = checkoutWith({ '.puprc': PUPRC, 'package.json': PACKAGE_JSON })

      await assert.rejects(
        runPrepare({ core, exec, env: prepareEnv({ INPUT_BRANCH: 'release/..x' }), cwd }),
        /'release\/\.\.x' is not a valid branch name/
      )
      assert.deepEqual(sequence(calls), ['git check-ref-format refs/heads/release/..x'])
    })

    it('stops before downloading pup when the checkout is on another branch', async (t) => {
      // The commit's parent is the checkout's HEAD. From another branch that the release branch is
      // an ancestor of, the ref update would be a fast-forward and carry that branch's commits along.
      const { core } = await coreWithOutputs(t)
      const { exec, calls } = recordingExec(
        allSucceed([{ command: 'git', args: /^symbolic-ref /, stdout: 'main\n' }])
      )
      const cwd = checkoutWith({ '.puprc': PUPRC, 'package.json': PACKAGE_JSON })

      await assert.rejects(
        runPrepare({ core, exec, env: prepareEnv(), cwd }),
        /The checkout is on 'main', not on 'release\/M26\.jigglypuff'.*Nothing was changed/s
      )
      assert.ok(!calls.some((call) => call.command === 'curl' || call.command === 'php'))
    })

    it('stops before downloading pup when the checkout is on no branch at all', async (t) => {
      const { core } = await coreWithOutputs(t)
      const { exec, calls } = recordingExec(
        allSucceed([{ command: 'git', args: /^symbolic-ref /, exitCode: 1 }])
      )
      const cwd = checkoutWith({ '.puprc': PUPRC, 'package.json': PACKAGE_JSON })

      await assert.rejects(
        runPrepare({ core, exec, env: prepareEnv(), cwd }),
        /The checkout is on a detached commit, not on 'release\/M26\.jigglypuff'/
      )
      assert.ok(!calls.some((call) => call.command === 'curl' || call.command === 'php'))
    })

    it('refuses a version lower than the one the branch already has, before changing anything', async (t) => {
      const { core, outputs } = await coreWithOutputs(t)
      const { exec, calls } = recordingExec(
        allSucceed([{ command: 'php', args: /get-version$/, stdout: '4.18.0\n' }])
      )
      const cwd = checkoutWith({ '.puprc': PUPRC, 'package.json': PACKAGE_JSON })

      await assert.rejects(
        runPrepare({ core, exec, env: prepareEnv(), cwd }),
        /Refusing to prepare 4\.17\.0: release\/M26\.jigglypuff already has 4\.18\.0.*Nothing was changed/s
      )
      assert.ok(!sequence(calls).some((call) => / replace-(version|tbd) /.test(call)), 'pup changed nothing')
      assert.deepEqual(outputs(), { distribution: 'phar' })
    })

    it('compares a four-part version by all four parts', async (t) => {
      for (const [current, version, accepted] of [
        ['4.18.0.1', '4.18.0', false],
        ['4.18.0.1', '4.18.0.2', true],
        ['4.18.0.1', '4.18.1', true],
      ]) {
        const { core } = await coreWithOutputs(t)
        const { exec } = recordingExec(
          allSucceed([
            { command: 'git', args: /^symbolic-ref /, stdout: `release/${version}\n` },
            { command: 'php', args: /get-version$/, stdout: `${current}\n` },
          ])
        )
        const cwd = checkoutWith({ '.puprc': PUPRC, 'package.json': PACKAGE_JSON })
        const env = prepareEnv({ INPUT_VERSION: version, INPUT_BRANCH: `release/${version}` })
        const prepare = runPrepare({ core, exec, env, cwd })

        if (accepted) {
          await prepare
        } else {
          await assert.rejects(prepare, /already has 4\.18\.0\.1/)
        }
      }
    })

    it('prepares the version the branch already has, as a re-run of the same release does', async (t) => {
      const { core, outputs } = await coreWithOutputs(t)
      const { exec, calls } = recordingExec(
        allSucceed([{ command: 'php', args: /get-version$/, stdout: '4.17.0\n' }])
      )
      const cwd = checkoutWith({ '.puprc': PUPRC, 'package.json': PACKAGE_JSON })

      await runPrepare({ core, exec, env: prepareEnv(), cwd })

      assert.ok(sequence(calls).some((call) => call.endsWith('replace-version 4.17.0')))
      assert.equal(outputs().version, '4.17.0')
    })

    it('warns and goes on when the branch holds a version that is not numeric', async (t) => {
      const { core, logged } = await coreWithOutputs(t)
      const { exec, calls } = recordingExec(
        allSucceed([{ command: 'php', args: /get-version$/, stdout: 'dev\n' }])
      )
      const cwd = checkoutWith({ '.puprc': PUPRC, 'package.json': PACKAGE_JSON })

      await runPrepare({ core, exec, env: prepareEnv(), cwd })

      assert.match(logged(), /::warning::The version files hold `dev`, which is not a numeric version/)
      assert.ok(sequence(calls).some((call) => call.endsWith('replace-version 4.17.0')))
    })

    it('fails with pup output when pup cannot find the current version, and changes nothing', async (t) => {
      // pup refuses to load a .puprc whose version regex finds nothing, so get-version exits 1.
      const { core } = await coreWithOutputs(t)
      const { exec, calls } = recordingExec(
        allSucceed([
          {
            command: 'php',
            args: /get-version$/,
            exitCode: 1,
            stdout: 'ERROR: Could not find version in file plugin.php using regex "/(Version: )(.+)/"',
          },
        ])
      )
      const cwd = checkoutWith({ '.puprc': PUPRC, 'package.json': PACKAGE_JSON })

      await assert.rejects(
        runPrepare({ core, exec, env: prepareEnv(), cwd }),
        /pup get-version failed.*Could not find version in file plugin\.php/s
      )
      assert.ok(!sequence(calls).some((call) => / replace-(version|tbd) /.test(call)), 'pup changed nothing')
    })

    it('stops before running pup when the repository has no usable .puprc', async (t) => {
      const cases = [
        [{}, /No \.puprc/],
        [{ '.puprc': '{ "paths": ' }, /\.puprc is not valid JSON/],
        [{ '.puprc': {} }, /no paths\.versions/],
      ]

      for (const [files, message] of cases) {
        const { core } = await coreWithOutputs(t)
        const { exec, calls } = recordingExec(allSucceed())
        const cwd = checkoutWith({ 'package.json': PACKAGE_JSON, ...files })

        await assert.rejects(runPrepare({ core, exec, env: prepareEnv(), cwd }), message)
        assert.ok(
          !calls.some((call) => call.command === 'curl' || call.command === 'php'),
          `pup never ran, got ${JSON.stringify(sequence(calls))}`
        )
      }
    })

    it('warns when the .puprc leaves the TBD directories to pup', async (t) => {
      const { core, logged } = await coreWithOutputs(t)
      const { exec } = recordingExec(allSucceed())
      const { checks, ...withoutChecks } = PUPRC
      const cwd = checkoutWith({ '.puprc': withoutChecks, 'package.json': PACKAGE_JSON })

      await runPrepare({ core, exec, env: prepareEnv(), cwd })

      assert.match(logged(), /::warning::.*checks\.tbd\.dirs.*src\//)
    })

    it('warns when package.json has no changelogger section', async (t) => {
      // The changelogger falls back to its defaults without one, and writes a changelog.md.
      const { core, logged } = await coreWithOutputs(t)
      const { exec } = recordingExec(allSucceed())
      const cwd = checkoutWith({ '.puprc': PUPRC, 'package.json': { name: 'x' } })

      await runPrepare({ core, exec, env: prepareEnv(), cwd })

      assert.match(logged(), /::warning::.*changelogger/)
    })

    it('validates the version with the strategy package.json configures', async (t) => {
      const semver = { changelogger: { versioning: 'semver', changesDir: 'changelog' } }

      const accepted = await coreWithOutputs(t)
      const run = recordingExec(allSucceed())
      await runPrepare({
        core: accepted.core,
        exec: run.exec,
        env: prepareEnv({ INPUT_VERSION: '4.17.0-beta.1' }),
        cwd: checkoutWith({ '.puprc': PUPRC, 'package.json': semver }),
      })
      assert.ok(sequence(run.calls).some((call) => call.endsWith('replace-version 4.17.0-beta.1')))
      assert.equal(accepted.outputs().version, '4.17.0-beta.1')

      const refused = await coreWithOutputs(t)
      const stopped = recordingExec(allSucceed())
      await assert.rejects(
        runPrepare({
          core: refused.core,
          exec: stopped.exec,
          env: prepareEnv({ INPUT_VERSION: '4.17.0.1' }),
          cwd: checkoutWith({ '.puprc': PUPRC, 'package.json': semver }),
        }),
        /'4\.17\.0\.1' is not a version this action can prepare.*semver/s
      )
      assert.deepEqual(stopped.calls, [], 'nothing ran for a version the changelog step would refuse')
    })

    it('leaves the shape check to a custom strategy, and says so', async (t) => {
      const { core, logged } = await coreWithOutputs(t)
      const { exec, calls } = recordingExec(allSucceed())
      const custom = { changelogger: { versioning: 'bin/versioning.js' } }
      const cwd = checkoutWith({ '.puprc': PUPRC, 'package.json': custom })

      await runPrepare({ core, exec, env: prepareEnv({ INPUT_VERSION: 'M26.1' }), cwd })

      assert.match(logged(), /::warning::.*custom versioning strategy \(bin\/versioning\.js\)/)
      assert.match(logged(), /::warning::.*M26\.1 holds no numeric version/)
      assert.ok(sequence(calls).some((call) => call.endsWith('replace-version M26.1')))
    })

    it('stops before running anything when package.json names a strategy the changelogger does not know', async (t) => {
      const { core, outputs } = await coreWithOutputs(t)
      const { exec, calls } = recordingExec(allSucceed())
      const cwd = checkoutWith({ '.puprc': PUPRC, 'package.json': { changelogger: { versioning: 'foo' } } })

      await assert.rejects(
        runPrepare({ core, exec, env: prepareEnv(), cwd }),
        /changelogger\.versioning to 'foo', which is not a versioning strategy the changelogger knows/
      )
      assert.deepEqual(calls, [])
      assert.deepEqual(outputs(), {})
    })

    it('compares a pre-release by its numeric start against the branch', async (t) => {
      const semver = { changelogger: { versioning: 'semver' } }

      for (const [current, accepted] of [
        ['4.18.0', false],
        ['4.17.0', true],
      ]) {
        const { core } = await coreWithOutputs(t)
        const { exec } = recordingExec(
          allSucceed([{ command: 'php', args: /get-version$/, stdout: `${current}\n` }])
        )
        const cwd = checkoutWith({ '.puprc': PUPRC, 'package.json': semver })
        const prepare = runPrepare({ core, exec, env: prepareEnv({ INPUT_VERSION: '4.17.0-beta.1' }), cwd })

        if (accepted) {
          await prepare
        } else {
          await assert.rejects(prepare, /Refusing to prepare 4\.17\.0-beta\.1: .* already has 4\.18\.0/)
        }
      }
    })

    it('fails with pup output when pup fails, and stops there', async (t) => {
      const { core, outputs } = await coreWithOutputs(t)
      const { exec, calls } = recordingExec(
        allSucceed([
          {
            command: 'php',
            args: /replace-version/,
            exitCode: 1,
            stdout: 'No version files found in .puprc paths.versions.',
          },
        ])
      )
      const cwd = checkoutWith({ '.puprc': PUPRC, 'package.json': PACKAGE_JSON })

      await assert.rejects(
        runPrepare({ core, exec, env: prepareEnv(), cwd }),
        /pup replace-version failed.*No version files found/s
      )
      assert.ok(!sequence(calls).some((call) => call.includes('replace-tbd')), 'replace-tbd never ran')
      assert.deepEqual(outputs(), { distribution: 'phar' })
    })

    it('fails when the pup download fails', async (t) => {
      const { core } = await coreWithOutputs(t)
      const { exec } = recordingExec(
        allSucceed([
          { command: 'curl', args: /fsSL/, exitCode: 22, stderr: 'The requested URL returned error: 404' },
        ])
      )
      const cwd = checkoutWith({ '.puprc': PUPRC, 'package.json': PACKAGE_JSON })

      await assert.rejects(
        runPrepare({ core, exec, env: prepareEnv(), cwd }),
        /Downloading pup 2\.0\.0 failed.*404/s
      )
    })

    it('resolves latest to the newest pup release and downloads that phar', async (t) => {
      const { core } = await coreWithOutputs(t)
      const { exec, calls } = recordingExec(allSucceed())
      const cwd = checkoutWith({ '.puprc': PUPRC, 'package.json': PACKAGE_JSON })
      const fetched = []
      const fetchImpl = async (url, options) => {
        fetched.push([url, options])
        return { ok: true, json: async () => ({ tag_name: '2.0.0' }) }
      }

      await runPrepare({
        core,
        exec,
        env: prepareEnv({ INPUT_PUP_VERSION: 'latest', INPUT_TOKEN: 'ghp_example' }),
        cwd,
        fetchImpl,
      })

      assert.deepEqual(fetched, [
        ['https://api.github.com/repos/stellarwp/pup/releases/latest', { headers: { authorization: 'Bearer ghp_example' } }],
      ])
      assert.ok(
        sequence(calls).some((call) => call.includes('pup/releases/download/2.0.0/pup.phar')),
        'downloads the phar the resolved release points at'
      )
    })

    it('fails loudly when the latest release reports no usable tag', async (t) => {
      const { core, outputs } = await coreWithOutputs(t)
      const { exec } = recordingExec(allSucceed())
      const cwd = checkoutWith({ '.puprc': PUPRC, 'package.json': PACKAGE_JSON })
      const fetchImpl = async () => ({
        ok: true,
        json: async () => ({ tag_name: undefined }),
      })

      await assert.rejects(
        runPrepare({ core, exec, env: prepareEnv({ INPUT_PUP_VERSION: 'latest' }), cwd, fetchImpl }),
        /The latest pup release has no usable tag/
      )
      assert.deepEqual(outputs(), {}, 'no distribution is decided from a broken response')
    })

    it('does not call the GitHub API for a pinned pup version', async (t) => {
      const { core } = await coreWithOutputs(t)
      const { exec } = recordingExec(allSucceed())
      const cwd = checkoutWith({ '.puprc': PUPRC, 'package.json': PACKAGE_JSON })
      let called = 0
      const fetchImpl = async () => {
        called += 1
        return { ok: true, json: async () => ({}) }
      }

      await runPrepare({ core, exec, env: prepareEnv(), cwd, fetchImpl })

      assert.equal(called, 0, 'a pinned version downloads straight from the release URL')
    })

    it('fails loudly when the release exists but has no phar, pointing at the pin', async (t) => {
      // pup 1.2.3 is such a release today; the TypeScript line will be another.
      const { core, outputs } = await coreWithOutputs(t)
      const { exec, calls } = recordingExec(
        allSucceed([
          { command: 'curl', args: /fsSI .*\/download\//, exitCode: 22, stderr: 'The requested URL returned error: 404' },
          { command: 'curl', args: /fsSI .*\/releases\/tag\// },
        ])
      )
      const cwd = checkoutWith({ '.puprc': PUPRC, 'package.json': PACKAGE_JSON })

      await assert.rejects(
        runPrepare({ core, exec, env: prepareEnv(), cwd }),
        /pup 2\.0\.0 publishes no pup\.phar asset.*Pin pup-version to a release that ships one, such as 2\.0\.0/s
      )
      assert.deepEqual(outputs(), { distribution: 'ts' }, 'the resolved distribution is reported on the failed run')
      assert.deepEqual(
        sequence(calls).filter((call) => call.startsWith('curl')),
        [
          'curl -fsSI https://github.com/stellarwp/pup/releases/download/2.0.0/pup.phar',
          'curl -fsSI https://github.com/stellarwp/pup/releases/tag/2.0.0',
        ],
        'the release page is checked once the asset is missing'
      )
      assert.ok(
        !sequence(calls).some((call) => /fsSL|php /.test(call)),
        'no phar is downloaded and no PHP runs without a phar asset'
      )
    })

    it('fails when the pinned release does not exist, naming the pin', async (t) => {
      // A typo in pup-version gets a 404 on the asset too; the release page tells the two apart.
      const { core, outputs } = await coreWithOutputs(t)
      const { exec, calls } = recordingExec(
        allSucceed([
          { command: 'curl', args: /fsSI/, exitCode: 22, stderr: 'The requested URL returned error: 404' },
        ])
      )
      const cwd = checkoutWith({ '.puprc': PUPRC, 'package.json': PACKAGE_JSON })

      await assert.rejects(
        runPrepare({ core, exec, env: prepareEnv({ INPUT_PUP_VERSION: '2.0.9' }), cwd }),
        /pup 2\.0\.9 is not a release: check pup-version for a typo\. Nothing was changed\./
      )
      assert.deepEqual(outputs(), {}, 'no distribution is reported for a release that does not exist')
      assert.ok(!sequence(calls).some((call) => /fsSL|php /.test(call)))
    })

    it('fails loudly when the release page check itself errors', async (t) => {
      const { core } = await coreWithOutputs(t)
      const { exec } = recordingExec(
        allSucceed([
          { command: 'curl', args: /fsSI .*\/download\//, exitCode: 22, stderr: 'The requested URL returned error: 404' },
          { command: 'curl', args: /fsSI .*\/releases\/tag\//, exitCode: 28, stderr: 'Connection timed out' },
        ])
      )
      const cwd = checkoutWith({ '.puprc': PUPRC, 'package.json': PACKAGE_JSON })

      await assert.rejects(
        runPrepare({ core, exec, env: prepareEnv(), cwd }),
        /Checking the pup 2\.0\.0 release failed.*Connection timed out/s
      )
    })

    it('fails loudly when the phar check itself errors', async (t) => {
      const { core } = await coreWithOutputs(t)
      const { exec } = recordingExec(
        allSucceed([{ command: 'curl', args: /fsSI/, exitCode: 28, stderr: 'Connection timed out' }])
      )
      const cwd = checkoutWith({ '.puprc': PUPRC, 'package.json': PACKAGE_JSON })

      await assert.rejects(
        runPrepare({ core, exec, env: prepareEnv(), cwd }),
        /Checking the pup 2\.0\.0 release failed.*Connection timed out/s
      )
    })
  })

  describe('runCommit', () => {
    it("commits every change to the branch through the API, on the checkout's own head", async (t) => {
      const { core, outputs, summary } = await coreWithOutputs(t)
      const { exec } = await recordedRealExec()
      const { github, requests } = await octokitFor(apiAccepts())
      const work = checkoutOn('release/M26.jigglypuff')
      const head = git(work, 'rev-parse', 'HEAD')
      const baseTree = git(work, 'rev-parse', 'HEAD^{tree}')
      fs.writeFileSync(path.join(work, 'plugin.php'), 'Version: 4.17.0\n')
      fs.writeFileSync(path.join(work, 'changelog.txt'), '= 4.17.0 =\n')
      fs.unlinkSync(path.join(work, 'changelog', 'entry.yaml'))
      fs.writeFileSync(path.join(work, 'bin', 'tool.sh'), '#!/bin/sh\necho\n', { mode: 0o755 })
      fs.writeFileSync(path.join(work, 'logo.png'), Buffer.concat([PNG_BYTES, Buffer.from([0x01])]))

      await runCommit({ github, core, exec, env: commitEnv(), cwd: work })

      assert.deepEqual(requested(requests), [
        `POST ${API.blobs}`,
        `POST ${API.blobs}`,
        `POST ${API.blobs}`,
        `POST ${API.blobs}`,
        `POST ${API.trees}`,
        `POST ${API.commits}`,
        `PATCH ${API.ref}`,
      ])

      const blobs = requests.filter((request) => request.path === API.blobs).map((request) => request.body)
      assert.ok(
        blobs.every((blob) => blob.encoding === 'base64'),
        'every file is uploaded as base64, so a binary survives'
      )
      const logo = Buffer.concat([PNG_BYTES, Buffer.from([0x01])]).toString('base64')
      assert.ok(blobs.some((blob) => blob.content === logo), 'the binary is uploaded byte for byte')

      const tree = requests.find((request) => request.path === API.trees).body
      assert.equal(tree.base_tree, baseTree, "the tree builds on the checkout's own tree")
      assert.deepEqual(tree.tree, [
        { path: 'bin/tool.sh', mode: '100755', type: 'blob', sha: 'blob-1' },
        { path: 'changelog.txt', mode: '100644', type: 'blob', sha: 'blob-2' },
        { path: 'changelog/entry.yaml', mode: '100644', type: 'blob', sha: null },
        { path: 'logo.png', mode: '100644', type: 'blob', sha: 'blob-3' },
        { path: 'plugin.php', mode: '100644', type: 'blob', sha: 'blob-4' },
      ])

      const commit = requests.find((request) => request.path === API.commits).body
      assert.deepEqual(commit, {
        message: 'Prepare release/M26.jigglypuff (4.17.0)',
        tree: 'tree-new',
        parents: [head],
      })

      const ref = requests.find((request) => request.path === API.ref).body
      assert.deepEqual(ref, { sha: 'commit-new' }, 'the ref update is not forced')

      assert.deepEqual(outputs(), {
        commit: 'commit-new',
        files: 'bin/tool.sh\nchangelog.txt\nchangelog/entry.yaml\nlogo.png\nplugin.php',
      })
      assert.match(summary(), /Committed `commit-` "Prepare release\/M26\.jigglypuff \(4\.17\.0\)" to `release\/M26\.jigglypuff`/)
      assert.match(summary(), /^- `bin\/tool\.sh`\n- `changelog\.txt`\n- `changelog\/entry\.yaml`\n- `logo\.png`\n- `plugin\.php`$/m)
      assert.equal(git(work, 'rev-parse', 'HEAD'), head, 'the checkout itself stays where it was')
    })

    it('uploads the staged content, not the file on disk', async (t) => {
      // .gitattributes normalization (here CRLF to LF) makes the staged blob differ from what is
      // on disk; the commit has to carry what git staged.
      const { core } = await coreWithOutputs(t)
      const { exec } = await recordedRealExec()
      const { github, requests } = await octokitFor(apiAccepts())
      const work = checkoutOn('release/M26.jigglypuff')
      fs.writeFileSync(path.join(work, '.gitattributes'), '* text eol=lf\n')
      fs.writeFileSync(path.join(work, 'notes.txt'), 'first line\r\nsecond line\r\n')

      await runCommit({ github, core, exec, env: commitEnv(), cwd: work })

      const staged = requests
        .filter((request) => request.path === API.blobs)
        .map((request) => request.body)
        .find((blob) => Buffer.from(blob.content, 'base64').toString() === 'first line\nsecond line\n')
      assert.ok(staged, 'the blob is the staged content, with CRLF normalized to LF')
    })

    it('neither commits nor calls the API when nothing changed, and still succeeds', async (t) => {
      // A retry of the same version finds the branch already prepared.
      const { core, outputs } = await coreWithOutputs(t)
      const { exec } = await recordedRealExec()
      const { github, requests } = await octokitFor(apiAccepts())
      const work = checkoutOn('release/M26.jigglypuff')

      await runCommit({ github, core, exec, env: commitEnv(), cwd: work })

      assert.deepEqual(requests, [])
      assert.deepEqual(outputs(), { commit: '', files: '' })
    })

    it('fails when the branch moved after the checkout, without forcing the ref', async (t) => {
      // GitHub refuses a ref update that is not a fast-forward with 422, as a push would.
      const { core } = await coreWithOutputs(t)
      const { exec } = await recordedRealExec()
      const { github, requests } = await octokitFor(
        apiAccepts([{ method: 'PATCH', path: API.ref, status: 422, body: { message: 'Update is not a fast forward' } }])
      )
      const work = checkoutOn('release/M26.jigglypuff')
      fs.writeFileSync(path.join(work, 'plugin.php'), 'Version: 4.17.0\n')

      await assert.rejects(
        runCommit({ github, core, exec, env: commitEnv(), cwd: work }),
        /GitHub refused to update release\/M26\.jigglypuff \(Update is not a fast forward\): the branch moved after the checkout.*Nothing was committed/s
      )
      assert.ok(!requests.some((request) => request.body?.force), 'no ref update is forced')
    })

    it('fails with the API error when a write fails', async (t) => {
      const { core } = await coreWithOutputs(t)
      const { exec } = await recordedRealExec()
      const { github } = await octokitFor(
        apiAccepts([{ method: 'POST', path: API.trees, status: 500, body: { message: 'boom' } }])
      )
      const work = checkoutOn('release/M26.jigglypuff')
      fs.writeFileSync(path.join(work, 'plugin.php'), 'Version: 4.17.0\n')

      await assert.rejects(runCommit({ github, core, exec, env: commitEnv(), cwd: work }), /boom/)
    })

    it('refuses a change that is not a regular file, naming it', async (t) => {
      const { core } = await coreWithOutputs(t)
      const { exec } = await recordedRealExec()
      const { github, requests } = await octokitFor(apiAccepts())
      const work = checkoutOn('release/M26.jigglypuff')
      fs.symlinkSync('plugin.php', path.join(work, 'link.php'))

      await assert.rejects(
        runCommit({ github, core, exec, env: commitEnv(), cwd: work }),
        /link\.php has mode 120000, which this action does not commit/
      )
      assert.deepEqual(requests, [], 'nothing is uploaded')
    })

    it('fails before listing anything when the repository is unknown', async (t) => {
      const { core } = await coreWithOutputs(t)
      const { exec, calls } = recordingExec([])
      const { github } = await octokitFor(apiAccepts())

      await assert.rejects(
        runCommit({ github, core, exec, env: commitEnv({ GITHUB_REPOSITORY: '' }), cwd: '/nowhere' }),
        /GITHUB_REPOSITORY/
      )
      assert.deepEqual(calls, [])
    })
  })
})
