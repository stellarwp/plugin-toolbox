'use strict'

const { describe, it } = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const report = require('../../../.github/actions/plugin-check-report/plugin-check-report.js')
const { actionsFor } = require('../../support/actions.js')

const FIXTURES = path.join(__dirname, 'fixtures')
const REPO = 'example-org/my-plugin'

const temp = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), `plugin-check-${prefix}-`))

describe('plugin-check-report action steps', () => {
  describe('runPaths', () => {
    it('makes a clean folder for the run', async (t) => {
      const { core, outputs } = await actionsFor(t)
      const tempDir = temp('paths')
      fs.mkdirSync(path.join(tempDir, 'plugin-check-report', 'report'), { recursive: true })
      fs.writeFileSync(path.join(tempDir, 'plugin-check-report', 'report', 'old.txt'), 'from an earlier use')

      const status = report.runPaths({
        core,
        env: {
          RUNNER_TEMP: tempDir,
          GITHUB_REPOSITORY: REPO,
        },
      })

      assert.equal(status, 0)
      assert.deepEqual(outputs(), {
        report: path.join(tempDir, 'plugin-check-report', 'report'),
        marker: `<!-- plugin-check:${REPO} -->`,
      })
      assert.deepEqual(fs.readdirSync(path.join(tempDir, 'plugin-check-report', 'report')), [])
    })

    it('uses the marker the caller gives', async (t) => {
      const { core, outputs } = await actionsFor(t)

      report.runPaths({
        core,
        env: { RUNNER_TEMP: temp('marker'), GITHUB_REPOSITORY: REPO, INPUT_COMMENT_MARKER: '<!-- mine -->' },
      })

      assert.equal(outputs().marker, '<!-- mine -->')
    })
  })

  describe('runUpdate', () => {
    it('writes the baseline of this run next to a copy of the results', async (t) => {
      const { core, logged } = await actionsFor(t)
      const reportDir = temp('report')

      const status = report.runUpdate({
        core,
        env: { RESULTS: path.join(FIXTURES, 'errors-up.txt'), REPORT_DIR: reportDir },
      })

      assert.equal(status, 0)
      assert.ok(fs.existsSync(path.join(reportDir, 'errors-up.txt')))
      assert.deepEqual(JSON.parse(fs.readFileSync(path.join(reportDir, 'baseline.json'), 'utf8')).warnings, {
        'WordPress.DB.DirectDatabaseQuery.DirectQuery': 1,
      })
      assert.match(logged(), /Wrote .*baseline\.json: 2 error codes, 1 warning codes/)
    })

    it('does nothing when there is no results file', async (t) => {
      const { core } = await actionsFor(t)
      const reportDir = temp('report')

      assert.equal(report.runUpdate({ core, env: { RESULTS: '/nonexistent/results.txt', REPORT_DIR: reportDir } }), 0)
      assert.deepEqual(fs.readdirSync(reportDir), [])
    })

    it('fails on a results file that is not Plugin Check output, as the compare does', async (t) => {
      const { core, logged } = await actionsFor(t)

      const status = report.runUpdate({
        core,
        env: { RESULTS: path.join(FIXTURES, 'garbage.txt'), REPORT_DIR: temp('report') },
      })

      assert.equal(status, 1)
      assert.match(logged(), /::error title=Plugin Check::The results file is not Plugin Check output/)
    })
  })

  describe('runCompare', () => {
    const base = () => ({
      RESULTS: path.join(FIXTURES, 'errors-up.txt'),
      PLUGIN_CHECK_BASELINE: path.join(FIXTURES, 'baseline.json'),
      RUN_URL: 'https://example.test/run/1',
    })

    it('fails the step with the annotation, the comment and the same text in the job summary', async (t) => {
      const { core, logged, summary } = await actionsFor(t)
      const commentFile = path.join(temp('compare'), 'comment.md')

      const status = report.runCompare({ core, env: { ...base(), COMMENT_FILE: commentFile, GITHUB_STEP_SUMMARY: process.env.GITHUB_STEP_SUMMARY } })

      assert.equal(status, 1)
      assert.match(logged(), /::error title=Plugin Check::WordPress\.Security\.EscapeOutput\.OutputNotEscaped has 3 errors, the baseline has 2\./)
      assert.match(logged(), /Plugin Check found more errors than the baseline allows\./)
      const comment = fs.readFileSync(commentFile, 'utf8')
      assert.match(comment, /❌ Plugin Check failed: 1 rule has more errors than the baseline allows/)
      assert.ok(summary().startsWith(comment), 'the summary is the comment, and then how to update the baseline')
    })

    it('passes, and writes no comment file when none is asked for', async (t) => {
      const { core, logged } = await actionsFor(t)

      const status = report.runCompare({ core, env: { ...base(), RESULTS: path.join(FIXTURES, 'same-as-baseline.txt'), COMMENT_FILE: '' } })

      assert.equal(status, 0)
      assert.match(logged(), /Plugin Check error counts are within the baseline\./)
    })

    it('fails when the results file is missing, with no comment', async (t) => {
      const { core, logged } = await actionsFor(t)
      const commentFile = path.join(temp('compare'), 'comment.md')

      const status = report.runCompare({ core, env: { ...base(), RESULTS: '/nonexistent/results.txt', COMMENT_FILE: commentFile } })

      assert.equal(status, 1)
      assert.match(logged(), /::error title=Plugin Check::Results file not found: \/nonexistent\/results\.txt/)
      assert.equal(fs.existsSync(commentFile), false)
    })

    it('refuses the old mode name ratchet with a hint', async (t) => {
      const { core, logged } = await actionsFor(t)

      const status = report.runCompare({ core, env: { ...base(), PLUGIN_CHECK_MODE: 'ratchet' } })

      assert.equal(status, 1)
      assert.match(logged(), /::error title=Plugin Check::Unknown mode 'ratchet'\. Use 'baseline' or 'strict'\. 'ratchet' is now called 'baseline'\./)
    })

    it('escapes a percent sign in a message, as the runner reads annotations', async (t) => {
      const { core, logged } = await actionsFor(t)
      const results = path.join(temp('compare'), 'results.txt')
      fs.writeFileSync(results, 'FILE: a.php\n[{"type":"ERROR","code":"100%done"}]\n')

      report.runCompare({ core, env: { ...base(), RESULTS: results, PLUGIN_CHECK_BASELINE: '/nonexistent/baseline.json' } })

      assert.match(logged(), /::warning title=Plugin Check::No baseline file at baseline\.json, so nothing was compared\./)
      const failing = report.runCompare({ core, env: { ...base(), RESULTS: results, PLUGIN_CHECK_BASELINE: path.join(FIXTURES, 'baseline.json') } })
      assert.equal(failing, 1)
      assert.match(logged(), /::error title=Plugin Check::100%25done has 1 errors/)
    })
  })
})
