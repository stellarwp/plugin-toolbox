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
  validateRef,
  validatePupVersion,
  readPuprc,
  hasChangeloggerConfig,
  pupDownloadUrl,
  pupCommands,
  basicCredential,
  pushEnv,
  commitMessage,
  compareVersions,
  readCurrentVersion,
} = require('../../../.github/actions/release-prep/release-prep.js')
const { coreWithOutputs, recordingExec } = require('../../support/actions.js')

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
    INPUT_REF: 'release/4.17.0',
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
    { command: 'git', args: /^symbolic-ref /, stdout: 'release/4.17.0\n' },
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

/**
 * A working copy of a repository whose `origin` is a local bare repository holding `branch`.
 *
 * The commit step then runs real git against it: a push goes to the bare repository, so a test can
 * read back what landed on the branch.
 *
 * @param {string} branch The release branch the working copy has checked out.
 *
 * @returns {{work: string, remote: string}} The two directories.
 */
function repositoryOn(branch) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'release-prep-git-'))
  const remote = path.join(root, 'remote.git')
  const work = path.join(root, 'work')

  git(root, 'init', '--quiet', '--bare', remote)
  git(root, 'init', '--quiet', '-b', branch, work)
  git(work, 'config', 'user.name', 'Test')
  git(work, 'config', 'user.email', 'test@example.com')
  fs.writeFileSync(path.join(work, 'plugin.php'), 'Version: 4.16.0\n')
  git(work, 'add', '-A')
  git(work, 'commit', '--quiet', '-m', 'Initial')
  git(work, 'remote', 'add', 'origin', remote)
  git(work, 'push', '--quiet', 'origin', `HEAD:refs/heads/${branch}`)

  return { work, remote }
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
    INPUT_REF: 'release/4.17.0',
    INPUT_VERSION: '4.17.0',
    INPUT_TOKEN: 'ghs_notarealtoken123',
    GITHUB_SERVER_URL: 'https://github.com',
    ...overrides,
  }
}

describe('release-prep', () => {
  describe('validateVersion', () => {
    it('accepts three or four numeric parts', () => {
      assert.equal(validateVersion('4.17.0'), '4.17.0')
      assert.equal(validateVersion('4.17.0.1'), '4.17.0.1')
    })

    it('reads the version without surrounding whitespace', () => {
      assert.equal(validateVersion(' 4.17.0\n'), '4.17.0')
    })

    it('refuses an empty version, saying the run was dispatched without one', () => {
      // A release dispatcher that has no version for the release sends an empty one.
      for (const empty of ['', '   ', undefined]) {
        assert.throws(() => validateVersion(empty), /No version was given.*Nothing was changed/s)
      }
    })

    it('refuses a pre-release, which the stellarwp changelog versioning rejects', () => {
      assert.throws(
        () => validateVersion('4.17.0-beta.1'),
        /'4\.17\.0-beta\.1' is not a version this action can prepare.*pre-release/s
      )
    })

    it('refuses anything but three or four numeric parts', () => {
      // 2.1..21 matters most: the changelogger reads the empty part as 0 and would accept it.
      for (const version of ['4.17', '4.17.0.1.2', '2.1..21', 'v4.17.0', '4.17.x', '4.17.0.']) {
        assert.throws(() => validateVersion(version), /not a version this action can prepare/)
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

  describe('validateRef', () => {
    it('accepts a branch name', () => {
      assert.equal(validateRef('release/4.17.0'), 'release/4.17.0')
    })

    it('refuses an empty ref', () => {
      assert.throws(() => validateRef(''), /No ref was given/)
    })

    it('refuses a full ref, naming the branch to pass instead', () => {
      assert.throws(
        () => validateRef('refs/heads/release/4.17.0'),
        /pass the branch name, e\.g\. 'release\/4\.17\.0'/
      )
    })
  })

  describe('validatePupVersion', () => {
    it('accepts a release number, which goes into the download URL', () => {
      assert.equal(validatePupVersion('2.0.0'), '2.0.0')
    })

    it('refuses anything else', () => {
      for (const version of ['', 'latest', '2.0.0/../../x', '2.0']) {
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

  describe('hasChangeloggerConfig', () => {
    it('is true only for a package.json with a changelogger section', () => {
      assert.equal(hasChangeloggerConfig(JSON.stringify(PACKAGE_JSON)), true)
      assert.equal(hasChangeloggerConfig('{"name":"x"}'), false)
      assert.equal(hasChangeloggerConfig(null), false)
      assert.equal(hasChangeloggerConfig('not json'), false)
    })
  })

  describe('the pup commands', () => {
    it('downloads the pinned release', () => {
      assert.equal(
        pupDownloadUrl('2.0.0'),
        'https://github.com/stellarwp/pup/releases/download/2.0.0/pup.phar'
      )
    })

    it('bumps the version files, then replaces the TBDs', () => {
      assert.deepEqual(pupCommands('/tmp/pup.phar', '4.17.0'), [
        { command: 'php', args: ['/tmp/pup.phar', 'replace-version', '4.17.0'] },
        { command: 'php', args: ['/tmp/pup.phar', 'replace-tbd', '4.17.0'] },
      ])
    })
  })

  describe('the push credential', () => {
    it('is the basic credential git uses for a token', () => {
      const credential = basicCredential('ghs_abc')

      assert.equal(Buffer.from(credential, 'base64').toString(), 'x-access-token:ghs_abc')
    })

    it('reaches git through its environment, scoped to the server, after clearing the key', () => {
      // The empty first value resets the list, dropping a header the checkout persisted.
      assert.deepEqual(pushEnv('ghs_abc', 'https://github.com'), {
        GIT_CONFIG_COUNT: '2',
        GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
        GIT_CONFIG_VALUE_0: '',
        GIT_CONFIG_KEY_1: 'http.https://github.com/.extraheader',
        GIT_CONFIG_VALUE_1: `AUTHORIZATION: basic ${basicCredential('ghs_abc')}`,
      })
    })

    it('adds nothing without a token, leaving the checkout credentials to git', () => {
      assert.deepEqual(pushEnv('', 'https://github.com'), {})
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
      assert.equal(commitMessage('release/4.17.0', '4.17.0'), 'Prepare release/4.17.0 (4.17.0)')
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
        'git check-ref-format refs/heads/release/4.17.0',
        'git symbolic-ref --quiet --short HEAD',
        `curl -fsSL --retry 3 -o ${phar} https://github.com/stellarwp/pup/releases/download/2.0.0/pup.phar`,
        `php -d display_errors=stderr ${phar} get-version`,
        `php ${phar} replace-version 4.17.0`,
        `php ${phar} replace-tbd 4.17.0`,
      ])
      assert.ok(
        calls.filter((call) => call.command === 'php').every((call) => call.options.cwd === cwd),
        'pup runs in the checkout'
      )
      assert.deepEqual(outputs(), { version: '4.17.0', date: TODAY, ref: 'release/4.17.0' })
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
        [{ INPUT_REF: '' }, /No ref was given/],
        [{ INPUT_PUP_VERSION: 'latest' }, /pup-version/],
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

    it('stops before downloading pup when the ref is not a valid branch name', async (t) => {
      const { core } = await coreWithOutputs(t)
      const { exec, calls } = recordingExec(
        allSucceed([{ command: 'git', args: /^check-ref-format /, exitCode: 1 }])
      )
      const cwd = checkoutWith({ '.puprc': PUPRC, 'package.json': PACKAGE_JSON })

      await assert.rejects(
        runPrepare({ core, exec, env: prepareEnv({ INPUT_REF: 'release/..x' }), cwd }),
        /'release\/\.\.x' is not a valid branch name/
      )
      assert.deepEqual(sequence(calls), ['git check-ref-format refs/heads/release/..x'])
    })

    it('stops before downloading pup when the checkout is on another branch', async (t) => {
      // The push writes HEAD to refs/heads/<ref>. From another branch that the release branch is an
      // ancestor of, it would be accepted as a fast-forward and carry that branch's commits along.
      const { core } = await coreWithOutputs(t)
      const { exec, calls } = recordingExec(
        allSucceed([{ command: 'git', args: /^symbolic-ref /, stdout: 'main\n' }])
      )
      const cwd = checkoutWith({ '.puprc': PUPRC, 'package.json': PACKAGE_JSON })

      await assert.rejects(
        runPrepare({ core, exec, env: prepareEnv(), cwd }),
        /The checkout is on 'main', not on 'release\/4\.17\.0'.*Nothing was changed/s
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
        /The checkout is on a detached commit, not on 'release\/4\.17\.0'/
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
        /Refusing to prepare 4\.17\.0: release\/4\.17\.0 already has 4\.18\.0.*Nothing was changed/s
      )
      assert.ok(!sequence(calls).some((call) => / replace-(version|tbd) /.test(call)), 'pup changed nothing')
      assert.deepEqual(outputs(), {})
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
        const env = prepareEnv({ INPUT_VERSION: version, INPUT_REF: `release/${version}` })
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

    it('warns and goes on when pup cannot read the current version', async (t) => {
      const { core, logged } = await coreWithOutputs(t)
      const { exec, calls } = recordingExec(
        allSucceed([{ command: 'php', args: /get-version$/, stdout: 'unknown\n' }])
      )
      const cwd = checkoutWith({ '.puprc': PUPRC, 'package.json': PACKAGE_JSON })

      await runPrepare({ core, exec, env: prepareEnv(), cwd })

      assert.match(logged(), /::warning::.*current version/)
      assert.ok(sequence(calls).some((call) => call.endsWith('replace-version 4.17.0')))
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
      assert.deepEqual(outputs(), {})
    })

    it('fails when the pup download fails', async (t) => {
      const { core } = await coreWithOutputs(t)
      const { exec } = recordingExec(
        allSucceed([{ command: 'curl', exitCode: 22, stderr: 'The requested URL returned error: 404' }])
      )
      const cwd = checkoutWith({ '.puprc': PUPRC, 'package.json': PACKAGE_JSON })

      await assert.rejects(
        runPrepare({ core, exec, env: prepareEnv(), cwd }),
        /Downloading pup 2\.0\.0 failed.*404/s
      )
    })
  })

  describe('runCommit', () => {
    it('commits every change and pushes it to the release branch', async (t) => {
      const { core, outputs, summary } = await coreWithOutputs(t)
      const { exec } = await recordedRealExec()
      const { work, remote } = repositoryOn('release/4.17.0')
      fs.writeFileSync(path.join(work, 'plugin.php'), 'Version: 4.17.0\n')
      fs.writeFileSync(path.join(work, 'changelog.txt'), '= 4.17.0 =\n')

      await runCommit({ core, exec, env: commitEnv(), cwd: work })

      const pushed = git(remote, 'rev-parse', 'refs/heads/release/4.17.0')
      assert.equal(pushed, git(work, 'rev-parse', 'HEAD'))
      assert.equal(git(remote, 'log', '-1', '--format=%s', pushed), 'Prepare release/4.17.0 (4.17.0)')
      assert.equal(
        git(remote, 'log', '-1', '--format=%an <%ae>', pushed),
        'github-actions[bot] <41898282+github-actions[bot]@users.noreply.github.com>'
      )
      assert.deepEqual(outputs(), { commit: pushed, files: 'changelog.txt\nplugin.php' })
      assert.match(summary(), /Prepare release\/4\.17\.0 \(4\.17\.0\)/)
      assert.match(summary(), /^- `changelog\.txt`\n- `plugin\.php`$/m)
    })

    it('never puts the token on a command line, in the log or in the git config', async (t) => {
      const { core, logged } = await coreWithOutputs(t)
      const { exec, calls, printed } = await recordedRealExec()
      const { work } = repositoryOn('release/4.17.0')
      fs.writeFileSync(path.join(work, 'plugin.php'), 'Version: 4.17.0\n')
      const token = commitEnv().INPUT_TOKEN
      const credential = basicCredential(token)

      await runCommit({ core, exec, env: commitEnv(), cwd: work })

      assert.match(printed(), /\[command\].*git push origin HEAD:refs\/heads\/release\/4\.17\.0/)
      const log = `${logged()}\n${printed()}`
      assert.match(log, new RegExp(`::add-mask::${token}`))
      assert.match(log, new RegExp(`::add-mask::${credential}`))

      const unmasked = log.split('\n').filter((line) => !line.startsWith('::add-mask::'))
      assert.ok(!unmasked.some((line) => line.includes(token) || line.includes(credential)))
      assert.ok(!calls.some((call) => call.args.join(' ').includes(credential)))
      assert.ok(!fs.readFileSync(path.join(work, '.git', 'config'), 'utf8').includes(credential))

      const push = calls.find((call) => call.args[0] === 'push')
      assert.deepEqual(push.args, ['push', 'origin', 'HEAD:refs/heads/release/4.17.0'])
      assert.equal(push.options.env.GIT_CONFIG_VALUE_1, `AUTHORIZATION: basic ${credential}`)
    })

    it('sends only its own credential when the checkout persisted another', async (t) => {
      // actions/checkout persists its token under the same http.<server>/.extraheader key, and git
      // sends every value of that key. Two Authorization headers make GitHub answer 400.
      const http = require('node:http')
      const seen = []
      const server = http.createServer((request, response) => {
        const { rawHeaders } = request
        seen.push(
          rawHeaders.filter((value, index) => index % 2 === 1 && /^authorization$/i.test(rawHeaders[index - 1]))
        )
        response.writeHead(404).end()
      })
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
      t.after(() => server.close())

      const serverUrl = `http://127.0.0.1:${server.address().port}`
      const { core } = await coreWithOutputs(t)
      const { exec } = await recordedRealExec()
      const { work } = repositoryOn('release/4.17.0')
      git(work, 'remote', 'set-url', 'origin', `${serverUrl}/stellarwp/plugin.git`)
      git(work, 'config', `http.${serverUrl}/.extraheader`, 'AUTHORIZATION: basic cGVyc2lzdGVk')
      fs.writeFileSync(path.join(work, 'plugin.php'), 'Version: 4.17.0\n')
      const env = commitEnv({ GITHUB_SERVER_URL: serverUrl, GIT_TERMINAL_PROMPT: '0' })

      // The server has no repository, so the push fails once git has sent its first request.
      await assert.rejects(runCommit({ core, exec, env, cwd: work }), /Pushing to release\/4\.17\.0 failed/)

      assert.ok(seen.length > 0, 'git reached the server')
      for (const headers of seen) {
        assert.deepEqual(headers, [`basic ${basicCredential(env.INPUT_TOKEN)}`])
      }
    })

    it('neither commits nor pushes when nothing changed, and still succeeds', async (t) => {
      // A retry of the same version finds the branch already prepared.
      const { core, outputs } = await coreWithOutputs(t)
      const { exec, calls } = await recordedRealExec()
      const { work, remote } = repositoryOn('release/4.17.0')
      const before = git(remote, 'rev-parse', 'refs/heads/release/4.17.0')

      await runCommit({ core, exec, env: commitEnv(), cwd: work })

      assert.equal(git(remote, 'rev-parse', 'refs/heads/release/4.17.0'), before)
      assert.ok(!calls.some((call) => call.args.includes('commit') || call.args.includes('push')))
      assert.deepEqual(outputs(), { commit: '', files: '' })
    })

    it('fails with git output when the push is refused', async (t) => {
      const { core } = await coreWithOutputs(t)
      const { exec } = await recordedRealExec()
      const { work, remote } = repositoryOn('release/4.17.0')

      // Someone else pushed to the branch after the checkout, so the push is not a fast-forward.
      const other = path.join(path.dirname(remote), 'other')
      git(path.dirname(remote), 'clone', '--quiet', '-b', 'release/4.17.0', remote, other)
      git(other, 'config', 'user.name', 'Other')
      git(other, 'config', 'user.email', 'other@example.com')
      git(other, 'commit', '--quiet', '--allow-empty', '-m', 'Elsewhere')
      git(other, 'push', '--quiet', 'origin', 'HEAD:refs/heads/release/4.17.0')

      fs.writeFileSync(path.join(work, 'plugin.php'), 'Version: 4.17.0\n')

      await assert.rejects(
        runCommit({ core, exec, env: commitEnv(), cwd: work }),
        /Pushing to release\/4\.17\.0 failed.*rejected/s
      )
    })
  })
})
