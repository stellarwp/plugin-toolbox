'use strict'

const { describe, it } = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const {
  run,
  installPup,
  downloadPhar,
  runPup,
  getVersion,
  zipName,
  pharPath,
  validatePupVersion,
  resolvePupRelease,
  resolvePupDistribution,
  pupDownloadUrl,
  pupReleaseUrl,
  DEFAULT_PUP_VERSION,
} = require('../../../.github/actions/pup/pup.js')
const { lastLine, runOrFail } = require('../../../.github/lib/commands.js')
const { coreWithOutputs, recordingExec } = require('../../support/actions.js')

const PHAR_URL = 'https://github.com/stellarwp/pup/releases/download/2.0.0/pup.phar'

/** A fresh folder for RUNNER_TEMP, so one test's phar never reaches another. */
function runnerTemp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pup-test-'))
}

/** Each call as `command arg arg…`. */
function sequence(calls) {
  return calls.map((call) => [call.command, ...call.args].join(' '))
}

/** A fetch that answers every call the same way, and records what it was asked. */
function fetchAnswering(status, body) {
  const calls = []
  const fetchImpl = async (url, options) => {
    calls.push([url, options])

    return { ok: status >= 200 && status < 300, status, json: async () => body }
  }

  return { fetchImpl, calls }
}

/** Rules under which the release exists, ships a phar, and pup answers as asked. */
function pupRules({ version = '4.19.1\n', name = 'my-plugin.4.19.1-dev\n' } = {}) {
  return [
    { command: 'curl', args: /^-fsSI / },
    {
      command: 'curl',
      args: /^-fsSL /,
      effect: (args) => fs.writeFileSync(args[args.indexOf('-o') + 1], 'phar'),
    },
    { command: 'php', args: /zip-name/, stdout: name },
    { command: 'php', args: /get-version/, stdout: version },
  ]
}

describe('pup', () => {
  describe('lastLine and runOrFail', () => {
    it('reads the last non-empty line, after any notice', () => {
      assert.equal(lastLine('PHP Notice: x\n4.19.1\n\n'), '4.19.1')
      assert.equal(lastLine(''), '')
      assert.equal(lastLine(undefined), '')
    })

    it('fails with what the command printed when it exits non-zero', async () => {
      const { exec } = recordingExec([{ command: 'php', exitCode: 3, stdout: 'out', stderr: 'err' }])

      await assert.rejects(
        runOrFail(exec, 'php', [], {}, 'pup check'),
        /pup check failed \(exit code 3\):\nout\nerr/
      )
    })
  })

  describe('validatePupVersion', () => {
    it('accepts a release number and latest', () => {
      assert.equal(validatePupVersion(' 2.0.0 '), '2.0.0')
      assert.equal(validatePupVersion('latest'), 'latest')
    })

    it('refuses anything else', () => {
      for (const version of ['', '2.0', 'v2.0.0', '2.0.0-beta', '../2.0.0']) {
        assert.throws(() => validatePupVersion(version), /pup-version/)
      }
    })
  })

  describe('the release URLs', () => {
    it('point at the phar and at the release page', () => {
      assert.equal(pupDownloadUrl('2.0.0'), PHAR_URL)
      assert.equal(pupReleaseUrl('2.0.0'), 'https://github.com/stellarwp/pup/releases/tag/2.0.0')
    })
  })

  describe('resolvePupRelease', () => {
    it('uses a pinned release as it is, with no request', async () => {
      const { fetchImpl, calls } = fetchAnswering(500, {})

      assert.equal(await resolvePupRelease({ version: '2.0.0', token: '', fetchImpl }), '2.0.0')
      assert.deepEqual(calls, [])
    })

    it('asks the API for the newest release, with the token when there is one', async () => {
      const { fetchImpl, calls } = fetchAnswering(200, { tag_name: '2.1.0' })

      assert.equal(await resolvePupRelease({ version: 'LATEST', token: 'ghp_x', fetchImpl }), '2.1.0')
      assert.deepEqual(calls, [
        ['https://api.github.com/repos/stellarwp/pup/releases/latest', { headers: { authorization: 'Bearer ghp_x' } }],
      ])
    })

    it('sends no authorization header without a token', async () => {
      const { fetchImpl, calls } = fetchAnswering(200, { tag_name: '2.1.0' })

      await resolvePupRelease({ version: 'latest', token: '', fetchImpl })
      assert.deepEqual(calls[0][1], { headers: {} })
    })

    it('fails when the API answers with an error', async () => {
      const { fetchImpl } = fetchAnswering(403, {})

      await assert.rejects(
        resolvePupRelease({ version: 'latest', token: '', fetchImpl }),
        /Reading the latest pup release failed \(HTTP 403\)/
      )
    })

    it('fails when the release has no usable tag', async () => {
      for (const body of [{}, { tag_name: 7 }, { tag_name: 'nightly' }]) {
        const { fetchImpl } = fetchAnswering(200, body)

        await assert.rejects(
          resolvePupRelease({ version: 'latest', token: '', fetchImpl }),
          /The latest pup release has no usable tag/
        )
      }
    })
  })

  describe('resolvePupDistribution', () => {
    it('is phar when the release publishes one', async () => {
      const { exec, calls } = recordingExec([{ command: 'curl' }])

      assert.equal(await resolvePupDistribution({ exec, release: '2.0.0' }), 'phar')
      assert.deepEqual(sequence(calls), [`curl -fsSI ${PHAR_URL}`])
    })

    it('is ts when the release exists but has no phar', async () => {
      const { exec, calls } = recordingExec([
        { command: 'curl', args: /download/, exitCode: 22, stderr: 'curl: (22) The requested URL returned error: 404' },
        { command: 'curl', args: /tag/ },
      ])

      assert.equal(await resolvePupDistribution({ exec, release: '3.0.0' }), 'ts')
      assert.equal(calls.length, 2)
    })

    it('fails naming the release when it does not exist', async () => {
      const { exec } = recordingExec([{ command: 'curl', exitCode: 22, stderr: 'curl: (22) returned error: 404' }])

      await assert.rejects(resolvePupDistribution({ exec, release: '9.9.9' }), /pup 9\.9\.9 is not a release/)
    })

    it('fails with curl output when the check itself breaks', async () => {
      const { exec } = recordingExec([{ command: 'curl', exitCode: 6, stderr: 'Could not resolve host' }])

      await assert.rejects(
        resolvePupDistribution({ exec, release: '2.0.0' }),
        /Checking the pup 2\.0\.0 release failed \(exit code 6\):\nCould not resolve host/
      )
    })
  })

  describe('downloadPhar', () => {
    it('downloads with retries to the given path', async () => {
      const phar = path.join(runnerTemp(), 'pup-2.0.0.phar')
      const { exec, calls } = recordingExec(pupRules())

      assert.equal(await downloadPhar({ exec, release: '2.0.0', phar }), true)
      assert.deepEqual(sequence(calls), [`curl -fsSL --retry 3 -o ${phar} ${PHAR_URL}`])
    })

    it('does nothing when the phar is already there', async () => {
      const phar = path.join(runnerTemp(), 'pup-2.0.0.phar')
      fs.writeFileSync(phar, 'phar')
      const { exec, calls } = recordingExec([])

      assert.equal(await downloadPhar({ exec, release: '2.0.0', phar }), false)
      assert.deepEqual(calls, [])
    })

    it('downloads again when the file is empty', async () => {
      const phar = path.join(runnerTemp(), 'pup-2.0.0.phar')
      fs.writeFileSync(phar, '')
      const { exec, calls } = recordingExec(pupRules())

      assert.equal(await downloadPhar({ exec, release: '2.0.0', phar }), true)
      assert.equal(calls.length, 1)
    })

    it('fails with curl output, and leaves no half file behind', async () => {
      const phar = path.join(runnerTemp(), 'pup-2.0.0.phar')
      const { exec } = recordingExec([
        {
          command: 'curl',
          exitCode: 56,
          stderr: 'curl: (56) connection reset',
          effect: (args) => fs.writeFileSync(args[args.indexOf('-o') + 1], 'half'),
        },
      ])

      await assert.rejects(
        downloadPhar({ exec, release: '2.0.0', phar }),
        /Downloading pup 2\.0\.0 failed \(exit code 56\):\ncurl: \(56\) connection reset/
      )
      assert.equal(fs.existsSync(phar), false)
    })
  })

  describe('pharPath', () => {
    it('is in RUNNER_TEMP, named after the release', () => {
      assert.equal(pharPath({ RUNNER_TEMP: '/runner/temp' }, '2.0.0'), '/runner/temp/pup-2.0.0.phar')
    })

    it('falls back to the system temp directory', () => {
      assert.equal(pharPath({}, '2.0.0'), path.join(os.tmpdir(), 'pup-2.0.0.phar'))
    })
  })

  describe('runPup', () => {
    it('runs the phar with php, in the checkout, with errors on stderr', async () => {
      const { exec, calls } = recordingExec([{ command: 'php', stdout: 'ok' }])

      assert.equal(await runPup({ exec, phar: '/p/pup.phar', cwd: '/repo', args: ['check'] }), 'ok')
      assert.deepEqual(sequence(calls), ['php -d display_errors=stderr /p/pup.phar check'])
      assert.equal(calls[0].options.cwd, '/repo')
      assert.equal(calls[0].options.silent, true)
    })

    it('fails with the output of pup', async () => {
      const { exec } = recordingExec([{ command: 'php', exitCode: 1, stdout: 'No version found' }])

      await assert.rejects(
        runPup({ exec, phar: '/p/pup.phar', cwd: '/repo', args: ['get-version'] }),
        /pup get-version failed \(exit code 1\):\nNo version found/
      )
    })
  })

  describe('getVersion', () => {
    it('reads the last line pup printed', async () => {
      const { exec, calls } = recordingExec([{ command: 'php', stdout: 'PHP Notice: x\n4.19.1\n' }])

      assert.equal(await getVersion({ exec, phar: '/p/pup.phar', cwd: '/repo' }), '4.19.1')
      assert.deepEqual(sequence(calls), ['php -d display_errors=stderr /p/pup.phar get-version'])
    })

    it('asks for the development version with dev', async () => {
      const { exec, calls } = recordingExec([{ command: 'php', stdout: '4.19.1-dev.abc123\n' }])

      assert.equal(await getVersion({ exec, phar: '/p/pup.phar', cwd: '/repo', dev: true }), '4.19.1-dev.abc123')
      assert.deepEqual(sequence(calls), ['php -d display_errors=stderr /p/pup.phar get-version --dev'])
    })

    it('fails when pup prints nothing', async () => {
      const { exec } = recordingExec([{ command: 'php', stdout: '\n' }])

      await assert.rejects(getVersion({ exec, phar: '/p/pup.phar', cwd: '/repo' }), /printed no version/)
    })
  })

  describe('zipName', () => {
    it('asks pup for the name of the version', async () => {
      const { exec, calls } = recordingExec([{ command: 'php', stdout: 'my-plugin.4.19.1-dev\n' }])

      assert.equal(
        await zipName({ exec, phar: '/p/pup.phar', cwd: '/repo', version: '4.19.1-dev.abc123' }),
        'my-plugin.4.19.1-dev'
      )
      assert.deepEqual(sequence(calls), ['php -d display_errors=stderr /p/pup.phar zip-name 4.19.1-dev.abc123'])
    })

    it('refuses an empty version before running anything', async () => {
      const { exec, calls } = recordingExec([])

      await assert.rejects(zipName({ exec, phar: '/p/pup.phar', cwd: '/repo', version: ' ' }), /needs a version/)
      assert.deepEqual(calls, [])
    })

    it('fails when pup prints nothing', async () => {
      const { exec } = recordingExec([{ command: 'php', stdout: '' }])

      await assert.rejects(
        zipName({ exec, phar: '/p/pup.phar', cwd: '/repo', version: '1.0.0' }),
        /printed no name/
      )
    })
  })

  describe('installPup', () => {
    it('checks the release, downloads the phar and returns where it is', async (t) => {
      const { core, logged } = await coreWithOutputs(t)
      const env = { RUNNER_TEMP: runnerTemp() }
      const { exec, calls } = recordingExec(pupRules())

      const result = await installPup({ core, exec, version: '2.0.0', token: '', env })

      assert.deepEqual(result, { release: '2.0.0', phar: path.join(env.RUNNER_TEMP, 'pup-2.0.0.phar') })
      assert.deepEqual(sequence(calls), [
        `curl -fsSI ${PHAR_URL}`,
        `curl -fsSL --retry 3 -o ${result.phar} ${PHAR_URL}`,
      ])
      assert.match(logged(), /Downloaded pup 2\.0\.0/)
    })

    it('uses the default release when none is given', async (t) => {
      const { core } = await coreWithOutputs(t)
      const { exec } = recordingExec(pupRules())

      const result = await installPup({ core, exec, version: '', token: '', env: { RUNNER_TEMP: runnerTemp() } })

      assert.equal(result.release, DEFAULT_PUP_VERSION)
    })

    it('reuses a phar from an earlier step, and asks the network for nothing', async (t) => {
      const { core, logged } = await coreWithOutputs(t)
      const env = { RUNNER_TEMP: runnerTemp() }
      fs.writeFileSync(path.join(env.RUNNER_TEMP, 'pup-2.0.0.phar'), 'phar')
      const { exec, calls } = recordingExec([])

      await installPup({ core, exec, version: '2.0.0', token: '', env })

      assert.deepEqual(calls, [])
      assert.match(logged(), /Reusing pup 2\.0\.0/)
    })

    it('resolves latest, then names the phar after the release it found', async (t) => {
      const { core } = await coreWithOutputs(t)
      const env = { RUNNER_TEMP: runnerTemp() }
      const { exec } = recordingExec(pupRules())
      const { fetchImpl } = fetchAnswering(200, { tag_name: '2.0.0' })

      const result = await installPup({ core, exec, version: 'latest', token: 't', env, fetchImpl })

      assert.equal(result.release, '2.0.0')
      assert.equal(path.basename(result.phar), 'pup-2.0.0.phar')
    })

    it('refuses a release that publishes no phar, naming a pin', async (t) => {
      const { core } = await coreWithOutputs(t)
      const { exec, calls } = recordingExec([
        { command: 'curl', args: /download/, exitCode: 22, stderr: '404' },
        { command: 'curl', args: /tag/ },
      ])

      await assert.rejects(
        installPup({ core, exec, version: '3.0.0', token: '', env: { RUNNER_TEMP: runnerTemp() } }),
        /pup 3\.0\.0 publishes no pup\.phar asset.*such as 2\.0\.0/s
      )
      assert.ok(!sequence(calls).some((call) => call.startsWith('curl -fsSL')), 'nothing was downloaded')
    })

    it('refuses a version that is not a release number before any request', async (t) => {
      const { core } = await coreWithOutputs(t)
      const { exec, calls } = recordingExec([])

      await assert.rejects(
        installPup({ core, exec, version: '2.0', token: '', env: { RUNNER_TEMP: runnerTemp() } }),
        /pup-version '2\.0' is not a pup release number/
      )
      assert.deepEqual(calls, [])
    })
  })

  describe('run', () => {
    function inputs(overrides = {}) {
      return { INPUT_PUP_VERSION: '2.0.0', INPUT_READ: '', INPUT_DEV: 'false', RUNNER_TEMP: runnerTemp(), ...overrides }
    }

    it('installs pup and sets the phar and the release', async (t) => {
      const { core, outputs } = await coreWithOutputs(t)
      const { exec, calls } = recordingExec(pupRules())
      const env = inputs()

      await run({ core, exec, env, cwd: '/repo' })

      assert.deepEqual(outputs(), { phar: path.join(env.RUNNER_TEMP, 'pup-2.0.0.phar'), release: '2.0.0' })
      assert.ok(!calls.some((call) => call.command === 'php'), 'pup was not run')
    })

    it('reads the version with read=version', async (t) => {
      const { core, outputs } = await coreWithOutputs(t)
      const { exec, calls } = recordingExec(pupRules())

      await run({ core, exec, env: inputs({ INPUT_READ: 'version' }), cwd: '/repo' })

      assert.equal(outputs().version, '4.19.1')
      assert.equal(outputs()['zip-name'], undefined)
      assert.ok(sequence(calls).some((call) => / get-version$/.test(call)))
    })

    it('reads the version and the zip name with read=zip-name, for the dev version', async (t) => {
      const { core, outputs } = await coreWithOutputs(t)
      const { exec, calls } = recordingExec(
        pupRules({ version: '4.19.1-dev.abc123\n', name: 'my-plugin.4.19.1-dev.abc123\n' })
      )

      await run({ core, exec, env: inputs({ INPUT_READ: 'zip-name', INPUT_DEV: 'true' }), cwd: '/repo' })

      assert.equal(outputs().version, '4.19.1-dev.abc123')
      assert.equal(outputs()['zip-name'], 'my-plugin.4.19.1-dev.abc123')
      assert.deepEqual(
        sequence(calls).filter((call) => call.startsWith('php ')),
        [
          `php -d display_errors=stderr ${outputs().phar} get-version --dev`,
          `php -d display_errors=stderr ${outputs().phar} zip-name 4.19.1-dev.abc123`,
        ]
      )
      assert.ok(calls.filter((call) => call.command === 'php').every((call) => call.options.cwd === '/repo'))
    })

    it('refuses a read it does not know, before any request', async (t) => {
      const { core } = await coreWithOutputs(t)
      const { exec, calls } = recordingExec([])

      await assert.rejects(run({ core, exec, env: inputs({ INPUT_READ: 'both' }) }), /read 'both' is not one of/)
      assert.deepEqual(calls, [])
    })

    it('refuses a dev that is not true or false', async (t) => {
      const { core } = await coreWithOutputs(t)
      const { exec, calls } = recordingExec([])

      await assert.rejects(run({ core, exec, env: inputs({ INPUT_DEV: 'yes' }) }), /dev 'yes' is not true or false/)
      assert.deepEqual(calls, [])
    })

    it('fails when pup fails while reading the version', async (t) => {
      const { core } = await coreWithOutputs(t)
      const { exec } = recordingExec([
        ...pupRules().slice(0, 2),
        { command: 'php', exitCode: 1, stdout: 'Could not find version in file plugin.php' },
      ])

      await assert.rejects(
        run({ core, exec, env: inputs({ INPUT_READ: 'version' }), cwd: '/repo' }),
        /pup get-version failed.*Could not find version in file plugin\.php/s
      )
    })
  })
})
