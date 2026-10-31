'use strict'

/**
 * Writes the "Try in WordPress Playground" comment on a pull request: "building" while the zip is
 * made, the links when it is ready, "failed" when something broke.
 *
 * The links come from blueprint files: the plugin repository's own, or the default next to this
 * script. Each file becomes one link. The `{{ZIP_URL}}` placeholder in a file is replaced with the
 * zip of the pull request, and the blueprint goes into the link itself, base64 encoded in the URL
 * hash. Nothing is hosted anywhere.
 *
 * run() is the entry point actions/github-script calls. The functions it is built from are pure,
 * apart from reading the blueprint files and the API calls, so a test can assert each one. Run as
 * a script, it prints the comment for local blueprint files instead of posting it; see main().
 */

const fs = require('node:fs')
const path = require('node:path')

/** Used when the caller lists no blueprint files. Works for any plugin. */
const DEFAULT_BLUEPRINT = path.join(__dirname, 'blueprints', 'default.json')

/** Where a blueprint in the URL hash opens. Playground reads JSON or base64 JSON from the hash. */
const PLAYGROUND_URL = 'https://playground.wordpress.net/'

/**
 * GitHub refuses a comment body longer than this. The hash is never sent to a server, so the
 * comment, not the link, is the limit that applies first.
 */
const MAX_COMMENT_LENGTH = 65536

/** A placeholder: a name in capitals between double braces. Anything else is left alone. */
const PLACEHOLDER = /\{\{([A-Z][A-Z0-9_]*)\}\}/g

/** Keys a blueprint file may hold that Playground does not need, removed to keep the link short. */
const DROPPED_KEYS = ['$schema', 'meta']

const STATUSES = ['building', 'ready', 'failed']

/**
 * Splits the `blueprints` input into file paths, one per line. Empty lines are skipped.
 *
 * @param {string} text The input.
 *
 * @returns {string[]} The paths, trimmed. Empty when the input is empty.
 */
function readBlueprintList(text) {
  return String(text ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
}

/**
 * Checks the zip URL. It ends up in every link, so a wrong one would make every preview fail in
 * the browser, long after this run looked green.
 *
 * @param {string} zipUrl The `zip-url` input.
 *
 * @throws {Error} When it is empty or not an https URL.
 *
 * @returns {string} The URL, trimmed.
 */
function validateZipUrl(zipUrl) {
  const trimmed = String(zipUrl ?? '').trim()
  let parsed = null

  try {
    parsed = new URL(trimmed)
  } catch {
    // Reported below, with the same message as a URL that is not https.
  }

  if (!parsed || parsed.protocol !== 'https:') {
    throw new Error(
      `The zip URL '${trimmed}' is not an https URL. Playground downloads the plugin from it in ` +
        'the browser, so it has to be a public https link.'
    )
  }

  return trimmed
}

/**
 * Reads one blueprint file.
 *
 * @param {string} file The path, relative to `cwd` or absolute.
 * @param {string} cwd  The directory relative paths start from: the checkout.
 *
 * @throws {Error} When the file is missing, is not JSON, or is not a JSON object.
 *
 * @returns {object} The parsed blueprint.
 */
function loadBlueprint(file, cwd) {
  const full = path.resolve(cwd, file)

  if (!fs.existsSync(full)) {
    throw new Error(`The blueprint file ${file} does not exist. Paths are relative to the repository root.`)
  }

  let blueprint = null
  try {
    blueprint = JSON.parse(fs.readFileSync(full, 'utf8'))
  } catch (error) {
    throw new Error(`The blueprint file ${file} is not valid JSON: ${error.message}`)
  }

  if (blueprint === null || typeof blueprint !== 'object' || Array.isArray(blueprint)) {
    throw new Error(`The blueprint file ${file} has to hold a JSON object, as Playground expects.`)
  }

  return blueprint
}

/**
 * Replaces the placeholders in every string of a blueprint.
 *
 * The values go into the parsed strings, never into the raw file, so a value with a quote or a
 * backslash cannot break the JSON.
 *
 * @param {*}      value  The blueprint, or a part of it.
 * @param {object} values Each placeholder name mapped to its value, e.g. {ZIP_URL: 'https://...'}.
 * @param {string} file   The file it came from, for the error message.
 * @param {Set}    used   Collects the names that were replaced.
 *
 * @throws {Error} On a placeholder with no value, which is most likely a typo.
 *
 * @returns {*} A copy with the placeholders replaced.
 */
function fillPlaceholders(value, values, file, used = new Set()) {
  if (typeof value === 'string') {
    return value.replace(PLACEHOLDER, (match, name) => {
      if (!Object.hasOwn(values, name)) {
        const known = Object.keys(values).map((key) => `{{${key}}}`).join(', ')
        throw new Error(`The blueprint file ${file} uses ${match}, which this action does not fill. It fills ${known}.`)
      }
      used.add(name)
      return values[name]
    })
  }

  if (Array.isArray(value)) {
    return value.map((item) => fillPlaceholders(item, values, file, used))
  }

  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, fillPlaceholders(item, values, file, used)])
    )
  }

  return value
}

/**
 * Turns one blueprint file into a link: its label, its note, and the blueprint as it goes into the
 * URL.
 *
 * The label and the note come from the file's `meta.title` and `meta.description`, so everything
 * about a variant is in one file. `meta` is then removed: Playground does not use it, and its schema
 * would also ask for `meta.author`.
 *
 * @param {string} file      The path, for messages.
 * @param {object} blueprint The parsed file.
 * @param {string} zipUrl    The zip to install.
 *
 * @throws {Error} When the blueprint never installs the zip: the link would not show this pull
 *                 request at all.
 *
 * @returns {{file: string, title: string, description: string, blueprint: object}} The variant.
 */
function prepareVariant(file, blueprint, zipUrl) {
  const used = new Set()
  const filled = fillPlaceholders(blueprint, { ZIP_URL: zipUrl }, file, used)

  if (!used.has('ZIP_URL')) {
    throw new Error(
      `The blueprint file ${file} does not use {{ZIP_URL}}, so its link would not install this pull ` +
        'request. Install the plugin with a step like {"step": "installPlugin", "pluginData": ' +
        '{"resource": "url", "url": "{{ZIP_URL}}"}}.'
    )
  }

  const meta = filled.meta && typeof filled.meta === 'object' ? filled.meta : {}
  for (const key of DROPPED_KEYS) {
    delete filled[key]
  }

  return {
    file,
    title: typeof meta.title === 'string' ? meta.title.trim() : '',
    description: typeof meta.description === 'string' ? meta.description.trim() : '',
    blueprint: filled,
  }
}

/**
 * Checks that the links can be told apart in the comment.
 *
 * @param {object[]} variants From prepareVariant.
 *
 * @throws {Error} When two have the same title, or more than one has none.
 */
function validateVariants(variants) {
  const untitled = variants.filter((variant) => variant.title === '')
  if (untitled.length > 1) {
    throw new Error(
      `${untitled.map((variant) => variant.file).join(' and ')} have no meta.title. With several ` +
        'blueprints, at most one may go without, so the links can be told apart.'
    )
  }

  const seen = new Map()
  for (const variant of variants) {
    if (variant.title !== '' && seen.has(variant.title)) {
      throw new Error(`${seen.get(variant.title)} and ${variant.file} have the same meta.title '${variant.title}'.`)
    }
    seen.set(variant.title, variant.file)
  }
}

/**
 * The Playground link for a blueprint.
 *
 * Base64 in the hash, rather than JSON in a `blueprint-url` query: the hash never leaves the browser,
 * so no server limit on the request line applies; base64 is about a seventh shorter than
 * percent-encoded JSON; and it is plain ASCII, which a Markdown link keeps as it is. Playground
 * decodes the bytes as UTF-8, so non-ASCII text in a blueprint survives.
 *
 * @param {object} blueprint The blueprint, placeholders filled.
 *
 * @returns {string} The link.
 */
function playgroundUrl(blueprint) {
  return `${PLAYGROUND_URL}#${Buffer.from(JSON.stringify(blueprint), 'utf8').toString('base64')}`
}

/**
 * The time on the badge, like `date '+%m/%d %I:%M %p %Z'`: 01/15 05:43 PM EST.
 *
 * @param {Date}   now      The time to show.
 * @param {string} timeZone An IANA time zone, e.g. America/New_York.
 *
 * @throws {Error} On a time zone the runner does not know.
 *
 * @returns {string} The stamp.
 */
function formatStamp(now, timeZone) {
  let format = null
  try {
    format = new Intl.DateTimeFormat('en-US', {
      timeZone,
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: true,
      timeZoneName: 'short',
    })
  } catch {
    throw new Error(`'${timeZone}' is not a time zone. Use an IANA name such as America/New_York.`)
  }

  const parts = Object.fromEntries(format.formatToParts(now).map((part) => [part.type, part.value]))

  return `${parts.month}/${parts.day} ${parts.hour}:${parts.minute} ${parts.dayPeriod} ${parts.timeZoneName}`
}

/**
 * A shields.io badge with a label, a message and a color.
 *
 * shields.io splits the path on single dashes and reads underscores as spaces, so both are doubled
 * first. A time zone without a short name prints as GMT-3, which would otherwise lose its dash.
 *
 * @param {string} label   Left side, e.g. "Build Started".
 * @param {string} message Right side.
 * @param {string} color   A shields.io color name.
 *
 * @returns {string} The image URL.
 */
function badgeUrl(label, message, color) {
  const escape = (text) => encodeURIComponent(text.replace(/-/g, '--').replace(/_/g, '__'))

  return `https://img.shields.io/badge/${escape(label)}-${escape(message)}-${color}`
}

/**
 * Escapes the characters that would end a Markdown link label early.
 *
 * @param {string} text A title from a blueprint file.
 *
 * @returns {string} The text, safe inside [ ].
 */
function escapeLinkText(text) {
  return text.replace(/[\\[\]]/g, '\\$&')
}

/**
 * The comment body. Its first line is the marker the next run looks for.
 *
 * @param {object}   options
 * @param {string}   options.status   building, ready or failed.
 * @param {string}   options.marker   Hidden first line.
 * @param {string}   options.sha      The commit, full or short.
 * @param {string}   options.stamp    The time for the badge.
 * @param {object[]} options.variants From prepareVariant, for "ready".
 * @param {string}   options.zipUrl   For "ready".
 * @param {string}   options.runUrl   The workflow run, for "failed".
 *
 * @returns {string} The Markdown body.
 */
function buildComment({ status, marker, sha, stamp, variants = [], zipUrl = '', runUrl = '' }) {
  const commit = String(sha ?? '').slice(0, 7)

  if (status === 'building') {
    return [
      marker,
      `🏗️ Playground preview building for commit ${commit}`,
      '',
      `![Build timestamp](${badgeUrl('Build Started', stamp, 'blue')})`,
      '',
      'This takes a few minutes.',
      '',
    ].join('\n')
  }

  if (status === 'failed') {
    return [
      marker,
      `❌ Playground preview build failed for commit ${commit}`,
      '',
      `![Build timestamp](${badgeUrl('Build Failed', stamp, 'red')})`,
      '',
      `See the [workflow run](${runUrl}) for the error. Push a commit to try again.`,
      '',
    ].join('\n')
  }

  const links = variants.map((variant) => {
    const label = variant.title === '' ? 'Try in WordPress Playground' : `Try in WordPress Playground (${escapeLinkText(variant.title)})`
    return `- 🛝 [${label}](${playgroundUrl(variant.blueprint)})`
  })

  const notes = variants
    .filter((variant) => variant.description !== '')
    .map((variant) => (variant.title === '' ? variant.description : `**${variant.title}:** ${variant.description}`))

  return [
    marker,
    `🎉 Playground preview ready for commit ${commit}`,
    '',
    `![Build timestamp](${badgeUrl('Built', stamp, 'darkgreen')})`,
    '',
    ...links,
    `- 💾 [Download zip](${zipUrl})`,
    '',
    ...(notes.length ? [...notes, ''] : []),
  ].join('\n')
}

/**
 * Fails when the comment is longer than GitHub accepts, naming each link's length, so the blueprint
 * to shorten is obvious.
 *
 * @param {string}   body     The comment.
 * @param {object[]} variants The variants in it.
 *
 * @throws {Error} When the body is too long.
 */
function checkCommentLength(body, variants) {
  if (body.length <= MAX_COMMENT_LENGTH) {
    return
  }

  const sizes = variants.map((variant) => `${variant.file}: ${playgroundUrl(variant.blueprint).length}`).join(', ')
  throw new Error(
    `The comment would be ${body.length} characters, and GitHub takes at most ${MAX_COMMENT_LENGTH}. ` +
      `Link lengths: ${sizes}. Make the largest blueprint smaller, for example by moving setup into ` +
      'a plugin or a WP-CLI command it runs.'
  )
}

/**
 * Builds the "ready" comment from the blueprint files.
 *
 * @param {object}   options
 * @param {string[]} options.files  Blueprint paths. Empty uses the default blueprint.
 * @param {string}   options.cwd    Where relative paths start.
 * @param {string}   options.zipUrl The zip.
 * @param {string}   options.marker The hidden first line.
 * @param {string}   options.sha    The commit.
 * @param {string}   options.stamp  The badge time.
 *
 * @returns {{body: string, variants: object[]}} The comment and the variants in it.
 */
function readyComment({ files, cwd, zipUrl, marker, sha, stamp }) {
  const url = validateZipUrl(zipUrl)
  const list = files.length ? files : [DEFAULT_BLUEPRINT]
  const variants = list.map((file) => prepareVariant(file, loadBlueprint(file, cwd), url))

  validateVariants(variants)

  const body = buildComment({ status: 'ready', marker, sha, stamp, variants, zipUrl: url })
  checkCommentLength(body, variants)

  return { body, variants }
}

/**
 * Replaces the comment that starts with the marker, or creates one.
 *
 * Found by its first line only, not by author, so it is still found when the caller passes a token
 * other than the workflow's own.
 *
 * @param {object} options
 * @param {object} options.github An Octokit.
 * @param {string} options.owner  Repository owner.
 * @param {string} options.repo   Repository name.
 * @param {number} options.issue  Pull request number.
 * @param {string} options.marker The first line to look for.
 * @param {string} options.body   The new body.
 *
 * @returns {Promise<{id: number, created: boolean}>} The comment, and whether it is new.
 */
async function upsertComment({ github, owner, repo, issue, marker, body }) {
  const comments = await github.paginate(github.rest.issues.listComments, {
    owner,
    repo,
    issue_number: issue,
    per_page: 100,
  })
  const existing = comments.find((comment) => typeof comment.body === 'string' && comment.body.startsWith(marker))

  if (existing) {
    await github.rest.issues.updateComment({ owner, repo, comment_id: existing.id, body })
    return { id: existing.id, created: false }
  }

  const { data } = await github.rest.issues.createComment({ owner, repo, issue_number: issue, body })
  return { id: data.id, created: true }
}

/**
 * The entry point actions/github-script calls. The inputs arrive as INPUT_* variables, so they
 * are data and never part of the script.
 *
 * @param {object}   options
 * @param {object}   options.github An Octokit, from github-script.
 * @param {object}   options.core   @actions/core, from github-script.
 * @param {object}   options.env    process.env.
 * @param {Date}     options.now    The current time, for tests.
 *
 * @throws {Error} On a bad input or blueprint. github-script then fails the step with the message.
 */
async function run({ github, core, env, now = new Date() }) {
  const status = String(env.INPUT_STATUS ?? '').trim()
  if (!STATUSES.includes(status)) {
    throw new Error(`Unknown status '${status}'. Use ${STATUSES.join(', ')}.`)
  }

  const issue = Number(env.INPUT_PULL_REQUEST)
  if (!Number.isInteger(issue) || issue <= 0) {
    throw new Error('No pull request number. This action only runs for pull_request events.')
  }

  const [owner, repo] = String(env.GITHUB_REPOSITORY ?? '').split('/')
  const marker = env.INPUT_COMMENT_MARKER || `<!-- playground-preview:${env.GITHUB_REPOSITORY} -->`
  const stamp = formatStamp(now, env.INPUT_TIME_ZONE || 'America/New_York')
  const sha = env.INPUT_SHA

  let body = ''
  if (status === 'ready') {
    body = readyComment({
      files: readBlueprintList(env.INPUT_BLUEPRINTS),
      cwd: env.GITHUB_WORKSPACE || process.cwd(),
      zipUrl: env.INPUT_ZIP_URL,
      marker,
      sha,
      stamp,
    }).body
  } else {
    const runUrl = `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`
    body = buildComment({ status, marker, sha, stamp, runUrl })
  }

  // The job summary keeps the links when posting the comment fails, and is where a test run reads them.
  await core.summary.addRaw(body).write()

  const comment = await upsertComment({ github, owner, repo, issue, marker, body })
  core.info(`${comment.created ? 'Created' : 'Updated'} comment ${comment.id} on #${issue} (${status}).`)
}

/**
 * Local use: prints the "ready" comment for blueprint files on this machine, posts nothing.
 *
 *   node playground-preview.js --zip-url https://example.com/my-plugin.zip [blueprint.json ...]
 *
 * With no file, the default blueprint is used. Open a link from the output to try it.
 *
 * @param {string[]} argv The arguments after the script.
 *
 * @returns {number} The exit code.
 */
function main(argv) {
  const { parseArgs } = require('node:util')

  try {
    const { values, positionals } = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        'zip-url': { type: 'string', default: '' },
        sha: { type: 'string', default: 'local' },
        'time-zone': { type: 'string', default: 'America/New_York' },
      },
    })
    const { body } = readyComment({
      files: positionals,
      cwd: process.cwd(),
      zipUrl: values['zip-url'],
      marker: '<!-- playground-preview:local -->',
      sha: values.sha,
      stamp: formatStamp(new Date(), values['time-zone']),
    })
    process.stdout.write(body)
    return 0
  } catch (error) {
    process.stderr.write(`${error.message}\n`)
    return 1
  }
}

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2))
}

module.exports = {
  run,
  main,
  readBlueprintList,
  validateZipUrl,
  loadBlueprint,
  fillPlaceholders,
  prepareVariant,
  validateVariants,
  playgroundUrl,
  formatStamp,
  badgeUrl,
  buildComment,
  checkCommentLength,
  readyComment,
  upsertComment,
  DEFAULT_BLUEPRINT,
  MAX_COMMENT_LENGTH,
}
