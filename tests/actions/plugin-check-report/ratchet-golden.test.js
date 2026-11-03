'use strict'

const { describe, it } = require('node:test')
const assert = require('node:assert')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const { CASES, expectedFor, runCase, writeExpected } = require('./golden.js')

const RATCHET = path.join(__dirname, '../../../.github/actions/plugin-check-report/ratchet.sh')

/**
 * Runs ratchet.sh with a built environment, like ratchet.test.js does: only PATH and HOME are kept,
 * so the runner's own GITHUB_* variables never reach the script.
 *
 * @param {string[]} args Arguments after the script.
 * @param {object}   env  The environment to add.
 *
 * @returns {{status: number, stdout: string}} The exit status and what the script printed.
 */
function execute(args, env) {
  const result = spawnSync('bash', [RATCHET, ...args], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env },
  })

  return { status: result.status, stdout: result.stdout }
}

// UPDATE_GOLDEN=1 rewrites fixtures/expected/ from this script. The files are the specification the
// JavaScript has to match, so rewrite them only from the original script, and read the diff.
if (process.env.UPDATE_GOLDEN === '1') {
  writeExpected(CASES.map((spec) => ({ name: spec.name, result: runCase(spec, execute) })))
}

describe('ratchet.sh, pinned output', () => {
  for (const spec of CASES) {
    it(`prints the pinned output for ${spec.name}`, () => {
      assert.deepStrictEqual(runCase(spec, execute), expectedFor(spec.name))
    })
  }
})
