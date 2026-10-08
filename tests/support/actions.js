'use strict'

/**
 * Builds the two arguments actions/github-script passes to an action's script, as the real things
 * rather than as stand-ins.
 *
 * `github` is a real Octokit from @actions/github, the same client the action is handed, with only
 * the network replaced. A test therefore asserts the HTTP requests the action would have sent, and
 * a wrong endpoint, a misspelled parameter or a wrong owner shows up as a different request.
 *
 * `core` is the real @actions/core, writing to a GITHUB_OUTPUT file in a temporary directory, so
 * outputs are read back the way a later workflow step would see them.
 *
 * Both packages are ESM only, so they are loaded with dynamic import and these factories are async.
 *
 * `exec` is the one stand-in. An action that shells out (git, php) would otherwise need those tools
 * and a network at test time, so recordingExec answers from rules the way recordingFetch does, and
 * records the calls for the test to assert.
 */

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

/**
 * Builds the Response a rule describes, as the API would have sent it.
 *
 * @param {number} status  HTTP status, defaulting to 200.
 * @param {object} body    Value to send as the JSON body.
 * @param {object} headers Extra headers, merged over the JSON content type.
 *
 * @returns {Response} The response for the fetch to return.
 */
function jsonResponse({ status = 200, body = {}, headers = {} }) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  })
}

/**
 * A `fetch` that answers from a list of rules and records every request it was given.
 *
 * A rule matches on `method` and on `path`, first match winning. A string path has to equal the
 * request path exactly; pass a RegExp to match a family of paths. Exactly, because a substring match
 * let a rule for `tags%2Fv1` answer the request for `tags%2Fv1.2` and a tag looked like it already
 * existed, the same prefix hazard move-git-tags guards against by reading git/ref.
 *
 * A rule with `responses` answers each matching request with the next entry, repeating the last one,
 * which is how a paginated endpoint is described. Anything unmatched answers 404, so a request the
 * test did not plan for surfaces as a 404 rather than as a silent success.
 *
 * @param {object[]} rules `{method, path, status, body, headers}` or `{method, path, responses}`,
 *                         where `path` is an exact string or a RegExp.
 *
 * @returns {{fetch: Function, requests: object[]}} The fetch, and the requests it recorded.
 */
function recordingFetch(rules = []) {
  const requests = []
  const matchCounts = new Map()

  const fetch = async (url, options = {}) => {
    const method = (options.method || 'GET').toUpperCase()
    const href = String(url)
    // The path with the API origin removed, left percent-encoded as it went over the wire.
    const requestPath = href.replace(/^https:\/\/api\.github\.com/, '')

    requests.push({
      method,
      url: href,
      path: requestPath,
      body: options.body ? JSON.parse(options.body) : undefined,
    })

    for (const [index, rule] of rules.entries()) {
      const pathMatches =
        rule.path instanceof RegExp ? rule.path.test(requestPath) : rule.path === requestPath

      if ((rule.method || 'GET').toUpperCase() !== method || !pathMatches) {
        continue
      }

      const seen = matchCounts.get(index) ?? 0
      matchCounts.set(index, seen + 1)

      const replies = rule.responses ?? [rule]

      return jsonResponse(replies[Math.min(seen, replies.length - 1)])
    }

    return jsonResponse({ status: 404, body: { message: 'Not Found' } })
  }

  return { fetch, requests }
}

/**
 * A real Octokit with the network replaced.
 *
 * @param {object[]} rules Passed to recordingFetch.
 *
 * @returns {Promise<{github: object, requests: object[]}>} The client, and the requests it records.
 */
async function octokitFor(rules = []) {
  const { getOctokit } = await import('@actions/github')
  const { fetch, requests } = recordingFetch(rules)

  return { github: getOctokit('test-token', { request: { fetch } }), requests }
}

/**
 * Reads back the outputs @actions/core appended to its GITHUB_OUTPUT file.
 *
 * core writes each one as a heredoc, `name<<delimiter`, the value, then the delimiter again, which
 * is the format a later workflow step reads. Parsing it rather than recording the calls means the
 * assertion is what the step actually handed on.
 *
 * @param {string} file Path to the GITHUB_OUTPUT file.
 *
 * @returns {object} Each output name mapped to its value.
 */
function readOutputs(file) {
  const outputs = {}
  const content = fs.readFileSync(file, 'utf8')
  const entry = /^(.+?)<<(ghadelimiter_[0-9a-f-]+)\r?\n([\s\S]*?)\r?\n\2$/gm

  let match
  while ((match = entry.exec(content)) !== null) {
    outputs[match[1]] = match[3]
  }

  return outputs
}

/**
 * The real stdout write, replaced once and kept, and the buffer currently collecting writes. While
 * nothing is collecting, writes go straight through, so the test runner's own output is untouched.
 */
let realStdoutWrite = null
let collecting = null

/**
 * Whether a stdout write is the action's log, which a test collects, or the test runner's own.
 *
 * node --test runs each file in a child process that reports its results to the parent over stdout,
 * as serialized Buffers written whenever the runner flushes, which can be in the middle of a later
 * test that awaits. Collecting those swallowed the reports of every test before it, and the file
 * counted as a single test. @actions/core writes its log as strings, so only strings are collected.
 *
 * @param {string|Uint8Array} chunk What was written.
 *
 * @returns {boolean} True for a write to collect.
 */
function isLogWrite(chunk) {
  return typeof chunk === 'string'
}

/**
 * Collects what is written to stdout for the length of one test.
 *
 * @actions/core writes its log there, including the `::notice::` and `::warning::` commands the
 * runner turns into annotations, so a test that let them through would annotate its own workflow.
 *
 * The write is replaced once for the process rather than per call. Replacing it per call meant a
 * second call in the same test captured the already-replaced write as the original, and restoring
 * put that back, leaving stdout collecting into a dead buffer and swallowing the runner's output for
 * every test after it.
 *
 * @param {object} t The node:test context, used to stop collecting when the test ends.
 *
 * @returns {Function} Reads back everything written while this test ran.
 */
function captureStdout(t) {
  const written = []

  if (!realStdoutWrite) {
    realStdoutWrite = process.stdout.write.bind(process.stdout)

    process.stdout.write = (chunk, encoding, callback) => {
      if (!collecting || !isLogWrite(chunk)) {
        return realStdoutWrite(chunk, encoding, callback)
      }

      collecting.push(String(chunk))

      const done = typeof encoding === 'function' ? encoding : callback
      if (typeof done === 'function') {
        done()
      }

      return true
    }
  }

  collecting = written

  // Nothing collects between tests, so this is right however many times a test called it.
  t.after(() => {
    collecting = null
  })

  return () => written.join('')
}

/** The job summary file for this process, created on first use. */
let summaryFile = null

/**
 * Collects what is written to the job summary for the length of one test.
 *
 * core.summary resolves GITHUB_STEP_SUMMARY on its first write and keeps the path for the life of
 * the process, so a fresh file per test would be ignored after the first one. There is one file
 * instead, and each test reads only what was appended after it began.
 *
 * @returns {Function} Reads back everything written to the summary since this call.
 */
function captureSummary() {
  if (!summaryFile) {
    summaryFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'toolbox-summary-')), 'summary')
    fs.writeFileSync(summaryFile, '')
    process.env.GITHUB_STEP_SUMMARY = summaryFile
  }

  const from = fs.statSync(summaryFile).size

  return () => fs.readFileSync(summaryFile, 'utf8').slice(from)
}

/**
 * The real @actions/core, pointed at a fresh GITHUB_OUTPUT file, with its log captured.
 *
 * setOutput reads GITHUB_OUTPUT on every call, so pointing it at a new file per test keeps the
 * outputs of one test out of another even though the module itself is cached.
 *
 * info, notice and warning write to stdout, and notice and warning write the `::notice::` and
 * `::warning::` commands the runner turns into annotations on the job. Left alone, a passing test
 * run annotates its own workflow with the messages the actions logged. Collecting the writes instead
 * keeps the run clean and lets a test assert what was logged. stdout is restored when the test ends,
 * before the runner reports the result.
 *
 * The job summary is collected too, so an action that writes one can be asserted on.
 *
 * @param {object} t The node:test context, used to restore stdout afterwards.
 *
 * @returns {Promise<{core: object, outputs: Function, logged: Function, summary: Function}>} The
 *          toolkit, and readers for its outputs, for everything it wrote to the log and for what it
 *          wrote to the job summary.
 */
async function coreWithOutputs(t) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'toolbox-output-')), 'output')
  fs.writeFileSync(file, '')
  process.env.GITHUB_OUTPUT = file

  const core = await import('@actions/core')

  return { core, outputs: () => readOutputs(file), logged: captureStdout(t), summary: captureSummary() }
}

/**
 * Stands in for @actions/exec: answers each call from a list of rules and records it.
 *
 * A rule matches on `command` and, when it has one, on `args`, a RegExp tested against the
 * arguments joined by spaces. The first match wins. It answers with `exitCode` (default 0),
 * `stdout` and `stderr`, and runs `effect(args, options)` first when it has one, which is how a test
 * stands in for a file the command would have written.
 *
 * A call no rule matches answers exit code 127, the shell's "command not found", so a call the test
 * did not plan for fails rather than passing silently.
 *
 * Like the real package, a non-zero exit rejects unless the caller passed `ignoreReturnCode`.
 *
 * @param {object[]} rules `{command, args, exitCode, stdout, stderr, effect}`.
 *
 * @returns {{exec: object, calls: object[]}} The stand-in, with `exec` and `getExecOutput`, and the
 *          calls it recorded as `{command, args, options}`.
 */
function recordingExec(rules = []) {
  const calls = []

  const getExecOutput = async (command, args = [], options = {}) => {
    calls.push({ command, args, options })

    const rule = rules.find(
      (candidate) =>
        candidate.command === command && (!candidate.args || candidate.args.test(args.join(' ')))
    )

    if (rule?.effect) {
      await rule.effect(args, options)
    }

    const result = rule
      ? { exitCode: rule.exitCode ?? 0, stdout: rule.stdout ?? '', stderr: rule.stderr ?? '' }
      : { exitCode: 127, stdout: '', stderr: `${command}: no test rule answers this call` }

    if (result.exitCode !== 0 && !options.ignoreReturnCode) {
      throw new Error(`The process '${command}' failed with exit code ${result.exitCode}`)
    }

    return result
  }

  const exec = {
    getExecOutput,
    exec: async (command, args, options) => (await getExecOutput(command, args, options)).exitCode,
  }

  return { exec, calls }
}

/**
 * Both arguments actions/github-script passes to a script, ready for one test.
 *
 * @param {object}   t     The node:test context.
 * @param {object[]} rules Passed to recordingFetch.
 *
 * @returns {Promise<{github: object, requests: object[], core: object, outputs: Function,
 *          logged: Function, summary: Function}>} Everything a test needs: the client, the
 *          requests it records, the toolkit, and readers for its outputs, its log and its summary.
 */
async function actionsFor(t, rules = []) {
  const { github, requests } = await octokitFor(rules)
  const { core, outputs, logged, summary } = await coreWithOutputs(t)

  return { github, requests, core, outputs, logged, summary }
}

module.exports = {
  actionsFor,
  octokitFor,
  coreWithOutputs,
  recordingFetch,
  recordingExec,
  readOutputs,
  isLogWrite,
}
