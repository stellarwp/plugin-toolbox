'use strict'

/**
 * Files the hooks and views a release changes as pending changelog entries, so the release notes
 * name them. Run before the changelog is written, on a checkout with full history and tags.
 *
 * Compared with the last release tag:
 *  - the `apply_filters` / `do_action` calls under `paths` whose name is a complete string literal.
 *    A hook is added when the current tree has it and the tag's tree does not, removed the other
 *    way round, so one that moved, or that still has another call elsewhere, is not listed;
 *  - the `.php` files under `views-path` that `git diff` reports as changed.
 *
 * Each kind becomes one entry, `<changesDir>/analyze-hooks-<added|removed|changed>-<kind>.yaml`, so
 * a second run rewrites the same files. An entry a changelog file already carries, or another
 * pending file holds, is not written again.
 *
 * runAnalyzeHooks reads the inputs and the checkout and runs git through `exec`. The functions it
 * is built from are pure, so a test can call them with text.
 */

const fs = require('node:fs')
const path = require('node:path')

const { runOrFail } = require('../../lib/exec.js')
const { readWorkingDirectory, readCheckoutFile } = require('../../lib/workspace.js')

/** What was not done, to close every error message. */
const WHAT = 'No hook or view changelog entry was written.'

/** The prefix of the files this action owns in the changes directory. */
const FILE_PREFIX = 'analyze-hooks-'

/** A release tag: three or four numeric parts, with or without a leading `v`. Not `6.18.3-rc1`, not `ft-002`. */
const RELEASE_TAG = /^v?\d+\.\d+\.\d+(\.\d+)?$/

/** The kind each WordPress function files its hook under. */
const FUNCTIONS = {
  apply_filters: 'filters',
  apply_filters_ref_array: 'filters',
  do_action: 'actions',
  do_action_ref_array: 'actions',
}

/**
 * A hook call whose name is a plain string literal, closed by `,` or `)`. A name built from a
 * variable, interpolation or concatenation (`'tec_' . $name`) is not a name.
 */
const HOOK_CALL = /\b(apply_filters(?:_ref_array)?|do_action(?:_ref_array)?)\(\s*(?:'([^'$]+)'|"([^"$]+)")\s*[,)]/g

/** Every entry the action can write, as `<change>-<kind>`: the keys the `types` input takes. */
const ENTRY_KEYS = ['added-filters', 'removed-filters', 'added-actions', 'removed-actions', 'changed-views']

/** The type an entry has when `types` does not name one. */
const DEFAULT_TYPE = 'tweak'

/**
 * The newest release tag, compared part by part as numbers.
 *
 * @param {string[]} tags The tags reachable from HEAD.
 *
 * @returns {string|undefined} The tag, or undefined when none is a release.
 */
function lastReleaseTag(tags) {
  const parts = (tag) => tag.replace(/^v/, '').split('.').map(Number)

  return tags
    .filter((tag) => RELEASE_TAG.test(tag))
    .sort((a, b) => {
      const [x, y] = [parts(a), parts(b)]
      for (let i = 0; i < Math.max(x.length, y.length); i++) {
        if ((x[i] ?? 0) !== (y[i] ?? 0)) {
          return (x[i] ?? 0) - (y[i] ?? 0)
        }
      }

      return 0
    })
    .pop()
}

/**
 * The hook names a source text calls.
 *
 * @param {string} source PHP source, or the matching lines of it.
 *
 * @returns {{filters: Set<string>, actions: Set<string>}} The names, per kind.
 */
function hooks(source) {
  const found = { filters: new Set(), actions: new Set() }

  for (const match of source.matchAll(HOOK_CALL)) {
    found[FUNCTIONS[match[1]]].add(match[2] ?? match[3])
  }

  return found
}

/**
 * The entries between the tag's source and the current one.
 *
 * @param {string}   before       The hook calls at the last release.
 * @param {string}   after        The hook calls now.
 * @param {string[]} changedFiles The files changed since the last release.
 * @param {string}   viewsPath    The directory views live in. Empty lists no view.
 *
 * @returns {{change: string, kind: string, names: string[]}[]} One entry per change and kind.
 */
function analyze(before, after, changedFiles, viewsPath) {
  const [old, now] = [hooks(before), hooks(after)]
  const entries = []

  for (const kind of ['filters', 'actions']) {
    const came = [...now[kind]].filter((name) => !old[kind].has(name))
    const gone = [...old[kind]].filter((name) => !now[kind].has(name))

    if (came.length) {
      entries.push({ change: 'Added', kind, names: came.sort() })
    }
    if (gone.length) {
      entries.push({ change: 'Removed', kind, names: gone.sort() })
    }
  }

  if (viewsPath !== '') {
    const views = changedFiles
      .filter((file) => file.startsWith(`${viewsPath}/`) && file.endsWith('.php'))
      .map((file) => file.slice(viewsPath.length + 1, -'.php'.length))

    if (views.length) {
      entries.push({ change: 'Changed', kind: 'views', names: [...new Set(views)].sort() })
    }
  }

  return entries
}

/**
 * Reads the `paths` input: one git pathspec per line.
 *
 * @param {string} input The input value.
 *
 * @throws {Error} When it lists nothing.
 *
 * @returns {string[]} The pathspecs.
 */
function readPaths(input) {
  const paths = String(input ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)

  if (paths.length === 0) {
    throw new Error(`paths is empty. Pass the directories to search for hooks, one per line, e.g. src. ${WHAT}`)
  }

  return paths
}

/**
 * Reads the `types` input: the changelog type of each entry, for a repository whose changelogger
 * has a type per kind of hook change.
 *
 * @param {string} input A JSON object in a string, `<change>-<kind>` to type. Empty is none.
 *
 * @throws {Error} When it is not a JSON object of known keys and non-empty strings.
 *
 * @returns {Object<string, string>} The type per entry key.
 */
function readTypes(input) {
  const trimmed = String(input ?? '').trim()
  if (trimmed === '') {
    return {}
  }

  const shape = `Pass a JSON object in a string, with keys from ${ENTRY_KEYS.join(', ')}, e.g. '{"added-filters": "tweak: added filters"}'. ${WHAT}`

  let types
  try {
    types = JSON.parse(trimmed)
  } catch {
    throw new Error(`types is not valid JSON. ${shape}`)
  }

  if (types === null || typeof types !== 'object' || Array.isArray(types)) {
    throw new Error(`types is not a JSON object. ${shape}`)
  }

  for (const [key, type] of Object.entries(types)) {
    if (!ENTRY_KEYS.includes(key)) {
      throw new Error(`types has the unknown key '${key}'. ${shape}`)
    }
    if (typeof type !== 'string' || type.trim() === '') {
      throw new Error(`types.${key} is not a changelog type. ${shape}`)
    }
  }

  return types
}

/**
 * Reads what the repository's changelogger configures, from package.json.
 *
 * @param {string|null} packageJson The file's contents, or null when there is none.
 *
 * @throws {Error} When the file is not JSON.
 *
 * @returns {{changesDir: string, changelogFiles: string[], labels: Object<string, string>}} Where
 *          the pending entries live, the files the changelog is written to, and the label each
 *          type is written with.
 */
function readChangelogger(packageJson) {
  let config = {}

  if (packageJson !== null) {
    try {
      config = JSON.parse(packageJson)?.changelogger ?? {}
    } catch {
      throw new Error(`package.json is not valid JSON, so the changelogger's configuration cannot be read. ${WHAT}`)
    }
  }

  const written = (Array.isArray(config.files) ? config.files : []).map((file) => file?.path)

  return {
    changesDir: typeof config.changesDir === 'string' && config.changesDir !== '' ? config.changesDir : 'changelog',
    // readme.txt and changelog.md as well as what is configured: a custom writing strategy names
    // no file, and a file that is not there is skipped.
    changelogFiles: [...new Set([config.changelogFile, ...written, 'changelog.md', 'readme.txt'])].filter(
      (file) => typeof file === 'string' && file !== ''
    ),
    labels: config.types !== null && typeof config.types === 'object' ? config.types : {},
  }
}

/**
 * The type and text of an entry.
 *
 * Without a type of its own an entry is a `tweak` that says what it is, `Added filters: …`. A type
 * from `types` already says it, in the label the changelogger writes, so the text is the names.
 *
 * @param {{change: string, kind: string, names: string[]}} entry The entry.
 * @param {Object<string, string>}                          types The `types` input.
 *
 * @returns {{key: string, type: string, text: string}} The entry's key, changelog type and text.
 */
function describe(entry, types) {
  const key = `${entry.change.toLowerCase()}-${entry.kind}`
  const names = entry.names.map((name) => `\`${name}\``).join(', ')

  return types[key]
    ? { key, type: types[key], text: names }
    : { key, type: DEFAULT_TYPE, text: `${entry.change} ${entry.kind}: ${names}` }
}

/** Whitespace removed, so an entry rewrapped or respaced by hand still compares equal. */
const squash = (text) => text.replace(/\s+/g, '')

/** A YAML scalar on one line: double quoted, single quoted or plain. */
const SCALAR = '(?:"((?:[^"\\\\]|\\\\.)*)"|\'((?:[^\']|\'\')*)\'|(.+))'

/**
 * Reads a one-line scalar of a change file.
 *
 * @param {string} body The change file.
 * @param {string} key  The key to read.
 *
 * @returns {string|undefined} Its value, unquoted.
 */
function scalar(body, key) {
  const match = new RegExp(`^${key}:\\s*${SCALAR}\\s*$`, 'm').exec(body)
  if (!match) {
    return undefined
  }
  if (match[1] !== undefined) {
    return match[1].replace(/\\(.)/g, '$1')
  }

  return match[2] !== undefined ? match[2].replace(/''/g, "'") : match[3].trim()
}

/**
 * Whether the plugin already carries an entry: in a changelog file, as a line that is the type's
 * label and the text, or in a pending change file that is not this action's.
 *
 * @param {{type: string, text: string}} entry   The entry.
 * @param {object}                       known
 * @param {string[]}                     known.lines   The squashed `* ` lines of the changelog files.
 * @param {Set<string>}                  known.pending The pending entries, as squashed `type|text`.
 * @param {Object<string, string>}       labels  The label the changelogger writes each type with.
 *
 * @returns {boolean} True when it is already there.
 */
function isKnown(entry, known, labels) {
  if (known.pending.has(squash(`${entry.type}|${entry.text}`))) {
    return true
  }

  const label = labels[entry.type] ?? `${entry.type[0].toUpperCase()}${entry.type.slice(1)}`

  // `Tweak - Added filters: …` from the stock strategies; a label that ends the sentence itself,
  // `Tweak - Added actions:`, is followed by the names with no separator.
  return [squash(`${label}-${entry.text}`), squash(`${label}${entry.text}`)].some((line) => known.lines.includes(line))
}

/**
 * Reads the entries the plugin already carries.
 *
 * @param {string}   cwd            The checkout.
 * @param {string}   changesDir     The directory of pending change files.
 * @param {string[]} changelogFiles The files the changelog is written to.
 *
 * @returns {{lines: string[], pending: Set<string>}} What isKnown compares with.
 */
function readKnown(cwd, changesDir, changelogFiles) {
  const lines = changelogFiles.flatMap((file) =>
    [...(readCheckoutFile(cwd, file) ?? '').matchAll(/^\* (.+)$/gm)].map((match) => squash(match[1]))
  )

  const pending = new Set()
  const dir = path.join(cwd, changesDir)

  for (const file of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
    if (!file.endsWith('.yaml') || file.startsWith(FILE_PREFIX)) {
      continue
    }

    const body = fs.readFileSync(path.join(dir, file), 'utf8')
    const [type, text] = [scalar(body, 'type'), scalar(body, 'entry')]

    if (type !== undefined && text !== undefined) {
      pending.add(squash(`${type}|${text}`))
    }
  }

  return { lines, pending }
}

/**
 * Runs the action.
 *
 * @param {object} options
 * @param {object} options.core The @actions/core toolkit, for the log, the outputs and the summary.
 * @param {object} options.exec The @actions/exec toolkit, which runs git.
 * @param {object} options.env  The environment, holding the inputs as `INPUT_*`.
 * @param {string} options.cwd  The workspace, the process's working directory by default.
 *
 * @throws {Error} When an input is refused, or no release tag is reachable from HEAD.
 *
 * @returns {Promise<void>}
 */
async function runAnalyzeHooks({ core, exec, env, cwd: workspace = process.cwd() }) {
  const paths = readPaths(env.INPUT_PATHS)
  const viewsPath = String(env.INPUT_VIEWS_PATH ?? '').trim().replace(/\/+$/, '')
  const types = readTypes(env.INPUT_TYPES)
  const cwd = readWorkingDirectory(env.INPUT_WORKING_DIRECTORY, { base: workspace, what: WHAT })
  const { changesDir, changelogFiles, labels } = readChangelogger(readCheckoutFile(cwd, 'package.json'))

  const git = (args, what) => runOrFail(exec, 'git', args, { cwd, silent: true }, what)

  const tag = lastReleaseTag((await git(['tag', '--merged', 'HEAD'], 'Listing the tags')).split('\n'))
  if (!tag) {
    throw new Error(
      'No release tag is reachable from HEAD, so there is no last release to compare with. ' +
        `Check out with fetch-depth: 0. ${WHAT}`
    )
  }

  // git grep exits 1 when nothing matches, which is a tree without hooks, not a failure.
  const calls = async (...tree) => {
    const result = await exec.getExecOutput(
      'git',
      ['grep', '-I', '-h', '-E', '(apply_filters|do_action)', ...tree, '--', ...paths],
      { cwd, silent: true, ignoreReturnCode: true }
    )
    if (result.exitCode > 1) {
      throw new Error(`Searching for hooks failed (exit code ${result.exitCode}):\n${result.stderr.trim()}`)
    }

    return result.stdout
  }

  const changed =
    viewsPath === ''
      ? []
      : (await git(['diff', '--name-only', tag, '--', viewsPath], 'Listing the changed views')).split('\n')

  const known = readKnown(cwd, changesDir, changelogFiles)
  const dir = path.join(cwd, changesDir)
  fs.mkdirSync(dir, { recursive: true })

  // Rewritten from scratch: a file from an earlier run whose change was since reverted must go.
  for (const file of fs.readdirSync(dir)) {
    if (file.startsWith(FILE_PREFIX) && file.endsWith('.yaml')) {
      fs.rmSync(path.join(dir, file))
    }
  }

  const summary = [`## Hook and view changes since ${tag}`]
  const files = []

  for (const found of analyze(await calls(tag), await calls(), changed, viewsPath)) {
    const entry = describe(found, types)

    if (isKnown(entry, known, labels)) {
      summary.push(`- skipped \`${entry.key}\`, the plugin already has it`)
      continue
    }

    const file = `${changesDir}/${FILE_PREFIX}${entry.key}.yaml`
    // JSON strings are valid YAML double-quoted scalars, so no name can break out of the entry.
    fs.writeFileSync(
      path.join(cwd, file),
      `significance: patch\ntype: ${JSON.stringify(entry.type)}\nentry: ${JSON.stringify(entry.text)}\n`
    )
    files.push(file)
    summary.push(`- \`${file}\`: ${entry.text}`)
  }

  core.setOutput('tag', tag)
  core.setOutput('files', files.join('\n'))
  core.info(`Wrote ${files.length} hook and view changelog entries (since ${tag}).`)
  await core.summary.addRaw(summary.join('\n'), true).write()
}

module.exports = { runAnalyzeHooks, lastReleaseTag, hooks, analyze, readPaths, readTypes, readChangelogger, describe, isKnown }
