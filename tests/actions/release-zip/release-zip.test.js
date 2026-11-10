'use strict'

const { describe, it } = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { runZip, readVersion, readYesNo, readAfterBuild, pupCommands } = require('../../../.github/actions/release-zip/release-zip.js')
const { coreWithOutputs, recordingExec } = require('../../support/actions.js')

/** A .puprc that names the zip and lists one version file. */
const PUPRC = {
  zip_name: 'give',
  paths: { versions: [{ file: 'give.php', regex: '(Version: )(.+)' }] },
}

/** The phar the pinned release downloads to. */
const PHAR = '/runner/temp/pup-2.0.0.phar'

/** The version zip-name resolved for an rc build. */
const VERSION = '4.19.0.1-rc-1792689067-fbcf8681'

/**
 * A temporary directory holding the given files, standing in for the checked-out repository.
 *
 * @param {object} files Each relative path mapped to its contents. An object is written as JSON.
 *
 * @returns {string} The directory.
 */
function checkoutWith(files = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'release-zip-'))

  for (const [name, contents] of Object.entries(files)) {
    const text = typeof contents === 'string' ? contents : JSON.stringify(contents)
    fs.writeFileSync(path.join(dir, name), text)
  }

  return dir
}

/**
 * The environment the manifest hands the step, over the inputs of a QA build with every step on.
 *
 * @param {object} overrides Inputs to change.
 *
 * @returns {object} The environment.
 */
function zipEnv(overrides = {}) {
  return {
    INPUT_VERSION: VERSION,
    INPUT_PRODUCTION: 'no',
    INPUT_CHECK: 'yes',
    INPUT_I18N: 'yes',
    INPUT_AFTER_BUILD: '',
    INPUT_PUP_VERSION: '2.0.0',
    INPUT_TOKEN: '',
    RUNNER_TEMP: '/runner/temp',
    ...overrides,
  }
}

/**
 * Rules under which every command succeeds: `pup package` writes the zip into the checkout, as
 * pup does, and `pup zip-name` names it from zip_name.
 *
 * @param {object[]} before Rules that take precedence, to make one command answer differently.
 *
 * @returns {object[]} Rules for recordingExec.
 */
function allSucceed(before = []) {
  return [
    ...before,
    { command: 'curl' },
    {
      command: 'php',
      args: / package /,
      effect: (args, options) => fs.writeFileSync(path.join(options.cwd, `give.${args.at(-1)}.zip`), 'PK'),
    },
    { command: 'php', args: / zip-name /, stdout: (args) => `give.${args.at(-1)}\n` },
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

/** The download, the same on every build. */
const DOWNLOAD = [
  'curl -fsSI https://github.com/stellarwp/pup/releases/download/2.0.0/pup.phar',
  `curl -fsSL --retry 3 -o ${PHAR} https://github.com/stellarwp/pup/releases/download/2.0.0/pup.phar`,
]

describe('release-zip', () => {
  describe('readVersion', () => {
    it('reads the version without surrounding whitespace', () => {
      assert.equal(readVersion(` ${VERSION}\n`), VERSION)
    })

    it('refuses an empty version, pointing at the zip-name output', () => {
      for (const empty of ['', '   ', undefined]) {
        assert.throws(() => readVersion(empty), /No version was given.*output of zip-name.*No zip was built/s)
      }
    })
  })

  describe('readYesNo', () => {
    it('reads yes and no, whatever the case and the whitespace', () => {
      assert.equal(readYesNo('YES', 'check'), true)
      assert.equal(readYesNo(' no ', 'check'), false)
    })

    it('refuses anything else, naming the input', () => {
      for (const value of ['', 'true', 'false', 'on', undefined]) {
        assert.throws(() => readYesNo(value, 'i18n'), /i18n '.*' is not yes or no\. No zip was built\./)
      }
    })
  })

  describe('readAfterBuild', () => {
    it('keeps the commands as given', () => {
      assert.equal(readAfterBuild('wp i18n make-pot . languages/give.pot\n'), 'wp i18n make-pot . languages/give.pot\n')
    })

    it('reads an empty or blank input as nothing to run', () => {
      assert.equal(readAfterBuild(''), '')
      assert.equal(readAfterBuild('  \n'), '')
      assert.equal(readAfterBuild(undefined), '')
    })
  })

  describe('pupCommands', () => {
    it('builds, checks with --dev, fetches the translations and packages a QA build', () => {
      assert.deepEqual(pupCommands({ version: VERSION, production: false, check: true, i18n: true }), [
        ['build'],
        ['check', '--dev'],
        ['i18n'],
        ['package', VERSION],
      ])
    })

    it('checks strict on a production build', () => {
      assert.deepEqual(pupCommands({ version: '4.19.0.1', production: true, check: true, i18n: true }), [
        ['build'],
        ['check'],
        ['i18n'],
        ['package', '4.19.0.1'],
      ])
    })

    it('leaves out the check and the translations when asked', () => {
      assert.deepEqual(pupCommands({ version: VERSION, production: false, check: false, i18n: false }), [
        ['build'],
        ['package', VERSION],
      ])
    })
  })

  describe('runZip', () => {
    it('downloads pup, then builds, checks, fetches the translations and packages, in the checkout', async (t) => {
      const { core, outputs } = await coreWithOutputs(t)
      const { exec, calls } = recordingExec(allSucceed())
      const cwd = checkoutWith({ '.puprc': PUPRC })

      await runZip({ core, exec, env: zipEnv(), cwd })

      assert.deepEqual(sequence(calls), [
        ...DOWNLOAD,
        `php -d display_errors=stderr ${PHAR} build`,
        `php -d display_errors=stderr ${PHAR} check --dev`,
        `php -d display_errors=stderr ${PHAR} i18n`,
        `php -d display_errors=stderr ${PHAR} package ${VERSION}`,
        `php -d display_errors=stderr ${PHAR} zip-name ${VERSION}`,
      ])
      assert.ok(
        calls.filter((call) => call.command === 'php').every((call) => call.options.cwd === cwd),
        'pup runs in the checkout'
      )
      assert.deepEqual(outputs(), {
        'zip-name': `give.${VERSION}`,
        'zip-path': path.join(cwd, `give.${VERSION}.zip`),
      })
    })

    it('shows the build in the log and reads only the zip name silently', async (t) => {
      const { core } = await coreWithOutputs(t)
      const { exec, calls } = recordingExec(allSucceed())
      const cwd = checkoutWith({ '.puprc': PUPRC })

      await runZip({ core, exec, env: zipEnv(), cwd })

      const php = calls.filter((call) => call.command === 'php')
      assert.ok(php.slice(0, -1).every((call) => !call.options.silent), 'pup build, check, i18n and package print to the log')
      assert.equal(php.at(-1).options.silent, true)
    })

    it('checks strict on a production build', async (t) => {
      const { core } = await coreWithOutputs(t)
      const { exec, calls } = recordingExec(allSucceed())
      const cwd = checkoutWith({ '.puprc': PUPRC })

      await runZip({ core, exec, env: zipEnv({ INPUT_VERSION: '4.19.0.1', INPUT_PRODUCTION: 'yes' }), cwd })

      assert.ok(sequence(calls).includes(`php -d display_errors=stderr ${PHAR} check`))
      assert.ok(!sequence(calls).some((call) => call.endsWith('check --dev')))
    })

    it('skips the check and the translations when asked', async (t) => {
      const { core } = await coreWithOutputs(t)
      const { exec, calls } = recordingExec(allSucceed())
      const cwd = checkoutWith({ '.puprc': PUPRC })

      await runZip({ core, exec, env: zipEnv({ INPUT_CHECK: 'no', INPUT_I18N: 'no' }), cwd })

      assert.deepEqual(
        sequence(calls).filter((call) => call.startsWith('php')),
        [`php -d display_errors=stderr ${PHAR} build`, `php -d display_errors=stderr ${PHAR} package ${VERSION}`, `php -d display_errors=stderr ${PHAR} zip-name ${VERSION}`]
      )
    })

    it('runs the after-build commands between pup build and pup check, in the checkout, like a run step', async (t) => {
      const { core } = await coreWithOutputs(t)
      const { exec, calls } = recordingExec(allSucceed([{ command: 'bash' }]))
      const cwd = checkoutWith({ '.puprc': PUPRC })
      const commands = 'php -d xdebug.mode=off "$(command -v wp)" i18n make-pot . languages/give.pot\n'

      await runZip({ core, exec, env: zipEnv({ INPUT_AFTER_BUILD: commands }), cwd })

      assert.deepEqual(sequence(calls), [
        ...DOWNLOAD,
        `php -d display_errors=stderr ${PHAR} build`,
        `bash --noprofile --norc -eo pipefail -c ${commands}`,
        `php -d display_errors=stderr ${PHAR} check --dev`,
        `php -d display_errors=stderr ${PHAR} i18n`,
        `php -d display_errors=stderr ${PHAR} package ${VERSION}`,
        `php -d display_errors=stderr ${PHAR} zip-name ${VERSION}`,
      ])
      const bash = calls.find((call) => call.command === 'bash')
      assert.equal(bash.options.cwd, cwd, 'the commands run in the checkout')
      assert.ok(!bash.options.silent, 'what they print goes to the log')
    })

    it('runs the after-build commands in working-directory', async (t) => {
      const { core } = await coreWithOutputs(t)
      const { exec, calls } = recordingExec(allSucceed([{ command: 'bash' }]))
      const workspace = checkoutWith()
      const cwd = path.join(workspace, 'source')
      fs.mkdirSync(cwd)
      fs.writeFileSync(path.join(cwd, '.puprc'), JSON.stringify(PUPRC))

      await runZip({
        core,
        exec,
        env: zipEnv({ INPUT_AFTER_BUILD: 'echo pot', INPUT_WORKING_DIRECTORY: 'source' }),
        cwd: workspace,
      })

      assert.equal(calls.find((call) => call.command === 'bash').options.cwd, cwd)
    })

    it('runs no shell when after-build is empty', async (t) => {
      const { core } = await coreWithOutputs(t)
      const { exec, calls } = recordingExec(allSucceed())
      const cwd = checkoutWith({ '.puprc': PUPRC })

      await runZip({ core, exec, env: zipEnv({ INPUT_AFTER_BUILD: '  \n' }), cwd })

      assert.ok(!calls.some((call) => call.command === 'bash'))
    })

    it('fails with the script output when an after-build command fails, and runs nothing after it', async (t) => {
      const { core, outputs } = await coreWithOutputs(t)
      const { exec, calls } = recordingExec(
        allSucceed([{ command: 'bash', exitCode: 1, stderr: 'Error: No such file or directory: languages' }])
      )
      const cwd = checkoutWith({ '.puprc': PUPRC })

      await assert.rejects(
        runZip({ core, exec, env: zipEnv({ INPUT_AFTER_BUILD: 'wp i18n make-pot . languages/give.pot' }), cwd }),
        /The after-build commands failed \(exit code 1\):\nError: No such file or directory: languages/
      )

      const php = sequence(calls).filter((call) => call.startsWith('php'))
      assert.deepEqual(php, [`php -d display_errors=stderr ${PHAR} build`], 'pup build ran, and no pup command after the failure')
      assert.deepEqual(outputs(), {})
    })

    it('builds in working-directory and reports the zip there, as an absolute path', async (t) => {
      const { core, outputs } = await coreWithOutputs(t)
      const { exec, calls } = recordingExec(allSucceed())
      const workspace = checkoutWith({})
      fs.mkdirSync(path.join(workspace, 'source'))
      fs.writeFileSync(path.join(workspace, 'source', '.puprc'), JSON.stringify(PUPRC))

      await runZip({ core, exec, env: zipEnv({ INPUT_WORKING_DIRECTORY: 'source' }), cwd: workspace })

      assert.ok(
        calls.filter((call) => call.command === 'php').every((call) => call.options.cwd === path.join(workspace, 'source')),
        'pup runs in source/'
      )
      assert.equal(outputs()['zip-path'], path.join(workspace, 'source', `give.${VERSION}.zip`))
    })

    it('refuses a working-directory that is not there, before downloading or running anything', async (t) => {
      const { core, outputs } = await coreWithOutputs(t)
      const { exec, calls } = recordingExec(allSucceed())
      const cwd = checkoutWith({ '.puprc': PUPRC })

      await assert.rejects(
        runZip({ core, exec, env: zipEnv({ INPUT_WORKING_DIRECTORY: 'missing' }), cwd }),
        /working-directory 'missing' is not a directory \(.*\/missing\).*No zip was built/s
      )
      assert.deepEqual(calls, [])
      assert.deepEqual(outputs(), {})
    })

    it('stops before downloading or running anything when an input is wrong', async (t) => {
      const cases = [
        [{ INPUT_VERSION: '' }, /No version was given/],
        [{ INPUT_PRODUCTION: 'true' }, /production 'true' is not yes or no/],
        [{ INPUT_CHECK: '' }, /check '' is not yes or no/],
        [{ INPUT_I18N: 'on' }, /i18n 'on' is not yes or no/],
        [{ INPUT_PUP_VERSION: 'newest' }, /pup-version 'newest' is not a pup release number/],
      ]

      for (const [overrides, message] of cases) {
        const { core, outputs } = await coreWithOutputs(t)
        const { exec, calls } = recordingExec(allSucceed())
        const cwd = checkoutWith({ '.puprc': PUPRC })

        await assert.rejects(runZip({ core, exec, env: zipEnv(overrides), cwd }), message)
        assert.deepEqual(calls, [], `nothing ran for ${JSON.stringify(overrides)}`)
        assert.deepEqual(outputs(), {})
      }
    })

    it('stops before downloading or running anything when the repository has no usable .puprc', async (t) => {
      const cases = [
        [{}, /No \.puprc.*No zip was built/s],
        [{ '.puprc': '{ "paths": ' }, /\.puprc is not valid JSON/],
        [{ '.puprc': {} }, /no paths\.versions/],
      ]

      for (const [files, message] of cases) {
        const { core, outputs } = await coreWithOutputs(t)
        const { exec, calls } = recordingExec(allSucceed())
        const cwd = checkoutWith(files)

        await assert.rejects(runZip({ core, exec, env: zipEnv(), cwd }), message)
        assert.deepEqual(calls, [], `nothing ran for ${JSON.stringify(files)}`)
        assert.deepEqual(outputs(), {})
      }
    })

    it('fails with pup output when a pup command fails, and runs nothing after it', async (t) => {
      const { core, outputs } = await coreWithOutputs(t)
      const { exec, calls } = recordingExec(
        allSucceed([{ command: 'php', args: / check /, exitCode: 1, stdout: '[tbd] TBD found in src/Thing.php' }])
      )
      const cwd = checkoutWith({ '.puprc': PUPRC })

      await assert.rejects(runZip({ core, exec, env: zipEnv(), cwd }), /pup check failed.*TBD found in src\/Thing\.php/s)

      assert.ok(!sequence(calls).some((call) => / (i18n|package|zip-name)/.test(call)), 'nothing runs after the failure')
      assert.deepEqual(outputs(), {})
    })

    it('fails with pup output when pup build fails', async (t) => {
      const { core } = await coreWithOutputs(t)
      const { exec } = recordingExec(
        allSucceed([{ command: 'php', args: / build$/, exitCode: 1, stdout: '[FAIL] Build step failed: npm run build' }])
      )
      const cwd = checkoutWith({ '.puprc': PUPRC })

      await assert.rejects(runZip({ core, exec, env: zipEnv(), cwd }), /pup build failed.*npm run build/s)
    })

    it('fails when pup package finishes but the zip is not in the checkout', async (t) => {
      const { core, outputs } = await coreWithOutputs(t)
      const { exec } = recordingExec(allSucceed([{ command: 'php', args: / package / }]))
      const cwd = checkoutWith({ '.puprc': PUPRC })

      await assert.rejects(
        runZip({ core, exec, env: zipEnv(), cwd }),
        /pup package finished but give\.4\.19\.0\.1-rc-1792689067-fbcf8681\.zip is not in the checkout/
      )
      assert.deepEqual(outputs(), {})
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
        runZip({ core, exec, env: zipEnv(), cwd }),
        /pup 2\.0\.0 publishes no pup\.phar asset.*such as 2\.0\.0\. No zip was built\./s
      )
      assert.ok(!sequence(calls).some((call) => /fsSL|php /.test(call)), 'nothing downloaded, nothing run')
      assert.deepEqual(outputs(), {})
    })

    it('resolves latest through the API with the token, then downloads that release', async (t) => {
      const { core } = await coreWithOutputs(t)
      const { exec, calls } = recordingExec(allSucceed())
      const cwd = checkoutWith({ '.puprc': PUPRC })
      const fetched = []
      const fetchImpl = async (url, options) => {
        fetched.push([url, options])
        return { ok: true, json: async () => ({ tag_name: '2.0.0' }) }
      }

      await runZip({ core, exec, env: zipEnv({ INPUT_PUP_VERSION: 'latest', INPUT_TOKEN: 'ghp_example' }), cwd, fetchImpl })

      assert.deepEqual(fetched, [
        ['https://api.github.com/repos/stellarwp/pup/releases/latest', { headers: { authorization: 'Bearer ghp_example' } }],
      ])
      assert.ok(sequence(calls).some((call) => call.includes('download/2.0.0/pup.phar')))
    })
  })
})
