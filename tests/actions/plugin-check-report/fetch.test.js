'use strict'

const { describe, it } = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const report = require('../../../.github/actions/plugin-check-report/plugin-check-report.js')
const { octokitFor, recordingExec } = require('../../support/actions.js')

const REPO = 'example-org/my-plugin'
const SHA = 'a'.repeat(40)
const OLD_SHA = 'b'.repeat(40)

/**
 * The API paths the lookup asks for, as they go over the wire.
 *
 * @param {string} workflow The workflow file name.
 */
const API = (workflow = 'plugin-check.yml') => {
  const runs = `/repos/${REPO}/actions/workflows/${workflow}/runs`

  return {
    forSha: (sha) => `${runs}?status=completed&head_sha=${sha}&per_page=10`,
    goingForSha: (sha) => `${runs}?head_sha=${sha}&per_page=20`,
    onBranch: (branch) => `${runs}?status=completed&branch=${encodeURIComponent(branch)}&per_page=100`,
    artifacts: (id) => `/repos/${REPO}/actions/runs/${id}/artifacts?name=plugin-check-report`,
  }
}

/**
 * A run as the workflow runs API lists it.
 *
 * @param {number} id       Run id.
 * @param {string} sha      Head commit.
 * @param {string} headRepo Repository the run's head commit belongs to. A pull request from a
 *                          fork has the fork's name here.
 *
 * @returns {object} The run.
 */
function run(id, sha = OLD_SHA, headRepo = REPO) {
  return {
    id,
    html_url: `https://github.com/${REPO}/actions/runs/${id}`,
    head_sha: sha,
    status: 'completed',
    head_repository: { full_name: headRepo },
  }
}

/**
 * A clock that only moves when the code sleeps, so the wait loop runs in no time.
 *
 * @returns {{now: Function, sleep: Function, slept: number[]}} The clock and the sleeps it saw.
 */
function fakeClock() {
  const clock = { time: 1000, slept: [] }

  return {
    now: () => clock.time,
    sleep: async (seconds) => {
      clock.slept.push(seconds)
      clock.time += seconds
    },
    slept: clock.slept,
  }
}

/**
 * Runs the lookup against answers written down, the way the old tests ran the script against a
 * stand-in `gh`.
 *
 * @param {string[]} args      Arguments of the lookup. An output file is added unless `bare` is set.
 * @param {object}   answers   Each API path mapped to the JSON body it answers with. A path with no
 *                             answer is a 404, like a failed request.
 * @param {object}   baselines Each run id mapped to the baseline.json its artifact holds. A run
 *                             with no entry has an artifact that cannot be downloaded.
 * @param {object}   options   `bare` (no output file), `env`, `clock`, `files` (run id mapped to the
 *                             exact text of the downloaded baseline.json).
 *
 * @returns {Promise<{status: number, stdout: string, stderr: string, paths: string[], calls: object[],
 *          output: string}>} The exit status, both streams, the API paths asked for in order, the
 *          commands run and the baseline file written.
 */
async function fetchBaseline(args, answers = {}, baselines = {}, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-check-fetch-'))
  const output = path.join(dir, 'out', 'baseline.json')

  const rules = Object.entries(answers).map(([apiPath, body]) => ({ path: apiPath, body }))
  const { github, requests } = await octokitFor(rules)
  const { exec, calls } = recordingExec(
    Object.entries(baselines).map(([id, baseline]) => ({
      command: 'gh',
      args: new RegExp(`^run download ${id} `),
      effect: (callArgs) => {
        const target = callArgs[callArgs.indexOf('--dir') + 1]
        fs.mkdirSync(target, { recursive: true })
        fs.writeFileSync(path.join(target, 'baseline.json'), options.files?.[id] ?? JSON.stringify(baseline))
      },
    }))
  )

  const stdout = []
  const stderr = []
  const clock = options.clock ?? fakeClock()
  const status = await report.main(
    ['fetch', ...args, ...(options.bare ? [] : [output])],
    { GITHUB_REPOSITORY: REPO, ...options.env },
    { out: (line) => stdout.push(line), err: (line) => stderr.push(line) },
    { github, exec, now: clock.now, sleep: clock.sleep }
  )

  return {
    status,
    stdout: stdout.join('\n'),
    stderr: stderr.join('\n'),
    paths: requests.map((request) => request.path),
    calls,
    output: fs.existsSync(output) ? fs.readFileSync(output, 'utf8') : '',
  }
}

const BASELINE = { errors: { 'Some.Rule': 2 }, warnings: {} }
const ONE_ARTIFACT = { artifacts: [{ name: 'plugin-check-report', expired: false }] }
const EXPIRED = { artifacts: [{ name: 'plugin-check-report', expired: true }] }

describe('plugin-check-report fetch', () => {
  it('takes the run for the base commit and calls it exact', async () => {
    const api = API()
    const result = await fetchBaseline(['--sha', SHA, 'develop'], {
      [api.forSha(SHA)]: { workflow_runs: [run(200, SHA)] },
      [api.onBranch('develop')]: { workflow_runs: [run(150)] },
      [api.artifacts(200)]: ONE_ARTIFACT,
    }, { 200: BASELINE })

    assert.equal(result.status, 0, result.stderr)
    assert.equal(result.stdout, `200 https://github.com/${REPO}/actions/runs/200 exact`)
    assert.deepEqual(JSON.parse(result.output), BASELINE)
  })

  it('falls back to an older run on the branch, skips an expired artifact, and calls it older', async () => {
    const api = API()
    const result = await fetchBaseline(['--sha', SHA, 'develop'], {
      [api.forSha(SHA)]: { workflow_runs: [] },
      [api.onBranch('develop')]: { workflow_runs: [run(120), run(150)] },
      [api.artifacts(150)]: EXPIRED,
      [api.artifacts(120)]: ONE_ARTIFACT,
    }, { 120: BASELINE })

    assert.equal(result.status, 0, result.stderr)
    assert.equal(result.stdout, `120 https://github.com/${REPO}/actions/runs/120 older`)
    // Newest first by run id, whatever order the API answered in.
    assert.ok(
      result.paths.findIndex((request) => request.includes('runs/150/')) <
        result.paths.findIndex((request) => request.includes('runs/120/'))
    )
  })

  it('never compares a run with itself or with a newer run', async () => {
    const api = API()
    const result = await fetchBaseline(['--before-run', '150', 'develop'], {
      [api.onBranch('develop')]: { workflow_runs: [run(160), run(150), run(140)] },
      [api.artifacts(140)]: ONE_ARTIFACT,
    }, { 140: BASELINE })

    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /^140 /)
    assert.ok(!result.paths.some((request) => /runs\/1[56]0\//.test(request)))
  })

  it('does not wait for a run for the base commit that has already finished', async () => {
    const api = API()
    const clock = fakeClock()
    const result = await fetchBaseline(['--sha', SHA, '--wait', '1200', 'develop'], {
      [api.goingForSha(SHA)]: { workflow_runs: [run(200, SHA)] },
      [api.forSha(SHA)]: { workflow_runs: [run(200, SHA)] },
      [api.onBranch('develop')]: { workflow_runs: [] },
      [api.artifacts(200)]: ONE_ARTIFACT,
    }, { 200: BASELINE }, { clock })

    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /^200 .* exact$/)
    assert.deepEqual(clock.slept, [])
  })

  it('exits 1 when no run has a baseline', async () => {
    const api = API()
    const result = await fetchBaseline(['develop'], {
      [api.onBranch('develop')]: { workflow_runs: [run(150)] },
      [api.artifacts(150)]: { artifacts: [] },
    })

    assert.equal(result.status, 1)
    assert.match(result.stderr, /No Plugin Check run on develop has a baseline/)
    assert.equal(result.output, '')
  })

  it('exits 2, not 1, when the lookup itself fails', async () => {
    // No answer for the branch's runs: the request is a 404, like an API error.
    const result = await fetchBaseline(['develop'], {})

    assert.equal(result.status, 2)
    assert.match(result.stderr, /Could not look up Plugin Check runs: runs on develop/)
  })

  it('exits 2 when the download fails', async () => {
    const api = API()
    const result = await fetchBaseline(['develop'], {
      [api.onBranch('develop')]: { workflow_runs: [run(150)] },
      [api.artifacts(150)]: ONE_ARTIFACT,
    })

    assert.equal(result.status, 2)
    assert.match(result.stderr, /download of the artifact of run 150/)
  })

  it('exits 2 when the list of artifacts cannot be read', async () => {
    const api = API()
    const result = await fetchBaseline(['develop'], {
      [api.onBranch('develop')]: { workflow_runs: [run(150)] },
    })

    assert.equal(result.status, 2)
    assert.match(result.stderr, /artifacts of run 150/)
  })

  it('stops at a failed lookup even when an older run could have worked', async () => {
    const api = API()
    const result = await fetchBaseline(['develop'], {
      [api.onBranch('develop')]: { workflow_runs: [run(150), run(120)] },
      [api.artifacts(150)]: ONE_ARTIFACT,
      [api.artifacts(120)]: ONE_ARTIFACT,
    }, { 120: BASELINE })

    assert.equal(result.status, 2)
    assert.ok(!result.paths.some((request) => request.includes('runs/120/')))
  })

  it('reads the runs of plugin-check.yml by default', async () => {
    const result = await fetchBaseline(['develop'], {})

    assert.ok(result.paths[0].includes('/workflows/plugin-check.yml/runs'), result.paths[0])
  })

  it('reads the runs of the workflow file --workflow names', async () => {
    const api = API('wporg-check.yml')
    const result = await fetchBaseline(['--workflow', 'wporg-check.yml', 'develop'], {
      [api.onBranch('develop')]: { workflow_runs: [run(150)] },
      [api.artifacts(150)]: ONE_ARTIFACT,
    }, { 150: BASELINE })

    assert.equal(result.status, 0, result.stderr)
    assert.ok(result.paths[0].includes('/workflows/wporg-check.yml/runs'), result.paths[0])
  })

  it('ignores a run whose head commit is in a fork, even on a branch named like the target', async () => {
    const api = API()
    const result = await fetchBaseline(['--sha', SHA, 'develop'], {
      // A fork's pull request run for the base commit, and a newer one on a fork branch "develop".
      [api.forSha(SHA)]: { workflow_runs: [run(300, SHA, 'someone/my-plugin')] },
      [api.onBranch('develop')]: { workflow_runs: [run(250, OLD_SHA, 'someone/my-plugin'), run(150)] },
      [api.artifacts(150)]: ONE_ARTIFACT,
      [api.artifacts(250)]: ONE_ARTIFACT,
      [api.artifacts(300)]: ONE_ARTIFACT,
    }, { 150: BASELINE, 250: { errors: { 'Some.Rule': 9999 }, warnings: {} }, 300: { errors: { 'Some.Rule': 9999 }, warnings: {} } })

    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /^150 .* older$/)
    assert.deepEqual(JSON.parse(result.output), BASELINE)
    assert.ok(
      !result.paths.some((request) => request.includes('/runs/250/') || request.includes('/runs/300/')),
      'no fork run was looked at'
    )
  })

  it('exits 1 when only fork runs exist', async () => {
    const api = API()
    const result = await fetchBaseline(['develop'], {
      [api.onBranch('develop')]: { workflow_runs: [run(250, OLD_SHA, 'someone/my-plugin')] },
    })

    assert.equal(result.status, 1)
    assert.match(result.stderr, /has a baseline/)
  })

  it('matches the repository name without regard to case', async () => {
    const api = API()
    const result = await fetchBaseline(['develop'], {
      [api.onBranch('develop')]: { workflow_runs: [run(150, OLD_SHA, 'Example-Org/My-Plugin')] },
      [api.artifacts(150)]: ONE_ARTIFACT,
    }, { 150: BASELINE })

    assert.equal(result.status, 0, result.stderr)
  })

  it('treats a run with no head repository as not ours', async () => {
    const api = API()
    const result = await fetchBaseline(['develop'], {
      [api.onBranch('develop')]: { workflow_runs: [{ ...run(150), head_repository: null }] },
    })

    assert.equal(result.status, 1)
  })

  it('does not wait for a fork run that is still going', async () => {
    const api = API()
    const clock = fakeClock()
    const result = await fetchBaseline(['--sha', SHA, '--wait', '1', 'develop'], {
      // Our run for the commit is done, and a fork's run for the same commit is not. Counted, the
      // fork's run would make the lookup sleep 30 seconds and then give up waiting.
      [api.goingForSha(SHA)]: {
        workflow_runs: [run(200, SHA), { ...run(300, SHA, 'someone/my-plugin'), status: 'in_progress' }],
      },
      [api.forSha(SHA)]: { workflow_runs: [run(200, SHA)] },
      [api.onBranch('develop')]: { workflow_runs: [] },
      [api.artifacts(200)]: ONE_ARTIFACT,
    }, { 200: BASELINE }, { clock })

    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /^200 .* exact$/)
    assert.doesNotMatch(result.stderr, /still going/)
    assert.deepEqual(clock.slept, [])
  })

  it('exits 2, not 1, for an option value that is empty or not a whole number', async () => {
    const cases = [
      [['--wait', '20m', 'develop'], /--wait must be a whole number, not '20m'/],
      [['--wait', '', 'develop'], /--wait needs a value/],
      [['--before-run', 'abc', 'develop'], /--before-run must be a whole number, not 'abc'/],
      [['--before-run', '-5', 'develop'], /--before-run must be a whole number/],
      [['--before-run', '9'.repeat(19), 'develop'], /--before-run is too large/],
      [['--sha', '', 'develop'], /--sha needs a value/],
      [['', 'baseline.json'], /a branch is needed/],
    ]

    for (const [args, message] of cases) {
      const result = await fetchBaseline(args, {}, {}, { bare: true })

      assert.equal(result.status, 2, args.join(' '))
      assert.match(result.stderr, message, args.join(' '))
      assert.deepEqual(result.paths, [], `${args.join(' ')} asked the API nothing`)
    }
  })

  it('exits 2 when an option or the branch is missing altogether', async () => {
    const cases = [
      [['--wait'], /--wait needs a value/],
      [['--workflow'], /--workflow needs a value/],
      [[], /a branch is needed/],
    ]

    for (const [args, message] of cases) {
      const result = await fetchBaseline(args, {}, {}, { bare: true })

      assert.equal(result.status, 2, args.join(' '))
      assert.match(result.stderr, message, args.join(' '))
    }
  })

  it('reads a run id with a leading zero as a decimal number', async () => {
    const api = API()
    const result = await fetchBaseline(['--before-run', '0150', 'develop'], {
      [api.onBranch('develop')]: { workflow_runs: [run(150), run(120)] },
      [api.artifacts(120)]: ONE_ARTIFACT,
    }, { 120: BASELINE })

    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /^120 /)
  })

  it('takes a run id of 18 digits for --before-run', async () => {
    const api = API()
    const result = await fetchBaseline(['--before-run', '999999999999999999', 'develop'], {
      [api.onBranch('develop')]: { workflow_runs: [run(150)] },
      [api.artifacts(150)]: ONE_ARTIFACT,
    }, { 150: BASELINE })

    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /^150 /)
  })

  it('refuses a --workflow that is a path or a ref, before calling the API', async () => {
    for (const workflow of ['.github/workflows/plugin-check.yml', 'plugin-check.yml@refs/heads/develop']) {
      const result = await fetchBaseline(['--workflow', workflow, 'develop'], {})

      assert.equal(result.status, 2, workflow)
      assert.match(result.stderr, /--workflow must be a file name/)
      assert.deepEqual(result.paths, [])
    }
  })

  it('asks the GitHub CLI for the repository when GITHUB_REPOSITORY is not set', async () => {
    const { github, requests } = await octokitFor([])
    const { exec, calls } = recordingExec([{ command: 'gh', args: /^repo view/, stdout: `${REPO}\n` }])
    const found = await report.fetchBaseline({
      args: ['develop'],
      env: {},
      github,
      exec,
      log: report.commandLog({ out: () => {}, err: () => {} }),
    })

    assert.equal(calls[0].command, 'gh')
    assert.match(calls[0].args.join(' '), /^repo view/)
    assert.equal(requests[0].path.startsWith(`/repos/${REPO}/`), true)
    assert.equal(found.status, 2, 'the runs are not answered, so the lookup fails after the repository')
  })

  it('exits 2 when there is no repository at all', async () => {
    const result = await fetchBaseline(['develop'], {}, {}, { env: { GITHUB_REPOSITORY: '' } })

    assert.equal(result.status, 2)
    assert.match(result.stderr, /no repository/)
  })

  it('takes the next run when the artifact has no baseline.json, or an empty one', async () => {
    const api = API()
    const result = await fetchBaseline(['develop'], {
      [api.onBranch('develop')]: { workflow_runs: [run(150), run(140), run(130)] },
      [api.artifacts(150)]: ONE_ARTIFACT,
      [api.artifacts(140)]: ONE_ARTIFACT,
      [api.artifacts(130)]: ONE_ARTIFACT,
    }, { 150: {}, 140: {}, 130: BASELINE }, { files: { 150: '' } })

    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /^140 /, 'an empty file is skipped, and a non-empty one is taken')
  })

  it('creates the folder of the output file', async () => {
    const api = API()
    const result = await fetchBaseline(['develop'], {
      [api.onBranch('develop')]: { workflow_runs: [run(150)] },
      [api.artifacts(150)]: ONE_ARTIFACT,
    }, { 150: BASELINE })

    assert.equal(result.status, 0)
    assert.deepEqual(JSON.parse(result.output), BASELINE)
  })

  it('asks for the pages of runs in the order the old script did, with the filters in the query', async () => {
    const api = API()
    const result = await fetchBaseline(['--sha', SHA, '--wait', '5', 'develop'], {
      [api.goingForSha(SHA)]: { workflow_runs: [run(200, SHA)] },
      [api.forSha(SHA)]: { workflow_runs: [run(200, SHA)] },
      [api.onBranch('develop')]: { workflow_runs: [] },
      [api.artifacts(200)]: ONE_ARTIFACT,
    }, { 200: BASELINE })

    assert.deepEqual(result.paths, [
      api.goingForSha(SHA),
      api.forSha(SHA),
      api.onBranch('develop'),
      api.artifacts(200),
    ])
  })

  it('encodes a branch name with a slash in the query', async () => {
    const api = API()
    const result = await fetchBaseline(['feature/x y'], {})

    assert.deepEqual(result.paths, [api.onBranch('feature/x y')])
    assert.match(result.paths[0], /branch=feature%2Fx%20y&/)
  })

  it('downloads with the GitHub CLI, for the repository and the artifact name', async () => {
    const api = API()
    const result = await fetchBaseline(['develop'], {
      [api.onBranch('develop')]: { workflow_runs: [run(150)] },
      [api.artifacts(150)]: ONE_ARTIFACT,
    }, { 150: BASELINE })

    assert.equal(result.calls.length, 1)
    assert.equal(result.calls[0].command, 'gh')
    assert.deepEqual(result.calls[0].args.slice(0, 7), ['run', 'download', '150', '--repo', REPO, '--name', 'plugin-check-report'])
  })

  describe('the wait for the run of the base commit', () => {
    it('polls every 30 seconds until the run is done', async () => {
      const api = API()
      const clock = fakeClock()
      const { github, requests } = await octokitFor([
        {
          path: api.goingForSha(SHA),
          responses: [
            { body: { workflow_runs: [{ ...run(200, SHA), status: 'in_progress' }] } },
            { body: { workflow_runs: [{ ...run(200, SHA), status: 'in_progress' }] } },
            { body: { workflow_runs: [run(200, SHA)] } },
          ],
        },
        { path: api.forSha(SHA), body: { workflow_runs: [run(200, SHA)] } },
        { path: api.onBranch('develop'), body: { workflow_runs: [] } },
        { path: api.artifacts(200), body: ONE_ARTIFACT },
      ])
      const { exec } = recordingExec([
        {
          command: 'gh',
          args: /^run download 200 /,
          effect: (args) => {
            const target = args[args.indexOf('--dir') + 1]
            fs.mkdirSync(target, { recursive: true })
            fs.writeFileSync(path.join(target, 'baseline.json'), JSON.stringify(BASELINE))
          },
        },
      ])
      const output = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-check-wait-')), 'baseline.json')

      const status = await report.main(
        ['fetch', '--sha', SHA, '--wait', '1200', 'develop', output],
        { GITHUB_REPOSITORY: REPO },
        { out: () => {}, err: () => {} },
        { github, exec, now: clock.now, sleep: clock.sleep }
      )

      assert.equal(status, 0)
      assert.deepEqual(clock.slept, [30, 30])
      assert.equal(requests.filter((request) => request.path === api.goingForSha(SHA)).length, 3)
    })

    it('gives up after the wait, says so, and goes on with older runs', async () => {
      const api = API()
      const clock = fakeClock()
      const stillGoing = { workflow_runs: [{ ...run(200, SHA), status: 'in_progress' }] }
      const result = await fetchBaseline(['--sha', SHA, '--wait', '60', 'develop'], {
        [api.goingForSha(SHA)]: stillGoing,
        [api.forSha(SHA)]: { workflow_runs: [] },
        [api.onBranch('develop')]: { workflow_runs: [run(150)] },
        [api.artifacts(150)]: ONE_ARTIFACT,
      }, { 150: BASELINE }, { clock })

      assert.equal(result.status, 0, result.stderr)
      assert.match(result.stdout, /^150 .* older$/)
      assert.match(result.stderr, new RegExp(`The run for ${SHA} is still going after 60 seconds; trying older runs\\.`))
      assert.deepEqual(clock.slept, [30, 30])
    })

    it('stops waiting for a run that never shows up after 120 seconds', async () => {
      const api = API()
      const clock = fakeClock()
      const result = await fetchBaseline(['--sha', SHA, '--wait', '1200', 'develop'], {
        [api.goingForSha(SHA)]: { workflow_runs: [] },
        [api.forSha(SHA)]: { workflow_runs: [] },
        [api.onBranch('develop')]: { workflow_runs: [run(150)] },
        [api.artifacts(150)]: ONE_ARTIFACT,
      }, { 150: BASELINE }, { clock })

      assert.equal(result.status, 0, result.stderr)
      assert.deepEqual(clock.slept, [30, 30, 30, 30])
      assert.doesNotMatch(result.stderr, /still going/)
    })

    it('says it is still going, not that the run never showed up, when the wait is short', async () => {
      const api = API()
      const clock = fakeClock()
      const result = await fetchBaseline(['--sha', SHA, '--wait', '20', 'develop'], {
        [api.goingForSha(SHA)]: { workflow_runs: [] },
        [api.forSha(SHA)]: { workflow_runs: [] },
        [api.onBranch('develop')]: { workflow_runs: [] },
      }, {}, { clock })

      assert.equal(result.status, 1)
      assert.match(result.stderr, /still going after 20 seconds/)
    })

    it('does not wait at all with --wait 0, or without --sha', async () => {
      const api = API()
      const clock = fakeClock()
      const result = await fetchBaseline(['--wait', '300', 'develop'], {
        [api.onBranch('develop')]: { workflow_runs: [] },
      }, {}, { clock })

      assert.equal(result.status, 1)
      assert.deepEqual(result.paths, [api.onBranch('develop')])
    })

    it('exits 2 when polling fails', async () => {
      const result = await fetchBaseline(['--sha', SHA, '--wait', '60', 'develop'], {})

      assert.equal(result.status, 2)
      assert.match(result.stderr, new RegExp(`runs for ${SHA}`))
    })
  })
})

describe('plugin-check-report fetch helpers', () => {
  it('reads the workflow file from the workflow ref', () => {
    assert.equal(
      report.workflowFromRef('example-org/my-plugin/.github/workflows/plugin-check.yml@refs/pull/12/merge'),
      'plugin-check.yml'
    )
    assert.equal(report.workflowFromRef(''), '')
    assert.equal(report.workflowFromRef(undefined), '')
  })

  it('lower-cases only A to Z', () => {
    assert.equal(report.asciiLower('Example-Org/ÄB'), 'example-org/Äb')
  })

  it('names the baseline for the event and the match', () => {
    assert.deepEqual(report.describeBaseline('pull_request', 'exact'), { label: 'Target branch', advisory: false })
    assert.deepEqual(report.describeBaseline('pull_request', 'older'), { label: 'Target branch, older run', advisory: true })
    assert.deepEqual(report.describeBaseline('push', 'exact'), { label: 'Previous run', advisory: false })
  })

  it('orders runs: the base commit first, then the branch, newest first, each once', () => {
    const ordered = report.orderCandidates({
      shaRuns: [run(5), run(9)],
      branchRuns: [run(7), run(9), run(11)],
      beforeRun: null,
    })

    assert.deepEqual(ordered.map((candidate) => candidate.id), [5, 9, 11, 7])
  })
})
