'use strict'

const { describe, it } = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const report = require('../../../.github/actions/plugin-check-report/plugin-check-report.js')
const { actionsFor, recordingExec } = require('../../support/actions.js')

const FIXTURES = path.join(__dirname, 'fixtures')
const REPO = 'example-org/my-plugin'
const SHA = 'a'.repeat(40)

const temp = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), `plugin-check-${prefix}-`))

const RUNS = `/repos/${REPO}/actions/workflows/plugin-check.yml/runs`
const run = (id, sha, headRepo = REPO) => ({
  id,
  html_url: `https://github.com/${REPO}/actions/runs/${id}`,
  head_sha: sha,
  status: 'completed',
  head_repository: { full_name: headRepo },
})

/**
 * Exec rules for a baseline that downloads.
 *
 * @param {number} id       The run.
 * @param {string} baseline What its baseline.json holds.
 *
 * @returns {object[]} The rule.
 */
function downloads(id, baseline = '{"errors":{"Some.Rule":2},"warnings":{}}') {
  return [
    {
      command: 'gh',
      args: new RegExp(`^run download ${id} `),
      effect: (args) => {
        const target = args[args.indexOf('--dir') + 1]
        fs.mkdirSync(target, { recursive: true })
        fs.writeFileSync(path.join(target, 'baseline.json'), baseline)
      },
    },
  ]
}

const ARTIFACT = { body: { artifacts: [{ name: 'plugin-check-report', expired: false }] } }

describe('plugin-check-report action steps', () => {
  describe('runPaths', () => {
    it('makes a clean folder for the run and names the workflow of the caller', async (t) => {
      const { core, outputs, logged } = await actionsFor(t)
      const tempDir = temp('paths')
      fs.mkdirSync(path.join(tempDir, 'plugin-check-report', 'report'), { recursive: true })
      fs.writeFileSync(path.join(tempDir, 'plugin-check-report', 'report', 'old.txt'), 'from an earlier use')

      const status = report.runPaths({
        core,
        env: {
          RUNNER_TEMP: tempDir,
          GITHUB_REPOSITORY: REPO,
          GITHUB_WORKFLOW_REF: `${REPO}/.github/workflows/plugin-check.yml@refs/pull/12/merge`,
        },
      })

      assert.equal(status, 0)
      assert.deepEqual(outputs(), {
        report: path.join(tempDir, 'plugin-check-report', 'report'),
        baseline: path.join(tempDir, 'plugin-check-report', 'baseline', 'baseline.json'),
        workflow: 'plugin-check.yml',
        marker: `<!-- plugin-check:${REPO} -->`,
      })
      assert.deepEqual(fs.readdirSync(path.join(tempDir, 'plugin-check-report', 'report')), [])
      assert.match(logged(), /Baselines are read from the runs of plugin-check\.yml\./)
    })

    it('uses the marker the caller gives', async (t) => {
      const { core, outputs } = await actionsFor(t)

      report.runPaths({
        core,
        env: { RUNNER_TEMP: temp('marker'), GITHUB_REPOSITORY: REPO, GITHUB_WORKFLOW_REF: 'a/b/.github/workflows/x.yml@r', INPUT_COMMENT_MARKER: '<!-- mine -->' },
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

  describe('runFetch', () => {
    it('takes the run for the base commit of a pull request and labels it', async (t) => {
      const baseline = path.join(temp('fetch'), 'baseline.json')
      const { github, core, outputs, logged } = await actionsFor(t, [
        { path: `${RUNS}?head_sha=${SHA}&per_page=20`, body: { workflow_runs: [run(200, SHA)] } },
        { path: `${RUNS}?status=completed&head_sha=${SHA}&per_page=10`, body: { workflow_runs: [run(200, SHA)] } },
        { path: `${RUNS}?status=completed&branch=develop&per_page=100`, body: { workflow_runs: [] } },
        { path: `/repos/${REPO}/actions/runs/200/artifacts?name=plugin-check-report`, ...ARTIFACT },
      ])
      const { exec } = recordingExec(downloads(200))

      const status = await report.runFetch({
        github,
        core,
        exec,
        env: { GITHUB_REPOSITORY: REPO, EVENT: 'pull_request', BASE_REF: 'develop', BASE_SHA: SHA, WAIT: '1200', WORKFLOW: 'plugin-check.yml', BASELINE: baseline },
        now: () => 1000,
        sleep: async () => {},
      })

      assert.equal(status, 0)
      assert.deepEqual(outputs(), {
        label: 'Target branch',
        url: `https://github.com/${REPO}/actions/runs/200`,
        advisory: 'false',
      })
      assert.match(logged(), /Baseline from https:\/\/github\.com\/example-org\/my-plugin\/actions\/runs\/200 \(exact\)/)
      assert.ok(fs.existsSync(baseline))
    })

    it('marks a baseline from an older run as advisory', async (t) => {
      const { github, core, outputs } = await actionsFor(t, [
        { path: `${RUNS}?head_sha=${SHA}&per_page=20`, body: { workflow_runs: [] } },
        { path: `${RUNS}?status=completed&head_sha=${SHA}&per_page=10`, body: { workflow_runs: [] } },
        { path: `${RUNS}?status=completed&branch=develop&per_page=100`, body: { workflow_runs: [run(150, 'b'.repeat(40))] } },
        { path: `/repos/${REPO}/actions/runs/150/artifacts?name=plugin-check-report`, ...ARTIFACT },
      ])
      const { exec } = recordingExec(downloads(150))

      await report.runFetch({
        github,
        core,
        exec,
        env: { GITHUB_REPOSITORY: REPO, EVENT: 'pull_request', BASE_REF: 'develop', BASE_SHA: SHA, WAIT: '0', WORKFLOW: 'plugin-check.yml', BASELINE: path.join(temp('fetch'), 'baseline.json') },
      })

      assert.deepEqual({ label: outputs().label, advisory: outputs().advisory }, { label: 'Target branch, older run', advisory: 'true' })
    })

    it('takes the run before this one on the same branch for a push', async (t) => {
      const { github, core, outputs } = await actionsFor(t, [
        { path: `${RUNS}?status=completed&branch=develop&per_page=100`, body: { workflow_runs: [run(300, SHA), run(150, SHA)] } },
        { path: `/repos/${REPO}/actions/runs/150/artifacts?name=plugin-check-report`, ...ARTIFACT },
      ])
      const { exec } = recordingExec(downloads(150))

      const status = await report.runFetch({
        github,
        core,
        exec,
        env: { GITHUB_REPOSITORY: REPO, EVENT: 'push', GITHUB_RUN_ID: '200', GITHUB_REF_NAME: 'develop', WORKFLOW: 'plugin-check.yml', BASELINE: path.join(temp('fetch'), 'baseline.json') },
      })

      assert.equal(status, 0)
      assert.equal(outputs().label, 'Previous run')
      assert.match(outputs().url, /runs\/150$/)
    })

    it('passes with a message, and no outputs, when no run has a baseline', async (t) => {
      const { github, core, outputs, logged } = await actionsFor(t, [
        { path: `${RUNS}?status=completed&branch=develop&per_page=100`, body: { workflow_runs: [] } },
      ])
      const { exec } = recordingExec()

      const status = await report.runFetch({
        github,
        core,
        exec,
        env: { GITHUB_REPOSITORY: REPO, EVENT: 'push', GITHUB_RUN_ID: '200', GITHUB_REF_NAME: 'develop', WORKFLOW: 'plugin-check.yml', BASELINE: path.join(temp('fetch'), 'baseline.json') },
      })

      assert.equal(status, 0)
      assert.deepEqual(outputs(), {})
      assert.match(logged(), /No earlier run has a baseline\./)
    })

    it('fails with exit status 2 when the lookup fails, so an outage never passes as no baseline', async (t) => {
      const { github, core, logged } = await actionsFor(t, [])
      const { exec } = recordingExec()

      const status = await report.runFetch({
        github,
        core,
        exec,
        env: { GITHUB_REPOSITORY: REPO, EVENT: 'push', GITHUB_RUN_ID: '200', GITHUB_REF_NAME: 'develop', WORKFLOW: 'plugin-check.yml', BASELINE: path.join(temp('fetch'), 'baseline.json') },
      })

      assert.equal(status, 2)
      assert.match(logged(), /Could not look up Plugin Check runs: runs on develop/)
    })

    it('fails with exit status 2 when the workflow file is unknown', async (t) => {
      const { github, core } = await actionsFor(t, [])
      const { exec } = recordingExec()

      const status = await report.runFetch({
        github,
        core,
        exec,
        env: { GITHUB_REPOSITORY: REPO, EVENT: 'push', GITHUB_RUN_ID: '200', GITHUB_REF_NAME: 'develop', WORKFLOW: '', BASELINE: 'x' },
      })

      assert.equal(status, 2)
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
      assert.equal(summary(), comment)
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

      assert.match(logged(), /::warning title=Plugin Check::No baseline to compare with/)
      const failing = report.runCompare({ core, env: { ...base(), RESULTS: results, PLUGIN_CHECK_BASELINE: path.join(FIXTURES, 'baseline.json') } })
      assert.equal(failing, 1)
      assert.match(logged(), /::error title=Plugin Check::100%25done has 1 errors/)
    })
  })
})
