'use strict'

const { describe, it } = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { chooseAsset, downloadPlugins, parsePlugins, run } = require('../../../.github/actions/download-plugins/download.js')
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
 * @param {object[]} extra  More rules.
 * @param {string[]} assets Names of the release's assets.
 *
 * @returns {object[]} Rules for recordingExec.
 */
function rules(tmp, inner, files = {}, extra = [], assets = []) {
  return [
    { command: 'gh', args: /^release view/, stdout: JSON.stringify({ tagName: 'v1.2.3', assets: assets.map((name) => ({ name })) }) },
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

    it('refuses two plugins that would share a directory', () => {
      assert.throws(() => parsePlugins('acme/calendar\ncommunity/calendar'), /'acme\/calendar' already goes to the directory 'calendar'/)
      assert.throws(() => parsePlugins('calendar\nacme/calendar'), /already goes to/)
      assert.doesNotThrow(() => parsePlugins('acme/calendar\ncommunity/events'))
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

    describe('release assets', () => {
      const install = async (t, assets, spec = 'stellarwp/learndash-core', inner = 'sfwd-lms') => {
        const { workspace, dest, tmp } = runner()
        const { core } = await coreWithOutputs(t)
        const { exec, calls } = recordingExec(rules(tmp, inner, { 'composer.json': '{}' }, [], assets))

        await downloadPlugins({ core, exec, plugins: parsePlugins(spec), workspace, tmp })

        return { dest, calls, download: calls.find((call) => call.command === 'gh' && call.args[1] === 'download') }
      }

      it('downloads the zip asset instead of the source archive and skips Composer', async (t) => {
        const { dest, calls, download } = await install(t, ['sfwd-lms.1.2.3.zip', 'sfwd-lms.1.2.3.zip.sha256'])

        assert.ok(download.args.includes('--pattern'))
        assert.equal(download.args[download.args.indexOf('--pattern') + 1], 'sfwd-lms.1.2.3.zip')
        assert.ok(!download.args.includes('--archive'))
        assert.equal(calls.filter((call) => call.command === 'composer').length, 0)
        // The archive's own directory, sfwd-lms, is placed under the repository's name.
        assert.ok(fs.existsSync(path.join(dest, 'learndash-core', 'composer.json')))
        assert.ok(!fs.existsSync(path.join(dest, 'sfwd-lms')))
      })

      it('falls back to the source archive, and Composer, when the release has no zip asset', async (t) => {
        for (const assets of [[], ['notes.txt', 'plugin.tar.gz'], ['plugin-source.zip']]) {
          const { calls, download } = await install(t, assets)

          assert.ok(download.args.includes('--archive'), assets.join())
          assert.ok(!download.args.includes('--pattern'))
          assert.equal(calls.filter((call) => call.command === 'composer').length, 1)
        }
      })

      it('takes the only zip named after the repository when there are several', async (t) => {
        const { download } = await install(t, ['learndash-core.zip', 'extras.zip', 'learndash-core-src.zip'])

        assert.equal(download.args[download.args.indexOf('--pattern') + 1], 'learndash-core.zip')
      })

      it('fails when several zips remain and none is the repository\'s', async (t) => {
        await assert.rejects(install(t, ['a.zip', 'b.zip']), /several zip assets \(a\.zip, b\.zip\)/)
      })
    })

    describe('chooseAsset', () => {
      it('ignores names that mark source or auxiliary zips and non-zips', () => {
        assert.equal(chooseAsset([{ name: 'p.zip' }, { name: 'p-source.zip' }, { name: 'p.zip.sig' }, { name: 'docs.zip' }], 'p', 'o/p'), 'p.zip')
        assert.equal(chooseAsset(undefined, 'p', 'o/p'), null)
      })
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
        /would replace the checkout/
      )
      assert.ok(fs.existsSync(workspace))
      assert.ok(dest)
    })

    it('runs Composer for a GitHub plugin but never for a WordPress.org one', async (t) => {
      const composerCalls = async (spec) => {
        const { workspace, tmp } = runner()
        const { core } = await coreWithOutputs(t)
        const { exec, calls } = recordingExec(rules(tmp, 'plugin', { 'composer.json': '{}' }))

        await downloadPlugins({ core, exec, plugins: parsePlugins(spec), workspace, tmp })

        return calls.filter((call) => call.command === 'composer')
      }

      assert.equal((await composerCalls('stellarwp/plugin')).length, 1)
      assert.equal((await composerCalls('plugin')).length, 0)
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

    it('refuses a destination that puts the target above the checkout', async (t) => {
      const { workspace, dest, tmp } = runner()
      const { core } = await coreWithOutputs(t)
      const { exec } = recordingExec(rules(tmp, 'work'))

      // dest is the checkout's parent, `work`; a plugin named `work` in its parent would be it.
      await assert.rejects(
        downloadPlugins({ core, exec, plugins: parsePlugins('work'), workspace, tmp, dest: path.dirname(dest) }),
        /would replace the checkout/
      )
      assert.ok(fs.existsSync(workspace))
    })

    it('refuses a target that is the checkout reached through a symlink', async (t) => {
      const { root, tmp } = runner()
      const { core } = await coreWithOutputs(t)

      // /<root>/real/repo is the checkout, and /<root>/link is a symlink to /<root>/real.
      fs.mkdirSync(path.join(root, 'real', 'repo'), { recursive: true })
      fs.symlinkSync(path.join(root, 'real'), path.join(root, 'link'))

      const workspace = path.join(root, 'real', 'repo')
      const { exec } = recordingExec(rules(tmp, 'repo'))

      await assert.rejects(
        downloadPlugins({ core, exec, plugins: parsePlugins('repo'), workspace, tmp, dest: path.join(root, 'link') }),
        /would replace the checkout/
      )
      assert.ok(fs.existsSync(workspace))
    })

    it('refuses a checkout whose directory name starts with two dots', async (t) => {
      const { root, tmp } = runner()
      const { core } = await coreWithOutputs(t)

      // The checkout is /<root>/work/akismet/..checkout, inside the target /<root>/work/akismet.
      const workspace = path.join(root, 'work', 'akismet', '..checkout')

      fs.mkdirSync(workspace, { recursive: true })

      const { exec } = recordingExec(rules(tmp, 'akismet'))

      await assert.rejects(
        downloadPlugins({ core, exec, plugins: parsePlugins('akismet'), workspace, tmp, dest: path.join(root, 'work') }),
        /would replace the checkout/
      )
      assert.ok(fs.existsSync(workspace))
    })

    it('refuses a symlinked workspace as well', async (t) => {
      const { root, tmp } = runner()
      const { core } = await coreWithOutputs(t)

      fs.mkdirSync(path.join(root, 'real', 'repo'), { recursive: true })
      fs.symlinkSync(path.join(root, 'real', 'repo'), path.join(root, 'workspace-link'))

      const { exec } = recordingExec(rules(tmp, 'repo'))

      await assert.rejects(
        downloadPlugins({ core, exec, plugins: parsePlugins('repo'), workspace: path.join(root, 'workspace-link'), tmp, dest: path.join(root, 'real') }),
        /would replace the checkout/
      )
      assert.ok(fs.existsSync(path.join(root, 'real', 'repo')))
    })

    it('fails when a command fails', async (t) => {
      const { workspace, tmp } = runner()
      const { core } = await coreWithOutputs(t)
      const { exec } = recordingExec([{ command: 'curl', exitCode: 22 }])

      await assert.rejects(
        downloadPlugins({ core, exec, plugins: parsePlugins('akismet'), workspace, tmp }),
        /Downloading akismet from WordPress.org failed \(exit code 22\)/
      )
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
