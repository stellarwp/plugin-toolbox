'use strict'

const { describe, it } = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const report = require('../../../.github/actions/plugin-check-report/plugin-check-report.js')
const { actionsFor } = require('../../support/actions.js')

const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-check-exclude-'))

/**
 * A repository root holding a config file.
 *
 * @param {string} text What the file holds.
 *
 * @returns {string} The path of the file.
 */
function configFile(text) {
  const file = path.join(temp(), '.plugin-check.json')
  fs.writeFileSync(file, text)

  return file
}

describe('parseExcludeInput', () => {
  it('reads one check per line', () => {
    assert.deepEqual(report.parseExcludeInput('late_escaping\ni18n_usage\n'), ['late_escaping', 'i18n_usage'])
  })

  it('trims, drops blank lines and repeats, and reads Windows line breaks', () => {
    assert.deepEqual(report.parseExcludeInput('  a \r\n\r\n\n b\na\n'), ['a', 'b'])
  })

  it('reads a comma list too, which the Plugin Check action turns its lines into', () => {
    assert.deepEqual(report.parseExcludeInput('a,b\nc'), ['a', 'b', 'c'])
  })

  it('is empty for an empty or blank input', () => {
    assert.deepEqual(report.parseExcludeInput(''), [])
    assert.deepEqual(report.parseExcludeInput(' \n\t\n'), [])
  })
})

describe('parseExcludeFile', () => {
  it('reads the list', () => {
    assert.deepEqual(report.parseExcludeFile('{"exclude-checks": ["late_escaping", "i18n_usage"]}'), ['late_escaping', 'i18n_usage'])
  })

  it('trims entries and drops repeats, keeping the first order', () => {
    assert.deepEqual(report.parseExcludeFile('{"exclude-checks": [" b ", "a", "b"]}'), ['b', 'a'])
  })

  it('means none when the key is missing or the list is empty', () => {
    assert.deepEqual(report.parseExcludeFile('{}'), [])
    assert.deepEqual(report.parseExcludeFile('{"exclude-checks": []}'), [])
  })

  it('ignores other keys, so the file can grow', () => {
    assert.deepEqual(report.parseExcludeFile('{"mode": "strict", "exclude-checks": ["a"]}'), ['a'])
  })

  const refused = [
    ['text that is not JSON', 'late_escaping', /^\.plugin-check\.json is not valid JSON: /],
    ['an empty file', '', /^\.plugin-check\.json is not valid JSON: /],
    ['a list at the top', '["a"]', /^\.plugin-check\.json must hold a JSON object, like \{"exclude-checks": \["check_name"\]\}\.$/],
    ['null', 'null', /must hold a JSON object/],
    ['a number', '3', /must hold a JSON object/],
    ['a text instead of a list', '{"exclude-checks": "a,b"}', /^"exclude-checks" in \.plugin-check\.json must be a list of check names, like \["check_name"\]\.$/],
    ['null instead of a list', '{"exclude-checks": null}', /must be a list of check names/],
    ['a number in the list', '{"exclude-checks": [1]}', /has 1, which is not a check name/],
    ['an empty entry', '{"exclude-checks": ["a", ""]}', /has "", which is not a check name/],
    ['a blank entry', '{"exclude-checks": ["  "]}', /has "  ", which is not a check name/],
    ['a space inside an entry', '{"exclude-checks": ["late escaping"]}', /has "late escaping", which is not a check name/],
    ['a comma inside an entry', '{"exclude-checks": ["a,b"]}', /has "a,b", which is not a check name/],
    ['a line break inside an entry', '{"exclude-checks": ["a\\nb"]}', /which is not a check name/],
    ['a nested list', '{"exclude-checks": [["a"]]}', /which is not a check name/],
  ]
  for (const [name, text, message] of refused) {
    it(`fails on ${name}`, () => {
      assert.throws(
        () => report.parseExcludeFile(text),
        (error) => error instanceof report.CheckFailure && error.exitCode === 1 && message.test(error.message)
      )
    })
  }

  it('names the file in the message', () => {
    assert.throws(
      () => report.parseExcludeFile('{', 'checks.json'),
      (error) => error.message.startsWith('checks.json is not valid JSON: ')
    )
  })
})

describe('excludedChecks', () => {
  it('uses the input when it names checks, and does not read the file', () => {
    const result = report.excludedChecks({ input: 'a\nb', fileText: 'this is not JSON' })

    assert.deepEqual(result, { checks: ['a', 'b'], source: 'input' })
  })

  it('uses the file when the input is empty or blank', () => {
    const fileText = '{"exclude-checks": ["from_file"]}'

    assert.deepEqual(report.excludedChecks({ input: '', fileText }), { checks: ['from_file'], source: 'file' })
    assert.deepEqual(report.excludedChecks({ input: ' \n', fileText }), { checks: ['from_file'], source: 'file' })
  })

  it('excludes nothing with neither', () => {
    assert.deepEqual(report.excludedChecks({}), { checks: [], source: 'none' })
    assert.deepEqual(report.excludedChecks({ input: '', fileText: null }), { checks: [], source: 'none' })
  })

  it('says none for a file with an empty list', () => {
    assert.deepEqual(report.excludedChecks({ fileText: '{"exclude-checks": []}' }), { checks: [], source: 'none' })
  })

  it('fails on a bad file when the input is empty', () => {
    assert.throws(() => report.excludedChecks({ input: '', fileText: '{' }), /is not valid JSON/)
  })
})

describe('runExcludeChecks', () => {
  it('outputs the file\'s checks one per line', async (t) => {
    const { core, outputs, logged } = await actionsFor(t)
    const file = configFile('{"exclude-checks": ["late_escaping", "i18n_usage"]}')

    const status = report.runExcludeChecks({ core, env: { EXCLUDE_CHECKS: '', CONFIG_FILE: file } })

    assert.equal(status, 0)
    assert.equal(outputs().checks, 'late_escaping\ni18n_usage')
    assert.match(logged(), /Excluding 2 check\(s\) from the \.plugin-check\.json: late_escaping, i18n_usage/)
  })

  it('lets the input replace the file, and leaves a bad file alone', async (t) => {
    const { core, outputs, logged } = await actionsFor(t)
    const file = configFile('this is not JSON')

    const status = report.runExcludeChecks({ core, env: { EXCLUDE_CHECKS: 'from_input\n', CONFIG_FILE: file } })

    assert.equal(status, 0)
    assert.equal(outputs().checks, 'from_input')
    assert.match(logged(), /from the exclude-checks input: from_input/)
  })

  it('outputs nothing when there is no input and no file', async (t) => {
    const { core, outputs, logged } = await actionsFor(t)

    const status = report.runExcludeChecks({ core, env: { EXCLUDE_CHECKS: '', CONFIG_FILE: path.join(temp(), '.plugin-check.json') } })

    assert.equal(status, 0)
    assert.equal(outputs().checks, '')
    assert.match(logged(), /No checks are excluded\./)
  })

  it('fails the step with the message, as an annotation, when the file is bad', async (t) => {
    const { core, logged } = await actionsFor(t)
    const file = configFile('{"exclude-checks": "late_escaping"}')

    const status = report.runExcludeChecks({ core, env: { EXCLUDE_CHECKS: '', CONFIG_FILE: file } })

    assert.equal(status, 1)
    assert.match(logged(), /::error title=Plugin Check::"exclude-checks" in \.plugin-check\.json must be a list of check names/)
  })

  it('fails the step when the file cannot be read', async (t) => {
    // Root reads a file with no permissions, so there is nothing to fail there.
    if (process.getuid?.() === 0) {
      return t.skip('root can read any file')
    }
    const { core, logged } = await actionsFor(t)
    const file = configFile('{}')
    fs.chmodSync(file, 0)

    const status = report.runExcludeChecks({ core, env: { EXCLUDE_CHECKS: '', CONFIG_FILE: file } })

    fs.chmodSync(file, 0o600)
    assert.equal(status, 1)
    assert.match(logged(), /::error title=Plugin Check::Could not read /)
  })
})

describe('exclude-checks on the command line', () => {
  const run = async (args, env = {}) => {
    const out = []
    const err = []
    const status = await report.main(['exclude-checks', ...args], env, { out: (line) => out.push(line), err: (line) => err.push(line) })

    return { status, out, err }
  }

  it('prints the flag wp plugin check takes', async () => {
    const file = configFile('{"exclude-checks": ["late_escaping", "i18n_usage"]}')

    assert.deepEqual(await run([file]), { status: 0, out: ['--exclude-checks=late_escaping,i18n_usage'], err: [] })
  })

  it('prints nothing when no check is excluded', async () => {
    assert.deepEqual(await run([path.join(temp(), '.plugin-check.json')]), { status: 0, out: [], err: [] })
  })

  it('lets EXCLUDE_CHECKS replace the file, as the workflow input does', async () => {
    const file = configFile('{"exclude-checks": ["from_file"]}')

    assert.deepEqual(await run([file], { EXCLUDE_CHECKS: 'a\nb' }), { status: 0, out: ['--exclude-checks=a,b'], err: [] })
  })

  it('reads .plugin-check.json in the current folder by default', async () => {
    const folder = temp()
    fs.writeFileSync(path.join(folder, '.plugin-check.json'), '{"exclude-checks": ["from_cwd"]}')
    const before = process.cwd()
    process.chdir(folder)
    try {
      assert.deepEqual(await run([]), { status: 0, out: ['--exclude-checks=from_cwd'], err: [] })
    } finally {
      process.chdir(before)
    }
  })

  it('fails with the message on standard error when the file is bad', async () => {
    const file = configFile('{')

    const { status, out, err } = await run([file])

    assert.equal(status, 1)
    assert.deepEqual(out, [])
    assert.match(err[0], new RegExp(`^${file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} is not valid JSON`))
  })

  it('lists the command in the usage line', async () => {
    const err = []

    const status = await report.main(['nope'], {}, { out: () => {}, err: (line) => err.push(line) })

    assert.equal(status, 2)
    assert.match(err[0], /compare\|exclude-checks/)
  })
})
