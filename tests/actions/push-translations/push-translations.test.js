'use strict'

const { describe, it } = require('node:test')
const assert = require('node:assert')

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

  it('sets the validated values as outputs and names the build in the summary', async (t) => {
    const { core, outputs, summary } = await coreWithOutputs(t)

    await runPushTranslations({ core, env: GIVE })

    const set = outputs()
    assert.strictEqual(set.project, 'givewp/give')
    assert.strictEqual(set['remote-pot'], '/home/deploy/pots/givewp/give.pot')
    assert.match(set['result-file'], /^give-[a-f0-9]{32}$/)
    assert.strictEqual(set['result-url'], `https://translations.stellarwp.com/bot-output/${set['result-file']}`)
    assert.ok(summary().includes(set['result-file']))
    // The key and the host are never outputs: the later steps take them from the inputs.
    assert.ok(!Object.values(set).some((value) => value.includes('PRIVATE KEY') || value.includes('ssh.example.com')))
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
