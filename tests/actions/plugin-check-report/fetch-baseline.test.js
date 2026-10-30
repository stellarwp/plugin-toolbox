'use strict'

const { describe, it } = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const FETCH = path.join(__dirname, '../../../.github/actions/plugin-check-report/fetch-baseline.sh')

const REPO = 'example-org/my-plugin'
const SHA = 'a'.repeat(40)
const OLD_SHA = 'b'.repeat(40)

/**
 * A stand-in for the GitHub CLI, put first on PATH.
 *
 * `gh api <path> --jq <filter>` answers from a JSON file named after the path, and applies the
 * filter with the real jq, so the script's own filters run as they would against GitHub. A path
 * with no file answers the way gh does for a 404: a message on stderr and exit 1. That is how a
 * test makes the lookup fail.
 *
 * `gh run download <id> --dir <dir>` copies the folder artifact-<id>, standing in for the
 * plugin-check-report artifact of that run.
 *
 * Every call is appended to a log, so a test can assert which requests were sent.
 */
const FAKE_GH = `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$FAKE_GH_LOG"
if [ "$1" = api ]; then
    key=$(printf '%s' "$2" | tr -c 'A-Za-z0-9' '_')
    file="$FAKE_GH_DIR/$key.json"
    if [ ! -f "$file" ]; then
        echo "gh: Not Found (HTTP 404)" >&2
        exit 1
    fi
    if [ "$3" = --jq ]; then
        jq -r "$4" "$file"
    else
        cat "$file"
    fi
elif [ "$1" = run ] && [ "$2" = download ]; then
    id=$3
    while [ $# -gt 0 ]; do
        [ "$1" = --dir ] && dir=$2
        shift
    done
    [ -d "$FAKE_GH_DIR/artifact-$id" ] || { echo "no artifact for run $id" >&2; exit 1; }
    mkdir -p "$dir"
    cp -R "$FAKE_GH_DIR/artifact-$id/." "$dir/"
else
    echo "fake gh: no answer for: $*" >&2
    exit 1
fi
`

/**
 * The file name the stand-in reads for an API path.
 *
 * @param {string} apiPath The path as the script passes it to `gh api`.
 *
 * @returns {string} The file name, every character other than a letter or digit made `_`.
 */
function keyFor(apiPath) {
  return `${apiPath.replace(/[^A-Za-z0-9]/g, '_')}.json`
}

/**
 * The API paths fetch-baseline.sh asks for.
 *
 * @param {string} workflow The workflow file name.
 */
const API = (workflow = 'plugin-check.yml') => {
  const runs = `repos/${REPO}/actions/workflows/${workflow}/runs`

  return {
    forSha: (sha) => `${runs}?status=completed&head_sha=${sha}&per_page=10`,
    goingForSha: (sha) => `${runs}?head_sha=${sha}&per_page=20`,
    onBranch: (branch) => `${runs}?status=completed&branch=${branch}&per_page=50`,
    artifacts: (id) => `repos/${REPO}/actions/runs/${id}/artifacts?name=plugin-check-report`,
  }
}

/**
 * A run as the workflow runs API lists it.
 *
 * @param {number} id   Run id.
 * @param {string} sha  Head commit.
 *
 * @returns {object} The run.
 */
function run(id, sha = OLD_SHA) {
  return { id, html_url: `https://github.com/${REPO}/actions/runs/${id}`, head_sha: sha, status: 'completed' }
}

/**
 * Sets up the stand-in's answers and runs fetch-baseline.sh against them.
 *
 * @param {string[]} args    Arguments for the script.
 * @param {object}   answers Each API path mapped to the JSON body it answers with.
 * @param {object}   baselines Each run id mapped to the baseline.json its artifact holds.
 *
 * @returns {{status: number, stdout: string, stderr: string, calls: string[], output: string}}
 *          The exit status, both streams, the gh calls made and the baseline file it wrote.
 */
function fetchBaseline(args, answers = {}, baselines = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-check-fetch-'))
  const bin = path.join(dir, 'bin')
  const data = path.join(dir, 'data')
  const log = path.join(dir, 'gh.log')
  const output = path.join(dir, 'out', 'baseline.json')

  fs.mkdirSync(bin)
  fs.mkdirSync(data)
  fs.writeFileSync(path.join(bin, 'gh'), FAKE_GH, { mode: 0o755 })
  fs.writeFileSync(log, '')

  for (const [apiPath, body] of Object.entries(answers)) {
    fs.writeFileSync(path.join(data, keyFor(apiPath)), JSON.stringify(body))
  }
  for (const [id, baseline] of Object.entries(baselines)) {
    fs.mkdirSync(path.join(data, `artifact-${id}`))
    fs.writeFileSync(path.join(data, `artifact-${id}`, 'baseline.json'), JSON.stringify(baseline))
  }

  const result = spawnSync('bash', [FETCH, ...args, output], {
    encoding: 'utf8',
    env: {
      PATH: `${bin}:${process.env.PATH}`,
      HOME: process.env.HOME,
      GITHUB_REPOSITORY: REPO,
      FAKE_GH_DIR: data,
      FAKE_GH_LOG: log,
    },
  })

  return {
    status: result.status,
    stdout: result.stdout.trim(),
    stderr: result.stderr,
    calls: fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean),
    output: fs.existsSync(output) ? fs.readFileSync(output, 'utf8') : '',
  }
}

const BASELINE = { errors: { 'Some.Rule': 2 }, warnings: {} }
const ONE_ARTIFACT = { artifacts: [{ name: 'plugin-check-report', expired: false }] }
const EXPIRED = { artifacts: [{ name: 'plugin-check-report', expired: true }] }

describe('fetch-baseline.sh', () => {
  it('takes the run for the base commit and calls it exact', () => {
    const api = API()
    const result = fetchBaseline(['--sha', SHA, 'develop'], {
      [api.forSha(SHA)]: { workflow_runs: [run(200, SHA)] },
      [api.onBranch('develop')]: { workflow_runs: [run(150)] },
      [api.artifacts(200)]: ONE_ARTIFACT,
    }, { 200: BASELINE })

    assert.equal(result.status, 0, result.stderr)
    assert.equal(result.stdout, `200 https://github.com/${REPO}/actions/runs/200 exact`)
    assert.deepEqual(JSON.parse(result.output), BASELINE)
  })

  it('falls back to an older run on the branch, skips an expired artifact, and calls it older', () => {
    const api = API()
    const result = fetchBaseline(['--sha', SHA, 'develop'], {
      [api.forSha(SHA)]: { workflow_runs: [] },
      [api.onBranch('develop')]: { workflow_runs: [run(120), run(150)] },
      [api.artifacts(150)]: EXPIRED,
      [api.artifacts(120)]: ONE_ARTIFACT,
    }, { 120: BASELINE })

    assert.equal(result.status, 0, result.stderr)
    assert.equal(result.stdout, `120 https://github.com/${REPO}/actions/runs/120 older`)
    // Newest first by run id, whatever order the API answered in.
    assert.ok(
      result.calls.findIndex((call) => call.includes('runs/150/')) <
        result.calls.findIndex((call) => call.includes('runs/120/'))
    )
  })

  it('never compares a run with itself or with a newer run', () => {
    const api = API()
    const result = fetchBaseline(['--before-run', '150', 'develop'], {
      [api.onBranch('develop')]: { workflow_runs: [run(160), run(150), run(140)] },
      [api.artifacts(140)]: ONE_ARTIFACT,
    }, { 140: BASELINE })

    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /^140 /)
    assert.ok(!result.calls.some((call) => /runs\/1[56]0\//.test(call)))
  })

  it('does not wait for a run for the base commit that has already finished', () => {
    const api = API()
    const result = fetchBaseline(['--sha', SHA, '--wait', '1200', 'develop'], {
      [api.goingForSha(SHA)]: { workflow_runs: [run(200, SHA)] },
      [api.forSha(SHA)]: { workflow_runs: [run(200, SHA)] },
      [api.onBranch('develop')]: { workflow_runs: [] },
      [api.artifacts(200)]: ONE_ARTIFACT,
    }, { 200: BASELINE })

    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /^200 .* exact$/)
  })

  it('exits 1 when no run has a baseline', () => {
    const api = API()
    const result = fetchBaseline(['develop'], {
      [api.onBranch('develop')]: { workflow_runs: [run(150)] },
      [api.artifacts(150)]: { artifacts: [] },
    })

    assert.equal(result.status, 1)
    assert.match(result.stderr, /No Plugin Check run on develop has a baseline/)
    assert.equal(result.output, '')
  })

  it('exits 2, not 1, when the lookup itself fails', () => {
    // No answer for the branch's runs: the stand-in fails the way gh does on an API error.
    const result = fetchBaseline(['develop'], {})

    assert.equal(result.status, 2)
    assert.match(result.stderr, /Could not look up Plugin Check runs/)
  })

  it('exits 2 when the download fails', () => {
    const api = API()
    const result = fetchBaseline(['develop'], {
      [api.onBranch('develop')]: { workflow_runs: [run(150)] },
      [api.artifacts(150)]: ONE_ARTIFACT,
    })

    assert.equal(result.status, 2)
    assert.match(result.stderr, /download of the artifact of run 150/)
  })

  it('reads the runs of plugin-check.yml by default', () => {
    const result = fetchBaseline(['develop'], {})

    assert.ok(result.calls[0].includes('/workflows/plugin-check.yml/runs'), result.calls[0])
  })

  it('reads the runs of the workflow file --workflow names', () => {
    const api = API('wporg-check.yml')
    const result = fetchBaseline(['--workflow', 'wporg-check.yml', 'develop'], {
      [api.onBranch('develop')]: { workflow_runs: [run(150)] },
      [api.artifacts(150)]: ONE_ARTIFACT,
    }, { 150: BASELINE })

    assert.equal(result.status, 0, result.stderr)
    assert.ok(result.calls[0].includes('/workflows/wporg-check.yml/runs'), result.calls[0])
  })

  it('refuses a --workflow that is a path or a ref, before calling the API', () => {
    for (const workflow of ['.github/workflows/plugin-check.yml', 'plugin-check.yml@refs/heads/develop']) {
      const result = fetchBaseline(['--workflow', workflow, 'develop'], {})

      assert.equal(result.status, 2, workflow)
      assert.match(result.stderr, /--workflow must be a file name/)
      assert.deepEqual(result.calls, [])
    }
  })
})
