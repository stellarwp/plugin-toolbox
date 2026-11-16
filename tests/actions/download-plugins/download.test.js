'use strict'

const { describe, it } = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { downloadPlugins, parsePlugins, run } = require('../../../.github/actions/download-plugins/download.js')
const { coreWithOutputs, recordingExec } = require('../../support/actions.js')

/**
 * A runner layout: `<root>/work/repo` is the checkout, `<root>/work` is where plugins go.
 *
 * @returns {{root: string, workspace: string, dest: string, tmp: string}} The directories.
 */
function runner() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'download-plugins-'))
  const dest = path.join(root, 'work')
  const workspace = path.join(dest, 'repo')
  const tmp = path.join(root, 'tmp')

  fs.mkdirSync(workspace, { recursive: true })
  fs.mkdirSync(tmp)

  return { root, workspace, dest, tmp }
}

/**
 * Rules for the commands a download runs. `unzip` creates the one directory a real archive holds,
 * and `mv` really moves it, so the result can be read back from disk.
 *
 * @param {string}   tmp   The scratch directory.
 * @param {string}   inner The directory the archive holds.
 * @param {object}   files Files the archive holds in it, by relative path.
 * @param {object[]} extra More rules.
 *
 * @returns {object[]} Rules for recordingExec.
 */
function rules(tmp, inner, files = {}, extra = []) {
  return [
    { command: 'gh', args: /^release view/, stdout: 'v1.2.3\n' },
    { command: 'gh', args: /^release download/ },
    { command: 'curl' },
    {
      command: 'unzip',
      effect: () => {
        const dir = path.join(tmp, 'unpacked', inner)

        fs.mkdirSync(dir, { recursive: true })

        for (const [file, contents] of Object.entries(files)) {
          fs.writeFileSync(path.join(dir, file), contents)
        }
      },
    },
    { command: 'mv', effect: (args) => fs.renameSync(args[0], args[1]) },
    { command: 'composer' },
    ...extra,
  ]
}

describe('download-plugins', () => {
  describe('parsePlugins', () => {
    it('splits on newlines and tells GitHub from WordPress.org', () => {
      assert.deepEqual(parsePlugins('stellarwp/learndash-core\nakismet\n'), [
        { spec: 'stellarwp/learndash-core', name: 'learndash-core', github: true },
        { spec: 'akismet', name: 'akismet', github: false },
      ])
    })

    it('reads an empty or missing value as no plugins', () => {
      assert.deepEqual(parsePlugins(''), [])
      assert.deepEqual(parsePlugins(undefined), [])
    })

    it('refuses an entry that could reshape a command or a path', () => {
      for (const bad of ['../evil', 'a/b/c', '--flag/x', 'Bad_Slug', 'owner/..', 'owner/name.']) {
        assert.throws(() => parsePlugins(bad), /Refusing to download/, bad)
      }
    })
  })

  describe('downloadPlugins', () => {
    it('downloads the latest release of a GitHub repository and installs its dependencies', async (t) => {
      const { workspace, dest, tmp } = runner()
      const { core } = await coreWithOutputs(t)
      const { exec, calls } = recordingExec(rules(tmp, 'learndash-core-abc', { 'composer.json': '{}' }))

      const placed = await downloadPlugins({ core, exec, plugins: parsePlugins('stellarwp/learndash-core'), workspace, tmp })

      assert.deepEqual(placed, [path.join(dest, 'learndash-core')])
      assert.ok(fs.existsSync(path.join(dest, 'learndash-core', 'composer.json')))
      assert.deepEqual(
        calls.map((call) => call.command),
        ['gh', 'gh', 'unzip', 'mv', 'composer']
      )
      assert.deepEqual(calls[3].args, [path.join(tmp, 'unpacked', 'learndash-core-abc'), path.join(dest, 'learndash-core')])
      assert.ok(calls[1].args.includes('v1.2.3'))
      assert.ok(calls[4].args.includes(`--working-dir=${path.join(dest, 'learndash-core')}`))
    })

    it('downloads a WordPress.org plugin with curl and skips Composer without a composer.json', async (t) => {
      const { workspace, dest, tmp } = runner()
      const { core } = await coreWithOutputs(t)
      const { exec, calls } = recordingExec(rules(tmp, 'akismet'))

      await downloadPlugins({ core, exec, plugins: parsePlugins('akismet'), workspace, tmp })

      assert.ok(fs.existsSync(path.join(dest, 'akismet')))
      assert.deepEqual(calls.map((call) => call.command), ['curl', 'unzip', 'mv'])
      assert.ok(calls[0].args.includes('https://downloads.wordpress.org/plugin/akismet.latest-stable.zip'))
    })

    it('replaces a copy a previous job left, instead of nesting inside it', async (t) => {
      const { workspace, dest, tmp } = runner()
      const { core } = await coreWithOutputs(t)

      fs.mkdirSync(path.join(dest, 'akismet'))
      fs.writeFileSync(path.join(dest, 'akismet', 'stale.php'), '')

      const { exec } = recordingExec(rules(tmp, 'akismet', { 'fresh.php': '' }))

      await downloadPlugins({ core, exec, plugins: parsePlugins('akismet'), workspace, tmp })

      assert.deepEqual(fs.readdirSync(path.join(dest, 'akismet')), ['fresh.php'])
    })

    it('never replaces the repository itself', async (t) => {
      const { workspace, dest, tmp } = runner()
      const { core } = await coreWithOutputs(t)
      const { exec } = recordingExec(rules(tmp, 'repo'))

      await assert.rejects(
        downloadPlugins({ core, exec, plugins: parsePlugins('repo'), workspace, tmp }),
        /same directory name as this repository/
      )
      assert.ok(fs.existsSync(workspace))
      assert.ok(dest)
    })

    it('gives Composer the tokens for a GitHub plugin, and not for a WordPress.org one', async (t) => {
      process.env.COMPOSER_AUTH = '{"github-oauth":{"github.com":"secret"}}'
      process.env.GH_TOKEN = 'secret'
      t.after(() => {
        delete process.env.COMPOSER_AUTH
        delete process.env.GH_TOKEN
      })

      const composerEnv = async (spec) => {
        const { workspace, tmp } = runner()
        const { core } = await coreWithOutputs(t)
        const { exec, calls } = recordingExec(rules(tmp, 'plugin', { 'composer.json': '{}' }))

        await downloadPlugins({ core, exec, plugins: parsePlugins(spec), workspace, tmp })

        return calls.find((call) => call.command === 'composer').options.env
      }

      assert.equal((await composerEnv('stellarwp/plugin')), undefined)

      const env = await composerEnv('plugin')

      assert.ok(env.PATH)
      assert.equal(env.COMPOSER_AUTH, undefined)
      assert.equal(env.GH_TOKEN, undefined)
    })

    it('places the plugins in a destination of the caller\'s choice', async (t) => {
      const { workspace, root, tmp } = runner()
      const { core } = await coreWithOutputs(t)
      const dest = path.join(root, 'elsewhere', 'plugins')
      const { exec } = recordingExec(rules(tmp, 'akismet'))

      const placed = await downloadPlugins({ core, exec, plugins: parsePlugins('akismet'), workspace, tmp, dest })

      assert.deepEqual(placed, [path.join(dest, 'akismet')])
      assert.ok(fs.existsSync(path.join(dest, 'akismet')))
    })

    it('fails when a command fails', async (t) => {
      const { workspace, tmp } = runner()
      const { core } = await coreWithOutputs(t)
      const { exec } = recordingExec([{ command: 'curl', exitCode: 22 }])

      await assert.rejects(downloadPlugins({ core, exec, plugins: parsePlugins('akismet'), workspace, tmp }), /curl/)
    })
  })

  describe('run', () => {
    it('downloads nothing for an empty input', async (t) => {
      const { core } = await coreWithOutputs(t)
      const { exec, calls } = recordingExec()

      await run({ core, exec, env: { INPUT_PLUGINS: '  \n' } })

      assert.equal(calls.length, 0)
    })

    it('resolves a relative destination against the workspace and reports the paths', async (t) => {
      const { workspace, root } = runner()
      const temp = path.join(root, 'runner-temp')

      fs.mkdirSync(temp)

      const { core, outputs } = await coreWithOutputs(t)
      const { exec } = recordingExec(rules(path.join(temp, 'x'), 'akismet'))
      const env = { INPUT_PLUGINS: 'akismet', INPUT_DESTINATION: 'tests/_plugins', GITHUB_WORKSPACE: workspace, RUNNER_TEMP: temp }

      // The scratch directory is made by run(), so the stand-in unzips into whichever one it got.
      const real = exec.getExecOutput
      exec.getExecOutput = (command, args, options) => {
        if (command === 'unzip') {
          const unpacked = args[args.indexOf('-d') + 1]

          fs.mkdirSync(path.join(unpacked, 'akismet'), { recursive: true })
        }

        return command === 'unzip' ? Promise.resolve({ exitCode: 0, stdout: '', stderr: '' }) : real(command, args, options)
      }

      await run({ core, exec, env })

      assert.equal(outputs().paths, path.join(workspace, 'tests', '_plugins', 'akismet'))
      assert.ok(fs.existsSync(path.join(workspace, 'tests', '_plugins', 'akismet')))
    })

    it('removes its scratch directory when it is done', async (t) => {
      const { workspace, root } = runner()
      const temp = path.join(root, 'runner-temp')

      fs.mkdirSync(temp)

      const { core } = await coreWithOutputs(t)
      const { exec } = recordingExec([{ command: 'curl', exitCode: 22 }])

      await assert.rejects(run({ core, exec, env: { INPUT_PLUGINS: 'akismet', GITHUB_WORKSPACE: workspace, RUNNER_TEMP: temp } }))
      assert.deepEqual(fs.readdirSync(temp), [])
    })
  })
})
