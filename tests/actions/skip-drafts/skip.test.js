'use strict'

const { describe, it } = require('node:test')
const assert = require('node:assert')

const { decide, run } = require('../../../.github/actions/skip-drafts/skip.js')
const { coreWithOutputs } = require('../../support/actions.js')

/** A draft pull request from `release/1.2` that lists `release/`, with the given overrides. */
function draft(overrides = {}) {
  return { eventName: 'pull_request', draft: true, headRef: 'release/1.2', prefixes: ['release/'], ...overrides }
}

describe('skip-drafts', () => {
  describe('decide', () => {
    it('skips a draft whose branch starts with a listed prefix', () => {
      const result = decide(draft())

      assert.equal(result.skip, true)
      assert.match(result.reason, /Draft pulls from release\/\*/)
    })

    it('uses the first prefix that fits', () => {
      assert.match(decide(draft({ prefixes: ['bucket/', 'rel', 'release/'] })).reason, /from rel\*/)
    })

    it('does not skip a draft from any other branch', () => {
      assert.equal(decide(draft({ headRef: 'feat/thing' })).skip, false)
    })

    it('does not skip a pull request that is ready, even from a listed branch', () => {
      assert.equal(decide(draft({ draft: false })).skip, false)
    })

    it('does not skip anything when no prefix is given', () => {
      assert.equal(decide(draft({ prefixes: [] })).skip, false)
    })

    it('never skips an event that is not a pull request', () => {
      for (const eventName of ['push', 'workflow_dispatch', 'schedule']) {
        assert.equal(decide(draft({ eventName })).skip, false)
      }
    })

    it('matches the start of the branch, not any part of it', () => {
      assert.equal(decide(draft({ headRef: 'hotfix/release/1' })).skip, false)
    })
  })

  describe('run', () => {
    const env = { EVENT_NAME: 'pull_request', DRAFT: 'true', HEAD_REF: 'bucket/x', INPUT_PREFIXES: 'release/\nbucket/' }

    it('sets skip=true for a listed draft', async (t) => {
      const { core, outputs } = await coreWithOutputs(t)

      run({ core, env })

      assert.equal(outputs().skip, 'true')
    })

    it('sets skip=false for a push, which has no draft state', async (t) => {
      const { core, outputs } = await coreWithOutputs(t)

      run({ core, env: { ...env, EVENT_NAME: 'push', DRAFT: '' } })

      assert.equal(outputs().skip, 'false')
    })
  })
})
