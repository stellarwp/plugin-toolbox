'use strict'

const { describe, it } = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const report = require('../../../.github/actions/plugin-check-report/plugin-check-report.js')
const { CASES, expectedFor, runCase } = require('./golden.js')

const FIXTURES = path.join(__dirname, 'fixtures')
const BASELINE = path.join(FIXTURES, 'baseline.json')

const ESCAPE = 'WordPress.Security.EscapeOutput.OutputNotEscaped'
const DIRECT_QUERY = 'WordPress.DB.DirectDatabaseQuery.DirectQuery'

/**
 * Runs the compare in this process, with an environment built from scratch rather than copied from
 * process.env. In CI the test runner has GITHUB_STEP_SUMMARY, GITHUB_RUN_ID and friends set, and the
 * compare would append its summary to this repository's own job and link to this run. Messages go
 * to captured lines, never to the runner's log, so a passing test run does not annotate itself.
 *
 * @param {string[]} args Arguments of the compare, usually a results file.
 * @param {object}   env  The environment to add.
 *
 * @returns {{status: number, stdout: string, stderr: string}} The exit status and both streams.
 */
function execute(args, env) {
  const stdout = []
  const stderr = []
  const log = report.commandLog({ out: (line) => stdout.push(`${line}\n`), err: (line) => stderr.push(`${line}\n`) })

  return { status: report.compare({ args, env, log }), stdout: stdout.join(''), stderr: stderr.join('') }
}

/**
 * Runs the compare the way the action does, and returns what it printed and wrote.
 *
 * @param {string[]} args Arguments after `--comment-file`, usually a results file.
 * @param {object}   env  Extra environment, such as PLUGIN_CHECK_BASELINE.
 *
 * @returns {{status: number, stdout: string, stderr: string, comment: string, summary: string}}
 *          The exit status, both streams, the comment file and the job summary it wrote.
 */
function compareWith(args, env = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-check-compare-'))
  const comment = path.join(dir, 'comment.md')
  const summary = path.join(dir, 'summary.md')

  const result = execute(['--comment-file', comment, ...args], {
    GITHUB_STEP_SUMMARY: summary,
    // A path that does not exist, so a test that wants no baseline gets none, instead of a
    // baseline.json some earlier local run left next to the script.
    PLUGIN_CHECK_BASELINE: path.join(dir, 'no-baseline.json'),
    ...env,
  })

  const read = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '')

  return { ...result, comment: read(comment), summary: read(summary) }
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
 * A results file with the lines given, in a temporary folder.
 *
 * @param {string} text The file's text.
 *
 * @returns {string} The path of the file.
 */
function resultsFile(text) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-check-results-')), 'results.txt')
  fs.writeFileSync(file, text)

  return file
}

/**
 * A results file with the results given as one file's JSON line.
 *
 * @param {object[]} results The results.
 *
 * @returns {string} The path of the file.
 */
function resultsOf(results) {
  return resultsFile(`FILE: plugin.php\n${JSON.stringify(results)}\n`)
}

/**
 * A results file with one new ERROR code per entry, for the tests about long lists.
 *
 * @param {number} codes How many different codes to write.
 *
 * @returns {string} The path of the file.
 */
function resultsWithNewCodes(codes) {
  return resultsOf(
    Array.from({ length: codes }, (_, index) => ({
      line: index + 1,
      column: 1,
      type: 'ERROR',
      code: `Test.Rule.Number${index + 1}`,
      message: 'A rule added for the test.',
      docs: '',
    }))
  )
}

/**
 * A baseline file with the text given, in a temporary folder.
 *
 * @param {string|object} content The file's text, or a value to write as JSON.
 *
 * @returns {string} The path of the file.
 */
function baselineFile(content) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-check-baseline-')), 'baseline.json')
  fs.writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content))

  return file
}

describe('plugin-check-report compare, pinned output', () => {
  for (const spec of CASES) {
    it(`prints what the original script printed for ${spec.name}`, () => {
      assert.deepStrictEqual(runCase(spec, execute), expectedFor(spec.name))
    })
  }
})

describe('plugin-check-report compare', () => {
  describe('results it refuses', () => {
    it('fails when the results file is missing', () => {
      const run = compareWith([fixture('does-not-exist.txt')])

      assert.equal(run.status, 1)
      assert.match(run.stdout, /::error title=Plugin Check::Results file not found/)
      assert.equal(run.comment, '', 'no comment body, so the workflow writes "could not run"')
    })

    it('fails when the results file is not Plugin Check output', () => {
      const run = compareWith([fixture('garbage.txt')])

      assert.equal(run.status, 1)
      assert.match(run.stdout, /is not Plugin Check output.*First unexpected line: <!DOCTYPE html>/)
    })

    it('fails when the results file is empty', () => {
      const run = compareWith([fixture('empty.txt')])

      assert.equal(run.status, 1)
      assert.match(run.stdout, /has no Plugin Check output/)
    })

    it('fails on a mode it does not know, before reading anything', () => {
      const run = compareWith([fixture('clean.txt')], { PLUGIN_CHECK_MODE: 'strcit' })

      assert.equal(run.status, 1)
      assert.match(run.stdout, /Unknown mode 'strcit'/)
    })

    it('refuses the old name ratchet, and says what to use', () => {
      const run = compareWith([fixture('clean.txt')], { PLUGIN_CHECK_MODE: 'ratchet' })

      assert.equal(run.status, 1)
      assert.match(
        run.stdout,
        /::error title=Plugin Check::Unknown mode 'ratchet'\. Use 'baseline' or 'strict'\. 'ratchet' is now called 'baseline'\./
      )
      assert.equal(run.comment, '')
    })

    it('runs baseline mode when the mode is not set, and when it is empty', () => {
      for (const env of [{}, { PLUGIN_CHECK_MODE: '' }, { PLUGIN_CHECK_MODE: 'baseline' }]) {
        const run = compareWith([fixture('errors-up.txt')], { ...env, PLUGIN_CHECK_BASELINE: BASELINE })

        assert.equal(run.status, 1, JSON.stringify(env))
        assert.match(run.comment, /rule has more errors than the baseline allows/)
      }
    })

    it('fails on a mode it does not know, even with a missing results file', () => {
      const run = compareWith([fixture('does-not-exist.txt')], { PLUGIN_CHECK_MODE: 'strcit' })

      assert.match(run.stdout, /Unknown mode/)
      assert.doesNotMatch(run.stdout, /Results file not found/)
    })

    it('fails with a usage message when no results file is given', () => {
      const run = execute([], {})

      assert.equal(run.status, 1)
      assert.match(run.stderr, /Usage/)
    })

    it('fails when --comment-file has no path', () => {
      for (const args of [['--comment-file'], ['--comment-file', '']]) {
        const run = execute(args, {})

        assert.equal(run.status, 1, args.join(' '))
        assert.match(run.stderr, /--comment-file needs a path/)
      }
    })

    it('cuts the first unexpected line to 200 bytes', () => {
      const run = compareWith([resultsFile(`${'x'.repeat(300)}\n`)])

      assert.equal(run.status, 1)
      assert.match(run.stdout, new RegExp(`First unexpected line: x{200}\\n`))
    })

    it('does not count a line of white space as unexpected', () => {
      const run = compareWith([resultsFile('FILE: plugin.php\n  \t \n[]\n\n')])

      assert.equal(run.status, 0)
    })

    it('fails when a results line is not JSON', () => {
      const run = compareWith([resultsFile('FILE: plugin.php\n[{"type":"ERROR"\n')])

      assert.equal(run.status, 5)
      assert.match(run.stderr, /parse error/)
      assert.equal(run.comment, '')
    })

    it('fails when a counted result has no rule code', () => {
      for (const code of [undefined, null, 5, true, { a: 1 }]) {
        const run = compareWith([resultsOf([{ type: 'ERROR', code }])])

        assert.equal(run.status, 5, String(code))
        assert.match(run.stderr, /has no rule code/)
      }
    })

    it('fails when a result is not an object, but skips null', () => {
      for (const item of [1, 'x', [1], true]) {
        assert.equal(compareWith([resultsOf([item])]).status, 5, JSON.stringify(item))
      }

      assert.equal(compareWith([resultsOf([null])]).status, 0)
    })

    it('ignores results that are neither ERROR nor WARNING', () => {
      const run = compareWith([resultsOf([{ type: 'INFO' }, { type: 'error', code: 'a' }])])

      assert.equal(run.status, 0)
      assert.match(run.comment, /\| Errors {3}\| 0 \|/)
    })

    it('reads several lists written on one line', () => {
      const run = compareWith([resultsFile('FILE: a.php\n[{"type":"ERROR","code":"a"}] [{"type":"ERROR","code":"b"}]\n')], {
        PLUGIN_CHECK_MODE: 'strict',
      })

      assert.match(run.stdout, /2 errors found/)
    })
  })

  describe('--update', () => {
    it('writes the counts per rule code', () => {
      const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-check-update-')), 'baseline.json')
      const run = compareWith(['--update', fixture('errors-up.txt')], { PLUGIN_CHECK_BASELINE: out })

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
      const run = compareWith(['--update', fixture('clean.txt')], { PLUGIN_CHECK_BASELINE: out })

      assert.equal(run.status, 0)
      assert.deepEqual(JSON.parse(fs.readFileSync(out, 'utf8')), { errors: {}, warnings: {} })
    })

    it('writes no comment and no summary', () => {
      const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-check-update-')), 'baseline.json')
      const run = compareWith(['--update', fixture('errors-up.txt')], { PLUGIN_CHECK_BASELINE: out })

      assert.equal(run.comment, '')
      assert.equal(run.summary, '')
    })

    it('fails, with the reason, when the folder of the file does not exist', () => {
      const run = compareWith(['--update', fixture('clean.txt')], { PLUGIN_CHECK_BASELINE: '/nonexistent/folder/baseline.json' })

      assert.equal(run.status, 1)
      assert.match(run.stderr, /Could not write \/nonexistent\/folder\/baseline\.json/)
    })
  })

  describe('compare in baseline mode', () => {
    it('passes a clean run with no baseline, with a warning and the one-column table', () => {
      const run = compareWith([fixture('clean.txt')])

      assert.equal(run.status, 0)
      assert.match(
        run.stdout,
        /::warning title=Plugin Check::No baseline file at no-baseline\.json, so nothing was compared\. To start one, commit the baseline\.json from this run's plugin-check-report artifact as no-baseline\.json\./
      )
      assert.match(run.comment, /⚠️ Plugin Check ran, but there is no baseline file yet/)
      assert.match(run.comment, /\| Errors {3}\| 0 \|/)
      assert.doesNotMatch(run.comment, /Change/)
    })

    it('says nothing about a missing baseline file in strict mode, which does not use one', () => {
      const run = compareWith([fixture('clean.txt')], { PLUGIN_CHECK_MODE: 'strict' })

      assert.equal(run.status, 0)
      assert.doesNotMatch(run.stdout, /::warning/)
      assert.match(run.stdout, /No baseline file\. Strict mode does not need one\./)
      assert.match(run.comment, /✅ Plugin Check passed: no errors/)
      assert.equal(run.summary, run.comment, 'nothing to update, so the summary is the comment')
    })

    it('asks for the baseline file to be lowered when an error count went down', () => {
      const run = compareWith([fixture('errors-down.txt')], { PLUGIN_CHECK_BASELINE: BASELINE })

      assert.equal(run.status, 0)
      assert.match(
        run.stdout,
        /::notice title=Plugin Check::Error counts went down\. Lower the baseline so they cannot come back: commit the baseline\.json from this run's plugin-check-report artifact as baseline\.json\./
      )
      assert.match(run.comment, /Rules that went down: \d+\. Update the baseline file, see the job summary\./)
    })

    it('does not ask for an update when only warnings went down, or in strict mode', () => {
      const warningsDown = baselineFile({ ...JSON.parse(fs.readFileSync(BASELINE, 'utf8')), warnings: { [DIRECT_QUERY]: 9 } })
      const quiet = compareWith([fixture('same-as-baseline.txt')], { PLUGIN_CHECK_BASELINE: warningsDown })

      assert.match(quiet.comment, /Rules that went down: 1\.\n/)
      assert.doesNotMatch(quiet.stdout, /Error counts went down/)
      assert.equal(quiet.summary, quiet.comment)

      const strict = compareWith([fixture('errors-down.txt')], { PLUGIN_CHECK_BASELINE: BASELINE, PLUGIN_CHECK_MODE: 'strict' })

      assert.doesNotMatch(strict.stdout, /Error counts went down/)
      assert.doesNotMatch(strict.comment, /Update the baseline file/)
    })

    it('puts the command to update the baseline in the job summary, not in the comment', () => {
      const run = compareWith([fixture('errors-down.txt')], {
        PLUGIN_CHECK_BASELINE: BASELINE,
        GITHUB_RUN_ID: '42',
        GITHUB_REPOSITORY: 'example-org/my-plugin',
        GITHUB_SERVER_URL: 'https://github.com',
      })

      assert.ok(run.summary.startsWith(run.comment))
      assert.match(run.summary, /Error counts went down\. To lower the baseline, replace baseline\.json with the file from this run:/)
      assert.match(run.summary, /gh run download 42 --repo example-org\/my-plugin --name plugin-check-report --dir \/tmp\/plugin-check/)
      assert.match(run.summary, /cp \/tmp\/plugin-check\/baseline\.json baseline\.json/)
      assert.doesNotMatch(run.comment, /gh run download/)
    })

    it('tells the author how to raise a count on purpose when the check fails', () => {
      const run = compareWith([fixture('errors-up.txt')], { PLUGIN_CHECK_BASELINE: BASELINE })

      assert.equal(run.status, 1)
      assert.match(run.summary, /raise their counts in baseline\.json in this pull request, so reviewers see it/)
      assert.match(run.summary, /gh run download <run-id> --repo <owner>\/<repo> /, 'placeholders outside a run')
    })

    it('fails with the file named, as an error annotation, when the baseline file is not valid', () => {
      const cases = {
        'not JSON': ['{"errors": ', /it is not JSON: /],
        'a merge conflict': ['<<<<<<< HEAD\n{"errors":{}}\n=======\n{"errors":{"a":1}}\n>>>>>>> branch\n', /it is not JSON: /],
        'the wrong shape': ['[1]', /it must be an object with "errors" and "warnings"\./],
      }

      for (const [what, [content, reason]] of Object.entries(cases)) {
        const run = compareWith([fixture('clean.txt')], { PLUGIN_CHECK_BASELINE: baselineFile(content) })

        assert.notEqual(run.status, 0, what)
        assert.match(run.stdout, /::error title=Plugin Check::The baseline file baseline\.json is not valid: /, what)
        assert.match(run.stdout, reason, what)
        assert.match(run.stdout, /[.!?] Fix it, or replace it with the baseline\.json from this run's plugin-check-report artifact\./, what)
        assert.equal(run.comment, '', what)
      }
    })

    it('passes when every count matches the baseline', () => {
      const run = compareWith([fixture('same-as-baseline.txt')], { PLUGIN_CHECK_BASELINE: BASELINE })

      assert.equal(run.status, 0)
      assert.match(run.comment, /✅ Plugin Check passed/)
      assert.match(run.comment, /\| Errors {3}\| 3 \| 3 \| ±0 \|/)
    })

    it('fails when a rule has more errors than the baseline', () => {
      const run = compareWith([fixture('errors-up.txt')], { PLUGIN_CHECK_BASELINE: BASELINE })

      assert.equal(run.status, 1)
      assert.match(run.stdout, new RegExp(`::error title=Plugin Check::${ESCAPE} has 3 errors, the baseline has 2`))
      assert.match(run.comment, /❌ Plugin Check failed: 1 rule has more errors than the baseline allows/)
      assert.match(run.comment, new RegExp(`Went up: \`${ESCAPE}\` \\(\\+1\\)`))
    })

    it('fails when a rule goes up even though the total stays the same', () => {
      const run = compareWith([fixture('rule-up-total-same.txt')], { PLUGIN_CHECK_BASELINE: BASELINE })

      assert.equal(run.status, 1)
      assert.match(run.comment, /\| Errors {3}\| 3 \| 3 \| ±0 \|/)
      assert.match(run.comment, /Rules that went down: 1\./)
    })

    it('passes with a notice when errors go down', () => {
      const run = compareWith([fixture('errors-down.txt')], { PLUGIN_CHECK_BASELINE: BASELINE })

      assert.equal(run.status, 0)
      assert.match(run.stdout, new RegExp(`::notice title=Plugin Check::${ESCAPE} \\(errors\\) went down from 2 to 1`))
      assert.match(run.comment, /\| Errors {3}\| 2 \| 3 \| -1 \|/)
    })

    it('passes with a notice when only warnings go up', () => {
      const run = compareWith([fixture('warnings-up.txt')], { PLUGIN_CHECK_BASELINE: BASELINE })

      assert.equal(run.status, 0)
      assert.match(run.stdout, /Warnings do not fail the check/)
      assert.match(run.comment, new RegExp(`Went up: \`${DIRECT_QUERY}\` warning \\(\\+2\\)`))
    })

    it('treats an empty baseline file, and null, as no counts at all', () => {
      for (const content of ['', 'null', '  \n']) {
        const run = compareWith([fixture('errors-up.txt')], { PLUGIN_CHECK_BASELINE: baselineFile(content) })

        assert.equal(run.status, 1, JSON.stringify(content))
        assert.match(run.stdout, /has 3 errors, the baseline has 0/)
      }
    })

    it('treats a missing kind, and a null or false count, as zero', () => {
      const run = compareWith([fixture('errors-up.txt')], {
        PLUGIN_CHECK_BASELINE: baselineFile({ errors: { [ESCAPE]: null } }),
      })

      assert.match(run.stdout, /has 3 errors, the baseline has 0/)
    })

    it('reads only the first value of a baseline file', () => {
      const run = compareWith([fixture('same-as-baseline.txt')], {
        PLUGIN_CHECK_BASELINE: baselineFile(`${fs.readFileSync(BASELINE, 'utf8')}\n{"errors":{"x":9}}`),
      })

      assert.equal(run.status, 0)
    })

    it('fails, with a reason, on a baseline that cannot be compared', () => {
      const cases = [
        ['not json', 2],
        ['[]', 5],
        ['5', 5],
        ['{"errors":5}', 5],
        ['{"errors":[]}', 5],
        ['{"errors":false}', 5],
        ['{"errors":{"a":"2"}}', 5],
        ['{"errors":{"a":true}}', 5],
        ['{"errors":{"a":1.5}}', 1],
      ]

      for (const [content, status] of cases) {
        const run = compareWith([resultsOf([{ type: 'ERROR', code: 'a' }])], { PLUGIN_CHECK_BASELINE: baselineFile(content) })

        assert.equal(run.status, status, content)
        assert.equal(run.comment, '', content)
      }
    })

    it('fails on a count too large to compare exactly, instead of printing another number', () => {
      for (const content of ['{"errors":{"a":9007199254740993}}', '{"warnings":{"a":1e300}}', '{"errors":{"a":-9007199254740993}}']) {
        const run = compareWith([resultsOf([{ type: 'ERROR', code: 'a' }])], { PLUGIN_CHECK_BASELINE: baselineFile(content) })

        assert.equal(run.status, 5, content)
        assert.match(run.stdout, /::error title=Plugin Check::The baseline file baseline\.json is not valid: .*more than 9007199254740991, which cannot be compared exactly/)
        assert.equal(run.comment, '', content)
      }

      const largest = compareWith([resultsOf([{ type: 'ERROR', code: 'a' }])], {
        PLUGIN_CHECK_BASELINE: baselineFile('{"errors":{"a":9007199254740991}}'),
      })
      assert.equal(largest.status, 0, 'the largest exact number still works')
      assert.match(largest.comment, /\| 1 \| 9007199254740991 \| -9007199254740990 \|/)
    })

    it('counts a rule with an empty code like any other', () => {
      const run = compareWith([resultsOf([{ type: 'ERROR', code: '' }, { type: 'ERROR', code: '' }])], {
        PLUGIN_CHECK_BASELINE: baselineFile({ errors: { '': 1 }, warnings: {} }),
      })

      assert.equal(run.status, 1)
      assert.match(run.comment, /\| Errors {3}\| 2 \| 1 \| \+1 \|/)
    })

    it('shows a rule code on one line, with a tab or a new line written out', () => {
      const run = compareWith([resultsOf([{ type: 'ERROR', code: 'a\tb\\c' }])], { PLUGIN_CHECK_BASELINE: baselineFile({}) })

      assert.match(run.stdout, /::error title=Plugin Check::a\\tb\\\\c has 1 errors/)
    })

    it('takes the links from GITHUB_RUN_ID when RUN_URL is not set', () => {
      const run = compareWith([fixture('clean.txt')], {
        GITHUB_RUN_ID: '42',
        GITHUB_SERVER_URL: 'https://github.com',
        GITHUB_REPOSITORY: 'example-org/my-plugin',
      })

      assert.match(run.comment, /📎 \[Run\]\(https:\/\/github\.com\/example-org\/my-plugin\/actions\/runs\/42\)/)
    })

    it('shows the results file for a run on a developer machine', () => {
      const run = compareWith([fixture('clean.txt')])

      assert.match(run.comment, /📎 Local run, see .*clean\.txt/)
    })
  })

  describe('compare in strict mode', () => {
    it('fails on any error, even with no baseline', () => {
      const run = compareWith([fixture('errors-down.txt')], { PLUGIN_CHECK_MODE: 'strict' })

      assert.equal(run.status, 1)
      assert.match(run.stdout, /2 errors found\. Strict mode fails on any error/)
      assert.match(run.comment, /❌ Plugin Check failed: 2 errors, and strict mode allows none/)
    })

    it('fails on errors that went down, which baseline mode would pass', () => {
      const run = compareWith([fixture('errors-down.txt')], {
        PLUGIN_CHECK_MODE: 'strict',
        PLUGIN_CHECK_BASELINE: BASELINE,
      })

      assert.equal(run.status, 1)
    })

    it('passes a clean run', () => {
      const run = compareWith([fixture('clean.txt')], { PLUGIN_CHECK_MODE: 'strict' })

      assert.equal(run.status, 0)
      assert.match(run.comment, /✅ Plugin Check passed: no errors/)
    })

    it('passes a run with warnings only', () => {
      const lines = fs
        .readFileSync(fixture('warnings-up.txt'), 'utf8')
        .split('\n')
        .map((line) => {
          if (!line.startsWith('[')) {
            return line
          }

          return JSON.stringify(JSON.parse(line).filter((result) => result.type === 'WARNING'))
        })

      const run = compareWith([resultsFile(lines.join('\n'))], { PLUGIN_CHECK_MODE: 'strict' })

      assert.equal(run.status, 0)
    })

    it('prints the per-rule messages before the strict one', () => {
      const run = compareWith([fixture('errors-up.txt')], { PLUGIN_CHECK_MODE: 'strict', PLUGIN_CHECK_BASELINE: BASELINE })
      const lines = run.stdout.split('\n')

      assert.match(lines[0], /has 3 errors, the baseline has 2/)
      assert.match(lines[1], /4 errors found\. Strict mode/)
    })
  })

  describe('the comment', () => {
    it('starts with the default marker', () => {
      const run = compareWith([fixture('clean.txt')])

      assert.equal(run.comment.split('\n')[0], '<!-- plugin-check -->')
    })

    it('starts with the marker the workflow passes', () => {
      const marker = '<!-- plugin-check:example-org/my-plugin -->'
      const run = compareWith([fixture('clean.txt')], { COMMENT_MARKER: marker })

      assert.equal(run.comment.split('\n')[0], marker)
    })

    it('lists at most five rules and never grows past fifteen lines', () => {
      const run = compareWith([resultsWithNewCodes(7)], { PLUGIN_CHECK_BASELINE: BASELINE })

      assert.equal(run.status, 1)
      assert.match(run.comment, /Went up \(top 5 of 7\)/)
      assert.doesNotMatch(run.comment, /Number6/)
      assert.ok(run.comment.trimEnd().split('\n').length <= 15)
    })

    it('cuts a comment to fifteen lines when a value holds line breaks, and drops the empty end', () => {
      const marker = `${'\n'.repeat(20)}end`
      const run = compareWith([fixture('clean.txt')], { COMMENT_MARKER: marker })

      // The first fifteen lines are all empty, so nothing is left once the empty end is dropped.
      assert.equal(run.comment, '\n')
    })

    it('writes the same text to the job summary', () => {
      const run = compareWith([fixture('same-as-baseline.txt')], { PLUGIN_CHECK_BASELINE: BASELINE })

      assert.equal(run.summary, run.comment)
    })

    it('writes a badge under the status line', () => {
      const run = compareWith([fixture('clean.txt')], { COMMENT_BADGE: 'https://example.test/badge.svg' })

      assert.match(run.comment, /\n!\[Plugin Check finished\]\(https:\/\/example\.test\/badge\.svg\)\n/)
    })

    it('fails, with the reason, when the comment file cannot be written', () => {
      const run = execute(['--comment-file', '/nonexistent/folder/comment.md', fixture('clean.txt')], { RUN_URL: 'u' })

      assert.equal(run.status, 1)
      assert.match(run.stderr, /Could not write \/nonexistent\/folder\/comment\.md/)
    })
  })
})

describe('compare with no baseline file, in a pull request', () => {
  // The workflow checked the target branch's commit in the same run, and passes its results.
  const baseResults = () => fixture('same-as-baseline.txt')

  it('compares with the target branch and says so', () => {
    const run = compareWith([fixture('errors-up.txt')], { PLUGIN_CHECK_BASE_RESULTS: baseResults(), PLUGIN_CHECK_BASE_REQUIRED: 'true' })

    assert.equal(run.status, 1)
    assert.match(
      run.stdout,
      /::warning title=Plugin Check::No baseline file at no-baseline\.json, so the target branch was checked too, and its results are the baseline for this run\. That makes the run slower\. To stop it, commit the baseline\.json from this run's plugin-check-report artifact as no-baseline\.json\./
    )
    assert.match(run.stdout, new RegExp(`::error title=Plugin Check::${ESCAPE} has 3 errors, the baseline has 2`))
    assert.match(run.comment, /\| Now \| Target branch \| Change \|/)
    assert.match(run.comment, /ℹ️ There is no baseline file, so the baseline is the target branch's results\. See the job summary to add one\./)
    assert.match(run.summary, /There is no no-baseline\.json yet\. To start one, add the file from this run:/)
  })

  it('passes when the pull request has no more errors than the target branch', () => {
    const run = compareWith([fixture('same-as-baseline.txt')], { PLUGIN_CHECK_BASE_RESULTS: baseResults(), PLUGIN_CHECK_BASE_REQUIRED: 'true' })

    assert.equal(run.status, 0)
    assert.match(run.comment, /✅ Plugin Check passed/)
    assert.match(run.comment, /\| Errors {3}\| 3 \| 3 \| ±0 \|/)
  })

  it('does not ask to lower a baseline file that does not exist', () => {
    const run = compareWith([fixture('errors-down.txt')], { PLUGIN_CHECK_BASE_RESULTS: baseResults(), PLUGIN_CHECK_BASE_REQUIRED: 'true' })

    assert.equal(run.status, 0)
    assert.match(run.stdout, /went down from/, 'the per-rule notices stay')
    assert.doesNotMatch(run.stdout, /Error counts went down/)
    assert.doesNotMatch(run.comment, /Update the baseline file/)
  })

  it('keeps the comment within fifteen lines, links last, with the note', () => {
    const run = compareWith([resultsWithNewCodes(7)], { PLUGIN_CHECK_BASE_RESULTS: baseResults(), PLUGIN_CHECK_BASE_REQUIRED: 'true' })
    const lines = run.comment.replace(/\n$/, '').split('\n')

    assert.ok(lines.length <= 15, `${lines.length} lines`)
    assert.match(lines.at(-1), /^📎 /)
    assert.ok(lines.some((line) => line.startsWith('ℹ️ There is no baseline file')))
  })

  it('fails, never passes, when the target branch could not be checked', () => {
    for (const env of [{}, { PLUGIN_CHECK_BASE_RESULTS: '/nonexistent/base-results.txt' }]) {
      const run = compareWith([fixture('clean.txt')], { PLUGIN_CHECK_BASE_REQUIRED: 'true', ...env })

      assert.equal(run.status, 1)
      assert.match(run.stdout, /::error title=Plugin Check::The target branch could not be checked, so there is nothing to compare with\./)
      assert.equal(run.comment, '', 'no comment body, so the workflow writes "could not run"')
    }
  })

  it('fails when the results of the target branch are not Plugin Check output', () => {
    const run = compareWith([fixture('clean.txt')], { PLUGIN_CHECK_BASE_RESULTS: fixture('garbage.txt'), PLUGIN_CHECK_BASE_REQUIRED: 'true' })

    assert.equal(run.status, 1)
    assert.match(run.stdout, /::error title=Plugin Check::The results of the target branch cannot be used\. The results file is not Plugin Check output/)
  })

  it('uses the baseline file when there is one, and ignores the target branch', () => {
    const run = compareWith([fixture('errors-up.txt')], {
      PLUGIN_CHECK_BASELINE: BASELINE,
      PLUGIN_CHECK_BASE_RESULTS: fixture('garbage.txt'),
      PLUGIN_CHECK_BASE_REQUIRED: 'true',
    })

    assert.equal(run.status, 1)
    assert.match(run.comment, /\| Now \| Baseline \| Change \|/)
    assert.doesNotMatch(run.stdout, /target branch was checked/)
  })

  it('leaves strict mode alone, which needs no baseline', () => {
    const run = compareWith([fixture('clean.txt')], {
      PLUGIN_CHECK_MODE: 'strict',
      PLUGIN_CHECK_BASE_RESULTS: fixture('garbage.txt'),
      PLUGIN_CHECK_BASE_REQUIRED: 'true',
    })

    assert.equal(run.status, 0)
    assert.match(run.stdout, /No baseline file\. Strict mode does not need one\./)
    assert.doesNotMatch(run.stdout, /target branch/)
  })
})

describe('the note about a pull request that changes the baseline file', () => {
  it('says so under the table, and keeps the comment within fifteen lines', () => {
    const run = compareWith([resultsWithNewCodes(7)], { PLUGIN_CHECK_BASELINE: BASELINE, PLUGIN_CHECK_BASELINE_CHANGED: 'true' })
    const lines = run.comment.replace(/\n$/, '').split('\n')

    assert.ok(lines.includes('ℹ️ This pull request changes the baseline file.'))
    assert.ok(lines.length <= 15, `${lines.length} lines`)
    assert.match(lines.at(-1), /^📎 /)
  })

  it('says nothing when the file is not changed, or does not exist', () => {
    const same = compareWith([fixture('same-as-baseline.txt')], { PLUGIN_CHECK_BASELINE: BASELINE, PLUGIN_CHECK_BASELINE_CHANGED: 'false' })
    const none = compareWith([fixture('clean.txt')], { PLUGIN_CHECK_BASELINE_CHANGED: 'true' })

    assert.doesNotMatch(same.comment, /changes the baseline file/)
    assert.doesNotMatch(none.comment, /changes the baseline file/)
  })
})

describe('the baseline file text', () => {
  it('sorts codes by Unicode code point, not by UTF-16 unit', () => {
    const counts = report.countPerCode([
      { type: 'ERROR', code: '😀' },
      { type: 'ERROR', code: '￿' },
      { type: 'ERROR', code: '10' },
      { type: 'ERROR', code: '9' },
    ])

    assert.deepEqual([...counts.errors.keys()], ['10', '9', '￿', '😀'])
  })

  it('writes DEL as \\u007f and ends with one new line', () => {
    const text = report.formatBaseline(report.countPerCode([{ type: 'ERROR', code: 'a\x7fb' }]))

    assert.equal(text, '{\n  "errors": {\n    "a\\u007fb": 1\n  },\n  "warnings": {}\n}\n')
  })

  it('keeps a code such as __proto__ as a code', () => {
    const counts = report.countPerCode([{ type: 'WARNING', code: '__proto__' }])

    assert.equal(report.formatBaseline(counts), '{\n  "errors": {},\n  "warnings": {\n    "__proto__": 1\n  }\n}\n')
  })
})

describe('the compare command line', () => {
  /**
   * Runs the command line in a new folder, so the default baseline path lands there.
   *
   * @param {string[]} argv The arguments after the script name.
   *
   * @returns {Promise<{status: number, lines: string[], dir: string}>} The status, what it printed and the folder.
   */
  async function inNewFolder(argv) {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-check-cli-')))
    const before = process.cwd()
    const lines = []

    process.chdir(dir)
    try {
      const status = await report.main(argv, {}, { out: (line) => lines.push(line), err: (line) => lines.push(line) })

      return { status, lines, dir }
    } finally {
      process.chdir(before)
    }
  }

  const pinned = () => fs.readFileSync(path.join(FIXTURES, 'expected', 'update-errors-up.json'), 'utf8')

  it('writes .plugin-check-baseline.json in the current folder by default', async () => {
    const { status, lines, dir } = await inNewFolder(['compare', '--update', fixture('errors-up.txt')])

    assert.equal(status, 0)
    assert.equal(fs.readFileSync(path.join(dir, '.plugin-check-baseline.json'), 'utf8'), pinned())
    assert.match(lines.join('\n'), /Wrote .*\.plugin-check-baseline\.json: 2 error codes, 1 warning codes/)
  })

  it('takes `update` as a short name for `compare --update`', async () => {
    const { status, dir } = await inNewFolder(['update', fixture('errors-up.txt')])

    assert.equal(status, 0)
    assert.equal(fs.readFileSync(path.join(dir, '.plugin-check-baseline.json'), 'utf8'), pinned())
  })

  it('compares with the file it wrote', async () => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-check-cli-')))
    fs.writeFileSync(path.join(dir, '.plugin-check-baseline.json'), pinned())
    const before = process.cwd()
    const lines = []

    process.chdir(dir)
    try {
      const status = await report.main(['compare', fixture('errors-up.txt')], {}, { out: (line) => lines.push(line), err: (line) => lines.push(line) })

      assert.equal(status, 0)
      assert.match(lines.join('\n'), /within the baseline/)
    } finally {
      process.chdir(before)
    }
  })
})
