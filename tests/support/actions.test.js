'use strict'

const { describe, it } = require('node:test')
const assert = require('node:assert')

const { actionsFor } = require('./actions.js')

describe('tests/support/actions', () => {
  describe('the captured log', () => {
    it('holds what the toolkit wrote during the test', async (t) => {
      const { core, logged } = await actionsFor(t)

      core.warning('a warning')

      assert.match(logged(), /::warning::a warning/)
    })

    it('survives a test that builds two sets of actions', async (t) => {
      /**
       * Replacing the stdout write per call meant the second call captured the already-replaced
       * write as the original. Restoring put that back, so stdout stayed captured after the test and
       * the runner's own output went into a dead buffer: every later test in the file disappeared
       * from the report while the run still passed.
       */
      const first = await actionsFor(t)
      const second = await actionsFor(t)

      second.core.info('from the second')

      // There is one @actions/core for the process, so the newest capture is the one collecting.
      assert.match(second.logged(), /from the second/, 'the newest capture still works')
      assert.equal(first.logged(), '', 'the earlier one stopped when the second began')
    })
  })
})
