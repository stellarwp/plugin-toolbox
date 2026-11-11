'use strict'

/**
 * Compares WordPress.org Plugin Check results with a baseline file.
 *
 * The baseline is the count of errors and warnings per rule code, kept in a file the repository
 * commits, `.plugin-check-baseline.json`. A pull request is compared with the file in its own
 * checkout, so a change to the baseline shows in the diff.
 *
 * One job:
 *   compare  Counts the results, compares them with the baseline file, writes the pull request
 *            comment and the job summary, and says whether the check passes. With `--update` it only
 *            writes the baseline file for this run.
 *
 * The small functions are pure, so a test can call them with plain values. The same code runs in
 * three places: the action's steps (`runPaths`, `runUpdate`, `runCompare`, through
 * actions/github-script), a command line (`node plugin-check-report.js compare ...`), and the tests.
 *
 * Every function that decides an exit status returns it: 0 passes, 1 is a failed check or a missing
 * file, another number is a file that could not be read as it should be. A step sets
 * `process.exitCode` from it, so the step fails without github-script adding a second error.
 */

const fs = require('node:fs')
const path = require('node:path')

/** Title of every annotation. */
const TITLE = 'Plugin Check'

/** The baseline file a repository commits, at its root. */
const BASELINE_FILE = '.plugin-check-baseline.json'

/** The pull request comment must stay short. Everything else is behind the links. */
const MAX_COMMENT_LINES = 15
const MAX_RULES_LISTED = 5

/** The first unexpected line of a results file is shown cut to this many bytes. */
const MAX_UNEXPECTED_BYTES = 200

const MODES = ['baseline', 'strict']
const DEFAULT_MODE = 'baseline'

/** A line of Plugin Check output: a file name, a JSON array of its results, or the clean message. */
const KNOWN_LINE = /^(FILE: |\[|Success:)/
const OUTPUT_LINE = /^(FILE: |Success:)/
/** Blank as `grep '[[:space:]]'` reads it: ASCII white space only. */
const BLANK_LINE = /^[ \t\n\v\f\r]*$/

/**
 * A failure the person running the check has to fix: the message is shown, the step fails with the
 * exit code, and no stack trace helps.
 */
class CheckFailure extends Error {
  /**
   * @param {string} message  What went wrong, in plain words.
   * @param {number} exitCode The exit status for the step.
   * @param {boolean} annotate Show the message as an error annotation, not only in the log.
   */
  constructor(message, exitCode = 1, annotate = false) {
    super(message)
    this.name = 'CheckFailure'
    this.exitCode = exitCode
    this.annotate = annotate
  }
}

/**
 * Orders two strings by Unicode code point. JavaScript's default order compares
 * UTF-16 units, which puts an emoji before U+FFFF; UTF-8 bytes sort by code point.
 *
 * @param {string} a First string.
 * @param {string} b Second string.
 *
 * @returns {number} Negative, zero or positive.
 */
function compareCodePoints(a, b) {
  return Buffer.compare(Buffer.from(a), Buffer.from(b))
}

/**
 * Cuts a string to a number of UTF-8 bytes. A character cut in the middle shows as U+FFFD.
 *
 * @param {string} text  The text.
 * @param {number} bytes The most bytes to keep.
 *
 * @returns {string} The text, or its first bytes.
 */
function cutBytes(text, bytes) {
  const buffer = Buffer.from(text)

  return buffer.length <= bytes ? text : buffer.subarray(0, bytes).toString('utf8')
}

/**
 * Splits a run of JSON values written one after another: whitespace between values, any
 * number of them.
 *
 * @param {string} text The text.
 *
 * @throws {CheckFailure} When it is not JSON.
 *
 * @returns {Array} The values, in order.
 */
function readJsonValues(text) {
  const values = []
  let position = 0

  while (true) {
    while (position < text.length && /\s/.test(text[position])) {
      position++
    }
    if (position >= text.length) {
      return values
    }

    const end = endOfJsonValue(text, position)
    try {
      values.push(JSON.parse(text.slice(position, end)))
    } catch (error) {
      throw new CheckFailure(`parse error: ${error.message}`, 2)
    }
    position = end
  }
}

/**
 * Finds where the JSON value that starts at a position ends.
 *
 * @param {string} text  The text.
 * @param {number} start Index of the value's first character.
 *
 * @throws {CheckFailure} When the value never ends.
 *
 * @returns {number} Index just after the value.
 */
function endOfJsonValue(text, start) {
  const first = text[start]

  if (first === '[' || first === '{') {
    let depth = 0
    let inString = false

    for (let index = start; index < text.length; index++) {
      const char = text[index]

      if (inString) {
        if (char === '\\') {
          index++
        } else if (char === '"') {
          inString = false
        }
      } else if (char === '"') {
        inString = true
      } else if (char === '[' || char === '{') {
        depth++
      } else if ((char === ']' || char === '}') && --depth === 0) {
        return index + 1
      }
    }

    throw new CheckFailure('parse error: Unfinished JSON term at EOF', 2)
  }

  const scalar = /^("(?:[^"\\]|\\.)*"|[^\s[\]{}",:]+)/.exec(text.slice(start))
  if (!scalar) {
    throw new CheckFailure('parse error: Invalid JSON', 2)
  }

  return start + scalar[0].length
}

/**
 * Why a results file cannot be Plugin Check's output, or null when it can.
 *
 * Anything else in the file (an HTML database error, a PHP fatal) means the check itself broke.
 * Without this it would count as "no results" and pass. A clean run prints "Success: ..." and a run
 * with results prints "FILE: ..." lines; an empty file means the command failed with its error on
 * stderr, which the results file does not hold.
 *
 * @param {string} text The results file.
 *
 * @returns {string|null} The message, or null.
 */
function checkResultsText(text) {
  const lines = text.split('\n')
  const unexpected = lines.find((line) => !KNOWN_LINE.test(line) && !BLANK_LINE.test(line))

  if (unexpected !== undefined) {
    return `The results file is not Plugin Check output, so the check did not run. First unexpected line: ${cutBytes(unexpected, MAX_UNEXPECTED_BYTES)}`
  }

  if (!lines.some((line) => OUTPUT_LINE.test(line))) {
    return 'The results file has no Plugin Check output, so the check did not run.'
  }

  return null
}

/**
 * The results of a file: every line that starts with `[` holds a JSON array of one file's results.
 *
 * @param {string} text The results file.
 *
 * @throws {CheckFailure} When a line is not JSON, or does not hold what Plugin Check prints.
 *
 * @returns {object[]} All results, in file order.
 */
function parseResults(text) {
  const results = []

  for (const line of text.split('\n')) {
    if (!line.startsWith('[')) {
      continue
    }

    let values
    try {
      values = readJsonValues(line)
    } catch (error) {
      throw new CheckFailure(error.message, 5)
    }

    for (const value of values) {
      if (!Array.isArray(value)) {
        throw new CheckFailure('A line of the results file does not hold a list of results.', 5)
      }
      for (const item of value) {
        results.push(item)
      }
    }
  }

  return results
}

/**
 * Counts the ERROR and WARNING results per rule code.
 *
 * A `null` item is skipped. Any other item that is not an object, and any counted
 * result whose code is not a string, fails: a rule with no name cannot be compared.
 *
 * @param {object[]} results From parseResults.
 *
 * @throws {CheckFailure} For an item or a code of the wrong type.
 *
 * @returns {{errors: Map<string, number>, warnings: Map<string, number>}} Counts, codes sorted by
 *          Unicode code point.
 */
function countPerCode(results) {
  for (const item of results) {
    if (item !== null && (typeof item !== 'object' || Array.isArray(item))) {
      throw new CheckFailure(`A Plugin Check result is not an object: ${JSON.stringify(item)}`, 5)
    }
  }

  const count = (type) => {
    const counts = new Map()

    for (const item of results) {
      if (item === null || item.type !== type) {
        continue
      }
      if (typeof item.code !== 'string') {
        throw new CheckFailure(`A Plugin Check ${type} result has no rule code: ${JSON.stringify(item)}`, 5)
      }
      counts.set(item.code, (counts.get(item.code) ?? 0) + 1)
    }

    return new Map([...counts].sort(([a], [b]) => compareCodePoints(a, b)))
  }

  return { errors: count('ERROR'), warnings: count('WARNING') }
}

/**
 * The text of a baseline file: sorted keys, two-space indent, one final newline, and DEL written as
 * \u007f. Built by hand, because an object puts keys such as "10"
 * before "9" whatever order they were added in.
 *
 * @param {{errors: Map<string, number>, warnings: Map<string, number>}} counts From countPerCode.
 *
 * @returns {string} The file's text.
 */
function formatBaseline(counts) {
  const kind = (map) => {
    if (map.size === 0) {
      return '{}'
    }

    const lines = [...map].map(([code, count]) => `    ${JSON.stringify(code).replace(/\x7f/g, '\\u007f')}: ${count}`)

    return `{\n${lines.join(',\n')}\n  }`
  }

  return `{\n  "errors": ${kind(counts.errors)},\n  "warnings": ${kind(counts.warnings)}\n}\n`
}

/**
 * Reads a baseline file.
 *
 * An empty file, or one that holds `null`, is an empty baseline. A kind that is `null` or missing
 * is empty. A count that is `null` or `false` is zero. Anything that cannot be compared fails.
 *
 * @param {string} text The baseline file.
 *
 * @throws {CheckFailure} When it is not a baseline.
 *
 * @returns {{errors: Map<string, number>, warnings: Map<string, number>}} Counts.
 */
function readBaseline(text) {
  const empty = { errors: new Map(), warnings: new Map() }
  const [value] = readJsonValues(text)

  if (value === undefined || value === null) {
    return empty
  }

  const invalid = (reason) => new CheckFailure(`The baseline is not valid: ${reason}`, 5)

  if (typeof value !== 'object' || Array.isArray(value)) {
    throw invalid('it must be an object with "errors" and "warnings".')
  }

  const counts = {}
  for (const kind of ['errors', 'warnings']) {
    const entries = value[kind]
    counts[kind] = new Map()

    if (entries === undefined || entries === null) {
      continue
    }
    if (typeof entries !== 'object' || Array.isArray(entries)) {
      throw invalid(`"${kind}" must be an object of counts per rule code.`)
    }

    for (const [code, count] of Object.entries(entries)) {
      if (count === null || count === false) {
        counts[kind].set(code, 0)
      } else if (Number.isSafeInteger(count)) {
        counts[kind].set(code, count)
      } else if (Number.isInteger(count)) {
        // JavaScript cannot hold it exactly, so a table or a message would show another number.
        throw new CheckFailure(
          `The baseline is not valid: the count of ${displayCode(code)} in "${kind}" is more than ${Number.MAX_SAFE_INTEGER}, which cannot be compared exactly.`,
          5
        )
      } else {
        throw new CheckFailure(
          `The baseline is not valid: the count of ${displayCode(code)} in "${kind}" must be a whole number.`,
          typeof count === 'number' ? 1 : 5
        )
      }
    }
  }

  return counts
}

/**
 * A rule code as it is shown in a message: a backslash, a tab, a newline and a carriage return are
 * written out.
 *
 * @param {string} code The rule code.
 *
 * @returns {string} The code, safe to show on one line.
 */
function displayCode(code) {
  return code.replace(/\\/g, '\\\\').replace(/\t/g, '\\t').replace(/\n/g, '\\n').replace(/\r/g, '\\r')
}

/**
 * One row for each rule code found in either set of counts, for errors and then warnings.
 *
 * Rules that went up come first, errors before warnings, the biggest increase first; the rest keep
 * their order by kind and code. The sort is stable, so the order is the same every time.
 *
 * @param {object} now  This run's counts.
 * @param {object} base The baseline's counts.
 *
 * @returns {{kind: string, code: string, base: number, now: number}[]} The rows.
 */
function buildRows(now, base) {
  const rows = []

  for (const kind of ['errors', 'warnings']) {
    const codes = [...new Set([...now[kind].keys(), ...base[kind].keys()])].sort(compareCodePoints)

    for (const code of codes) {
      rows.push({ kind, code, base: base[kind].get(code) ?? 0, now: now[kind].get(code) ?? 0 })
    }
  }

  return rows.sort(
    (a, b) =>
      (a.now > a.base ? 0 : 1) - (b.now > b.base ? 0 : 1) ||
      (a.kind === 'errors' ? 0 : 1) - (b.kind === 'errors' ? 0 : 1) ||
      -(a.now - a.base) - -(b.now - b.base)
  )
}

/**
 * Judges the rows: which messages to print, the totals, and whether the check fails.
 *
 * @param {object}  input
 * @param {object[]} input.rows       From buildRows.
 * @param {string}  input.mode        `baseline` or `strict`.
 * @param {boolean} input.noBaseline  There was nothing to compare with: only the totals count.
 * @param {string}  input.baselineName The baseline file's name, for the hint to update it.
 * @param {boolean} input.fromFile    The baseline is the committed file, which can be lowered.
 *
 * @returns {object} `messages` (`{level, text}` in print order), `totals`, `wentUp`, `wentDown`,
 *          `errorsDown` (how many rules have fewer errors), `errorsUp`, `upList` and `failed`.
 */
function evaluate({ rows, mode, noBaseline, baselineName = BASELINE_FILE, fromFile = true }) {
  const totals = { errorsBase: 0, errorsNow: 0, warningsBase: 0, warningsNow: 0 }
  const messages = []
  let failed = false
  let wentDown = 0
  let errorsDown = 0
  let wentUp = 0
  let errorsUp = 0
  let upList = ''

  for (const { kind, code, base: allowed, now: found } of rows) {
    let label = ''

    if (kind === 'errors') {
      totals.errorsBase += allowed
      totals.errorsNow += found
    } else {
      totals.warningsBase += allowed
      totals.warningsNow += found
      label = ' warning'
    }

    // With no baseline, only the totals mean anything.
    if (noBaseline) {
      continue
    }

    const shown = displayCode(code)

    if (found > allowed) {
      wentUp++
      if (wentUp <= MAX_RULES_LISTED) {
        upList += `${upList ? ', ' : ''}\`${shown}\`${label} (+${found - allowed})`
      }

      if (kind !== 'errors') {
        messages.push({
          level: 'notice',
          text: `${shown} has ${found} warnings, the baseline has ${allowed}. Warnings do not fail the check.`,
        })
        continue
      }

      errorsUp++
      failed = true
      messages.push({
        level: 'error',
        text: `${shown} has ${found} errors, the baseline has ${allowed}. The full list is in the plugin-check-results artifact.`,
      })
    } else if (found < allowed) {
      wentDown++
      if (kind === 'errors') {
        errorsDown++
      }
      messages.push({ level: 'notice', text: `${shown} (${kind}) went down from ${allowed} to ${found}.` })
    }
  }

  // Fewer errors than the file says leaves room for them to come back unnoticed. Strict mode does
  // not use the file, so it asks for nothing.
  if (mode !== 'strict' && fromFile && errorsDown > 0) {
    messages.push({
      level: 'notice',
      text: `Error counts went down. Lower the baseline so they cannot come back: commit the baseline.json from this run's plugin-check-report artifact as ${baselineName}.`,
    })
  }

  // Strict mode ignores the baseline for pass or fail: any error fails. The counts and the table
  // still compare with the baseline, so the comment shows what changed.
  if (mode === 'strict') {
    failed = totals.errorsNow > 0
    if (failed) {
      messages.push({ level: 'error', text: `${totals.errorsNow} errors found. Strict mode fails on any error.` })
    }
  }

  return { messages, totals, wentUp, wentDown, errorsDown, errorsUp, upList, failed }
}

/**
 * "+3", "-2" or "±0".
 *
 * @param {number} now  This run's count.
 * @param {number} base The baseline's count.
 *
 * @returns {string} The change.
 */
function change(now, base) {
  const diff = now - base

  if (diff > 0) {
    return `+${diff}`
  }

  return diff < 0 ? String(diff) : '±0'
}

/**
 * The status line at the top of the comment.
 *
 * The totals can go down while a rule goes up, so the status names the rules, not the totals.
 *
 * @param {object}  input
 * @param {string}  input.mode       `baseline` or `strict`.
 * @param {boolean} input.failed     The check fails.
 * @param {boolean} input.noBaseline Nothing was compared.
 * @param {number}  input.errorsUp   How many rules have more errors.
 * @param {number}  input.errorsNow  This run's error total.
 *
 * @returns {string} The line.
 */
function statusLine({ mode, failed, noBaseline, errorsUp, errorsNow }) {
  if (mode === 'strict' && failed) {
    return `❌ Plugin Check failed: ${errorsNow} errors, and strict mode allows none`
  }
  if (mode === 'strict') {
    return '✅ Plugin Check passed: no errors'
  }
  if (noBaseline) {
    return '⚠️ Plugin Check ran, but there is no baseline file yet'
  }
  if (failed) {
    return errorsUp === 1
      ? '❌ Plugin Check failed: 1 rule has more errors than the baseline allows'
      : `❌ Plugin Check failed: ${errorsUp} rules have more errors than the baseline allows`
  }

  return '✅ Plugin Check passed'
}

/**
 * The line of links at the bottom of the comment.
 *
 * @param {object} input
 * @param {string} input.artifactUrl Link to the uploaded results and the fresh baseline, or ''.
 * @param {string} input.runUrl      Link to the workflow run, or ''.
 * @param {string} input.resultsPath The results file, shown for a run on a developer's machine.
 *
 * @returns {string} The line.
 */
function linksLine({ artifactUrl, runUrl, resultsPath }) {
  if (artifactUrl) {
    return `📎 [Full results and new baseline](${artifactUrl})${runUrl ? ` · [Run](${runUrl})` : ''}`
  }

  return runUrl ? `📎 [Run](${runUrl})` : `📎 Local run, see ${resultsPath}`
}

/**
 * The body of the pull request comment.
 *
 * @param {object}   input
 * @param {string}   input.marker      Hidden first line.
 * @param {string}   input.status      From statusLine.
 * @param {string}   input.badge       Image URL shown under the status line, or ''.
 * @param {string}   input.column      Name of the baseline column, with its link when it has one.
 * @param {boolean}  input.noBaseline  Leave the baseline and change columns out.
 * @param {object}   input.totals      From evaluate.
 * @param {number}   input.wentUp      How many rules went up.
 * @param {number}   input.wentDown    How many rules went down.
 * @param {boolean}  input.updateHint  An error count went down: ask for the baseline file to be updated.
 * @param {string}   input.note        One line under the table, such as where the baseline came from, or ''.
 * @param {string}   input.upList      The first rules that went up, ready to print.
 * @param {string}   input.links       From linksLine.
 *
 * @returns {string} The body, cut to MAX_COMMENT_LINES lines, with no final line break.
 */
function buildComment({ marker, status, badge, column, noBaseline, totals, wentUp, wentDown, updateHint = false, note = '', upList, links }) {
  let body = `${marker}\n${status}\n\n`

  if (badge) {
    body += `![Plugin Check finished](${badge})\n\n`
  }

  if (noBaseline) {
    body += '|          | Now |\n|:--|--:|\n'
    body += `| Errors   | ${totals.errorsNow} |\n`
    body += `| Warnings | ${totals.warningsNow} |\n\n`
  } else {
    body += `|          | Now | ${column} | Change |\n|:--|--:|--:|:--|\n`
    body += `| Errors   | ${totals.errorsNow} | ${totals.errorsBase} | ${change(totals.errorsNow, totals.errorsBase)} |\n`
    body += `| Warnings | ${totals.warningsNow} | ${totals.warningsBase} | ${change(totals.warningsNow, totals.warningsBase)} |\n\n`
  }

  if (note) {
    body += `${note}\n`
  }
  if (wentUp > MAX_RULES_LISTED) {
    body += `Went up (top ${MAX_RULES_LISTED} of ${wentUp}): ${upList}\n`
  } else if (wentUp > 0) {
    body += `Went up: ${upList}\n`
  }
  if (wentDown > 0) {
    body += `Rules that went down: ${wentDown}.${updateHint ? ' Update the baseline file, see the job summary.' : ''}\n`
  }
  // A blank line separates the notes above from the links, when there are notes.
  if (wentUp > 0 || wentDown > 0 || note) {
    body += '\n'
  }
  body += links

  // Hard cap: whatever happens above, the comment never grows past MAX_COMMENT_LINES.
  return body.split('\n').slice(0, MAX_COMMENT_LINES).join('\n').replace(/\n+$/, '')
}

/**
 * The one line under the table that says where the baseline came from, when that is worth saying.
 *
 * @param {object}  input
 * @param {string}  input.source  `file`, `target` or `none`.
 * @param {boolean} input.changed The pull request changes the baseline file, so the comparison is
 *                                with its own change. A reviewer should look at the diff of the file.
 *
 * @returns {string} The line, or ''.
 */
function baselineNote({ source, changed }) {
  if (source === 'target') {
    return "ℹ️ There is no baseline file, so the baseline is the target branch's results. See the job summary to add one."
  }

  return source === 'file' && changed ? 'ℹ️ This pull request changes the baseline file.' : ''
}

/**
 * Reads the baseline file, and names it when it cannot be used.
 *
 * Plugin Check reports it as an error annotation: a committed file can be broken by a merge conflict
 * or by hand, and the author has to fix it.
 *
 * @param {string} file The path.
 * @param {string} name The file's name, as the messages show it.
 *
 * @throws {CheckFailure} When it is not a baseline.
 *
 * @returns {{errors: Map<string, number>, warnings: Map<string, number>}} Counts.
 */
function readBaselineFile(file, name) {
  try {
    return readBaseline(fs.readFileSync(file, 'utf8'))
  } catch (error) {
    if (!(error instanceof CheckFailure)) {
      throw error
    }

    const reason = error.message
      .replace(/^The baseline is not valid: /, '')
      .replace(/^parse error: /, 'it is not JSON: ')

    // A parser's message has no full stop of its own, and the sentence after it needs one.
    const stop = /[.!?]$/.test(reason) ? '' : '.'

    throw new CheckFailure(
      `The baseline file ${name} is not valid: ${reason}${stop} Fix it, or replace it with the baseline.json from this run's plugin-check-report artifact.`,
      error.exitCode,
      true
    )
  }
}

/**
 * The target branch's results as a baseline, for a pull request in a repository with no baseline
 * file. The workflow checked the target branch's commit in the same run, so its counts are what the
 * pull request is compared with.
 *
 * @param {object} env  PLUGIN_CHECK_BASE_RESULTS (the results file) and PLUGIN_CHECK_BASE_REQUIRED.
 * @param {string} name The baseline file's name, for the message.
 *
 * @throws {CheckFailure} When the results are missing or are not Plugin Check output. Never passes
 *         without a baseline, because the workflow asked for one.
 *
 * @returns {{errors: Map<string, number>, warnings: Map<string, number>}} Counts.
 */
function readTargetResults(env, name) {
  const file = env.PLUGIN_CHECK_BASE_RESULTS || ''

  if (!file || !isFile(file)) {
    throw new CheckFailure(
      `The target branch could not be checked, so there is nothing to compare with. Look at the job that checks the target branch in this run. To skip that check, commit the baseline.json from this run's plugin-check-report artifact as ${name}.`,
      1,
      true
    )
  }

  const text = fs.readFileSync(file, 'utf8')
  const refusal = checkResultsText(text)
  if (refusal) {
    throw new CheckFailure(`The results of the target branch cannot be used. ${refusal}`, 1, true)
  }

  return countPerCode(parseResults(text))
}

/**
 * The part of the job summary that says how to change the baseline file, or '' when there is nothing
 * to do. The comment stays short; this is where the commands go.
 *
 * @param {object} input
 * @param {string} input.mode         `baseline` or `strict`.
 * @param {boolean} input.noFile      There is no baseline file.
 * @param {object} input.verdict      From evaluate.
 * @param {string} input.baselineName The baseline file's name.
 * @param {object} input.env          GITHUB_RUN_ID and GITHUB_REPOSITORY, for the real command.
 *
 * @returns {string} Markdown with a final line break, or ''.
 */
function updateSection({ mode, noFile, verdict, baselineName, env }) {
  if (mode === 'strict') {
    return ''
  }

  const lines = []
  if (noFile) {
    lines.push(`There is no ${baselineName} yet. To start one, add the file from this run:`)
  } else if (verdict.errorsDown > 0) {
    lines.push(`Error counts went down. To lower the baseline, replace ${baselineName} with the file from this run:`)
  } else if (verdict.failed) {
    lines.push(
      `If the new errors are on purpose, raise their counts in ${baselineName} in this pull request, so reviewers see it. The file from this run has the new counts:`
    )
  } else {
    return ''
  }

  const run = env.GITHUB_RUN_ID || '<run-id>'
  const repo = env.GITHUB_REPOSITORY || '<owner>/<repo>'

  return [
    '',
    ...lines,
    '',
    '```bash',
    `gh run download ${run} --repo ${repo} --name plugin-check-report --dir /tmp/plugin-check`,
    `cp /tmp/plugin-check/baseline.json ${baselineName}`,
    '```',
    '',
  ].join('\n')
}

/**
 * Compares a results file with a baseline, or writes the baseline for the results.
 *
 * @param {object}   input
 * @param {string[]} input.args Arguments: `--update` and `--comment-file <path>` in any order, then
 *                              the results file.
 * @param {object}   input.env  Environment. PLUGIN_CHECK_MODE (`baseline`, the default, or `strict`),
 *                              COMMENT_MARKER, PLUGIN_CHECK_BASELINE (default: .plugin-check-baseline.json
 *                              in the current folder), PLUGIN_CHECK_BASE_RESULTS (the target branch's results,
 *                              used as the baseline when there is no file) and
 *                              PLUGIN_CHECK_BASE_REQUIRED (`true`: they must exist),
 *                              PLUGIN_CHECK_BASELINE_CHANGED (`true`: this pull request changes the
 *                              baseline file), COMMENT_BADGE,
 *                              RUN_URL, ARTIFACT_URL, GITHUB_STEP_SUMMARY.
 * @param {object}   input.log  Where messages go: `out`, `err`, `error`, `warning`, `notice`.
 *
 * @returns {number} The exit status: 0 passes, 1 fails the check, another number is a file that
 *          could not be read as it should be.
 */
function compare({ args, env, log }) {
  try {
    return compareOrThrow({ args, env, log })
  } catch (error) {
    if (error instanceof CheckFailure) {
      // A baseline file that cannot be read is the author's to fix, so it shows in the checks panel.
      if (error.annotate) {
        log.error(error.message)
      } else {
        log.err(error.message)
      }

      return error.exitCode
    }

    throw error
  }
}

/**
 * The body of compare(), which lets a CheckFailure through.
 *
 * @see compare
 *
 * @param {object} input The same input as compare().
 *
 * @returns {number} The exit status.
 */
function compareOrThrow({ args, env, log }) {
  // Checked before anything else, so a typo in the caller never runs as the default.
  const mode = env.PLUGIN_CHECK_MODE || DEFAULT_MODE
  if (!MODES.includes(mode)) {
    log.error(`Unknown mode '${mode}'. Use 'baseline' or 'strict'.`)

    return 1
  }

  let update = false
  let commentFile = ''
  let rest = [...args]
  while (rest.length > 0) {
    if (rest[0] === '--update') {
      update = true
      rest = rest.slice(1)
    } else if (rest[0] === '--comment-file') {
      if (!rest[1]) {
        log.err('--comment-file needs a path')

        return 1
      }
      commentFile = rest[1]
      rest = rest.slice(2)
    } else {
      break
    }
  }

  const resultsPath = rest[0]
  if (!resultsPath) {
    log.err('Usage: compare [--update | --comment-file <path>] <results-file>')

    return 1
  }

  // The default is the committed file in the current folder, so `compare --update` from the plugin
  // root writes it in place.
  const baselinePath = env.PLUGIN_CHECK_BASELINE || path.resolve(BASELINE_FILE)
  const baselineName = path.basename(baselinePath)

  if (!isFile(resultsPath)) {
    log.error(`Results file not found: ${resultsPath}`)

    return 1
  }

  const text = fs.readFileSync(resultsPath, 'utf8')
  const refusal = checkResultsText(text)
  if (refusal) {
    log.error(refusal)

    return 1
  }

  const now = countPerCode(parseResults(text))

  if (update) {
    writeText(baselinePath, formatBaseline(now), 'write')
    log.out(`Wrote ${baselinePath}: ${now.errors.size} error codes, ${now.warnings.size} warning codes`)

    return 0
  }

  // Where the baseline comes from: the committed file, else (baseline mode, pull request) the target
  // branch's results, else nothing. With no baseline at all, the counts are reported and the check
  // passes: failing would block a push before anyone has a result to make the file from.
  const hasFile = isFile(baselinePath)
  let source = hasFile ? 'file' : 'none'
  let base = { errors: new Map(), warnings: new Map() }

  if (hasFile) {
    base = readBaselineFile(baselinePath, baselineName)
  } else if (mode === 'strict') {
    // Strict mode does not use a baseline, so it has nothing to say and builds nothing.
    log.out('No baseline file. Strict mode does not need one.')
  } else if (env.PLUGIN_CHECK_BASE_RESULTS || env.PLUGIN_CHECK_BASE_REQUIRED === 'true') {
    base = readTargetResults(env, baselineName)
    source = 'target'
    log.warning(
      `No baseline file at ${baselineName}, so the target branch was checked too, and its results are the baseline for this run. That makes the run slower. To stop it, commit the baseline.json from this run's plugin-check-report artifact as ${baselineName}.`
    )
  } else {
    log.warning(
      `No baseline file at ${baselineName}, so nothing was compared. To start one, commit the baseline.json from this run's plugin-check-report artifact as ${baselineName}.`
    )
  }

  const noBaseline = source === 'none'
  const verdict = evaluate({ rows: buildRows(now, base), mode, noBaseline, baselineName, fromFile: hasFile })

  for (const { level, text: message } of verdict.messages) {
    log[level](message)
  }

  let runUrl = env.RUN_URL || ''
  if (!runUrl && env.GITHUB_RUN_ID) {
    for (const name of ['GITHUB_SERVER_URL', 'GITHUB_REPOSITORY']) {
      if (env[name] === undefined) {
        log.err(`${name}: unbound variable`)

        return 1
      }
    }
    runUrl = `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`
  }

  const body = buildComment({
    marker: env.COMMENT_MARKER || '<!-- plugin-check -->',
    status: statusLine({ mode, noBaseline, ...verdict, errorsNow: verdict.totals.errorsNow }),
    badge: env.COMMENT_BADGE || '',
    column: source === 'target' ? 'Target branch' : 'Baseline',
    noBaseline,
    totals: verdict.totals,
    wentUp: verdict.wentUp,
    wentDown: verdict.wentDown,
    updateHint: mode !== 'strict' && hasFile && verdict.errorsDown > 0,
    note: baselineNote({ source, changed: env.PLUGIN_CHECK_BASELINE_CHANGED === 'true' }),
    upList: verdict.upList,
    links: linksLine({ artifactUrl: env.ARTIFACT_URL || '', runUrl, resultsPath }),
  })

  if (commentFile) {
    writeText(commentFile, `${body}\n`, 'write')
  }
  if (env.GITHUB_STEP_SUMMARY) {
    const how = updateSection({ mode, noFile: !hasFile, verdict, baselineName, env })
    writeText(env.GITHUB_STEP_SUMMARY, `${body}\n${how}`, 'append')
  }

  if (verdict.failed) {
    log.out(
      mode === 'strict'
        ? 'Plugin Check found errors, and strict mode allows none.'
        : 'Plugin Check found more errors than the baseline allows.'
    )

    return 1
  }

  log.out(
    noBaseline
      ? 'Plugin Check ran with no baseline, so nothing was compared.'
      : 'Plugin Check error counts are within the baseline.'
  )

  return 0
}

/**
 * Writes a file, or adds to it. A folder that does not exist fails the step with the reason.
 *
 * @param {string} file   The path.
 * @param {string} text   What to write.
 * @param {string} how    `write` replaces the file, `append` adds to it.
 *
 * @throws {CheckFailure} When the file cannot be written.
 */
function writeText(file, text, how) {
  try {
    if (how === 'append') {
      fs.appendFileSync(file, text)
    } else {
      fs.writeFileSync(file, text)
    }
  } catch (error) {
    throw new CheckFailure(`Could not write ${file}: ${error.message}`, 1)
  }
}

/**
 * Whether a path is a file, following links, as `[ -f ]` does.
 *
 * @param {string} file The path.
 *
 * @returns {boolean} True for a file.
 */
function isFile(file) {
  try {
    return fs.statSync(file).isFile()
  } catch {
    return false
  }
}

/**
 * Where messages go when the code runs from a command line: annotations as the `::error` lines a
 * runner would turn into annotations, and plain text on the two streams.
 *
 * @param {{out: Function, err: Function}} io Writes one line to standard output or standard error.
 *
 * @returns {object} The log.
 */
function commandLog(io) {
  const annotation = (level) => (message) => io.out(`::${level} title=${TITLE}::${message}`)

  return {
    out: io.out,
    err: io.err,
    error: annotation('error'),
    warning: annotation('warning'),
    notice: annotation('notice'),
  }
}

/**
 * Where messages go inside an actions/github-script step.
 *
 * @param {object} core The toolkit github-script passes in.
 *
 * @returns {object} The log.
 */
function actionLog(core) {
  const annotate = (method) => (message) => core[method](message, { title: TITLE })

  return {
    out: (line) => core.info(line),
    err: (line) => core.info(line),
    error: annotate('error'),
    warning: annotate('warning'),
    notice: annotate('notice'),
  }
}

/**
 * The first step: where this run keeps its files.
 *
 * One folder per run under RUNNER_TEMP, cleared first, so a second use of the action in the same
 * job never reads the first one's files.
 *
 * @param {object} input
 * @param {object} input.core The toolkit github-script passes in.
 * @param {object} input.env  The environment: RUNNER_TEMP, GITHUB_REPOSITORY and INPUT_COMMENT_MARKER.
 *
 * @returns {number} 0.
 */
function runPaths({ core, env }) {
  const dir = path.join(env.RUNNER_TEMP, 'plugin-check-report')
  fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(path.join(dir, 'report'), { recursive: true })

  core.setOutput('report', path.join(dir, 'report'))
  core.setOutput('marker', env.INPUT_COMMENT_MARKER || `<!-- plugin-check:${env.GITHUB_REPOSITORY} -->`)

  return 0
}

/**
 * The second step: a baseline made from this run, kept even when the compare fails. Later runs
 * download it as their baseline.
 *
 * @param {object} input
 * @param {object} input.core The toolkit.
 * @param {object} input.env  RESULTS and REPORT_DIR.
 *
 * @returns {number} The exit status. A results file that is not Plugin Check output fails here too,
 *          with the same message, and then nothing is uploaded.
 */
function runUpdate({ core, env }) {
  if (!isFile(env.RESULTS ?? '')) {
    return 0
  }

  fs.copyFileSync(env.RESULTS, path.join(env.REPORT_DIR, path.basename(env.RESULTS)))

  return compare({
    args: ['--update', env.RESULTS],
    env: { ...env, PLUGIN_CHECK_BASELINE: path.join(env.REPORT_DIR, 'baseline.json') },
    log: actionLog(core),
  })
}

/**
 * The last step: fails the step when the mode says so. Also writes the comment body and the same
 * text to the job summary.
 *
 * @param {object} input
 * @param {object} input.core The toolkit.
 * @param {object} input.env  RESULTS, COMMENT_FILE, and the variables compare() reads.
 *
 * @returns {number} The exit status.
 */
function runCompare({ core, env, now }) {
  const args = env.COMMENT_FILE ? ['--comment-file', env.COMMENT_FILE] : []

  // The comment always shows the finish badge, so the action makes it: no caller passes one.
  return compare({
    args: [...args, env.RESULTS ?? ''],
    env: { ...env, COMMENT_BADGE: finishBadge(now) },
    log: actionLog(core),
  })
}

/** The time zone of the time on the badges. */
const BADGE_TIME_ZONE = 'America/New_York'

/**
 * The time on a badge, like `11/03 06:08 PM EST`: month and day, a 12-hour clock, and the zone's
 * short name, which is EST in winter and EDT in summer. It is what `date '+%m/%d %I:%M %p %Z'` prints
 * with `LC_ALL=C` and `TZ=America/New_York`.
 *
 * Tested for the default zone only. A zone whose short name Intl writes as `GMT+1` would need the
 * `+` and the `-` of a shields.io badge escaped.
 *
 * @param {Date}   now      The moment.
 * @param {string} timeZone An IANA time zone.
 *
 * @returns {string} The time, not yet escaped for a URL.
 */
function badgeStamp(now, timeZone) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone,
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: true,
      timeZoneName: 'short',
    })
      .formatToParts(now)
      .map(({ type, value }) => [type, value])
  )

  return `${parts.month}/${parts.day} ${parts.hour}:${parts.minute} ${parts.dayPeriod} ${parts.timeZoneName}`
}

/**
 * The "Check Finished" badge shown under the status line of the comment: a shields.io image with
 * the time the check finished. Only a space and a slash are escaped, so the colon of the time stays
 * as it is.
 *
 * The workflow's "Check Started" badge in the `start` job is made by a shell step of the same
 * shape. That job has no checkout to run this file from.
 *
 * @param {Date}   now      The moment. Default: now.
 * @param {string} timeZone An IANA time zone. Default: America/New_York.
 *
 * @returns {string} The image URL.
 */
function finishBadge(now = new Date(), timeZone = BADGE_TIME_ZONE) {
  const stamp = badgeStamp(now, timeZone).replace(/ /g, '%20').replace(/\//g, '%2F')

  return `https://img.shields.io/badge/Check%20Finished-${stamp}-darkgreen`
}

/**
 * The comment for a run that could not compare anything: the build or the check broke before the
 * results existed, or the compare refused its settings.
 *
 * @param {object} input
 * @param {string} input.marker The hidden first line.
 * @param {string} input.badge  The badge URL.
 * @param {string} input.runUrl The link to the workflow run.
 *
 * @returns {string} The Markdown body, with a final line break.
 */
function couldNotRunComment({ marker, badge, runUrl }) {
  return `${marker}\n❌ Plugin Check could not run\n\n![Plugin Check finished](${badge})\n\n📎 [Run](${runUrl})\n`
}

/**
 * The step after the compare: when the compare wrote no comment body, says so, instead of leaving
 * "in progress" on the pull request. A body that exists and is not empty is left alone, whatever
 * the verdict was.
 *
 * @param {object} input
 * @param {object} input.core The toolkit.
 * @param {object} input.env  COMMENT_FILE, COMMENT_MARKER, RUN_URL and GITHUB_REPOSITORY.
 * @param {Date}   input.now  Optional clock.
 *
 * @returns {number} 0, or 1 when the file cannot be written.
 */
function runCouldNotRun({ core, env, now }) {
  const file = env.COMMENT_FILE ?? ''
  if (!file) {
    return 0
  }

  try {
    if (fs.statSync(file).size > 0) {
      return 0
    }
  } catch {
    // No file: write it.
  }

  const marker = env.COMMENT_MARKER || `<!-- plugin-check:${env.GITHUB_REPOSITORY} -->`
  try {
    writeText(file, couldNotRunComment({ marker, badge: finishBadge(now), runUrl: env.RUN_URL ?? '' }), 'write')
  } catch (error) {
    core.error(error.message, { title: TITLE })

    return 1
  }
  core.info('The compare wrote no comment, so the comment says Plugin Check could not run.')

  return 0
}

/** The file a repository keeps its excluded checks in, at its root. */
const EXCLUDE_FILE = '.plugin-check.json'

/**
 * The checks to skip, from the workflow input: one per line. A comma works too, because the Plugin
 * Check action turns the lines into a comma list. Blank lines and repeats are dropped.
 *
 * @param {string} text The input.
 *
 * @returns {string[]} The check names, in order.
 */
function parseExcludeInput(text) {
  return [...new Set(text.split(/[\r\n,]+/).map((line) => line.trim()).filter(Boolean))]
}

/**
 * The checks to skip, from the repository's `.plugin-check.json`:
 * `{"exclude-checks": ["check_a", "check_b"]}`. Other keys are ignored, so the file can grow. A
 * missing `exclude-checks` key means none. Repeats are dropped.
 *
 * @param {string} text The file's contents.
 * @param {string} name What to call the file in a message.
 *
 * @returns {string[]} The check names, in order.
 *
 * @throws {CheckFailure} When the file cannot be used. The message says what to fix.
 */
function parseExcludeFile(text, name = EXCLUDE_FILE) {
  let data
  try {
    data = JSON.parse(text)
  } catch (error) {
    throw new CheckFailure(`${name} is not valid JSON: ${error.message}`, 1)
  }

  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    throw new CheckFailure(`${name} must hold a JSON object, like {"exclude-checks": ["check_name"]}.`, 1)
  }

  const list = data['exclude-checks']
  if (list === undefined) {
    return []
  }
  if (!Array.isArray(list)) {
    throw new CheckFailure(`"exclude-checks" in ${name} must be a list of check names, like ["check_name"].`, 1)
  }

  const checks = []
  for (const entry of list) {
    const check = typeof entry === 'string' ? entry.trim() : ''
    if (!check || /[\s,]/.test(check)) {
      throw new CheckFailure(
        `"exclude-checks" in ${name} has ${JSON.stringify(entry)}, which is not a check name. Each entry is one text without spaces or commas.`,
        1
      )
    }
    checks.push(check)
  }

  return [...new Set(checks)]
}

/**
 * Which checks to skip. The workflow input wins when it names any: then the file is not even read.
 * Otherwise the file is used. With neither, none.
 *
 * @param {object}      input
 * @param {string}      input.input    The workflow input.
 * @param {string|null} input.fileText The file's contents, or null when there is no file.
 * @param {string}      input.fileName What to call the file in a message.
 *
 * @returns {{checks: string[], source: string}} The check names, and where they came from: `input`,
 *          `file` or `none`.
 *
 * @throws {CheckFailure} When the file is used and cannot be.
 */
function excludedChecks({ input = '', fileText = null, fileName = EXCLUDE_FILE }) {
  const fromInput = parseExcludeInput(input)
  if (fromInput.length > 0) {
    return { checks: fromInput, source: 'input' }
  }
  if (fileText === null) {
    return { checks: [], source: 'none' }
  }

  const checks = parseExcludeFile(fileText, fileName)

  return { checks, source: checks.length > 0 ? 'file' : 'none' }
}

/**
 * The file's contents, or null when there is no such file.
 *
 * @param {string} file The path.
 *
 * @returns {string|null} The text.
 *
 * @throws {CheckFailure} When the file exists but cannot be read.
 */
function readIfFile(file) {
  if (!file || !isFile(file)) {
    return null
  }

  try {
    return fs.readFileSync(file, 'utf8')
  } catch (error) {
    throw new CheckFailure(`Could not read ${file}: ${error.message}`, 1)
  }
}

/**
 * The step before the Plugin Check action: works out which checks to skip, from the workflow input
 * or else the repository's `.plugin-check.json`.
 *
 * Sets the output `checks`: one name per line, the format the Plugin Check action takes.
 *
 * @param {object} input
 * @param {object} input.core The toolkit.
 * @param {object} input.env  EXCLUDE_CHECKS (the workflow input) and CONFIG_FILE (the path).
 *
 * @returns {number} 0, or 1 when the file cannot be used.
 */
function runExcludeChecks({ core, env }) {
  const file = env.CONFIG_FILE ?? ''

  try {
    const { checks, source } = excludedChecks({
      input: env.EXCLUDE_CHECKS ?? '',
      // Not read when the input names checks: the input replaces the file.
      fileText: parseExcludeInput(env.EXCLUDE_CHECKS ?? '').length > 0 ? null : readIfFile(file),
      fileName: path.basename(file) || EXCLUDE_FILE,
    })

    core.setOutput('checks', checks.join('\n'))
    core.info(
      source === 'none'
        ? 'No checks are excluded.'
        : `Excluding ${checks.length} check(s) from the ${source === 'input' ? 'exclude-checks input' : path.basename(file)}: ${checks.join(', ')}`
    )

    return 0
  } catch (error) {
    if (error instanceof CheckFailure) {
      core.error(error.message, { title: TITLE })

      return error.exitCode
    }

    throw error
  }
}

/**
 * The command line: `compare`, `update` and `exclude-checks`.
 *
 * @param {string[]} argv The arguments after the script name.
 * @param {object}   env  The environment, default process.env.
 * @param {object}   io   `out` and `err`, each writing one line. Default: the process streams.
 *
 * @returns {Promise<number>} The exit status.
 */
async function main(
  argv,
  env = process.env,
  io = {
    out: (line) => process.stdout.write(`${line}\n`),
    err: (line) => process.stderr.write(`${line}\n`),
  }
) {
  const [command, ...args] = argv
  const log = commandLog(io)

  if (command === 'compare') {
    return compare({ args, env, log })
  }

  // `update <results>` is `compare --update <results>`: writes the baseline file for the results.
  if (command === 'update') {
    return compare({ args: ['--update', ...args], env, log })
  }

  // Prints the flag `wp plugin check` takes, so a local run skips the same checks as CI:
  // `wp plugin check my-plugin $(node plugin-check-report.js exclude-checks)`. Prints nothing when
  // no check is excluded. EXCLUDE_CHECKS, when set, replaces the file, as the workflow input does.
  if (command === 'exclude-checks') {
    const file = args[0] ?? EXCLUDE_FILE

    try {
      const input = env.EXCLUDE_CHECKS ?? ''
      const { checks } = excludedChecks({
        input,
        fileText: parseExcludeInput(input).length > 0 ? null : readIfFile(file),
        fileName: file,
      })
      if (checks.length > 0) {
        io.out(`--exclude-checks=${checks.join(',')}`)
      }

      return 0
    } catch (error) {
      if (error instanceof CheckFailure) {
        log.err(error.message)

        return error.exitCode
      }

      throw error
    }
  }

  io.err('Usage: plugin-check-report.js compare|update|exclude-checks ...')

  return 2
}

if (require.main === module) {
  main(process.argv.slice(2)).then((status) => {
    process.exitCode = status
  })
}

module.exports = {
  CheckFailure,
  MODES,
  actionLog,
  BADGE_TIME_ZONE,
  BASELINE_FILE,
  EXCLUDE_FILE,
  badgeStamp,
  buildComment,
  buildRows,
  change,
  checkResultsText,
  commandLog,
  compare,
  compareCodePoints,
  countPerCode,
  couldNotRunComment,
  cutBytes,
  displayCode,
  evaluate,
  excludedChecks,
  finishBadge,
  formatBaseline,
  linksLine,
  main,
  parseExcludeFile,
  parseExcludeInput,
  parseResults,
  readBaseline,
  baselineNote,
  readBaselineFile,
  readTargetResults,
  readIfFile,
  readJsonValues,
  runCompare,
  runCouldNotRun,
  runExcludeChecks,
  runPaths,
  runUpdate,
  statusLine,
  updateSection,
}
