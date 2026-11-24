'use strict'

const { describe, it, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert')
const { execFileSync } = require('node:child_process')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { runGeneratePot, WP_CLI } = require('../../../.github/actions/generate-pot/generate-pot.js')
const { coreWithOutputs, recordingExec, recordedRealExec } = require('../../support/actions.js')

/** A git that signs nothing, whatever the machine it runs on configures. */
const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@example.com',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@example.com',
  GIT_CONFIG_COUNT: '2',
  GIT_CONFIG_KEY_0: 'tag.gpgsign',
  GIT_CONFIG_VALUE_0: 'false',
  GIT_CONFIG_KEY_1: 'commit.gpgsign',
  GIT_CONFIG_VALUE_1: 'false',
}

/** What the stand-in for curl writes as the phar, and the release whose checksum it matches. */
const PHAR = '<?php // a phar'
const FAKE_WP_CLI = { version: '9.9.9', sha512: crypto.createHash('sha512').update(PHAR).digest('hex') }

/**
 * A POT as make-pot writes it.
 *
 * @param {object} options
 * @param {string} options.date    The POT-Creation-Date.
 * @param {string} options.version The plugin version, in Project-Id-Version.
 * @param {string} options.wp      The wp-cli version, in X-Generator.
 * @param {string} options.msgid   The one string.
 * @param {string} options.year    The year in the Copyright line.
 * @param {number} options.line    The line of the string, in its `#:` reference.
 *
 * @returns {string} The file.
 */
const pot = ({ date = '2026-01-01T00:00:00+00:00', version = '1.0.0', wp = '2.12.0', msgid = 'Hello', year = '2026', line = 3 } = {}) => `# Copyright (C) ${year} Plugin
# This file is distributed under the same license as the Plugin plugin.
msgid ""
msgstr ""
"Project-Id-Version: Plugin ${version}\\n"
"Report-Msgid-Bugs-To: https://example.com\\n"
"POT-Creation-Date: ${date}\\n"
"X-Generator: WP-CLI ${wp}\\n"
"X-Domain: plugin\\n"

#: plugin.php:${line}
msgid "${msgid}"
msgstr ""
`

describe('generate-pot', () => {
  let repo
  let runnerTemp

  const git = (...args) => execFileSync('git', args, { cwd: repo, env: GIT_ENV, encoding: 'utf8', stdio: 'pipe' })

  const write = (name, body) => {
    fs.mkdirSync(path.dirname(path.join(repo, name)), { recursive: true })
    fs.writeFileSync(path.join(repo, name), body)
  }

  const read = (name) => fs.readFileSync(path.join(repo, name), 'utf8')

  const commit = () => {
    git('add', '--all')
    git('commit', '-q', '--allow-empty', '-m', 'commit')
  }

  /**
   * Runs the action with real git, and stand-ins for curl and php.
   *
   * @param {object} t       The node:test context.
   * @param {object} options
   * @param {object} options.inputs    The INPUT_* variables, over a `pot-path` of `lang/plugin.pot`.
   * @param {string} options.generated What the stand-in for make-pot writes; undefined writes nothing.
   * @param {string} options.phar      What the stand-in for curl downloads.
   * @param {object} options.wpCli     The release expected; the stand-in's by default.
   * @param {string} options.cwd       The workspace.
   *
   * @returns {Promise<{outputs: object, calls: object[], php: object}>} The outputs, the curl and
   *          php calls, and the php call.
   */
  const run = async (t, { inputs = {}, generated, phar = PHAR, wpCli = FAKE_WP_CLI, cwd = repo } = {}) => {
    const { core, outputs } = await coreWithOutputs(t)
    const real = await recordedRealExec()
    const fake = recordingExec([
      { command: 'curl', effect: (args) => fs.writeFileSync(args[args.indexOf('-o') + 1], phar) },
      {
        command: 'php',
        effect: (args, options) => {
          if (generated !== undefined) {
            const target = path.join(options.cwd, args[args.indexOf('make-pot') + 2])
            fs.mkdirSync(path.dirname(target), { recursive: true })
            fs.writeFileSync(target, generated)
          }
        },
      },
    ])
    const exec = {
      getExecOutput: (command, args, options) =>
        (command === 'git' ? real.exec : fake.exec).getExecOutput(command, args, { ...options, env: GIT_ENV }),
    }

    await runGeneratePot({
      core,
      exec,
      env: { RUNNER_TEMP: runnerTemp, INPUT_POT_PATH: 'lang/plugin.pot', ...inputs },
      cwd,
      wpCli,
    })

    return { outputs: outputs(), calls: fake.calls, php: fake.calls.find((call) => call.command === 'php') }
  }

  beforeEach(() => {
    repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'generate-pot-')))
    runnerTemp = fs.mkdtempSync(path.join(os.tmpdir(), 'generate-pot-temp-'))
    git('init', '-q')
    write('plugin.php', '<?php')
    commit()
  })

  afterEach(() => {
    fs.rmSync(repo, { recursive: true, force: true })
    fs.rmSync(runnerTemp, { recursive: true, force: true })
  })

  describe('the wp-cli phar', () => {
    it('pins the release TEC runs', () => {
      assert.deepStrictEqual(WP_CLI, {
        version: '2.12.0',
        sha512:
          'be928f6b8ca1e8dfb9d2f4b75a13aa4aee0896f8a9a0a1c45cd5d2c98605e6172e6d014dda2e27f88c98befc16c040cbb2bd1bfa121510ea5cdf5f6a30fe8832',
      })
    })

    it('downloads the pinned release into the runner temp directory and runs it', async (t) => {
      const { calls, php } = await run(t, { generated: pot() })
      const phar = path.join(runnerTemp, 'wp-cli-9.9.9.phar')

      assert.deepStrictEqual(calls[0].args.slice(-3), [
        '-o',
        phar,
        'https://github.com/wp-cli/wp-cli/releases/download/v9.9.9/wp-cli-9.9.9.phar',
      ])
      assert.deepStrictEqual(php.args.slice(0, 5), ['-d', 'xdebug.mode=off', phar, 'i18n', 'make-pot'])
      assert.strictEqual(php.options.cwd, repo)
    })

    it('fails on a checksum mismatch, runs nothing and leaves no file behind', async (t) => {
      await assert.rejects(run(t, { wpCli: WP_CLI }), /wp-cli 2\.12\.0.*sha512.*No POT was generated/s)

      assert.deepStrictEqual(fs.readdirSync(runnerTemp), [])
      assert.ok(!fs.existsSync(path.join(repo, 'lang/plugin.pot')))
    })

    it('checks a phar an earlier step left before it is reused', async (t) => {
      fs.writeFileSync(path.join(runnerTemp, 'wp-cli-9.9.9.phar'), 'tampered')

      await assert.rejects(run(t), /sha512/)
      assert.deepStrictEqual(fs.readdirSync(runnerTemp), [])
    })

    it('reuses a phar that matches, without a download', async (t) => {
      fs.writeFileSync(path.join(runnerTemp, 'wp-cli-9.9.9.phar'), PHAR)

      const { calls } = await run(t, { generated: pot() })

      assert.deepStrictEqual(calls.map((call) => call.command), ['php'])
    })

    it('leaves no file behind when the download fails', async (t) => {
      const { core } = await coreWithOutputs(t)
      const { exec } = recordingExec([
        { command: 'curl', exitCode: 56, stderr: 'Connection reset', effect: (args) => fs.writeFileSync(args[args.indexOf('-o') + 1], 'half') },
      ])

      await assert.rejects(
        runGeneratePot({ core, exec, env: { RUNNER_TEMP: runnerTemp, INPUT_POT_PATH: 'lang/plugin.pot' }, cwd: repo }),
        /Downloading wp-cli 2\.12\.0 failed.*Connection reset/s
      )
      assert.deepStrictEqual(fs.readdirSync(runnerTemp), [])
    })
  })

  describe('the make-pot command', () => {
    it('runs with the defaults: the checkout as the source, the audit skipped, nothing else', async (t) => {
      const { php } = await run(t, { generated: pot() })

      assert.deepStrictEqual(php.args.slice(3), ['i18n', 'make-pot', '.', 'lang/plugin.pot', '--skip-audit'])
    })

    it('passes a source-path or pot-path that starts with - after ./, so make-pot does not read it as an option', async (t) => {
      fs.mkdirSync(path.join(repo, '-src'))

      const { php, outputs } = await run(t, { generated: pot(), inputs: { INPUT_SOURCE_PATH: '-src', INPUT_POT_PATH: '-plugin.pot' } })

      assert.deepStrictEqual(php.args.slice(5, 7), ['./-src', './-plugin.pot'])
      assert.strictEqual(outputs['pot-path'], '-plugin.pot')
    })

    it('passes the source, the domain and the headers', async (t) => {
      const { php } = await run(t, {
        generated: pot(),
        inputs: {
          INPUT_SOURCE_PATH: 'src',
          INPUT_DOMAIN: 'kadence-blocks',
          INPUT_HEADERS: '{ "Report-Msgid-Bugs-To": "https://example.com/bugs", "Last-Translator": "" }',
        },
      })

      assert.deepStrictEqual(php.args.slice(5), [
        'src',
        'lang/plugin.pot',
        '--skip-audit',
        '--domain=kadence-blocks',
        '--headers={"Report-Msgid-Bugs-To":"https://example.com/bugs","Last-Translator":""}',
      ])
    })

    it('excludes the .distignore lines, the submodule paths and the exclude input', async (t) => {
      write('.distignore', '# Development files\n/tests\n\nnode_modules\r\n')
      write('.gitmodules', '[submodule "common"]\n\tpath = common\n\turl = https://example.com/common.git\n[submodule "x"]\n  path=libs/x\n')

      const { php } = await run(t, { generated: pot(), inputs: { INPUT_EXCLUDE: '*.js.map\n\n  src/**/*.js  \nnode_modules\n' } })

      assert.strictEqual(php.args.at(-1), '--exclude=/tests,node_modules,common,libs/x,*.js.map,src/**/*.js')
    })

    it('makes the .distignore and submodule paths relative to source-path, and drops the ones outside it', async (t) => {
      write('.distignore', '/tests\nnode_modules\nsrc/internal.php\n/src/admin/\nassets/js\n**/private/*.php\n*/fixtures\n')
      write('.gitmodules', '[submodule "lib"]\n\tpath = src/vendor/lib\n[submodule "common"]\n\tpath = common\n')

      const { php } = await run(t, { generated: pot(), inputs: { INPUT_SOURCE_PATH: './src/', INPUT_EXCLUDE: 'src/*.map' } })

      assert.strictEqual(php.args.at(-1), '--exclude=node_modules,internal.php,admin,**/private/*.php,*/fixtures,vendor/lib,src/*.map')
    })

    it('excludes the export-ignore paths of .gitattributes, relative to source-path', async (t) => {
      write(
        '.gitattributes',
        '# Not in the zip\n* text=auto\n/src/tests export-ignore\n/.github  export-ignore  linguist-vendored\n' +
          'src/docs -export-ignore\nsrc/keep !export-ignore\nnode_modules export-ignore\n/README.md export-ignore\n'
      )
      write('.distignore', 'node_modules\n')

      const { php } = await run(t, { generated: pot(), inputs: { INPUT_SOURCE_PATH: 'src' } })

      assert.strictEqual(php.args.at(-1), '--exclude=node_modules,tests')
    })

    it('takes the last export-ignore, -export-ignore or !export-ignore of a line, as git does', async (t) => {
      write('.gitattributes', 'a export-ignore -export-ignore\nb -export-ignore export-ignore\nc export-ignore !export-ignore\n')

      const { php } = await run(t, { generated: pot() })

      assert.strictEqual(php.args.at(-1), '--exclude=b')
    })

    it('skips the [attr] macro lines, quoted patterns and patterns with a comma of .gitattributes', async (t) => {
      write(
        '.gitattributes',
        '[attr]dist export-ignore\n"with space" export-ignore\na,b export-ignore\n/kept export-ignore\n'
      )

      const { php } = await run(t, { generated: pot() })

      assert.strictEqual(php.args.at(-1), '--exclude=/kept')
    })

    it('reads .distignore in the working directory', async (t) => {
      const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'generate-pot-workspace-'))
      t.after(() => fs.rmSync(workspace, { recursive: true, force: true }))
      fs.renameSync(repo, path.join(workspace, 'source'))
      repo = path.join(workspace, 'source')
      write('.distignore', 'vendor\n')

      const { php, outputs } = await run(t, { generated: pot(), cwd: workspace, inputs: { INPUT_WORKING_DIRECTORY: 'source' } })

      assert.strictEqual(php.options.cwd, repo)
      assert.strictEqual(php.args.at(-1), '--exclude=vendor')
      assert.strictEqual(outputs['pot-path'], 'lang/plugin.pot')
    })

    it('fails when make-pot fails', async (t) => {
      const { core } = await coreWithOutputs(t)
      fs.writeFileSync(path.join(runnerTemp, 'wp-cli-9.9.9.phar'), PHAR)
      const { exec } = recordingExec([{ command: 'php', exitCode: 1, stderr: 'Error: Not a valid source directory.' }])

      await assert.rejects(
        runGeneratePot({ core, exec, env: { RUNNER_TEMP: runnerTemp, INPUT_POT_PATH: 'lang/plugin.pot' }, cwd: repo, wpCli: FAKE_WP_CLI }),
        /wp i18n make-pot failed.*Not a valid source directory/s
      )
    })
  })

  describe('the inputs', () => {
    const refused = [
      ['an empty pot-path without a plugin file', { INPUT_POT_PATH: ' ' }, /pot-path is empty and no PHP file at the top of '\.' has a Plugin Name header/],
      ['an absolute pot-path', { INPUT_POT_PATH: '/tmp/plugin.pot' }, /pot-path '\/tmp\/plugin\.pot' is not a path inside the checkout/],
      ['a pot-path outside the checkout', { INPUT_POT_PATH: '../plugin.pot' }, /not a path inside the checkout/],
      ['headers that are not JSON', { INPUT_HEADERS: '{nope' }, /headers is not valid JSON/],
      ['headers that are not an object', { INPUT_HEADERS: '["a"]' }, /headers is not a JSON object of strings/],
      ['a header that is not a string', { INPUT_HEADERS: '{"a": 1}' }, /headers is not a JSON object of strings/],
      ['a working-directory that is not there', { INPUT_WORKING_DIRECTORY: 'nowhere' }, /working-directory 'nowhere' is not a directory/],
    ]

    for (const [name, inputs, message] of refused) {
      it(`refuses ${name} before anything is downloaded`, async (t) => {
        const { core } = await coreWithOutputs(t)
        const { exec, calls } = recordingExec()

        await assert.rejects(runGeneratePot({ core, exec, env: { RUNNER_TEMP: runnerTemp, INPUT_POT_PATH: 'lang/plugin.pot', ...inputs }, cwd: repo }), message)
        assert.deepStrictEqual(calls, [])
      })
    }
  })

  describe('the pot-path default', () => {
    const header = (lines) => `<?php\n/**\n * Plugin Name: Plugin\n${lines.map((line) => ` * ${line}\n`).join('')} */\n`

    it('is <Domain Path>/<Text Domain>.pot from the plugin header, and is reported', async (t) => {
      write('plugin.php', header(['Text Domain: my-plugin', 'Domain Path: /languages/']))

      const { php, outputs } = await run(t, { generated: pot(), inputs: { INPUT_POT_PATH: '' } })

      assert.strictEqual(php.args[6], 'languages/my-plugin.pot')
      assert.strictEqual(outputs['pot-path'], 'languages/my-plugin.pot')
    })

    it('takes the domain input over the Text Domain header', async (t) => {
      write('plugin.php', header(['Domain Path: lang']))

      const { outputs } = await run(t, { generated: pot(), inputs: { INPUT_POT_PATH: '', INPUT_DOMAIN: 'other' } })

      assert.strictEqual(outputs['pot-path'], 'lang/other.pot')
    })

    it('reads the plugin file in source-path, and puts the POT under it', async (t) => {
      write('src/main.php', header(['Text Domain: my-plugin', 'Domain Path: /lang']))

      const { outputs } = await run(t, { generated: pot(), inputs: { INPUT_POT_PATH: '', INPUT_SOURCE_PATH: './src/' } })

      assert.strictEqual(outputs['pot-path'], 'src/lang/my-plugin.pot')
    })

    it('accepts a Text Domain and Domain Path parts of letters, digits, dots, dashes and underscores', async (t) => {
      write('plugin.php', header(['Text Domain: my_plugin-2.x', 'Domain Path: /i18n/lang_v2/']))

      const { outputs } = await run(t, { generated: pot(), inputs: { INPUT_POT_PATH: '' } })

      assert.strictEqual(outputs['pot-path'], 'i18n/lang_v2/my_plugin-2.x.pot')
    })

    it('is overridden by the pot-path input', async (t) => {
      write('plugin.php', header(['Text Domain: my-plugin', 'Domain Path: /languages']))

      const { outputs } = await run(t, { generated: pot() })

      assert.strictEqual(outputs['pot-path'], 'lang/plugin.pot')
    })

    const refused = [
      ['no Text Domain and no domain input', ['Domain Path: /languages'], /plugin\.php has no Text Domain header\. Pass domain or pot-path/],
      ['no Domain Path', ['Text Domain: my-plugin'], /plugin\.php has no Domain Path header\. Pass pot-path/],
      ['a Text Domain that reads as an option', ['Text Domain: --allow-root', 'Domain Path: lang'], /Text Domain '--allow-root' is not a file name/],
      ['a Text Domain with a space', ['Text Domain: a b', 'Domain Path: lang'], /Text Domain 'a b' is not a file name/],
      ['a Domain Path that leads up', ['Text Domain: my-plugin', 'Domain Path: ../..'], /Domain Path '\.\.\/\.\.' is not a directory inside the plugin/],
      ['a Domain Path that leads up from a directory', ['Text Domain: my-plugin', 'Domain Path: lang/../..'], /Domain Path 'lang\/\.\.\/\.\.' is not a directory inside the plugin/],
      ['a Domain Path of the plugin root', ['Text Domain: my-plugin', 'Domain Path: /'], /Domain Path names the plugin's root\. Pass pot-path/],
    ]

    for (const [name, lines, message] of refused) {
      it(`refuses a plugin header with ${name} before anything is downloaded`, async (t) => {
        write('plugin.php', header(lines))
        const { core } = await coreWithOutputs(t)
        const { exec, calls } = recordingExec()

        await assert.rejects(runGeneratePot({ core, exec, env: { RUNNER_TEMP: runnerTemp, INPUT_POT_PATH: '' }, cwd: repo }), message)
        assert.deepStrictEqual(calls, [])
      })
    }
  })

  describe('the changed check', () => {
    it('reports a new POT as changed', async (t) => {
      const { outputs } = await run(t, { generated: pot() })

      assert.deepStrictEqual(outputs, { 'pot-path': 'lang/plugin.pot', changed: 'yes' })
      assert.strictEqual(read('lang/plugin.pot'), pot())
    })

    it('reports a POT with a changed string as changed and keeps it', async (t) => {
      write('lang/plugin.pot', pot())
      commit()
      const generated = pot({ date: '2026-02-02T00:00:00+00:00', msgid: 'Goodbye' })

      const { outputs } = await run(t, { generated })

      assert.strictEqual(outputs.changed, 'yes')
      assert.strictEqual(read('lang/plugin.pot'), generated)
    })

    it('puts back a POT that differs in the three stamped headers only', async (t) => {
      write('lang/plugin.pot', pot())
      commit()

      const { outputs } = await run(t, { generated: pot({ date: '2026-02-02T00:00:00+00:00', version: '1.1.0', wp: '2.13.0' }) })

      assert.strictEqual(outputs.changed, 'no')
      assert.strictEqual(read('lang/plugin.pot'), pot())
      assert.strictEqual(git('status', '--porcelain'), '')
    })

    it('reports a changed string that holds a stamped header name as changed', async (t) => {
      write('lang/plugin.pot', pot({ msgid: 'X-Generator: old' }))
      commit()
      const generated = pot({ msgid: 'X-Generator: new' })

      const { outputs } = await run(t, { generated })

      assert.strictEqual(outputs.changed, 'yes')
      assert.strictEqual(read('lang/plugin.pot'), generated)
    })

    it('reports a POT that another header changed as changed', async (t) => {
      write('lang/plugin.pot', pot())
      commit()

      const { outputs } = await run(t, { generated: pot().replace('X-Domain: plugin', 'X-Domain: other') })

      assert.strictEqual(outputs.changed, 'yes')
    })

    it('puts back a POT that differs in the Copyright year and the #: references only', async (t) => {
      write('lang/plugin.pot', pot({ year: '2025' }))
      commit()

      const { outputs } = await run(t, { generated: pot({ line: 7 }) })

      assert.strictEqual(outputs.changed, 'no')
      assert.strictEqual(read('lang/plugin.pot'), pot({ year: '2025' }))
    })

    it('reports a POT with a changed translator comment as changed', async (t) => {
      write('lang/plugin.pot', pot())
      commit()

      const { outputs } = await run(t, { generated: pot().replace('#: plugin.php', '#. translators: a name\n#: plugin.php') })

      assert.strictEqual(outputs.changed, 'yes')
    })

    it('reports an identical POT as unchanged', async (t) => {
      write('lang/plugin.pot', pot())
      commit()

      const { outputs } = await run(t, { generated: pot() })

      assert.strictEqual(outputs.changed, 'no')
    })

    it('fails when make-pot wrote no POT', async (t) => {
      await assert.rejects(run(t), /wrote no file at lang\/plugin\.pot/)
    })
  })
})
