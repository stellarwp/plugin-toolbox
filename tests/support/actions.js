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
 */

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

/** Builds the JSON Response a rule describes. */
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
 * @returns {Promise<{github: object, requests: object[]}>}
 */
async function octokitFor(rules = []) {
  const { getOctokit } = await import('@actions/github')
  const { fetch, requests } = recordingFetch(rules)

  return { github: getOctokit('test-token', { request: { fetch } }), requests }
}

/** Reads back the outputs @actions/core appended to its GITHUB_OUTPUT file. */
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
 * @param {object} t The node:test context, used to restore stdout afterwards.
 * @returns {Promise<{core: object, outputs: Function, logged: Function}>}
 */
async function coreWithOutputs(t) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'toolbox-output-')), 'output')
  fs.writeFileSync(file, '')
  process.env.GITHUB_OUTPUT = file

  const core = await import('@actions/core')

  const written = []
  const realWrite = process.stdout.write.bind(process.stdout)

  process.stdout.write = (chunk, encoding, callback) => {
    written.push(String(chunk))

    const done = typeof encoding === 'function' ? encoding : callback
    if (typeof done === 'function') {
      done()
    }

    return true
  }

  t.after(() => {
    process.stdout.write = realWrite
  })

  return { core, outputs: () => readOutputs(file), logged: () => written.join('') }
}

/**
 * Both arguments actions/github-script passes to a script, ready for one test.
 *
 * @param {object}   t     The node:test context.
 * @param {object[]} rules Passed to recordingFetch.
 * @returns {Promise<{github: object, requests: object[], core: object, outputs: Function,
 *                    logged: Function}>}
 */
async function actionsFor(t, rules = []) {
  const { github, requests } = await octokitFor(rules)
  const { core, outputs, logged } = await coreWithOutputs(t)

  return { github, requests, core, outputs, logged }
}

module.exports = { actionsFor, octokitFor, coreWithOutputs, recordingFetch, readOutputs }
