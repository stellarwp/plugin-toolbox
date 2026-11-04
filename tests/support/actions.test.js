'use strict'

const { describe, it } = require('node:test')
const assert = require('node:assert')

const { actionsFor, coreWithOutputs, recordingExec, isLogWrite } = require('./actions.js')

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

  describe('isLogWrite', () => {
    it("collects the toolkit's string writes and leaves the runner's Buffers alone", () => {
      // The runner reports results as Buffers over the same stdout. Collecting them swallowed the
      // report of every test that finished while a later one was awaiting.
      assert.equal(isLogWrite('::warning::a warning\n'), true)
      assert.equal(isLogWrite(Buffer.from('report')), false)
      assert.equal(isLogWrite(new Uint8Array([1, 2])), false)
    })
  })

  describe('the job summary', () => {
    it('holds what the toolkit wrote to it during the test', async (t) => {
      const { core, summary } = await coreWithOutputs(t)

      await core.summary.addRaw('a summary line').write()

      assert.match(summary(), /a summary line/)
    })
  })

  describe('recordingExec', () => {
    it('answers from the first matching rule and records every call', async () => {
      const { exec, calls } = recordingExec([
        { command: 'git', args: /^status/, stdout: ' M a.php\n' },
        { command: 'git', stdout: 'any other git call' },
      ])

      const status = await exec.getExecOutput('git', ['status', '--porcelain'])
      const other = await exec.getExecOutput('git', ['rev-parse', 'HEAD'], { cwd: '/repo' })

      assert.deepEqual(status, { exitCode: 0, stdout: ' M a.php\n', stderr: '' })
      assert.equal(other.stdout, 'any other git call')
      assert.deepEqual(calls, [
        { command: 'git', args: ['status', '--porcelain'], options: {} },
        { command: 'git', args: ['rev-parse', 'HEAD'], options: { cwd: '/repo' } },
      ])
    })

    it('fails a non-zero exit the way @actions/exec does, unless the caller ignores it', async () => {
      const { exec } = recordingExec([{ command: 'php', exitCode: 1, stderr: 'boom' }])

      await assert.rejects(exec.getExecOutput('php', ['x']), /The process 'php' failed with exit code 1/)
      await assert.rejects(exec.exec('php', ['x']), /The process 'php' failed with exit code 1/)

      const ignored = await exec.getExecOutput('php', ['x'], { ignoreReturnCode: true })

      assert.deepEqual(ignored, { exitCode: 1, stdout: '', stderr: 'boom' })
    })

    it('answers a call no rule planned for as a missing command, never as a success', async () => {
      const { exec } = recordingExec([])

      const result = await exec.getExecOutput('curl', ['-fsSL'], { ignoreReturnCode: true })

      assert.equal(result.exitCode, 127)
    })

    it('runs a rule effect, so a test can stand in for what the command writes', async () => {
      const written = []
      const { exec } = recordingExec([
        { command: 'php', effect: (args, options) => written.push([args[0], options.cwd]) },
      ])

      await exec.exec('php', ['pup.phar'], { cwd: '/repo' })

      assert.deepEqual(written, [['pup.phar', '/repo']])
    })
  })
})
