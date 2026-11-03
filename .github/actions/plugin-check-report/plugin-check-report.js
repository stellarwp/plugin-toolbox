'use strict'

/**
 * Compares WordPress.org Plugin Check results with a baseline, and finds the baseline.
 *
 * The baseline is the count of errors and warnings per rule code of an earlier run of the same
 * workflow, kept as the `plugin-check-report` artifact of that run. Nothing is committed.
 *
 * Two jobs:
 *   compare  Counts the results, compares them with a baseline file, writes the pull request
 *            comment and the job summary, and says whether the check passes. With `update` it only
 *            writes the baseline file for this run.
 *   fetch    Finds the earlier run that has a baseline and downloads its baseline.json.
 *
 * The small functions are pure, so a test can call them with plain values. The functions that talk
 * to GitHub take their client as an argument, so a test can pass a real Octokit with the network
 * replaced, as the other actions do. The same code runs in three places: the action's steps
 * (`runPaths`, `runUpdate`, `runFetch`, `runCompare`, through actions/github-script), a command line
 * (`node plugin-check-report.js compare|fetch ...`), and the tests.
 *
 * Every function that decides an exit status returns it: 0 passes, 1 is a failed check or a missing
 * baseline, 2 is a lookup that could not be trusted. A step sets `process.exitCode` from it, so the
 * step fails without github-script adding a second error.
 */

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

/** Title of every annotation. */
const TITLE = 'Plugin Check'

/** The pull request comment must stay short. Everything else is behind the links. */
const MAX_COMMENT_LINES = 15
const MAX_RULES_LISTED = 5

/** The first unexpected line of a results file is shown cut to this many bytes. */
const MAX_UNEXPECTED_BYTES = 200

const MODES = ['ratchet', 'strict']
const DEFAULT_MODE = 'ratchet'

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
   */
  constructor(message, exitCode = 1) {
    super(message)
    this.name = 'CheckFailure'
    this.exitCode = exitCode
  }
}

/**
 * Orders two strings by Unicode code point, as `jq` sorts them. JavaScript's default order compares
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
 * Splits a run of JSON values written one after another, as `jq` reads its input: whitespace
 * between values, any number of them.
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
      throw new CheckFailure(`jq: parse error: ${error.message}`, 2)
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

    throw new CheckFailure('jq: parse error: Unfinished JSON term at EOF', 2)
  }

  const scalar = /^("(?:[^"\\]|\\.)*"|[^\s[\]{}",:]+)/.exec(text.slice(start))
  if (!scalar) {
    throw new CheckFailure('jq: parse error: Invalid JSON', 2)
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
 * A `null` item is skipped, as jq skips it. Any other item that is not an object, and any counted
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
 * \u007f, exactly as `jq -S` prints it. Built by hand, because an object puts keys such as "10"
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
 * written out, as jq's @tsv writes them.
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
 * their order by kind and code. The sort is stable, as jq's is, so the order is the same every time.
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
 * @param {string}  input.mode        `ratchet` or `strict`.
 * @param {boolean} input.advisory    The baseline is from an older commit than the target, so more
 *                                    errors are only reported.
 * @param {boolean} input.noBaseline  There was nothing to compare with: only the totals count.
 *
 * @returns {object} `messages` (`{level, text}` in print order), `totals`, `wentUp`, `wentDown`,
 *          `errorsUp`, `upList` and `failed`.
 */
function evaluate({ rows, mode, advisory, noBaseline }) {
  const totals = { errorsBase: 0, errorsNow: 0, warningsBase: 0, warningsNow: 0 }
  const messages = []
  let failed = false
  let wentDown = 0
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
      if (advisory) {
        messages.push({
          level: 'warning',
          text: `${shown} has ${found} errors, an older run of the target branch has ${allowed}. Not enforced, because the target may have changed since.`,
        })
      } else {
        failed = true
        messages.push({
          level: 'error',
          text: `${shown} has ${found} errors, the baseline has ${allowed}. The full list is in the plugin-check-results artifact.`,
        })
      }
    } else if (found < allowed) {
      wentDown++
      messages.push({ level: 'notice', text: `${shown} (${kind}) went down from ${allowed} to ${found}.` })
    }
  }

  // Strict mode ignores the baseline for pass or fail: any error fails. The counts and the table
  // still compare with the baseline, so the comment shows what changed.
  if (mode === 'strict') {
    failed = totals.errorsNow > 0
    if (failed) {
      messages.push({ level: 'error', text: `${totals.errorsNow} errors found. Strict mode fails on any error.` })
    }
  }

  return { messages, totals, wentUp, wentDown, errorsUp, upList, failed }
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
 * @param {string}  input.mode       `ratchet` or `strict`.
 * @param {boolean} input.failed     The check fails.
 * @param {boolean} input.noBaseline Nothing was compared.
 * @param {boolean} input.advisory   The baseline is from an older run of the target branch.
 * @param {number}  input.errorsUp   How many rules have more errors.
 * @param {number}  input.errorsNow  This run's error total.
 *
 * @returns {string} The line.
 */
function statusLine({ mode, failed, noBaseline, advisory, errorsUp, errorsNow }) {
  if (mode === 'strict' && failed) {
    return `❌ Plugin Check failed: ${errorsNow} errors, and strict mode allows none`
  }
  if (mode === 'strict') {
    return '✅ Plugin Check passed: no errors'
  }
  if (noBaseline) {
    return '⚠️ Plugin Check ran, but there was no baseline to compare with'
  }
  if (errorsUp > 0 && advisory) {
    return `⚠️ Plugin Check passed, not enforced: ${errorsUp} rule(s) have more errors than an older run of the target branch`
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
 * @param {string}   input.upList      The first rules that went up, ready to print.
 * @param {string}   input.links       From linksLine.
 *
 * @returns {string} The body, cut to MAX_COMMENT_LINES lines, with no final line break.
 */
function buildComment({ marker, status, badge, column, noBaseline, totals, wentUp, wentDown, upList, links }) {
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

  if (wentUp > MAX_RULES_LISTED) {
    body += `Went up (top ${MAX_RULES_LISTED} of ${wentUp}): ${upList}\n`
  } else if (wentUp > 0) {
    body += `Went up: ${upList}\n`
  }
  if (wentDown > 0) {
    body += `Rules that went down: ${wentDown}.\n`
  }
  // A blank line separates the notes above from the links, when there are notes.
  if (wentUp > 0 || wentDown > 0) {
    body += '\n'
  }
  body += links

  // Hard cap: whatever happens above, the comment never grows past MAX_COMMENT_LINES.
  return body.split('\n').slice(0, MAX_COMMENT_LINES).join('\n').replace(/\n+$/, '')
}

/**
 * Compares a results file with a baseline, or writes the baseline for the results.
 *
 * @param {object}   input
 * @param {string[]} input.args Arguments: `--update` and `--comment-file <path>` in any order, then
 *                              the results file.
 * @param {object}   input.env  Environment. PLUGIN_CHECK_MODE (`ratchet`, the default, or `strict`),
 *                              COMMENT_MARKER, PLUGIN_CHECK_BASELINE (default: baseline.json next
 *                              to this file), BASELINE_LABEL, BASELINE_URL, PLUGIN_CHECK_ADVISORY
 *                              (`true` when the baseline is from an older commit than the target),
 *                              COMMENT_BADGE, RUN_URL, ARTIFACT_URL, GITHUB_STEP_SUMMARY.
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
      log.err(error.message)

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
    log.error(`Unknown mode '${mode}'. Use 'ratchet' or 'strict'.`)

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

  const baselinePath = env.PLUGIN_CHECK_BASELINE || path.join(__dirname, 'baseline.json')

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

  // No earlier run to compare with: report the counts and pass. Failing here would block every pull
  // request whenever the target branch has no finished run (its first run, or expired artifacts).
  const noBaseline = !isFile(baselinePath)
  let base = { errors: new Map(), warnings: new Map() }
  if (noBaseline) {
    log.warning(
      `No baseline to compare with (${baselinePath}), so nothing was compared. Run the workflow on the target branch to make one.`
    )
  } else {
    base = readBaseline(fs.readFileSync(baselinePath, 'utf8'))
  }

  const advisory = env.PLUGIN_CHECK_ADVISORY === 'true'
  const verdict = evaluate({ rows: buildRows(now, base), mode, advisory, noBaseline })
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

  // The column is named after where the baseline came from ("Target branch", "Previous run"), and
  // links to that run when known.
  let column = env.BASELINE_LABEL || 'Baseline'
  if (env.BASELINE_URL) {
    column = `[${column}](${env.BASELINE_URL})`
  }

  const body = buildComment({
    marker: env.COMMENT_MARKER || '<!-- plugin-check -->',
    status: statusLine({ mode, advisory, noBaseline, ...verdict, errorsNow: verdict.totals.errorsNow }),
    badge: env.COMMENT_BADGE || '',
    column,
    noBaseline,
    totals: verdict.totals,
    wentUp: verdict.wentUp,
    wentDown: verdict.wentDown,
    upList: verdict.upList,
    links: linksLine({ artifactUrl: env.ARTIFACT_URL || '', runUrl, resultsPath }),
  })

  if (commentFile) {
    writeText(commentFile, `${body}\n`, 'write')
  }
  if (env.GITHUB_STEP_SUMMARY) {
    writeText(env.GITHUB_STEP_SUMMARY, `${body}\n`, 'append')
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

/** The artifact every run of the workflow uploads, with the baseline.json inside it. */
const ARTIFACT = 'plugin-check-report'

/** How long a pull request waits for the run of its base commit to show up at all, in seconds. */
const GRACE_SECONDS = 120
const POLL_SECONDS = 30

const FETCH_USAGE =
  'Usage: plugin-check-report.js fetch [--workflow <file>] [--sha <commit>] [--wait <seconds>] [--before-run <run-id>] <branch> [<output-file>]'

/**
 * A lookup that cannot be trusted. It exits with 2, never 1, so "no baseline" is never mistaken for
 * a typo or an outage.
 *
 * @param {string} reason What failed.
 *
 * @returns {CheckFailure} The failure to throw.
 */
function lookupFailed(reason) {
  return new CheckFailure(`Could not look up Plugin Check runs: ${reason}`, 2)
}

/**
 * Checks a whole number from the command line.
 *
 * At most 18 digits, which keeps it inside a 64-bit integer, and a leading zero is not octal.
 *
 * @param {string} flag  The option it belongs to, for the message.
 * @param {string} value The text.
 *
 * @throws {CheckFailure} When it is not a whole number, or is too large.
 *
 * @returns {bigint} The number.
 */
function readWholeNumber(flag, value) {
  if (!/^[0-9]+$/.test(value)) {
    throw lookupFailed(`${flag} must be a whole number, not '${value}'`)
  }
  if (value.length > 18) {
    throw lookupFailed(`${flag} is too large: '${value}'`)
  }

  return BigInt(value)
}

/**
 * Checks the name of the workflow file. It goes into an API path, and a path or a ref there would
 * ask for some other resource.
 *
 * @param {string} workflow The file name, such as `plugin-check.yml`.
 *
 * @throws {CheckFailure} When it is empty, or holds a `/` or an `@`.
 *
 * @returns {string} The name.
 */
function checkWorkflowFile(workflow) {
  if (workflow === '' || /[/@]/.test(workflow)) {
    throw lookupFailed(`--workflow must be a file name such as plugin-check.yml, not '${workflow}'`)
  }

  return workflow
}

/**
 * The file name of the calling workflow. In a called workflow GITHUB_WORKFLOW_REF is the caller's, like
 * `example-org/my-plugin/.github/workflows/plugin-check.yml@refs/pull/12/merge`. The runs that
 * hold the baseline belong to that file, not to the toolbox's workflow.
 *
 * @param {string} ref The value of GITHUB_WORKFLOW_REF.
 *
 * @returns {string} The file name, or '' when there is no ref.
 */
function workflowFromRef(ref) {
  const withoutRef = String(ref ?? '').split('@')[0]

  return withoutRef.slice(withoutRef.lastIndexOf('/') + 1)
}

/**
 * Reads the command line of the lookup.
 *
 * Options come first, in any order, then the branch and an optional output file. An option with no
 * value, or an empty one, fails here, so a typo never reads as "no baseline".
 *
 * @param {string[]} args The arguments.
 *
 * @throws {CheckFailure} For anything the lookup cannot use.
 *
 * @returns {{workflow: string, sha: string, wait: number, beforeRun: bigint|null, branch: string,
 *          output: string}} What to look up.
 */
function parseFetchArgs(args) {
  const options = { workflow: 'plugin-check.yml', sha: '', wait: 0, beforeRun: null }
  let rest = [...args]

  const needValue = () => {
    if (rest.length < 2 || rest[1] === '') {
      throw lookupFailed(`${rest[0]} needs a value. ${FETCH_USAGE}`)
    }
  }

  while (rest.length > 0) {
    switch (rest[0]) {
      case '--workflow':
        needValue()
        options.workflow = rest[1]
        break
      case '--sha':
        needValue()
        options.sha = rest[1]
        break
      case '--wait':
        needValue()
        options.wait = Number(readWholeNumber('--wait', rest[1]))
        break
      case '--before-run':
        needValue()
        options.beforeRun = readWholeNumber('--before-run', rest[1])
        break
      default:
        return finishFetchArgs(options, rest)
    }
    rest = rest.slice(2)
  }

  return finishFetchArgs(options, rest)
}

/**
 * The branch and the output file, after the options.
 *
 * @param {object}   options What the options said.
 * @param {string[]} rest    The arguments left.
 *
 * @throws {CheckFailure} When there is no branch.
 *
 * @returns {object} The options, the branch and the output file.
 */
function finishFetchArgs(options, rest) {
  if (rest.length < 1 || rest[0] === '') {
    throw lookupFailed(`a branch is needed. ${FETCH_USAGE}`)
  }

  return { ...options, branch: rest[0], output: rest[1] || path.join(__dirname, 'baseline.json') }
}

/**
 * Lower-cases the letters A to Z only, as `ascii_downcase` does.
 *
 * @param {string} text The text.
 *
 * @returns {string} The text.
 */
function asciiLower(text) {
  return text.replace(/[A-Z]/g, (letter) => letter.toLowerCase())
}

/**
 * Whether a run belongs to this repository's own branches.
 *
 * The runs API matches `branch` and `head_sha` against the head of a pull request too, so a run for
 * a pull request from a fork, from a branch named like the target, would otherwise be taken for a
 * run of the target, and its artifact is whatever that fork's workflow chose to upload.
 *
 * @param {object} run  A workflow run from the API.
 * @param {string} repo `owner/name`.
 *
 * @returns {boolean} True when the run's head commit is in this repository.
 */
function isOwnRun(run, repo) {
  return asciiLower(run.head_repository?.full_name || '') === asciiLower(repo)
}

/**
 * How many of this repository's own runs there are, and how many of them are not finished.
 *
 * @param {object[]} runs The runs from the API.
 * @param {string}   repo `owner/name`.
 *
 * @returns {{total: number, going: number}} The counts.
 */
function countRuns(runs, repo) {
  const own = runs.filter((run) => isOwnRun(run, repo))

  return { total: own.length, going: own.filter((run) => run.status !== 'completed').length }
}

/**
 * The runs to try, best first.
 *
 * Runs for the base commit come first, in the order the API gave them. Then the latest runs on the
 * branch, newest first by run id. A run is tried once, and a run that is not older than
 * `beforeRun` is skipped, so a run never compares with itself, and a re-run of an older push never
 * compares with a newer one.
 *
 * @param {object}      input
 * @param {object[]}    input.shaRuns    Own runs for the base commit.
 * @param {object[]}    input.branchRuns Own runs on the branch.
 * @param {bigint|null} input.beforeRun  Skip runs with this id or a higher one.
 *
 * @returns {object[]} The runs.
 */
function orderCandidates({ shaRuns, branchRuns, beforeRun }) {
  const newestFirst = [...branchRuns].sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0))
  const tried = new Set()
  const candidates = []

  for (const run of [...shaRuns, ...newestFirst]) {
    if (beforeRun !== null && BigInt(run.id) >= beforeRun) {
      continue
    }
    if (tried.has(String(run.id))) {
      continue
    }
    tried.add(String(run.id))
    candidates.push(run)
  }

  return candidates
}

/**
 * The runs of a workflow, from the API.
 *
 * @param {object} github A GitHub client.
 * @param {object} query  `owner`, `repo`, `workflow`, then the filters in the order they are sent.
 * @param {object} log    The log, for the reason a request failed.
 * @param {string} reason What the caller was looking for, for the message.
 *
 * @throws {CheckFailure} When the request fails or the answer is not a list of runs.
 *
 * @returns {Promise<object[]>} The runs.
 */
async function listRuns(github, { owner, repo, workflow, ...filters }, log, reason) {
  let data
  try {
    ;({ data } = await github.request('GET /repos/{owner}/{repo}/actions/workflows/{workflow_id}/runs', {
      owner,
      repo,
      workflow_id: workflow,
      ...filters,
    }))
  } catch (error) {
    log.err(`${error.message}${error.status ? ` (HTTP ${error.status})` : ''}`)
    throw lookupFailed(reason)
  }

  if (!Array.isArray(data?.workflow_runs)) {
    throw lookupFailed(reason)
  }

  return data.workflow_runs
}

/**
 * Waits for the run of the base commit to finish, when it is still going.
 *
 * A pull request opened right after a merge starts at the same time as the push run on the target
 * branch. Waiting for it beats comparing with an older run. A run that does not show up at all is
 * waited for only a short time, since the commit may never have had one.
 *
 * @param {object}   input
 * @param {object}   input.github   A GitHub client.
 * @param {object}   input.query    `owner`, `repo`, `workflow`.
 * @param {string}   input.sha      The base commit.
 * @param {number}   input.wait     The most seconds to wait.
 * @param {Function} input.now      The time in whole seconds.
 * @param {Function} input.sleep    Waits for a number of seconds.
 * @param {object}   input.log      The log.
 */
async function waitForBaseRun({ github, query, sha, wait, now, sleep, log }) {
  const repo = `${query.owner}/${query.repo}`
  const started = now()
  const deadline = started + wait

  while (true) {
    const runs = await listRuns(github, { ...query, head_sha: sha, per_page: 20 }, log, `runs for ${sha}`)
    const { total, going } = countRuns(runs, repo)

    if (total === 0 && now() >= started + GRACE_SECONDS) {
      return
    }
    if (total !== 0 && going === 0) {
      return
    }
    if (now() >= deadline) {
      log.err(`The run for ${sha} is still going after ${wait} seconds; trying older runs.`)

      return
    }

    await sleep(POLL_SECONDS)
  }
}

/**
 * Finds the earlier run that has a baseline, and downloads its baseline.json.
 *
 * Runs are tried in this order, and the first one with the artifact wins: runs for the base commit
 * when `--sha` is given, then the latest runs on the branch. The artifact is downloaded with the
 * GitHub CLI. A run that broke before the report job, whose artifact expired, or whose artifact has
 * no baseline.json has nothing to give, and the next run is tried.
 *
 * @param {object}   input
 * @param {string[]} input.args  The command line, see parseFetchArgs.
 * @param {object}   input.env   The environment. GITHUB_REPOSITORY names the repository.
 * @param {object}   input.github A GitHub client.
 * @param {object}   input.exec  `getExecOutput(command, args, options)`, as in @actions/exec.
 * @param {object}   input.log   The log.
 * @param {Function} input.now   The time in whole seconds. Default: the clock.
 * @param {Function} input.sleep Waits for a number of seconds. Default: a real wait.
 *
 * @returns {Promise<{status: number, id?: number, url?: string, match?: string}>} Status 0 with the
 *          run found and `exact` or `older` (the run is not for the base commit); 1 when no run has
 *          a baseline; 2 when the lookup itself failed, so "no baseline" is not known.
 */
async function fetchBaseline({
  args,
  env,
  github,
  exec,
  log,
  now = () => Math.floor(Date.now() / 1000),
  sleep = (seconds) => new Promise((resolve) => setTimeout(resolve, seconds * 1000)),
}) {
  let temp = null

  try {
    const { workflow, sha, wait, beforeRun, branch, output } = parseFetchArgs(args)

    const repo = env.GITHUB_REPOSITORY || (await repositoryFromGh(exec))
    checkWorkflowFile(workflow)
    const [owner, name] = repo.split('/')
    const query = { owner, repo: name, workflow }

    if (sha && wait > 0) {
      await waitForBaseRun({ github, query, sha, wait, now, sleep, log })
    }

    const shaRuns = sha
      ? await listRuns(github, { ...query, status: 'completed', head_sha: sha, per_page: 10 }, log, `runs for ${sha}`)
      : []
    const branchRuns = await listRuns(
      github,
      { ...query, status: 'completed', branch, per_page: 100 },
      log,
      `runs on ${branch}`
    )

    const candidates = orderCandidates({
      shaRuns: shaRuns.filter((run) => isOwnRun(run, repo)),
      branchRuns: branchRuns.filter((run) => isOwnRun(run, repo)),
      beforeRun,
    })

    temp = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-check-fetch-'))

    for (const run of candidates) {
      const file = await downloadBaseline({ github, exec, log, owner, repo: name, id: run.id, dir: path.join(temp, 'report') })
      if (file === null) {
        continue
      }

      fs.mkdirSync(path.dirname(output), { recursive: true })
      fs.copyFileSync(file, output)

      return { status: 0, id: run.id, url: run.html_url, match: sha && run.head_sha !== sha ? 'older' : 'exact' }
    }

    log.err(`No Plugin Check run on ${branch}${sha ? ` or ${sha}` : ''} has a baseline.`)

    return { status: 1 }
  } catch (error) {
    const failure = error instanceof CheckFailure ? error : lookupFailed(error.message)
    log.err(failure.message)

    return { status: failure.exitCode }
  } finally {
    if (temp) {
      fs.rmSync(temp, { recursive: true, force: true })
    }
  }
}

/**
 * Downloads the baseline.json of one run's artifact.
 *
 * @param {object} input
 * @param {object} input.github A GitHub client.
 * @param {object} input.exec   `getExecOutput`.
 * @param {object} input.log    The log.
 * @param {string} input.owner  Repository owner.
 * @param {string} input.repo   Repository name.
 * @param {number} input.id     The run.
 * @param {string} input.dir    A folder to download into.
 *
 * @throws {CheckFailure} When the artifacts cannot be listed or the download fails.
 *
 * @returns {Promise<string|null>} The path of the baseline.json, or null when the run has none.
 */
async function downloadBaseline({ github, exec, log, owner, repo, id, dir }) {
  let data
  try {
    ;({ data } = await github.request('GET /repos/{owner}/{repo}/actions/runs/{run_id}/artifacts', {
      owner,
      repo,
      run_id: id,
      name: ARTIFACT,
    }))
  } catch (error) {
    log.err(`${error.message}${error.status ? ` (HTTP ${error.status})` : ''}`)
    throw lookupFailed(`artifacts of run ${id}`)
  }

  if (!Array.isArray(data?.artifacts)) {
    throw lookupFailed(`artifacts of run ${id}`)
  }
  if (!data.artifacts.some((artifact) => !artifact.expired)) {
    return null
  }

  fs.rmSync(dir, { recursive: true, force: true })
  const download = await exec.getExecOutput(
    'gh',
    ['run', 'download', String(id), '--repo', `${owner}/${repo}`, '--name', ARTIFACT, '--dir', dir],
    { silent: true, ignoreReturnCode: true }
  )
  if (download.exitCode !== 0) {
    if (download.stderr) {
      log.err(download.stderr.trimEnd())
    }
    throw lookupFailed(`download of the artifact of run ${id}`)
  }

  const file = path.join(dir, 'baseline.json')

  return isFile(file) && fs.statSync(file).size > 0 ? file : null
}

/**
 * The repository of the current folder, from the GitHub CLI, for a run on a developer's machine.
 *
 * @param {object} exec `getExecOutput`.
 *
 * @throws {CheckFailure} When there is no repository.
 *
 * @returns {Promise<string>} `owner/name`.
 */
async function repositoryFromGh(exec) {
  const result = await exec.getExecOutput('gh', ['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner'], {
    silent: true,
    ignoreReturnCode: true,
  })
  const repo = result.stdout.trim()

  if (result.exitCode !== 0 || !repo) {
    throw lookupFailed('no repository')
  }

  return repo
}

/**
 * The label and the advisory flag for a baseline that was found.
 *
 * A baseline from an older run than the base commit's cannot fail the check, because the target
 * may have changed since.
 *
 * @param {string} event `pull_request`, or any other event name.
 * @param {string} match `exact` or `older`.
 *
 * @returns {{label: string, advisory: boolean}} How the comment names the baseline.
 */
function describeBaseline(event, match) {
  if (match === 'older') {
    return { label: 'Target branch, older run', advisory: true }
  }

  return { label: event === 'pull_request' ? 'Target branch' : 'Previous run', advisory: false }
}

/**
 * The first step: where this run keeps its files, and which workflow's runs hold the baseline.
 *
 * One folder per run under RUNNER_TEMP, cleared first, so a second use of the action in the same
 * job never reads the first one's files.
 *
 * @param {object} input
 * @param {object} input.core The toolkit github-script passes in.
 * @param {object} input.env  The environment: RUNNER_TEMP, GITHUB_WORKFLOW_REF, GITHUB_REPOSITORY and
 *                            INPUT_COMMENT_MARKER.
 *
 * @returns {number} 0.
 */
function runPaths({ core, env }) {
  const dir = path.join(env.RUNNER_TEMP, 'plugin-check-report')
  fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(path.join(dir, 'report'), { recursive: true })
  fs.mkdirSync(path.join(dir, 'baseline'), { recursive: true })

  const workflow = workflowFromRef(env.GITHUB_WORKFLOW_REF)

  core.setOutput('report', path.join(dir, 'report'))
  core.setOutput('baseline', path.join(dir, 'baseline', 'baseline.json'))
  core.setOutput('workflow', workflow)
  core.setOutput('marker', env.INPUT_COMMENT_MARKER || `<!-- plugin-check:${env.GITHUB_REPOSITORY} -->`)
  core.info(`Baselines are read from the runs of ${workflow}.`)

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
 * The step that finds the baseline. A pull request takes the run for its base commit; for a stacked
 * pull request that is the run of the pull request below it. When that run is still going, it is
 * waited for. When it has no baseline, the latest run on the base branch is used instead, and
 * more errors than it are only reported, not failed. Any other event takes the run before it on
 * the same branch, so a merge that adds errors fails there, where the whole team sees it.
 *
 * Sets the outputs `label`, `url` and `advisory` when it finds one.
 *
 * @param {object}   input
 * @param {object}   input.github A GitHub client.
 * @param {object}   input.core   The toolkit.
 * @param {object}   input.exec   `exec` from github-script.
 * @param {object}   input.env    EVENT, BASE_REF, BASE_SHA, WAIT, WORKFLOW, BASELINE, GITHUB_REPOSITORY,
 *                                GITHUB_RUN_ID and GITHUB_REF_NAME.
 * @param {Function} input.now    Optional clock.
 * @param {Function} input.sleep  Optional wait.
 *
 * @returns {Promise<number>} 0 when a baseline was found or none exists, 2 when the lookup failed.
 */
async function runFetch({ github, core, exec, env, now, sleep }) {
  const pullRequest = env.EVENT === 'pull_request'
  const args = pullRequest
    ? ['--workflow', env.WORKFLOW ?? '', '--sha', env.BASE_SHA ?? '', '--wait', env.WAIT ?? '', env.BASE_REF ?? '', env.BASELINE ?? '']
    : ['--workflow', env.WORKFLOW ?? '', '--before-run', env.GITHUB_RUN_ID ?? '', env.GITHUB_REF_NAME ?? '', env.BASELINE ?? '']

  const found = await fetchBaseline({ args, env, github, exec, log: actionLog(core), now, sleep })

  if (found.status === 1) {
    core.info('No earlier run has a baseline.')

    return 0
  }
  if (found.status !== 0) {
    return found.status
  }

  const { label, advisory } = describeBaseline(env.EVENT, found.match)
  core.setOutput('label', label)
  core.setOutput('url', found.url)
  core.setOutput('advisory', String(advisory))
  core.info(`Baseline from ${found.url} (${found.match})`)

  return 0
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
function runCompare({ core, env }) {
  const args = env.COMMENT_FILE ? ['--comment-file', env.COMMENT_FILE] : []

  return compare({ args: [...args, env.RESULTS ?? ''], env, log: actionLog(core) })
}

/**
 * A GitHub client for a run on a developer's machine. The token comes from GITHUB_TOKEN, else
 * GH_TOKEN, else the GitHub CLI.
 *
 * @param {object} env  The environment.
 * @param {object} exec `getExecOutput`.
 *
 * @returns {Promise<object>} A client.
 */
async function clientFromEnv(env, exec) {
  let token = env.GITHUB_TOKEN || env.GH_TOKEN

  if (!token) {
    const result = await exec.getExecOutput('gh', ['auth', 'token'], { silent: true, ignoreReturnCode: true })
    token = result.stdout.trim()
  }
  if (!token) {
    throw lookupFailed('no token. Set GITHUB_TOKEN, or sign in with `gh auth login`')
  }

  const { getOctokit } = await import('@actions/github')

  return getOctokit(token)
}

/**
 * `getExecOutput` for a command line, built on child_process.
 *
 * @param {object} env The environment the commands run with.
 *
 * @returns {{getExecOutput: Function}} The same shape as @actions/exec.
 */
function commandExec(env) {
  const { spawnSync } = require('node:child_process')

  return {
    getExecOutput: async (command, args = []) => {
      const result = spawnSync(command, args, { encoding: 'utf8', env })

      return { exitCode: result.status ?? 127, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
    },
  }
}

/**
 * The command line: `compare` and `fetch`, with the arguments and the environment variables of the
 * two bash scripts they replace.
 *
 * @param {string[]} argv The arguments after the script name.
 * @param {object}   env  The environment, default process.env.
 * @param {object}   io   `out` and `err`, each writing one line. Default: the process streams.
 * @param {object}   deps Stand-ins for a test: `github`, `exec`, `now`, `sleep`.
 *
 * @returns {Promise<number>} The exit status.
 */
async function main(
  argv,
  env = process.env,
  io = {
    out: (line) => process.stdout.write(`${line}\n`),
    err: (line) => process.stderr.write(`${line}\n`),
  },
  deps = {}
) {
  const [command, ...args] = argv
  const log = commandLog(io)

  if (command === 'compare') {
    return compare({ args, env, log })
  }

  if (command === 'fetch') {
    const exec = deps.exec ?? commandExec(env)
    let github = deps.github
    try {
      github ??= await clientFromEnv(env, exec)
    } catch (error) {
      log.err(error.message)

      return 2
    }

    const found = await fetchBaseline({ args, env, github, exec, log, now: deps.now, sleep: deps.sleep })
    if (found.status === 0) {
      log.out(`${found.id} ${found.url} ${found.match}`)
    }

    return found.status
  }

  io.err('Usage: plugin-check-report.js compare|fetch ...')

  return 2
}

if (require.main === module) {
  main(process.argv.slice(2)).then((status) => {
    process.exitCode = status
  })
}

module.exports = {
  ARTIFACT,
  CheckFailure,
  MODES,
  actionLog,
  asciiLower,
  buildComment,
  buildRows,
  change,
  checkResultsText,
  checkWorkflowFile,
  commandLog,
  compare,
  compareCodePoints,
  countPerCode,
  countRuns,
  cutBytes,
  describeBaseline,
  displayCode,
  evaluate,
  fetchBaseline,
  formatBaseline,
  isOwnRun,
  linksLine,
  main,
  orderCandidates,
  parseFetchArgs,
  parseResults,
  readBaseline,
  readJsonValues,
  readWholeNumber,
  runCompare,
  runFetch,
  runPaths,
  runUpdate,
  statusLine,
  workflowFromRef,
}
