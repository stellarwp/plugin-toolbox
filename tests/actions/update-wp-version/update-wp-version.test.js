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

/** A fetch for a run that must not look anything up. */
const noFetch = async () => {
  throw new Error('No lookup was expected.')
}

/** A fetch answering the WordPress version-check endpoint with the given body and status. */
const versionCheck = (body, status = 200) => {
  const calls = []
  const fetchImpl = async (url) => {
    calls.push(url)
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status })
  }
  return { fetchImpl, calls }
}

/** The stable-check endpoint, which lists every WordPress release. */
const STABLE_CHECK_URL = 'https://api.wordpress.org/core/stable-check/1.0/'

/**
 * Releases as stable-check lists them: 1.0, 1.2 and 1.5 only as patch releases, as the real list
 * does, then every minor from 2.0 to 7.2 with a patch release of each.
 */
const RELEASES = Object.fromEntries(
  [
    '1.0.2',
    '1.2.1',
    '1.5.1.3',
    ...[2, 3, 4, 5, 6].flatMap((major) => [...Array(10).keys()].flatMap((minor) => [`${major}.${minor}`, `${major}.${minor}.1`])),
    '7.0',
    '7.0.9',
    '7.1',
    '7.1.5',
    '7.2',
  ].map((version) => [version, 'insecure'])
)

/**
 * A fetch answering stable-check with the given body and status, and refusing any other URL.
 *
 * @param {object|string} body   The answer, JSON-encoded unless it is a string.
 * @param {number}        status The HTTP status.
 */
const stableCheck = (body = RELEASES, status = 200) => async (url) => {
  if (url !== STABLE_CHECK_URL) {
    throw new Error(`No lookup of ${url} was expected.`)
  }
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status })
}

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

  const run = async (t, tested, min, inputs = {}, fetchImpl = stableCheck()) => {
    const { core, outputs, logged, summary } = await coreWithOutputs(t)

    await runUpdateWpVersion({
      core,
      cwd: dir,
      fetchImpl,
      env: { INPUT_TESTED_UP_TO: tested, INPUT_MIN_VERSION: min, ...inputs },
    })

    return { outputs: outputs(), logged: logged(), summary: summary() }
  }

  /** Asserts the run is refused with the message, with no file changed and no output set. */
  const refuses = async (t, tested, min, message, fetchImpl = stableCheck()) => {
    const before = snapshot()
    const { core, outputs } = await coreWithOutputs(t)

    await assert.rejects(
      runUpdateWpVersion({
        core,
        cwd: dir,
        fetchImpl,
        env: { INPUT_TESTED_UP_TO: tested, INPUT_MIN_VERSION: min },
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
    const { outputs, summary } = await run(t, '6.8.1', 'auto')

    assert.strictEqual(outputs['min-version'], '6.6')
    assert.strictEqual(outputs.changed, 'true')
    assert.match(read('readme.txt'), /^Tested up to: 6\.8\.1$/m)
    assert.match(read('readme.txt'), /^Requires at least: 6\.6$/m)
    assert.strictEqual(read('test-plugin.php'), PLUGIN.replace('least: 6.0', 'least: 6.6'))
    assert.strictEqual(read('.github/workflows/tests-php.yml'), WORKFLOW)
    assert.strictEqual(
      summary,
      '## Version Updates\n' +
        '* Tested Up To: `6.8.1`\n' +
        '* Minimum Required Version: `6.6`\n' +
        '* `readme.txt`: Tested up to changed from 6.4 to 6.8.1\n' +
        '* `readme.txt`: Requires at least changed from 6.0 to 6.6\n' +
        '* `test-plugin.php`: Requires at least changed from 6.0 to 6.6\n'
    )
  })

  it('takes a version of two parts', async (t) => {
    const { outputs } = await run(t, '6.8', 'auto')

    assert.strictEqual(outputs['min-version'], '6.6')
    assert.match(read('readme.txt'), /^Tested up to: 6\.8$/m)
  })

  it('leaves the minimum alone unless asked, and needs no .puprc for it', async (t) => {
    fs.rmSync(path.join(dir, '.puprc'))
    const { outputs, summary } = await run(t, '7.0', '')

    assert.strictEqual(outputs['min-version'], '')
    assert.strictEqual(read('readme.txt'), README.replace('up to: 6.4', 'up to: 7.0'))
    assert.strictEqual(read('test-plugin.php'), PLUGIN)
    assert.match(summary, /\* Minimum Required Version: Unchanged\n\* `readme.txt`: Tested up to changed from 6\.4 to 7\.0\n$/)
  })

  it('changes the header only, not a version quoted further down', async (t) => {
    await run(t, '6.8', '')

    assert.match(read('readme.txt'), /^Tested up to: 6\.2 was the previous target\.$/m)
  })

  it('replaces the whole previous version, a pre-release suffix included', async (t) => {
    write('readme.txt', README.replace('up to: 6.4', 'up to: 6.8-RC1'))
    await run(t, '6.8', '')

    assert.match(read('readme.txt'), /^Tested up to: 6\.8$/m)
  })

  it('keeps a comment close that directly follows the value', async (t) => {
    write('test-plugin.php', PLUGIN.replace(' * Requires at least: 6.0\n */', ' * Requires at least: 6.0*/'))
    await run(t, '6.8', 'auto')

    assert.match(read('test-plugin.php'), /^ \* Requires at least: 6\.6\*\/$/m)
  })

  it('reports a header already at the version, and sets changed to false when nothing changed', async (t) => {
    await run(t, '6.8', 'auto')
    const { outputs, summary, logged } = await run(t, '6.8', 'auto')

    assert.strictEqual(outputs.changed, 'false')
    assert.match(summary, /\* `readme.txt`: Tested up to already at 6\.8\n/)
    assert.match(summary, /\* `test-plugin.php`: Requires at least already at 6\.6\n$/)
    assert.match(logged, /readme\.txt: Tested up to already at 6\.8/)
  })

  it('never lowers Tested up to, and says so', async (t) => {
    write('readme.txt', README.replace('up to: 6.4', 'up to: 7.1.4'))
    write('test-plugin.php', PLUGIN_TESTED.replace('up to: 6.4', 'up to: 7.0'))
    const { outputs, summary } = await run(t, '7.1', '')

    assert.strictEqual(outputs.changed, 'true')
    assert.strictEqual(read('readme.txt'), README.replace('up to: 6.4', 'up to: 7.1.4'))
    assert.match(summary, /\* `readme.txt`: Tested up to left at 7\.1\.4, which is above 7\.1\n/)
    assert.match(summary, /\* `test-plugin.php`: Tested up to changed from 7\.0 to 7\.1\n$/)

    write('test-plugin.php', PLUGIN)
    const again = await run(t, '7.1', '')
    assert.strictEqual(again.outputs.changed, 'false')
  })

  it('never lowers Requires at least with auto, but sets a lower version given exactly', async (t) => {
    write('test-plugin.php', PLUGIN.replace('least: 6.0', 'least: 6.9'))
    const { outputs, summary } = await run(t, '7.0', 'auto')

    assert.strictEqual(outputs['min-version'], '6.9')
    assert.match(summary, /\* Minimum Required Version: `6\.9`\n/)
    assert.strictEqual(read('test-plugin.php'), PLUGIN.replace('least: 6.0', 'least: 6.9'))
    assert.match(summary, /\* `readme.txt`: Requires at least changed from 6\.0 to 6\.8\n/)
    assert.match(summary, /\* `test-plugin.php`: Requires at least left at 6\.9, which is above 6\.8\n$/)

    await run(t, '7.0', '6.7')
    assert.strictEqual(read('test-plugin.php'), PLUGIN.replace('least: 6.0', 'least: 6.7'))
  })

  it('reports the minimum the files hold: the highest kept value, or empty when no file has the header', async (t) => {
    write('readme.txt', README.replace('least: 6.0', 'least: 6.9'))
    write('test-plugin.php', PLUGIN.replace('least: 6.0', 'least: 6.9'))
    const kept = await run(t, '7.0', 'auto')

    assert.strictEqual(kept.outputs['min-version'], '6.9')
    assert.match(kept.summary, /\* Minimum Required Version: `6\.9`\n/)

    write('readme.txt', README.replace('least: 6.0', 'least: 6.9'))
    write('test-plugin.php', PLUGIN.replace('least: 6.0', 'least: 7.0'))
    assert.strictEqual((await run(t, '7.0', 'auto')).outputs['min-version'], '7.0')

    write('readme.txt', README.replace('Requires at least: 6.0\n', ''))
    write('test-plugin.php', PLUGIN.replace(' * Requires at least: 6.0\n', ''))
    const none = await run(t, '7.0', 'auto')

    assert.strictEqual(none.outputs['min-version'], '')
    assert.match(none.summary, /\* Minimum Required Version: Unchanged\n/)
  })

  it('updates a Tested up to header the plugin file carries, and adds none', async (t) => {
    write('test-plugin.php', PLUGIN_TESTED)
    const { summary } = await run(t, '6.8', '')

    assert.strictEqual(read('test-plugin.php'), PLUGIN_TESTED.replace('up to: 6.4', 'up to: 6.8'))
    assert.match(summary, /\* `test-plugin.php`: Tested up to changed from 6\.4 to 6\.8\n$/)

    await run(t, '6.9', 'auto')
    assert.strictEqual(
      read('test-plugin.php'),
      PLUGIN_TESTED.replace('up to: 6.4', 'up to: 6.9').replace('least: 6.0', 'least: 6.7')
    )

    write('test-plugin.php', PLUGIN)
    await run(t, '6.9', '')
    assert.strictEqual(read('test-plugin.php'), PLUGIN)
  })

  it('passes without a readme.txt, or with one that has no header, and warns when nothing was written', async (t) => {
    fs.rmSync(path.join(dir, 'readme.txt'))
    const { outputs, summary } = await run(t, '6.8', 'auto')

    assert.strictEqual(outputs['min-version'], '6.6')
    assert.match(read('test-plugin.php'), /Requires at least: 6\.6/)
    assert.ok(!summary.includes('readme.txt'))

    write('readme.txt', '== Changelog ==\n\n* Fix - Something.\n')
    const { logged, outputs: noHeader } = await run(t, '6.8', '')

    assert.strictEqual(read('readme.txt'), '== Changelog ==\n\n* Fix - Something.\n')
    assert.strictEqual(noHeader.changed, 'false')
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
      env: { INPUT_TESTED_UP_TO: '6.8', INPUT_MIN_VERSION: '', INPUT_WORKING_DIRECTORY: 'source' },
    })

    assert.match(read('source/readme.txt'), /^Tested up to: 6\.8$/m)
    assert.strictEqual(read('readme.txt'), README)
  })

  it('refuses a version that is not two or three plain numeric parts', async (t) => {
    const bad = [
      'banana',
      '6',
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
      await refuses(t, version, 'auto', /must look like 6\.8 or 6\.8\.1/)
      await refuses(t, version, '', /must look like 6\.8 or 6\.8\.1/)
    }
  })

  it('sets the major and minor of the latest WordPress release when tested-up-to is empty', async (t) => {
    const { fetchImpl, calls } = versionCheck({ offers: [{ version: '6.8.3' }, { version: '6.7.4' }] })
    await run(t, ' ', '', {}, fetchImpl)

    assert.deepStrictEqual(calls, ['https://api.wordpress.org/core/version-check/1.7/'])
    assert.match(read('readme.txt'), /^Tested up to: 6\.8$/m)

    write('readme.txt', README.replace('up to: 6.4', 'up to: 6.8.2'))
    await run(t, '', '', {}, fetchImpl)
    assert.match(read('readme.txt'), /^Tested up to: 6\.8\.2$/m)
  })

  it('refuses when the latest WordPress release cannot be looked up', async (t) => {
    const failed = /Looking up the latest WordPress release failed/
    const unusable = /The latest WordPress release has no usable version/

    await refuses(t, '', '', failed, versionCheck({}, 500).fetchImpl)
    await refuses(t, '', '', failed, versionCheck('<html>').fetchImpl)
    await refuses(t, '', '', failed, async () => {
      throw new Error('getaddrinfo ENOTFOUND')
    })
    await refuses(t, '', '', unusable, versionCheck({}).fetchImpl)
    await refuses(t, '', '', unusable, versionCheck({ offers: [] }).fetchImpl)
    await refuses(t, '', '', unusable, versionCheck({ offers: [{ version: '6.8; rm -rf' }] }).fetchImpl)
  })

  it('takes the minimum two releases back in the stable-check list, across a major version', async (t) => {
    // 2.0 followed 1.5, so two releases back from 2.0 is 1.2, which arithmetic would get wrong.
    const expected = { '7.0': '6.8', '7.1': '6.9', '6.1.0': '5.9', '7.2.1': '7.0', '2.0': '1.2', '1.5': '1.0' }

    for (const [tested, minimum] of Object.entries(expected)) {
      write('readme.txt', README.replace('least: 6.0', 'least: 1.0'))
      write('test-plugin.php', PLUGIN.replace('least: 6.0', 'least: 1.0'))
      const { outputs } = await run(t, tested, 'auto')

      assert.strictEqual(outputs['min-version'], minimum, tested)
      assert.match(read('readme.txt'), new RegExp(`^Requires at least: ${minimum.replace('.', '\\.')}$`, 'm'))
    }
  })

  it('refuses auto when stable-check lists fewer than two releases before the tested one', async (t) => {
    for (const tested of ['1.0', '1.2']) {
      await refuses(t, tested, 'auto', new RegExp(`fewer than two WordPress releases before ${tested.replace('.', '\\.')}`))
    }
  })

  it('refuses auto when the tested version is not a release stable-check lists', async (t) => {
    for (const tested of ['7.3', '0.1', '1.1']) {
      await refuses(t, tested, 'auto', new RegExp(`${tested.replace('.', '\\.')} is not a WordPress release`))
    }
  })

  it('looks up the releases only for auto', async (t) => {
    await run(t, '7.0', '6.8', {}, noFetch)
    await run(t, '7.0', '', {}, noFetch)

    assert.match(read('readme.txt'), /^Requires at least: 6\.8$/m)
  })

  it('refuses auto when the WordPress releases cannot be looked up', async (t) => {
    const failed = /Looking up the WordPress releases failed/
    const unusable = /lists no WordPress releases/

    await refuses(t, '7.0', 'auto', failed, stableCheck({}, 500))
    await refuses(t, '7.0', 'auto', failed, stableCheck('<html>'))
    await refuses(t, '7.0', 'auto', failed, async () => {
      throw new Error('getaddrinfo ENOTFOUND')
    })
    await refuses(t, '7.0', 'auto', unusable, stableCheck(null))
    await refuses(t, '7.0', 'auto', unusable, stableCheck(['7.0', '6.9']))
    await refuses(t, '7.0', 'auto', unusable, stableCheck({ latest: '7.0' }))
  })

  it('sets a minimum given as a version exactly', async (t) => {
    const { outputs } = await run(t, '7.0', ' 6.9 ')

    assert.strictEqual(outputs['min-version'], '6.9')
    assert.match(read('readme.txt'), /^Requires at least: 6\.9$/m)
    assert.strictEqual(read('test-plugin.php'), PLUGIN.replace('least: 6.0', 'least: 6.9'))
  })

  it('refuses a min-version that is not empty, auto or a version', async (t) => {
    for (const min of ['yes', 'no', 'true', '6', 'v6.9', '6.09', '6.9-RC1']) {
      await refuses(t, '6.8', min, /min-version must be empty, auto, or a version like 6\.9/)
    }
  })

  it('refuses a min-version above the tested version', async (t) => {
    await refuses(t, '6.8', '6.9', /min-version 6\.9 is above the tested version 6\.8/)
  })

  it('refuses a working-directory that is not there', async (t) => {
    const { core } = await coreWithOutputs(t)

    await assert.rejects(
      runUpdateWpVersion({
        core,
        cwd: dir,
        env: { INPUT_TESTED_UP_TO: '6.8', INPUT_MIN_VERSION: '', INPUT_WORKING_DIRECTORY: 'nowhere' },
      }),
      /working-directory 'nowhere' is not a directory/
    )
  })

  it('refuses to update the minimum unless .puprc lists exactly one root PHP file that exists', async (t) => {
    const exactlyOne = /\.puprc must list exactly one root PHP file under paths\.versions/

    write('other.php', PLUGIN)
    write('.puprc', puprc(['test-plugin.php', 'other.php']))
    await refuses(t, '6.8', 'auto', /exactly one root PHP file under paths\.versions, got 'test-plugin\.php', 'other\.php'/)

    write('.puprc', puprc(['src/Main.php', 'readme.txt']))
    await refuses(t, '6.8', 'auto', exactlyOne)

    write('.puprc', puprc(['missing.php']))
    await refuses(t, '6.8', 'auto', /got 'missing\.php', which is not a file/)

    write('.puprc', '{nope')
    await refuses(t, '6.8', 'auto', /\.puprc is not valid JSON/)

    fs.rmSync(path.join(dir, '.puprc'))
    const needed = /^min-version is set, so a \.puprc listing the plugin file under paths\.versions is needed; see this action's README\./
    await refuses(t, '6.8', 'auto', needed)
    await refuses(t, '6.9', '6.6', needed)
  })

  it('takes a plugin file .puprc lists with a leading ./', async (t) => {
    write('.puprc', puprc(['./test-plugin.php', './test-plugin.php', 'readme.txt']))
    await run(t, '6.8', 'auto')

    assert.strictEqual(read('test-plugin.php'), PLUGIN.replace('least: 6.0', 'least: 6.6'))
  })

  it('still sets the tested version in readme.txt when .puprc names no single plugin file', async (t) => {
    write('other.php', PLUGIN_TESTED)
    write('.puprc', puprc(['test-plugin.php', 'other.php']))
    await run(t, '6.8', '')

    assert.match(read('readme.txt'), /^Tested up to: 6\.8$/m)
    assert.strictEqual(read('other.php'), PLUGIN_TESTED)
  })
})
