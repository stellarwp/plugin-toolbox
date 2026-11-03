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
      } else if (typeof count === 'number' && Number.isInteger(count)) {
        counts[kind].set(code, count)
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

/**
 * The command line. `main(['compare', ...args])` is `compare()` with the real environment.
 *
 * @param {string[]} argv The arguments after the script name.
 * @param {object}   env  The environment, default process.env.
 * @param {object}   io   `out` and `err`, each writing one line. Default: the process streams.
 *
 * @returns {Promise<number>} The exit status.
 */
async function main(argv, env = process.env, io = {
  out: (line) => process.stdout.write(`${line}\n`),
  err: (line) => process.stderr.write(`${line}\n`),
}) {
  const [command, ...args] = argv

  if (command === 'compare') {
    return compare({ args, env, log: commandLog(io) })
  }

  io.err('Usage: plugin-check-report.js compare [--update | --comment-file <path>] <results-file>')

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
  buildComment,
  buildRows,
  change,
  checkResultsText,
  commandLog,
  compare,
  compareCodePoints,
  countPerCode,
  cutBytes,
  displayCode,
  evaluate,
  formatBaseline,
  linksLine,
  main,
  parseResults,
  readBaseline,
  readJsonValues,
  statusLine,
}
