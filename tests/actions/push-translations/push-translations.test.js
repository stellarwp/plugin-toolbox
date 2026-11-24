'use strict'

const { describe, it } = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const {
  runPushTranslations,
  runReadResult,
  readInputs,
} = require('../../../.github/actions/push-translations/push-translations.js')
const { coreWithOutputs } = require('../../support/actions.js')

const BUILD_ID = '0123456789abcdef0123456789abcdef'

/** What The Events Calendar passes, with the defaults of action.yml filled in. */
const TEC = {
  INPUT_PROJECT: 'the-events-calendar',
  INPUT_POT_PATH: 'lang/the-events-calendar.pot',
  INPUT_REMOTE_FOLDER: 'tec/',
  INPUT_SITE_DIRECTORY: 'translations.stellarwp.com/html/',
  INPUT_RESULT_URL: 'https://translations.stellarwp.com/bot-output/',
  INPUT_HOST: 'ssh.example.com',
  INPUT_USER: 'deploy',
  INPUT_SSH_KEY: '-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----',
  INPUT_POT_LOCATION: '/home/deploy/pots/',
}

/** What GiveWP passes: a project under a parent, and its own remote folder. */
const GIVE = {
  ...TEC,
  INPUT_PROJECT: 'givewp/give',
  INPUT_POT_PATH: 'languages/give.pot',
  INPUT_REMOTE_FOLDER: 'givewp',
}

describe('push-translations', () => {
  it('accepts the TEC shape', () => {
    assert.deepStrictEqual(readInputs(TEC, BUILD_ID), {
      project: 'the-events-calendar',
      'pot-path': 'lang/the-events-calendar.pot',
      host: 'ssh.example.com',
      user: 'deploy',
      'remote-path': '/home/deploy/pots/tec/',
      'remote-pot': '/home/deploy/pots/tec/the-events-calendar.pot',
      'site-directory': 'translations.stellarwp.com/html',
      'result-file': `the-events-calendar-${BUILD_ID}`,
      'result-url': `https://translations.stellarwp.com/bot-output/the-events-calendar-${BUILD_ID}`,
    })
  })

  it('accepts the Give shape', () => {
    assert.deepStrictEqual(readInputs(GIVE, BUILD_ID), {
      project: 'givewp/give',
      'pot-path': 'languages/give.pot',
      host: 'ssh.example.com',
      user: 'deploy',
      'remote-path': '/home/deploy/pots/givewp/',
      'remote-pot': '/home/deploy/pots/givewp/give.pot',
      'site-directory': 'translations.stellarwp.com/html',
      'result-file': `give-${BUILD_ID}`,
      'result-url': `https://translations.stellarwp.com/bot-output/give-${BUILD_ID}`,
    })
  })

  it('trims the values, and takes a POT at the root and an absolute site directory', () => {
    const read = readInputs(
      { ...TEC, INPUT_POT_PATH: ' give.pot\n', INPUT_SITE_DIRECTORY: '/var/www/site', INPUT_HOST: '10.0.0.1\n' },
      BUILD_ID
    )

    assert.strictEqual(read['pot-path'], 'give.pot')
    assert.strictEqual(read['site-directory'], '/var/www/site')
  })

  it('returns host and user without the newlines around them, which the later steps connect with', () => {
    const read = readInputs({ ...TEC, INPUT_HOST: '\nssh.example.com\n', INPUT_USER: ' deploy\n' }, BUILD_ID)

    assert.strictEqual(read.host, 'ssh.example.com')
    assert.strictEqual(read.user, 'deploy')
  })

  it('refuses a newline inside host or user', () => {
    for (const input of ['INPUT_HOST', 'INPUT_USER']) {
      assert.throws(() => readInputs({ ...TEC, [input]: 'example\nid' }, BUILD_ID), /Nothing was sent/)
    }
  })

  it('gives each run a build id of its own, 32 hex characters', () => {
    const [first, second] = [readInputs(TEC), readInputs(TEC)]

    assert.match(first['result-file'], /^the-events-calendar-[a-f0-9]{32}$/)
    assert.notStrictEqual(first['result-file'], second['result-file'])
  })

  it('refuses a build id that is not 32 hex characters', () => {
    assert.throws(() => readInputs(TEC, 'abc; rm -rf ~'), /build id/)
  })

  const refused = {
    'a shell metacharacter in project': { INPUT_PROJECT: 'give; rm -rf ~' },
    'a command substitution in project': { INPUT_PROJECT: 'give$(id)' },
    'a backtick in project': { INPUT_PROJECT: 'give`id`' },
    'a space in project': { INPUT_PROJECT: 'give wp' },
    'a parent directory in project': { INPUT_PROJECT: '../give' },
    'an option as project': { INPUT_PROJECT: '--path=/tmp' },
    'an absolute project': { INPUT_PROJECT: '/givewp/give' },
    'an empty project': { INPUT_PROJECT: '' },
    'a pipe in remote-folder': { INPUT_REMOTE_FOLDER: 'tec|cat' },
    'a parent directory in remote-folder': { INPUT_REMOTE_FOLDER: 'tec/../..' },
    'an absolute remote-folder': { INPUT_REMOTE_FOLDER: '/tec' },
    'an empty remote-folder': { INPUT_REMOTE_FOLDER: ' ' },
    'a quote in site-directory': { INPUT_SITE_DIRECTORY: "html' && id '" },
    'a parent directory in site-directory': { INPUT_SITE_DIRECTORY: '../html' },
    'a home shorthand in site-directory': { INPUT_SITE_DIRECTORY: '~/html' },
    'an empty site-directory': { INPUT_SITE_DIRECTORY: '' },
    'a pot-path that is not a .pot': { INPUT_POT_PATH: 'languages/give.php' },
    'a space in pot-path': { INPUT_POT_PATH: 'languages/give wp.pot' },
    'a parent directory in pot-path': { INPUT_POT_PATH: '../../etc/give.pot' },
    'an absolute pot-path': { INPUT_POT_PATH: '/etc/give.pot' },
    'a metacharacter in pot-path': { INPUT_POT_PATH: 'languages/$(id).pot' },
    'a newline inside pot-path': { INPUT_POT_PATH: 'languages/give.pot\nid.pot' },
    'an empty pot-path': { INPUT_POT_PATH: '' },
    'a result-url that is not https': { INPUT_RESULT_URL: 'http://translations.stellarwp.com/bot-output/' },
    'a file result-url': { INPUT_RESULT_URL: 'file:///etc/passwd' },
    'a result-url with a query': { INPUT_RESULT_URL: 'https://translations.stellarwp.com/bot-output/?a=b' },
    'a result-url with credentials': { INPUT_RESULT_URL: 'https://user:pass@translations.stellarwp.com/' },
    'an empty result-url': { INPUT_RESULT_URL: '' },
    'a metacharacter in host': { INPUT_HOST: 'example.com;id' },
    'an option as host': { INPUT_HOST: '-oProxyCommand=id' },
    'an empty host': { INPUT_HOST: '' },
    'a space in user': { INPUT_USER: 'deploy -o x' },
    'an empty user': { INPUT_USER: undefined },
    'an empty ssh-key': { INPUT_SSH_KEY: '  \n' },
    'a relative pot-location': { INPUT_POT_LOCATION: 'pots/' },
    'a parent directory in pot-location': { INPUT_POT_LOCATION: '/home/deploy/../root/' },
    'a metacharacter in pot-location': { INPUT_POT_LOCATION: '/home/deploy/pots/ && id' },
    'an empty pot-location': { INPUT_POT_LOCATION: '' },
  }

  for (const [name, inputs] of Object.entries(refused)) {
    it(`refuses ${name}`, () => {
      const input = Object.keys(inputs)[0].replace('INPUT_', '').toLowerCase().replace(/_/g, '-')

      assert.throws(
        () => readInputs({ ...TEC, ...inputs }, BUILD_ID),
        new RegExp(`^Error: ${input} .*Nothing was sent to the translations server\\.$`, 's')
      )
    })
  }

  it('does not repeat a value that comes from a secret in the message', () => {
    for (const input of ['INPUT_HOST', 'INPUT_USER', 'INPUT_POT_LOCATION']) {
      assert.throws(
        () => readInputs({ ...TEC, [input]: 's3cret value' }, BUILD_ID),
        (error) => !error.message.includes('s3cret')
      )
    }
  })

  it('sets the validated values as outputs, and leaves the result file out of the summary', async (t) => {
    const { core, outputs, summary } = await coreWithOutputs(t)

    await runPushTranslations({ core, env: GIVE })

    const set = outputs()
    assert.strictEqual(set.project, 'givewp/give')
    assert.strictEqual(set['remote-pot'], '/home/deploy/pots/givewp/give.pot')
    assert.match(set['result-file'], /^give-[a-f0-9]{32}$/)
    assert.strictEqual(set['result-url'], `https://translations.stellarwp.com/bot-output/${set['result-file']}`)
    assert.ok(!summary().includes(set['result-file'].slice(-32)))
    assert.strictEqual(set.host, 'ssh.example.com')
    assert.strictEqual(set.user, 'deploy')
    // The key is never an output: the later steps take it from the input.
    assert.ok(!Object.values(set).some((value) => value.includes('PRIVATE KEY')))
  })
})

describe('runReadResult', () => {
  /** A fetch that answers once and records the URL it was asked for. */
  const fetchOf = (status, body) => {
    const urls = []

    return { urls, fetchImpl: async (url) => (urls.push(url), new Response(body, { status })) }
  }

  it('sets what the import printed as the output, several lines included', async (t) => {
    const { core, outputs, summary } = await coreWithOutputs(t)
    const { urls, fetchImpl } = fetchOf(200, '3 new strings added\n1 string obsoleted\n')

    await runReadResult({ core, env: { RESULT_URL: 'https://example.com/bot-output/give-abc' }, fetchImpl })

    assert.deepStrictEqual(urls, ['https://example.com/bot-output/give-abc'])
    assert.strictEqual(outputs()['glotpress-result'], '3 new strings added\n1 string obsoleted')
    assert.match(summary(), /3 new strings added/)
  })

  it('fails when the site does not answer 200, and sets no output', async (t) => {
    const { core, outputs } = await coreWithOutputs(t)

    await assert.rejects(
      runReadResult({ core, env: { RESULT_URL: 'https://example.com/x' }, fetchImpl: fetchOf(404, 'no').fetchImpl }),
      /answered 404/
    )
    assert.deepStrictEqual(outputs(), {})
  })

  it('refuses a URL that is not https before any request', async (t) => {
    const { core } = await coreWithOutputs(t)
    const { urls, fetchImpl } = fetchOf(200, 'x')

    await assert.rejects(runReadResult({ core, env: { RESULT_URL: 'http://example.com/x' }, fetchImpl }), /no https URL/)
    assert.deepStrictEqual(urls, [])
  })
})

describe('the pot-path default', () => {
  /**
   * A workspace holding one plugin file with the given header lines.
   *
   * @param {string} header The header lines, one per line.
   *
   * @returns {string} The workspace directory.
   */
  function workspace(header) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'push-translations-'))
    fs.writeFileSync(path.join(dir, 'give.php'), `<?php\n/**\n * Plugin Name: Give\n${header}\n */\n`)
    return dir
  }

  it('is <Domain Path>/<Text Domain>.pot from the plugin header when pot-path is empty', () => {
    const env = { ...GIVE, INPUT_POT_PATH: '', GITHUB_WORKSPACE: workspace(' * Text Domain: give\n * Domain Path: /languages/') }

    assert.strictEqual(readInputs(env, BUILD_ID)['pot-path'], 'languages/give.pot')
  })

  it('is not used when pot-path is given', () => {
    const env = { ...GIVE, GITHUB_WORKSPACE: workspace(' * Text Domain: other\n * Domain Path: /lang') }

    assert.strictEqual(readInputs(env, BUILD_ID)['pot-path'], 'languages/give.pot')
  })

  const refused = {
    'no plugin file': null,
    'no Text Domain': ' * Domain Path: /languages',
    'no Domain Path': ' * Text Domain: give',
    'a Text Domain that is not a file name': ' * Text Domain: give $(id)\n * Domain Path: /languages',
  }

  for (const [name, header] of Object.entries(refused)) {
    it(`refuses an empty pot-path when the header has ${name}`, () => {
      const dir = header === null ? fs.mkdtempSync(path.join(os.tmpdir(), 'push-translations-')) : workspace(header)

      assert.throws(
        () => readInputs({ ...GIVE, INPUT_POT_PATH: '', GITHUB_WORKSPACE: dir }, BUILD_ID),
        /^Error: pot-path .*Nothing was sent to the translations server\.$/s
      )
    })
  }
})
