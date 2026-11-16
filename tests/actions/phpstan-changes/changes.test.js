'use strict'

const { describe, it } = require('node:test')
const assert = require('node:assert')

const { decide, globToRegExp, run, words } = require('../../../.github/actions/phpstan-changes/changes.js')
const { actionsFor } = require('../../support/actions.js')

const DEFAULT_GLOBS = ['*.php', '*phpstan*.neon*', '*composer.json', '*composer.lock']
const CALLER = '.github/workflows/phpstan.yml'

/** A pull request event, with the given overrides. */
function pullRequest(overrides = {}) {
  return {
    eventName: 'pull_request',
    draft: false,
    headRef: 'feat/thing',
    skipDraftPrefixes: [],
    globs: DEFAULT_GLOBS,
    changedCount: 1,
    caller: CALLER,
    listFiles: async () => ['README.md'],
    ...overrides,
  }
}

/** A file lister that fails the test when it is called. */
async function neverListed() {
  throw new Error('The files were listed.')
}

describe('phpstan-changes', () => {
  describe('globToRegExp', () => {
    it('lets * cross directories, like the workflow always did', () => {
      assert.ok(globToRegExp('*.php').test('src/Deep/File.php'))
      assert.ok(!globToRegExp('*.php').test('src/File.phps'))
    })

    it('matches the whole path', () => {
      assert.ok(!globToRegExp('composer.json').test('vendor/composer.json'))
      assert.ok(globToRegExp('*composer.json').test('vendor/composer.json'))
    })

    it('reads ? as one character and [..] as a set', () => {
      assert.ok(globToRegExp('file?.php').test('file1.php'))
      assert.ok(!globToRegExp('file?.php').test('file12.php'))
      assert.ok(globToRegExp('file[12].php').test('file2.php'))
      assert.ok(!globToRegExp('file[!12].php').test('file2.php'))
    })

    it('treats regex characters as plain text', () => {
      assert.ok(globToRegExp('a+b(1).php').test('a+b(1).php'))
      assert.ok(!globToRegExp('a.php').test('aXphp'))
    })
  })

  describe('decide', () => {
    it('always runs for anything but a pull request', async () => {
      for (const eventName of ['push', 'workflow_dispatch', 'schedule']) {
        assert.equal((await decide(pullRequest({ eventName, listFiles: neverListed }))).run, true)
      }
    })

    it('skips a draft whose branch starts with a listed prefix', async () => {
      const result = await decide(pullRequest({ draft: true, headRef: 'release/1.2', skipDraftPrefixes: ['release/'] }))

      assert.equal(result.run, false)
      assert.match(result.reason, /Draft pulls from release\/\*/)
    })

    it('runs a draft from any other branch, and a ready pull from a listed one', async () => {
      const listFiles = async () => ['a.php']

      assert.equal((await decide(pullRequest({ draft: true, skipDraftPrefixes: ['release/'], listFiles }))).run, true)
      assert.equal((await decide(pullRequest({ headRef: 'release/1', skipDraftPrefixes: ['release/'], listFiles }))).run, true)
    })

    it('runs when no glob is given, without listing files', async () => {
      assert.equal((await decide(pullRequest({ globs: [], listFiles: neverListed }))).run, true)
    })

    it('runs when the pull request changes 3000 files or more, without listing them', async () => {
      assert.equal((await decide(pullRequest({ changedCount: 3000, listFiles: neverListed }))).run, true)
      assert.equal((await decide(pullRequest({ changedCount: 2999 }))).run, false)
    })

    it('runs when one file matches a glob', async () => {
      const result = await decide(pullRequest({ listFiles: async () => ['README.md', 'src/A.php'] }))

      assert.equal(result.run, true)
      assert.equal(result.reason, 'Matched: src/A.php')
    })

    it('runs when the caller workflow changes', async () => {
      const result = await decide(pullRequest({ listFiles: async () => [CALLER] }))

      assert.equal(result.run, true)
      assert.match(result.reason, /the workflow itself/)
    })

    it('skips when nothing matches', async () => {
      const result = await decide(pullRequest({ listFiles: async () => ['README.md', 'docs/a.txt'] }))

      assert.equal(result.run, false)
      assert.match(result.reason, /No matching files/)
    })
  })

  describe('run', () => {
    const env = {
      REPOSITORY: 'stellarwp/plugin-toolbox',
      WORKFLOW_REF: `stellarwp/plugin-toolbox/${CALLER}@refs/pull/1/merge`,
      EVENT_NAME: 'pull_request',
      DRAFT: 'false',
      HEAD_REF: 'feat/thing',
      PR_NUMBER: '7',
      PR_CHANGED_FILES: '2',
      INPUT_SKIP_DRAFT_PREFIXES: '',
      INPUT_CHANGED_FILES: '*.php\n*composer.json',
    }

    /** The files endpoint, answering with the given file objects. */
    const files = (entries) => ({
      method: 'GET',
      path: '/repos/stellarwp/plugin-toolbox/pulls/7/files?per_page=100',
      body: entries.map((entry) => (typeof entry === 'string' ? { filename: entry } : entry)),
    })

    it('lists the files through the API and sets run=true on a match', async (t) => {
      const { github, core, outputs, requests } = await actionsFor(t, [files(['README.md', 'a.php'])])

      await run({ github, core, env })

      assert.equal(outputs().run, 'true')
      assert.equal(requests.length, 1)
    })

    it('includes the old name of a renamed file', async (t) => {
      const { github, core, outputs } = await actionsFor(t, [files([{ filename: 'a.txt', previous_filename: 'a.php' }])])

      await run({ github, core, env })

      assert.equal(outputs().run, 'true')
    })

    it('finds the caller file from workflow_ref', async (t) => {
      const { github, core, outputs } = await actionsFor(t, [files([CALLER])])

      await run({ github, core, env })

      assert.equal(outputs().run, 'true')
    })

    it('sets run=false when nothing matches', async (t) => {
      const { github, core, outputs } = await actionsFor(t, [files(['README.md'])])

      await run({ github, core, env })

      assert.equal(outputs().run, 'false')
    })

    it('does not call the API for a push', async (t) => {
      const { github, core, outputs, requests } = await actionsFor(t)

      await run({ github, core, env: { ...env, EVENT_NAME: 'push' } })

      assert.equal(outputs().run, 'true')
      assert.equal(requests.length, 0)
    })
  })

  describe('words', () => {
    it('splits on any whitespace and drops empties', () => {
      assert.deepEqual(words('a\n b\t\nc \n'), ['a', 'b', 'c'])
      assert.deepEqual(words(undefined), [])
    })
  })
})
