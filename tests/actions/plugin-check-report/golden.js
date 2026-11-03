'use strict'

/**
 * The cases whose exact output is pinned in fixtures/expected/.
 *
 * The files there were written by the original ratchet.sh. Every implementation of the compare has
 * to print the same status, the same stdout, the same comment, the same job summary and, for
 * --update, the same baseline file, byte for byte. A case is described once here and run by a
 * `execute` function, so the same list checks the bash script and the JavaScript that replaces it.
 */

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const FIXTURES = path.join(__dirname, 'fixtures')
const EXPECTED = path.join(FIXTURES, 'expected')

/** A path that never exists, so a case without a baseline gets none and prints a fixed path. */
const NO_BASELINE = '/nonexistent/baseline.json'

/**
 * A results file with one new ERROR code per entry.
 *
 * @param {number} codes How many different codes to write.
 *
 * @returns {string} The file's text.
 */
function newCodes(codes) {
  const results = Array.from({ length: codes }, (_, index) => ({
    line: index + 1,
    column: 1,
    type: 'ERROR',
    code: `Test.Rule.Number${index + 1}`,
    message: 'A rule added for the test.',
    docs: '',
  }))

  return `FILE: plugin.php\n${JSON.stringify(results)}\n`
}

/**
 * The warnings-up sample without its ERROR results.
 *
 * @returns {string} The file's text.
 */
function warningsOnly() {
  const text = fs.readFileSync(path.join(FIXTURES, 'warnings-up.txt'), 'utf8')

  return text
    .split('\n')
    .map((line) => {
      if (!line.startsWith('[')) {
        return line
      }

      return JSON.stringify(JSON.parse(line).filter((result) => result.type === 'WARNING'))
    })
    .join('\n')
}

const RUN = { RUN_URL: 'https://example.test/actions/runs/1' }
const BASELINE = 'baseline.json'

/**
 * Each case: a name, the results (a fixture name, or `text` to write), the baseline fixture to use,
 * extra arguments, and the environment.
 */
const CASES = [
  { name: 'clean-no-baseline', results: 'clean.txt', env: RUN },
  { name: 'same-as-baseline', results: 'same-as-baseline.txt', baseline: BASELINE, env: RUN },
  { name: 'errors-up', results: 'errors-up.txt', baseline: BASELINE, env: RUN },
  { name: 'rule-up-total-same', results: 'rule-up-total-same.txt', baseline: BASELINE, env: RUN },
  { name: 'errors-down', results: 'errors-down.txt', baseline: BASELINE, env: RUN },
  { name: 'warnings-up', results: 'warnings-up.txt', baseline: BASELINE, env: RUN },
  {
    name: 'errors-up-advisory',
    results: 'errors-up.txt',
    baseline: BASELINE,
    env: { ...RUN, PLUGIN_CHECK_ADVISORY: 'true' },
  },
  {
    name: 'errors-up-advisory-uppercase',
    results: 'errors-up.txt',
    baseline: BASELINE,
    env: { ...RUN, PLUGIN_CHECK_ADVISORY: 'TRUE' },
  },
  { name: 'strict-no-baseline', results: 'errors-down.txt', env: { ...RUN, PLUGIN_CHECK_MODE: 'strict' } },
  {
    name: 'strict-errors-down',
    results: 'errors-down.txt',
    baseline: BASELINE,
    env: { ...RUN, PLUGIN_CHECK_MODE: 'strict' },
  },
  { name: 'strict-clean', results: 'clean.txt', env: { ...RUN, PLUGIN_CHECK_MODE: 'strict' } },
  { name: 'strict-warnings-only', text: warningsOnly, env: { ...RUN, PLUGIN_CHECK_MODE: 'strict' } },
  {
    name: 'label-and-url',
    results: 'same-as-baseline.txt',
    baseline: BASELINE,
    env: { ...RUN, BASELINE_LABEL: 'Target branch', BASELINE_URL: 'https://github.com/o/r/actions/runs/1' },
  },
  { name: 'seven-new-codes', text: () => newCodes(7), baseline: BASELINE, env: RUN },
  { name: 'six-new-codes', text: () => newCodes(6), baseline: BASELINE, env: RUN },
  {
    name: 'badge-and-artifact',
    results: 'errors-up.txt',
    baseline: BASELINE,
    env: {
      ...RUN,
      COMMENT_BADGE: 'https://img.shields.io/badge/Check%20Finished-now-darkgreen',
      ARTIFACT_URL: 'https://github.com/o/r/actions/runs/1/artifacts/2',
    },
  },
  { name: 'artifact-only', results: 'clean.txt', env: { ARTIFACT_URL: 'https://github.com/o/r/actions/runs/1/artifacts/2' } },
  {
    name: 'marker',
    results: 'clean.txt',
    env: { ...RUN, COMMENT_MARKER: '<!-- plugin-check:example-org/my-plugin -->' },
  },
  {
    name: 'marker-with-line-breaks',
    results: 'errors-up.txt',
    baseline: BASELINE,
    env: { ...RUN, COMMENT_MARKER: Array.from({ length: 20 }, (_, index) => `line ${index + 1}`).join('\n') },
  },
  { name: 'results-missing', results: false, args: ['/nonexistent/results.txt'], env: RUN },
  { name: 'results-garbage', results: 'garbage.txt', env: RUN },
  { name: 'results-empty', results: 'empty.txt', env: RUN },
  { name: 'unknown-mode', results: 'clean.txt', env: { ...RUN, PLUGIN_CHECK_MODE: 'strcit' } },
  { name: 'update-errors-up', results: 'errors-up.txt', update: true, env: RUN },
  { name: 'update-clean', results: 'clean.txt', update: true, env: RUN },
  { name: 'update-garbage', results: 'garbage.txt', update: true, env: RUN },
]

/**
 * Runs one case.
 *
 * @param {object}   spec    A case from CASES.
 * @param {Function} execute `(args, env) => {status, stdout}`. Runs the script under test with the
 *                           arguments and environment given.
 *
 * @returns {{status: number, stdout: string, comment: string, summary: string, baseline: string}}
 *          What the script did. The temporary folder in stdout is written `<tmp>`.
 */
function runCase(spec, execute) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-check-golden-'))
  const comment = path.join(dir, 'comment.md')
  const summary = path.join(dir, 'summary.md')
  const written = path.join(dir, 'baseline.json')

  let results
  if (spec.text) {
    results = path.join(dir, 'results.txt')
    fs.writeFileSync(results, spec.text())
  } else {
    results = spec.args ? spec.args[0] : path.join(FIXTURES, spec.results)
  }

  const env = {
    GITHUB_STEP_SUMMARY: summary,
    PLUGIN_CHECK_BASELINE: spec.update ? written : spec.baseline ? path.join(FIXTURES, spec.baseline) : NO_BASELINE,
    ...spec.env,
  }
  const args = spec.update ? ['--update', results] : ['--comment-file', comment, results]
  const result = execute(args, env)

  const read = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '')

  return {
    status: result.status,
    stdout: result.stdout.split(dir).join('<tmp>'),
    comment: read(comment),
    summary: read(summary),
    baseline: read(written),
  }
}

/**
 * The pinned files of a case, as written by the original script.
 *
 * @param {string} name A case name.
 *
 * @returns {{status: number, stdout: string, comment: string, summary: string, baseline: string}}
 *          The expected result.
 */
function expectedFor(name) {
  const read = (extension) => {
    const file = path.join(EXPECTED, `${name}.${extension}`)

    return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''
  }
  const statuses = JSON.parse(fs.readFileSync(path.join(EXPECTED, 'status.json'), 'utf8'))

  return {
    status: statuses[name],
    stdout: read('out'),
    comment: read('md'),
    summary: read('summary'),
    baseline: read('json'),
  }
}

/**
 * Writes the pinned files from a run of the script under test. Only the original bash script is
 * allowed to make them: run it once, review the diff, and commit.
 *
 * @param {object[]} outcomes `{name, result}` for each case.
 */
function writeExpected(outcomes) {
  fs.mkdirSync(EXPECTED, { recursive: true })
  const statuses = {}

  for (const { name, result } of outcomes) {
    statuses[name] = result.status
    for (const [extension, text] of [
      ['out', result.stdout],
      ['md', result.comment],
      ['summary', result.summary],
      ['json', result.baseline],
    ]) {
      const file = path.join(EXPECTED, `${name}.${extension}`)
      if (text === '') {
        fs.rmSync(file, { force: true })
      } else {
        fs.writeFileSync(file, text)
      }
    }
  }

  fs.writeFileSync(path.join(EXPECTED, 'status.json'), `${JSON.stringify(statuses, null, 2)}\n`)
}

module.exports = { CASES, FIXTURES, expectedFor, runCase, writeExpected }
