'use strict'

const { describe, it } = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const RATCHET = path.join(__dirname, '../../../.github/actions/plugin-check-report/ratchet.sh')
const FIXTURES = path.join(__dirname, 'fixtures')
const BASELINE = path.join(FIXTURES, 'baseline.json')

const ESCAPE = 'WordPress.Security.EscapeOutput.OutputNotEscaped'
const DIRECT_QUERY = 'WordPress.DB.DirectDatabaseQuery.DirectQuery'

/**
 * Runs ratchet.sh the way the action does, and returns what it printed and wrote.
 *
 * The environment is built from scratch rather than copied from process.env. In CI the test runner
 * has GITHUB_STEP_SUMMARY, GITHUB_RUN_ID and friends set, and the script would append its summary
 * to this repository's own job and link to this run. Only PATH and HOME are kept, so bash and jq
 * are found. The script's `::error::` lines go to the captured stdout, never to the runner's log,
 * so a passing test run does not annotate its own workflow.
 *
 * @param {string[]} args Arguments after the script, usually a results file.
 * @param {object}   env  Extra environment, such as PLUGIN_CHECK_BASELINE.
 *
 * @returns {{status: number, stdout: string, stderr: string, comment: string, summary: string}}
 *          The exit status, both streams, the comment file and the job summary it wrote.
 */
function ratchet(args, env = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-check-ratchet-'))
  const comment = path.join(dir, 'comment.md')
  const summary = path.join(dir, 'summary.md')

  const result = spawnSync('bash', [RATCHET, '--comment-file', comment, ...args], {
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      GITHUB_STEP_SUMMARY: summary,
      // A path that does not exist, so a test that wants no baseline gets none, instead of a
      // baseline.json some earlier local run left next to the script.
      PLUGIN_CHECK_BASELINE: path.join(dir, 'no-baseline.json'),
      ...env,
    },
  })

  const read = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '')

  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    comment: read(comment),
    summary: read(summary),
  }
}

/**
 * The path of one of the sample results files.
 *
 * @param {string} name File name under fixtures/.
 *
 * @returns {string} The absolute path.
 */
function fixture(name) {
  return path.join(FIXTURES, name)
}

/**
 * A results file with one new ERROR code per entry, for the tests about long lists.
 *
 * @param {number} codes How many different codes to write.
 *
 * @returns {string} The path of the file.
 */
function resultsWithNewCodes(codes) {
  const results = Array.from({ length: codes }, (_, index) => ({
    line: index + 1,
    column: 1,
    type: 'ERROR',
    code: `Test.Rule.Number${index + 1}`,
    message: 'A rule added for the test.',
    docs: '',
  }))
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-check-results-')), 'results.txt')
  fs.writeFileSync(file, `FILE: plugin.php\n${JSON.stringify(results)}\n`)

  return file
}

describe('ratchet.sh', () => {
  describe('results it refuses', () => {
    it('fails when the results file is missing', () => {
      const run = ratchet([fixture('does-not-exist.txt')])

      assert.equal(run.status, 1)
      assert.match(run.stdout, /::error title=Plugin Check::Results file not found/)
      assert.equal(run.comment, '', 'no comment body, so the workflow writes "could not run"')
    })

    it('fails when the results file is not Plugin Check output', () => {
      const run = ratchet([fixture('garbage.txt')])

      assert.equal(run.status, 1)
      assert.match(run.stdout, /is not Plugin Check output.*First unexpected line: <!DOCTYPE html>/)
    })

    it('fails when the results file is empty', () => {
      const run = ratchet([fixture('empty.txt')])

      assert.equal(run.status, 1)
      assert.match(run.stdout, /has no Plugin Check output/)
    })

    it('fails on a mode it does not know, before reading anything', () => {
      const run = ratchet([fixture('clean.txt')], { PLUGIN_CHECK_MODE: 'strcit' })

      assert.equal(run.status, 1)
      assert.match(run.stdout, /Unknown mode 'strcit'/)
    })
  })

  describe('--update', () => {
    it('writes the counts per rule code', () => {
      const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-check-update-')), 'baseline.json')
      const run = ratchet(['--update', fixture('errors-up.txt')], { PLUGIN_CHECK_BASELINE: out })

      assert.equal(run.status, 0)
      assert.deepEqual(JSON.parse(fs.readFileSync(out, 'utf8')), {
        errors: {
          [ESCAPE]: 3,
          'WordPress.WP.AlternativeFunctions.file_get_contents_file_get_contents': 1,
        },
        warnings: { [DIRECT_QUERY]: 1 },
      })
    })

    it('writes empty counts for a clean run', () => {
      const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-check-update-')), 'baseline.json')
      const run = ratchet(['--update', fixture('clean.txt')], { PLUGIN_CHECK_BASELINE: out })

      assert.equal(run.status, 0)
      assert.deepEqual(JSON.parse(fs.readFileSync(out, 'utf8')), { errors: {}, warnings: {} })
    })
  })

  describe('compare in ratchet mode', () => {
    it('passes a clean run with no baseline, with a warning and the one-column table', () => {
      const run = ratchet([fixture('clean.txt')])

      assert.equal(run.status, 0)
      assert.match(run.stdout, /::warning title=Plugin Check::No baseline to compare with/)
      assert.match(run.comment, /⚠️ Plugin Check ran, but there was no baseline to compare with/)
      assert.match(run.comment, /\| Errors {3}\| 0 \|/)
      assert.doesNotMatch(run.comment, /Change/)
    })

    it('passes when every count matches the baseline', () => {
      const run = ratchet([fixture('same-as-baseline.txt')], { PLUGIN_CHECK_BASELINE: BASELINE })

      assert.equal(run.status, 0)
      assert.match(run.comment, /✅ Plugin Check passed/)
      assert.match(run.comment, /\| Errors {3}\| 3 \| 3 \| ±0 \|/)
    })

    it('fails when a rule has more errors than the baseline', () => {
      const run = ratchet([fixture('errors-up.txt')], { PLUGIN_CHECK_BASELINE: BASELINE })

      assert.equal(run.status, 1)
      assert.match(run.stdout, new RegExp(`::error title=Plugin Check::${ESCAPE} has 3 errors, the baseline has 2`))
      assert.match(run.comment, /❌ Plugin Check failed: 1 rule has more errors than the baseline allows/)
      assert.match(run.comment, new RegExp(`Went up: \`${ESCAPE}\` \\(\\+1\\)`))
    })

    it('fails when a rule goes up even though the total stays the same', () => {
      const run = ratchet([fixture('rule-up-total-same.txt')], { PLUGIN_CHECK_BASELINE: BASELINE })

      assert.equal(run.status, 1)
      assert.match(run.comment, /\| Errors {3}\| 3 \| 3 \| ±0 \|/)
      assert.match(run.comment, /Rules that went down: 1\./)
    })

    it('passes with a notice when errors go down', () => {
      const run = ratchet([fixture('errors-down.txt')], { PLUGIN_CHECK_BASELINE: BASELINE })

      assert.equal(run.status, 0)
      assert.match(run.stdout, new RegExp(`::notice title=Plugin Check::${ESCAPE} \\(errors\\) went down from 2 to 1`))
      assert.match(run.comment, /\| Errors {3}\| 2 \| 3 \| -1 \|/)
    })

    it('passes with a notice when only warnings go up', () => {
      const run = ratchet([fixture('warnings-up.txt')], { PLUGIN_CHECK_BASELINE: BASELINE })

      assert.equal(run.status, 0)
      assert.match(run.stdout, /Warnings do not fail the check/)
      assert.match(run.comment, new RegExp(`Went up: \`${DIRECT_QUERY}\` warning \\(\\+2\\)`))
    })

    it('only warns when the baseline is from an older run of the target branch', () => {
      const run = ratchet([fixture('errors-up.txt')], {
        PLUGIN_CHECK_BASELINE: BASELINE,
        PLUGIN_CHECK_ADVISORY: 'true',
      })

      assert.equal(run.status, 0)
      assert.match(run.stdout, /::warning title=Plugin Check::.*Not enforced/)
      assert.match(run.comment, /⚠️ Plugin Check passed, not enforced/)
    })
  })

  describe('compare in strict mode', () => {
    it('fails on any error, even with no baseline', () => {
      const run = ratchet([fixture('errors-down.txt')], { PLUGIN_CHECK_MODE: 'strict' })

      assert.equal(run.status, 1)
      assert.match(run.stdout, /2 errors found\. Strict mode fails on any error/)
      assert.match(run.comment, /❌ Plugin Check failed: 2 errors, and strict mode allows none/)
    })

    it('fails on errors that went down, which ratchet mode would pass', () => {
      const run = ratchet([fixture('errors-down.txt')], {
        PLUGIN_CHECK_MODE: 'strict',
        PLUGIN_CHECK_BASELINE: BASELINE,
      })

      assert.equal(run.status, 1)
    })

    it('passes a clean run', () => {
      const run = ratchet([fixture('clean.txt')], { PLUGIN_CHECK_MODE: 'strict' })

      assert.equal(run.status, 0)
      assert.match(run.comment, /✅ Plugin Check passed: no errors/)
    })

    it('passes a run with warnings only', () => {
      const results = fixture('warnings-up.txt')
      const onlyWarnings = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-check-warn-')), 'results.txt')
      // The warnings-up sample without its ERROR results.
      const lines = fs.readFileSync(results, 'utf8').split('\n').map((line) => {
        if (!line.startsWith('[')) {
          return line
        }
        const kept = JSON.parse(line).filter((result) => result.type === 'WARNING')
        return JSON.stringify(kept)
      })
      fs.writeFileSync(onlyWarnings, lines.join('\n'))

      const run = ratchet([onlyWarnings], { PLUGIN_CHECK_MODE: 'strict' })

      assert.equal(run.status, 0)
    })
  })

  describe('the comment', () => {
    it('starts with the default marker', () => {
      const run = ratchet([fixture('clean.txt')])

      assert.equal(run.comment.split('\n')[0], '<!-- plugin-check -->')
    })

    it('starts with the marker the workflow passes', () => {
      const marker = '<!-- plugin-check:example-org/my-plugin -->'
      const run = ratchet([fixture('clean.txt')], { COMMENT_MARKER: marker })

      assert.equal(run.comment.split('\n')[0], marker)
    })

    it('names the baseline column after where it came from, with a link', () => {
      const run = ratchet([fixture('same-as-baseline.txt')], {
        PLUGIN_CHECK_BASELINE: BASELINE,
        BASELINE_LABEL: 'Target branch',
        BASELINE_URL: 'https://github.com/o/r/actions/runs/1',
      })

      assert.match(run.comment, /\| Now \| \[Target branch\]\(https:\/\/github\.com\/o\/r\/actions\/runs\/1\) \| Change \|/)
    })

    it('lists at most five rules and never grows past fifteen lines', () => {
      const run = ratchet([resultsWithNewCodes(7)], { PLUGIN_CHECK_BASELINE: BASELINE })

      assert.equal(run.status, 1)
      assert.match(run.comment, /Went up \(top 5 of 7\)/)
      assert.doesNotMatch(run.comment, /Number6/)
      assert.ok(run.comment.trimEnd().split('\n').length <= 15)
    })

    it('writes the same text to the job summary', () => {
      const run = ratchet([fixture('errors-down.txt')], { PLUGIN_CHECK_BASELINE: BASELINE })

      assert.equal(run.summary, run.comment)
    })
  })
})
