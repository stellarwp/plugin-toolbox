'use strict'

const { describe, it } = require('node:test')
const assert = require('node:assert')

const { decide, run } = require('../../../.github/actions/changed-files/changes.js')
const { actionsFor } = require('../../support/actions.js')

const DEFAULT_GLOBS = ['*.php', '*phpstan*.neon*', '*composer.json', '*composer.lock']
const CALLER = '.github/workflows/phpstan.yml'

/** A pull request event, with the given overrides. */
function pullRequest(overrides = {}) {
  return {
    eventName: 'pull_request',
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

describe('changed-files', () => {
  describe('decide', () => {
    it('always runs for anything but a pull request', async () => {
      for (const eventName of ['push', 'workflow_dispatch', 'schedule']) {
        assert.equal((await decide(pullRequest({ eventName, listFiles: neverListed }))).changed, true)
      }
    })

    it('runs when no glob is given, without listing files', async () => {
      assert.equal((await decide(pullRequest({ globs: [], listFiles: neverListed }))).changed, true)
    })

    it('runs when the pull request changes 3000 files or more, without listing them', async () => {
      assert.equal((await decide(pullRequest({ changedCount: 3000, listFiles: neverListed }))).changed, true)
      assert.equal((await decide(pullRequest({ changedCount: 2999 }))).changed, false)
    })

    it('runs when one file matches a glob', async () => {
      const result = await decide(pullRequest({ listFiles: async () => ['README.md', 'src/A.php'] }))

      assert.equal(result.changed, true)
      assert.equal(result.reason, 'Matched: src/A.php')
    })

    it('runs when the caller workflow changes', async () => {
      const result = await decide(pullRequest({ listFiles: async () => [CALLER] }))

      assert.equal(result.changed, true)
      assert.match(result.reason, /the workflow itself/)
    })

    it('skips when nothing matches', async () => {
      const result = await decide(pullRequest({ listFiles: async () => ['README.md', 'docs/a.txt'] }))

      assert.equal(result.changed, false)
      assert.match(result.reason, /No matching files/)
    })
  })

  describe('run', () => {
    const env = {
      REPOSITORY: 'stellarwp/plugin-toolbox',
      WORKFLOW_REF: `stellarwp/plugin-toolbox/${CALLER}@refs/pull/1/merge`,
      EVENT_NAME: 'pull_request',
      PR_NUMBER: '7',
      PR_CHANGED_FILES: '2',
      INPUT_CHANGED_FILES: '*.php\n*composer.json',
    }

    /** The files endpoint, answering with the given file objects. */
    const files = (entries) => ({
      method: 'GET',
      path: '/repos/stellarwp/plugin-toolbox/pulls/7/files?per_page=100',
      body: entries.map((entry) => (typeof entry === 'string' ? { filename: entry } : entry)),
    })

    it('lists the files through the API and sets changed=true on a match', async (t) => {
      const { github, core, outputs, requests } = await actionsFor(t, [files(['README.md', 'a.php'])])

      await run({ github, core, env })

      assert.equal(outputs().changed, 'true')
      assert.equal(requests.length, 1)
    })

    it('includes the old name of a renamed file', async (t) => {
      const { github, core, outputs } = await actionsFor(t, [files([{ filename: 'a.txt', previous_filename: 'a.php' }])])

      await run({ github, core, env })

      assert.equal(outputs().changed, 'true')
    })

    it('finds the caller file from workflow_ref', async (t) => {
      const { github, core, outputs } = await actionsFor(t, [files([CALLER])])

      await run({ github, core, env })

      assert.equal(outputs().changed, 'true')
    })

    it('sets changed=false when nothing matches', async (t) => {
      const { github, core, outputs } = await actionsFor(t, [files(['README.md'])])

      await run({ github, core, env })

      assert.equal(outputs().changed, 'false')
    })

    it('does not call the API for a push', async (t) => {
      const { github, core, outputs, requests } = await actionsFor(t)

      await run({ github, core, env: { ...env, EVENT_NAME: 'push' } })

      assert.equal(outputs().changed, 'true')
      assert.equal(requests.length, 0)
    })
  })
})
