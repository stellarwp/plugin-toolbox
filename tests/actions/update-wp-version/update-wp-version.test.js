'use strict'

const { describe, it, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { runUpdateWpVersion } = require('../../../.github/actions/update-wp-version/update-wp-version.js')
const { coreWithOutputs } = require('../../support/actions.js')

const README = `=== Test Plugin ===

Contributors: someone
Stable tag: 1.2.3
Requires at least: 6.0
Tested up to: 6.4
Requires PHP: 7.4

== Description ==

Tested up to: 6.2 was the previous target.
`

const PLUGIN = `<?php
/**
 * Plugin Name: Test Plugin
 * Version: 1.2.3
 * Requires at least: 6.0
 */
`

/** A plugin file that also carries the tested version, as LearnDash's does. */
const PLUGIN_TESTED = `<?php
/**
 * Plugin Name: Test Plugin
 * Version: 1.2.3
 * Requires at least: 6.0
 * Tested up to: 6.4
 */
`

const WORKFLOW = 'jobs:\n  t:\n    steps:\n      - run: wp core update --version=6.8\n'

/** A .puprc listing the given version files, the plugin file twice as real ones do. */
const puprc = (files = ['test-plugin.php', 'test-plugin.php', 'readme.txt', 'src/Main.php']) =>
  JSON.stringify({ paths: { versions: files.map((file) => ({ file, regex: '(Version: )(.+)' })) } })

describe('update-wp-version', () => {
  let dir

  const write = (name, body) => {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true })
    fs.writeFileSync(path.join(dir, name), body)
  }

  const read = (name) => fs.readFileSync(path.join(dir, name), 'utf8')

  /** Every file of the checkout, to assert a refusal wrote nothing. */
  const snapshot = () =>
    Object.fromEntries(
      fs
        .readdirSync(dir, { recursive: true, withFileTypes: true })
        .filter((entry) => entry.isFile())
        .map((entry) => path.join(entry.parentPath, entry.name))
        .sort()
        .map((file) => [path.relative(dir, file), fs.readFileSync(file, 'utf8')])
    )

  const run = async (t, tested, updateMin, inputs = {}) => {
    const { core, outputs, logged, summary } = await coreWithOutputs(t)

    await runUpdateWpVersion({
      core,
      cwd: dir,
      env: { INPUT_TESTED_UP_TO: tested, INPUT_UPDATE_MIN_VERSION: updateMin, ...inputs },
    })

    return { outputs: outputs(), logged: logged(), summary: summary() }
  }

  /** Asserts the run is refused with the message, with no file changed and no output set. */
  const refuses = async (t, tested, updateMin, message) => {
    const before = snapshot()
    const { core, outputs } = await coreWithOutputs(t)

    await assert.rejects(
      runUpdateWpVersion({
        core,
        cwd: dir,
        env: { INPUT_TESTED_UP_TO: tested, INPUT_UPDATE_MIN_VERSION: updateMin },
      }),
      (error) => message.test(error.message) && error.message.endsWith('No file was changed.')
    )
    assert.deepStrictEqual(snapshot(), before)
    assert.deepStrictEqual(outputs(), {})
  }

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'toolbox-update-wp-version-'))
    write('readme.txt', README)
    write('test-plugin.php', PLUGIN)
    write('.puprc', puprc())
    write('.github/workflows/tests-php.yml', WORKFLOW)
  })

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('sets the tested version and the minimum two minors behind it', async (t) => {
    const { outputs, summary } = await run(t, '6.8.1', 'yes')

    assert.strictEqual(outputs['min-version'], '6.6')
    assert.match(read('readme.txt'), /^Tested up to: 6\.8\.1$/m)
    assert.match(read('readme.txt'), /^Requires at least: 6\.6$/m)
    assert.strictEqual(read('test-plugin.php'), PLUGIN.replace('least: 6.0', 'least: 6.6'))
    assert.strictEqual(read('.github/workflows/tests-php.yml'), WORKFLOW)
    assert.strictEqual(
      summary,
      '## Version Updates\n' +
        '* Tested Up To: `6.8.1`\n' +
        '* Minimum Required Version: `6.6`\n' +
        '* Updated `readme.txt`\n' +
        '* Updated `test-plugin.php`\n'
    )
  })

  it('takes a version of two parts', async (t) => {
    const { outputs } = await run(t, '6.8', 'yes')

    assert.strictEqual(outputs['min-version'], '6.6')
    assert.match(read('readme.txt'), /^Tested up to: 6\.8$/m)
  })

  it('leaves the minimum alone unless asked, and needs no .puprc for it', async (t) => {
    fs.rmSync(path.join(dir, '.puprc'))
    const { outputs, summary } = await run(t, '7.0', 'no')

    assert.strictEqual(outputs['min-version'], '')
    assert.strictEqual(read('readme.txt'), README.replace('up to: 6.4', 'up to: 7.0'))
    assert.strictEqual(read('test-plugin.php'), PLUGIN)
    assert.match(summary, /\* Minimum Required Version: Unchanged\n\* Updated `readme.txt`\n$/)
  })

  it('changes the header only, not a version quoted further down', async (t) => {
    await run(t, '6.8', 'no')

    assert.match(read('readme.txt'), /^Tested up to: 6\.2 was the previous target\.$/m)
  })

  it('updates a Tested up to header the plugin file carries, and adds none', async (t) => {
    write('test-plugin.php', PLUGIN_TESTED)
    const { summary } = await run(t, '6.8', 'no')

    assert.strictEqual(read('test-plugin.php'), PLUGIN_TESTED.replace('up to: 6.4', 'up to: 6.8'))
    assert.match(summary, /\* Updated `test-plugin.php`\n$/)

    await run(t, '6.9', 'yes')
    assert.strictEqual(
      read('test-plugin.php'),
      PLUGIN_TESTED.replace('up to: 6.4', 'up to: 6.9').replace('least: 6.0', 'least: 6.7')
    )

    write('test-plugin.php', PLUGIN)
    await run(t, '6.9', 'no')
    assert.strictEqual(read('test-plugin.php'), PLUGIN)
  })

  it('passes without a readme.txt, or with one that has no header, and warns when nothing was written', async (t) => {
    fs.rmSync(path.join(dir, 'readme.txt'))
    const { outputs, summary } = await run(t, '6.8', 'yes')

    assert.strictEqual(outputs['min-version'], '6.6')
    assert.match(read('test-plugin.php'), /Requires at least: 6\.6/)
    assert.ok(!summary.includes('readme.txt'))

    write('readme.txt', '== Changelog ==\n\n* Fix - Something.\n')
    const { logged } = await run(t, '6.8', 'no')

    assert.strictEqual(read('readme.txt'), '== Changelog ==\n\n* Fix - Something.\n')
    assert.match(logged, /::warning::No file carries a header to set/)
  })

  it('works in the directory the repository is checked out in', async (t) => {
    const workspace = dir
    dir = path.join(workspace, 'source')
    write('readme.txt', README)
    dir = workspace
    const { core } = await coreWithOutputs(t)

    await runUpdateWpVersion({
      core,
      cwd: workspace,
      env: { INPUT_TESTED_UP_TO: '6.8', INPUT_UPDATE_MIN_VERSION: 'no', INPUT_WORKING_DIRECTORY: 'source' },
    })

    assert.match(read('source/readme.txt'), /^Tested up to: 6\.8$/m)
    assert.strictEqual(read('readme.txt'), README)
  })

  it('refuses a version that is not two or three plain numeric parts', async (t) => {
    const bad = [
      'banana',
      '6',
      '',
      '6.8.1.2',
      'v6.8',
      // Zero-padded parts: 6.010 is not 6.10.
      '6.08',
      '6.010',
      '06.8',
      // An input is data, so a shell payload is only a wrong version.
      '6.8"; touch INJECTED; #',
      '6.8$(touch INJECTED)',
      '6.8`touch INJECTED`',
      '6.8\nRequires at least: 1.0',
    ]

    for (const version of bad) {
      await refuses(t, version, 'yes', /must look like 6\.8 or 6\.8\.1/)
      await refuses(t, version, 'no', /must look like 6\.8 or 6\.8\.1/)
    }
  })

  it('refuses to derive a minimum across a major version', async (t) => {
    for (const version of ['7.0', '6.1.0', '7.1']) {
      await refuses(t, version, 'yes', /Cannot derive a minimum version two minors behind/)
    }
  })

  it('refuses an update-min-version that is not yes or no', async (t) => {
    await refuses(t, '6.8', 'true', /update-min-version 'true' is not yes or no/)
  })

  it('refuses a working-directory that is not there', async (t) => {
    const { core } = await coreWithOutputs(t)

    await assert.rejects(
      runUpdateWpVersion({
        core,
        cwd: dir,
        env: { INPUT_TESTED_UP_TO: '6.8', INPUT_UPDATE_MIN_VERSION: 'no', INPUT_WORKING_DIRECTORY: 'nowhere' },
      }),
      /working-directory 'nowhere' is not a directory/
    )
  })

  it('refuses to update the minimum unless .puprc lists exactly one root PHP file that exists', async (t) => {
    const exactlyOne = /\.puprc must list exactly one root PHP file under paths\.versions/

    write('other.php', PLUGIN)
    write('.puprc', puprc(['test-plugin.php', 'other.php']))
    await refuses(t, '6.8', 'yes', /exactly one root PHP file under paths\.versions, got 'test-plugin\.php', 'other\.php'/)

    write('.puprc', puprc(['src/Main.php', 'readme.txt']))
    await refuses(t, '6.8', 'yes', exactlyOne)

    write('.puprc', puprc(['missing.php']))
    await refuses(t, '6.8', 'yes', /got 'missing\.php', which is not a file/)

    write('.puprc', '{nope')
    await refuses(t, '6.8', 'yes', /\.puprc is not valid JSON/)

    fs.rmSync(path.join(dir, '.puprc'))
    await refuses(t, '6.8', 'yes', /No \.puprc/)
  })

  it('still sets the tested version in readme.txt when .puprc names no single plugin file', async (t) => {
    write('other.php', PLUGIN_TESTED)
    write('.puprc', puprc(['test-plugin.php', 'other.php']))
    await run(t, '6.8', 'no')

    assert.match(read('readme.txt'), /^Tested up to: 6\.8$/m)
    assert.strictEqual(read('other.php'), PLUGIN_TESTED)
  })
})
