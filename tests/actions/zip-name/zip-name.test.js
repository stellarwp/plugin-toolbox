'use strict'

const { describe, it } = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync } = require('node:child_process')

const {
  runZipName,
  readYesNo,
  readPrerelease,
  readSequence,
  readPrintedVersion,
  buildSuffix,
  PRERELEASE_LABELS,
  DEV_SUFFIX_COMMANDS,
} = require('../../../.github/actions/zip-name/zip-name.js')
const { coreWithOutputs, recordingExec, recordedRealExec } = require('../../support/actions.js')

/** A .puprc that names the zip and lists one version file. */
const PUPRC = {
  zip_name: 'give',
  paths: { versions: [{ file: 'give.php', regex: '(Version: )(.+)' }] },
}

/** The phar the pinned release downloads to. */
const PHAR = '/runner/temp/pup-2.0.0.phar'

/** What the commit of the checkout looks like to git, as the rules answer it. */
const TIMESTAMP = '1792689067'
const HASH = 'fbcf8681'

/**
 * A temporary directory holding the given files, standing in for the checked-out repository.
 *
 * @param {object} files Each relative path mapped to its contents. An object is written as JSON.
 *
 * @returns {string} The directory.
 */
function checkoutWith(files = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zip-name-'))

  for (const [name, contents] of Object.entries(files)) {
    const text = typeof contents === 'string' ? contents : JSON.stringify(contents)
    fs.writeFileSync(path.join(dir, name), text)
  }

  return dir
}

/**
 * The environment the manifest hands the step, over the inputs of a default QA build.
 *
 * @param {object} overrides Inputs to change.
 *
 * @returns {object} The environment.
 */
function nameEnv(overrides = {}) {
  return {
    INPUT_PRODUCTION: 'no',
    INPUT_PRERELEASE: 'dev',
    INPUT_SEQUENCE: '',
    INPUT_EXPECTED_VERSION: '',
    INPUT_PUP_VERSION: '2.0.0',
    INPUT_TOKEN: '',
    RUNNER_TEMP: '/runner/temp',
    ...overrides,
  }
}

/**
 * Rules under which every command the action runs succeeds: the checkout holds 4.19.0.1, and pup
 * names the zip `give.<version>` as it does from zip_name.
 *
 * @param {object[]} before Rules that take precedence, to make one command answer differently.
 *
 * @returns {object[]} Rules for recordingExec.
 */
function allSucceed(before = []) {
  return [
    ...before,
    { command: 'curl' },
    { command: 'php', args: /get-version$/, stdout: '4.19.0.1\n' },
    { command: 'php', args: / zip-name /, stdout: (args) => `give.${args.at(-1)}\n` },
    { command: 'git', args: /^show /, stdout: `${TIMESTAMP}\n` },
    { command: 'git', args: /^rev-parse /, stdout: `${HASH}\n` },
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

/** The calls up to and including the version read, the same on every build. */
const UP_TO_VERSION = [
  'curl -fsSI https://github.com/stellarwp/pup/releases/download/2.0.0/pup.phar',
  `curl -fsSL --retry 3 -o ${PHAR} https://github.com/stellarwp/pup/releases/download/2.0.0/pup.phar`,
  `php -d display_errors=stderr ${PHAR} get-version`,
]

/** The two git reads of the commit, as DevSuffix.php runs them. */
const COMMIT_READS = ['git show -s --format=%ct HEAD', 'git rev-parse --short=8 HEAD']

describe('zip-name', () => {
  describe('readYesNo', () => {
    it('reads yes and no, whatever the case and the whitespace', () => {
      assert.equal(readYesNo('yes', 'production'), true)
      assert.equal(readYesNo(' No\n', 'production'), false)
    })

    it('refuses anything else, naming the input', () => {
      for (const value of ['', 'true', 'false', '1', 'y', undefined]) {
        assert.throws(() => readYesNo(value, 'production'), /production '.*' is not yes or no\. No zip name was resolved\./)
      }
    })
  })

  describe('readPrerelease', () => {
    it('reads the four labels, in any case', () => {
      for (const label of PRERELEASE_LABELS) {
        assert.equal(readPrerelease(label), label)
        assert.equal(readPrerelease(label.toUpperCase()), label)
      }
    })

    it('reads an empty value as dev, the name every QA build had', () => {
      assert.equal(readPrerelease(''), 'dev')
      assert.equal(readPrerelease(undefined), 'dev')
    })

    it('refuses any other label, listing the accepted ones', () => {
      for (const value of ['nightly', 'rc1', 'rc-1', 'release', 'yes']) {
        assert.throws(() => readPrerelease(value), /prerelease '.*' is not dev, alpha, beta, or rc\. No zip name was resolved\./)
      }
    })
  })

  describe('readSequence', () => {
    it('reads digits from 1', () => {
      assert.equal(readSequence('1'), '1')
      assert.equal(readSequence(' 12 '), '12')
    })

    it('reads an empty value as no sequence', () => {
      assert.equal(readSequence(''), null)
      assert.equal(readSequence(undefined), null)
    })

    it('refuses zero, a leading zero, a negative, a decimal and text', () => {
      for (const value of ['0', '01', '-1', '1.5', 'abc', '2a', 'rc-2']) {
        assert.throws(() => readSequence(value), /sequence '.*' is not a build number.*No zip name was resolved\./s, value)
      }
    })
  })

  describe('buildSuffix', () => {
    it('names a default build the way DevSuffix.php does: -dev-<timestamp>-<hash>', () => {
      // "-dev-{$timestamp}-{$hash}" in pup's src/Commands/Traits/DevSuffix.php.
      assert.equal(buildSuffix('dev', null, TIMESTAMP, HASH), `-dev-${TIMESTAMP}-${HASH}`)
    })

    it('reads the commit with the two commands DevSuffix.php runs', () => {
      // `git show -s --format=%ct HEAD` and `git rev-parse --short=8 HEAD`, in that file.
      assert.deepEqual(DEV_SUFFIX_COMMANDS, [
        ['show', '-s', '--format=%ct', 'HEAD'],
        ['rev-parse', '--short=8', 'HEAD'],
      ])
    })

    it('puts another label in place of dev', () => {
      assert.equal(buildSuffix('rc', null, TIMESTAMP, HASH), `-rc-${TIMESTAMP}-${HASH}`)
    })

    it('puts a sequence in place of the timestamp and the hash', () => {
      assert.equal(buildSuffix('rc', '2', TIMESTAMP, HASH), '-rc-2')
      assert.equal(buildSuffix('beta', '10', TIMESTAMP, HASH), '-beta-10')
    })
  })

  describe('readPrintedVersion', () => {
    it('reads the version pup printed, ignoring anything before it', () => {
      assert.equal(readPrintedVersion('4.19.0.1\n'), '4.19.0.1')
      assert.equal(readPrintedVersion('PHP Deprecated: something\n4.19.0.1\n'), '4.19.0.1')
    })

    it('keeps a version that is not numeric: what the files hold is what the zip carries', () => {
      assert.equal(readPrintedVersion('4.19.0-beta.1\n'), '4.19.0-beta.1')
    })

    it('refuses an empty answer and unknown, which pup prints when the regex matches nothing', () => {
      assert.throws(() => readPrintedVersion(''), /read no version.*No zip name was resolved/s)
      assert.throws(() => readPrintedVersion('unknown\n'), /read no version.*printed 'unknown'/s)
    })
  })

  describe('runZipName', () => {
    it('names a default QA build as pup get-version --dev would, from the commit', async (t) => {
      const { core, outputs } = await coreWithOutputs(t)
      const { exec, calls } = recordingExec(allSucceed())
      const cwd = checkoutWith({ '.puprc': PUPRC })

      await runZipName({ core, exec, env: nameEnv(), cwd })

      const version = `4.19.0.1-dev-${TIMESTAMP}-${HASH}`
      assert.deepEqual(sequence(calls), [
        ...UP_TO_VERSION,
        ...COMMIT_READS,
        `php -d display_errors=stderr ${PHAR} zip-name ${version}`,
      ])
      assert.ok(
        calls.filter((call) => call.command !== 'curl').every((call) => call.options.cwd === cwd),
        'pup and git run in the checkout'
      )
      assert.deepEqual(outputs(), {
        'base-version': '4.19.0.1',
        version,
        'zip-name': `give.${version}`,
        prerelease: 'dev',
      })
    })

    it('names an rc build with the label in place of dev', async (t) => {
      const { core, outputs } = await coreWithOutputs(t)
      const { exec } = recordingExec(allSucceed())
      const cwd = checkoutWith({ '.puprc': PUPRC })

      await runZipName({ core, exec, env: nameEnv({ INPUT_PRERELEASE: 'rc' }), cwd })

      assert.deepEqual(outputs(), {
        'base-version': '4.19.0.1',
        version: `4.19.0.1-rc-${TIMESTAMP}-${HASH}`,
        'zip-name': `give.4.19.0.1-rc-${TIMESTAMP}-${HASH}`,
        prerelease: 'rc',
      })
    })

    it('names a numbered build with the sequence, reading nothing from the commit', async (t) => {
      const { core, outputs } = await coreWithOutputs(t)
      const { exec, calls } = recordingExec(allSucceed())
      const cwd = checkoutWith({ '.puprc': PUPRC })

      await runZipName({ core, exec, env: nameEnv({ INPUT_PRERELEASE: 'beta', INPUT_SEQUENCE: '2' }), cwd })

      assert.deepEqual(sequence(calls), [...UP_TO_VERSION, `php -d display_errors=stderr ${PHAR} zip-name 4.19.0.1-beta-2`])
      assert.deepEqual(outputs(), {
        'base-version': '4.19.0.1',
        version: '4.19.0.1-beta-2',
        'zip-name': 'give.4.19.0.1-beta-2',
        prerelease: 'beta',
      })
    })

    it('names a production build after the clean version, reading nothing from the commit', async (t) => {
      const { core, outputs, logged } = await coreWithOutputs(t)
      const { exec, calls } = recordingExec(allSucceed())
      const cwd = checkoutWith({ '.puprc': PUPRC })

      await runZipName({ core, exec, env: nameEnv({ INPUT_PRODUCTION: 'yes' }), cwd })

      assert.deepEqual(sequence(calls), [...UP_TO_VERSION, `php -d display_errors=stderr ${PHAR} zip-name 4.19.0.1`])
      assert.deepEqual(outputs(), {
        'base-version': '4.19.0.1',
        version: '4.19.0.1',
        'zip-name': 'give.4.19.0.1',
        prerelease: '',
      })
      assert.doesNotMatch(logged(), /::warning::/, 'the default prerelease is no cause for a warning')
    })

    it('ignores prerelease and sequence on a production build, and says so', async (t) => {
      const cases = [
        [{ INPUT_PRERELEASE: 'rc', INPUT_SEQUENCE: '3' }, /production is yes, so prerelease 'rc' and sequence '3' are ignored/],
        [{ INPUT_PRERELEASE: 'rc' }, /production is yes, so prerelease 'rc' is ignored/],
        [{ INPUT_SEQUENCE: '3' }, /production is yes, so sequence '3' is ignored/],
      ]

      for (const [overrides, warning] of cases) {
        const { core, outputs, logged } = await coreWithOutputs(t)
        const { exec } = recordingExec(allSucceed())
        const cwd = checkoutWith({ '.puprc': PUPRC })

        await runZipName({ core, exec, env: nameEnv({ INPUT_PRODUCTION: 'yes', ...overrides }), cwd })

        assert.match(logged(), warning)
        assert.deepEqual(outputs(), {
          'base-version': '4.19.0.1',
          version: '4.19.0.1',
          'zip-name': 'give.4.19.0.1',
          prerelease: '',
        })
      }
    })

    it('ignores a prerelease or sequence it would refuse on a QA build, when production is yes', async (t) => {
      // production is the master switch: a typo in the form must not hold up a production zip.
      const { core, outputs, logged } = await coreWithOutputs(t)
      const { exec } = recordingExec(allSucceed())
      const cwd = checkoutWith({ '.puprc': PUPRC })

      await runZipName({ core, exec, env: nameEnv({ INPUT_PRODUCTION: 'yes', INPUT_PRERELEASE: 'nightly', INPUT_SEQUENCE: 'abc' }), cwd })

      assert.match(logged(), /::warning::production is yes, so prerelease 'nightly' and sequence 'abc' are ignored/)
      assert.deepEqual(outputs(), {
        'base-version': '4.19.0.1',
        version: '4.19.0.1',
        'zip-name': 'give.4.19.0.1',
        prerelease: '',
      })
    })

    it('stops before downloading or running anything when production, prerelease or sequence is wrong', async (t) => {
      const cases = [
        [{ INPUT_PRODUCTION: 'true' }, /production 'true' is not yes or no/],
        [{ INPUT_PRODUCTION: '' }, /production '' is not yes or no/],
        [{ INPUT_PRERELEASE: 'nightly' }, /prerelease 'nightly' is not dev, alpha, beta, or rc/],
        [{ INPUT_SEQUENCE: 'abc' }, /sequence 'abc' is not a build number/],
        [{ INPUT_SEQUENCE: '0' }, /sequence '0' is not a build number/],
        [{ INPUT_SEQUENCE: '02' }, /sequence '02' is not a build number/],
        [{ INPUT_PUP_VERSION: '2.0' }, /pup-version '2\.0' is not a pup release number/],
      ]

      for (const [overrides, message] of cases) {
        const { core, outputs } = await coreWithOutputs(t)
        const { exec, calls } = recordingExec(allSucceed())
        const cwd = checkoutWith({ '.puprc': PUPRC })

        await assert.rejects(runZipName({ core, exec, env: nameEnv(overrides), cwd }), message)
        assert.deepEqual(calls, [], `nothing ran for ${JSON.stringify(overrides)}`)
        assert.deepEqual(outputs(), {})
      }
    })

    it('stops before downloading or running anything when the repository has no usable .puprc', async (t) => {
      const cases = [
        [{}, /No \.puprc.*No zip name was resolved/s],
        [{ '.puprc': '{ "paths": ' }, /\.puprc is not valid JSON/],
        [{ '.puprc': {} }, /no paths\.versions/],
        [{ '.puprc': { paths: { versions: [] } } }, /no paths\.versions/],
      ]

      for (const [files, message] of cases) {
        const { core, outputs } = await coreWithOutputs(t)
        const { exec, calls } = recordingExec(allSucceed())
        const cwd = checkoutWith(files)

        await assert.rejects(runZipName({ core, exec, env: nameEnv(), cwd }), message)
        assert.deepEqual(calls, [], `nothing ran for ${JSON.stringify(files)}`)
        assert.deepEqual(outputs(), {})
      }
    })

    it('accepts the version expected-version names', async (t) => {
      const { core, outputs } = await coreWithOutputs(t)
      const { exec } = recordingExec(allSucceed())
      const cwd = checkoutWith({ '.puprc': PUPRC })

      await runZipName({ core, exec, env: nameEnv({ INPUT_EXPECTED_VERSION: ' 4.19.0.1 ' }), cwd })

      assert.equal(outputs()['base-version'], '4.19.0.1')
    })

    it('prints VERSION_MISMATCH on its own line and fails when the files hold another version', async (t) => {
      const { core, outputs, logged } = await coreWithOutputs(t)
      const { exec, calls } = recordingExec(allSucceed())
      const cwd = checkoutWith({ '.puprc': PUPRC })

      await assert.rejects(
        runZipName({ core, exec, env: nameEnv({ INPUT_EXPECTED_VERSION: '4.19.0.2' }), cwd }),
        /The version files hold 4\.19\.0\.1, not the expected 4\.19\.0\.2.*No zip name was resolved/s
      )

      assert.match(logged(), /^VERSION_MISMATCH: expected 4\.19\.0\.2, but the version files hold 4\.19\.0\.1\.$/m)
      assert.deepEqual(sequence(calls), UP_TO_VERSION, 'nothing runs after the version read')
      assert.deepEqual(outputs(), {})
    })

    it('fails when pup reads no version, before naming anything', async (t) => {
      for (const printed of ['unknown\n', '']) {
        const { core, outputs } = await coreWithOutputs(t)
        const { exec, calls } = recordingExec(allSucceed([{ command: 'php', args: /get-version$/, stdout: printed }]))
        const cwd = checkoutWith({ '.puprc': PUPRC })

        await assert.rejects(runZipName({ core, exec, env: nameEnv(), cwd }), /pup get-version read no version/)
        assert.deepEqual(sequence(calls), UP_TO_VERSION)
        assert.deepEqual(outputs(), {})
      }
    })

    it('fails with pup output when pup cannot read the version files', async (t) => {
      // pup refuses to load a .puprc whose version regex finds nothing, so get-version exits 1.
      const { core, outputs } = await coreWithOutputs(t)
      const { exec } = recordingExec(
        allSucceed([
          {
            command: 'php',
            args: /get-version$/,
            exitCode: 1,
            stdout: 'ERROR: Could not find version in file give.php using regex "/(Version: )(.+)/"',
          },
        ])
      )
      const cwd = checkoutWith({ '.puprc': PUPRC })

      await assert.rejects(
        runZipName({ core, exec, env: nameEnv(), cwd }),
        /pup get-version failed.*Could not find version in file give\.php/s
      )
      assert.deepEqual(outputs(), {})
    })

    it('fails when pup names the zip without the version, rather than hand on a name the upload would miss', async (t) => {
      const { core, outputs } = await coreWithOutputs(t)
      const { exec } = recordingExec(allSucceed([{ command: 'php', args: / zip-name /, stdout: 'give\n' }]))
      const cwd = checkoutWith({ '.puprc': PUPRC })

      await assert.rejects(
        runZipName({ core, exec, env: nameEnv({ INPUT_PRODUCTION: 'yes' }), cwd }),
        /pup zip-name printed 'give', not a name ending in \.4\.19\.0\.1.*zip_name in \.puprc/s
      )
      assert.deepEqual(outputs(), {})
    })

    it('fails with pup output when pup zip-name fails', async (t) => {
      // Without zip_name in .puprc and without a composer.json, pup throws a ConfigException.
      const { core } = await coreWithOutputs(t)
      const { exec } = recordingExec(
        allSucceed([{ command: 'php', args: / zip-name /, exitCode: 1, stderr: 'Could not find a "zip_name" in .puprc' }])
      )
      const cwd = checkoutWith({ '.puprc': PUPRC })

      await assert.rejects(runZipName({ core, exec, env: nameEnv(), cwd }), /pup zip-name failed.*zip_name/s)
    })

    it('fails when the release exists but has no phar, naming the pin', async (t) => {
      const { core, outputs } = await coreWithOutputs(t)
      const { exec, calls } = recordingExec(
        allSucceed([
          { command: 'curl', args: /fsSI .*\/download\//, exitCode: 22, stderr: 'The requested URL returned error: 404' },
          { command: 'curl', args: /fsSI .*\/releases\/tag\// },
        ])
      )
      const cwd = checkoutWith({ '.puprc': PUPRC })

      await assert.rejects(
        runZipName({ core, exec, env: nameEnv(), cwd }),
        /pup 2\.0\.0 publishes no pup\.phar asset.*such as 2\.0\.0\. No zip name was resolved\./s
      )
      assert.ok(!sequence(calls).some((call) => /fsSL|php |git /.test(call)), 'nothing downloaded, nothing run')
      assert.deepEqual(outputs(), {})
    })

    it('resolves latest through the API with the token, then downloads that release', async (t) => {
      const { core, outputs } = await coreWithOutputs(t)
      const { exec, calls } = recordingExec(allSucceed())
      const cwd = checkoutWith({ '.puprc': PUPRC })
      const fetched = []
      const fetchImpl = async (url, options) => {
        fetched.push([url, options])
        return { ok: true, json: async () => ({ tag_name: '2.0.0' }) }
      }

      await runZipName({ core, exec, env: nameEnv({ INPUT_PUP_VERSION: 'latest', INPUT_TOKEN: 'ghp_example' }), cwd, fetchImpl })

      assert.deepEqual(fetched, [
        ['https://api.github.com/repos/stellarwp/pup/releases/latest', { headers: { authorization: 'Bearer ghp_example' } }],
      ])
      assert.ok(sequence(calls).some((call) => call.includes('download/2.0.0/pup.phar')))
      assert.equal(outputs().version, `4.19.0.1-dev-${TIMESTAMP}-${HASH}`)
    })

    it('reads the checkout in working-directory, resolved against the workspace', async (t) => {
      // A workflow that checks the repository out into source/ and runs the action from the workspace.
      const { core, outputs } = await coreWithOutputs(t)
      const { exec, calls } = recordingExec(allSucceed())
      const workspace = checkoutWith({})
      fs.mkdirSync(path.join(workspace, 'source'))
      fs.writeFileSync(path.join(workspace, 'source', '.puprc'), JSON.stringify(PUPRC))

      await runZipName({ core, exec, env: nameEnv({ INPUT_WORKING_DIRECTORY: 'source' }), cwd: workspace })

      assert.ok(
        calls.filter((call) => call.command !== 'curl').every((call) => call.options.cwd === path.join(workspace, 'source')),
        'pup and git run in source/'
      )
      assert.equal(outputs()['base-version'], '4.19.0.1')
    })

    it('refuses a working-directory that is not there, before downloading or running anything', async (t) => {
      const { core, outputs } = await coreWithOutputs(t)
      const { exec, calls } = recordingExec(allSucceed())
      const cwd = checkoutWith({ '.puprc': PUPRC })

      await assert.rejects(
        runZipName({ core, exec, env: nameEnv({ INPUT_WORKING_DIRECTORY: 'source' }), cwd }),
        /working-directory 'source' is not a directory \(.*\/source\).*No zip name was resolved/s
      )
      assert.deepEqual(calls, [])
      assert.deepEqual(outputs(), {})
    })

    it('reuses the phar an earlier step of the job downloaded, without checking or downloading again', async (t) => {
      const { core, outputs, logged } = await coreWithOutputs(t)
      const { exec, calls } = recordingExec(allSucceed())
      const cwd = checkoutWith({ '.puprc': PUPRC })
      const runnerTemp = fs.mkdtempSync(path.join(os.tmpdir(), 'zip-name-runner-'))
      fs.writeFileSync(path.join(runnerTemp, 'pup-2.0.0.phar'), '<?php // pup')

      await runZipName({ core, exec, env: nameEnv({ RUNNER_TEMP: runnerTemp }), cwd })

      assert.ok(!calls.some((call) => call.command === 'curl'), `no curl at all, got ${JSON.stringify(sequence(calls))}`)
      assert.ok(sequence(calls)[0].startsWith(`php -d display_errors=stderr ${path.join(runnerTemp, 'pup-2.0.0.phar')} get-version`))
      assert.match(logged(), /Reusing pup 2\.0\.0, downloaded by an earlier step/)
      assert.equal(outputs()['base-version'], '4.19.0.1')
    })

    it('downloads again over an empty phar a cut-off download left, and leaves none behind when the download fails', async (t) => {
      const runnerTemp = fs.mkdtempSync(path.join(os.tmpdir(), 'zip-name-runner-'))
      const phar = path.join(runnerTemp, 'pup-2.0.0.phar')
      fs.writeFileSync(phar, '')
      const { core } = await coreWithOutputs(t)
      const { exec, calls } = recordingExec(
        allSucceed([
          {
            command: 'curl',
            args: /fsSL/,
            // curl writes what it got before the connection dropped, then exits non-zero.
            effect: () => fs.writeFileSync(phar, '<?php // half'),
            exitCode: 56,
            stderr: 'Recv failure: Connection reset by peer',
          },
        ])
      )
      const cwd = checkoutWith({ '.puprc': PUPRC })

      await assert.rejects(runZipName({ core, exec, env: nameEnv({ RUNNER_TEMP: runnerTemp }), cwd }), /Downloading pup 2\.0\.0 failed.*Connection reset/s)

      assert.ok(sequence(calls).some((call) => call.startsWith('curl -fsSL')), 'an empty phar is not reused')
      assert.equal(fs.existsSync(phar), false, 'the half-written phar is removed')
    })

    it('gives a real commit the suffix pup get-version --dev gives it', async (t) => {
      // The two git reads run for real, against a repository made here; pup stays a stand-in. What
      // DevSuffix.php would build from the same commit is computed alongside and has to match.
      const { core, outputs } = await coreWithOutputs(t)
      const work = fs.mkdtempSync(path.join(os.tmpdir(), 'zip-name-git-'))
      const git = (...args) => execFileSync('git', args, { cwd: work, encoding: 'utf8' }).trim()
      git('init', '--quiet')
      git('config', 'user.name', 'Test')
      git('config', 'user.email', 'test@example.com')
      fs.writeFileSync(path.join(work, '.puprc'), JSON.stringify(PUPRC))
      fs.writeFileSync(path.join(work, 'give.php'), 'Version: 4.19.0.1\n')
      git('add', '-A')
      git('commit', '--quiet', '-m', 'Initial')

      const real = await recordedRealExec()
      const fake = recordingExec(allSucceed())
      const exec = {
        getExecOutput: (command, args, options) =>
          (command === 'git' ? real.exec : fake.exec).getExecOutput(command, args, options),
      }

      await runZipName({ core, exec, env: nameEnv(), cwd: work })

      const devSuffix = `-dev-${git('show', '-s', '--format=%ct', 'HEAD')}-${git('rev-parse', '--short=8', 'HEAD')}`
      assert.match(devSuffix, /^-dev-\d{10}-[0-9a-f]{8}$/)
      assert.equal(outputs().version, `4.19.0.1${devSuffix}`)
      assert.equal(outputs()['zip-name'], `give.4.19.0.1${devSuffix}`)
    })
  })
})
