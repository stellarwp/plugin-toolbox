'use strict'

/**
 * Files the hooks and views a release changes as pending changelog entries, so the release notes
 * name them. Run before the changelog is written, on a checkout with full history and tags.
 *
 * Compared with the last release tag:
 *  - the `apply_filters` / `do_action` calls under `paths` whose name is a complete string literal,
 *    outside comments and outside the HTML of a template.
 *    A hook is added when it is live now and was not at the tag, deprecated when every call became
 *    a `_deprecated` one, and removed when no call is left, so one that moved, or that still has
 *    another call elsewhere, is not listed. A hook in both trees whose docblocks gained a `@since`
 *    line is updated;
 *  - the `.php` files under `views-paths` that `git diff` reports as changed, by their path in the
 *    checkout.
 *
 * Each kind becomes one entry, `<changesDir>/analyze-hooks-<change>-<kind>.yaml`, so
 * a second run rewrites the same files. An entry a changelog file already carries above the last
 * release's heading, or another pending file holds, is not written again.
 *
 * runAnalyzeHooks reads the inputs and the checkout and runs git through `exec`. The functions it
 * is built from are pure, so a test can call them with text.
 */

const fs = require('node:fs')
const path = require('node:path')

const { readChangeloggerSection } = require('../../lib/changelogger.js')
const { runOrFail } = require('../../lib/exec.js')
const { compareVersions } = require('../../lib/versions.js')
const { readWorkingDirectory, readCheckoutFile } = require('../../lib/workspace.js')

/** What was not done, to close every error message. */
const WHAT = 'No hook or view changelog entry was written.'

/** The prefix of the files this action owns in the changes directory. */
const FILE_PREFIX = 'analyze-hooks-'

/** A release tag: three or four numeric parts, with or without a leading `v`. Not `6.18.3-rc1`, not `ft-002`. */
const RELEASE_TAG = /^v?\d+\.\d+\.\d+(\.\d+)?$/

/**
 * A hook call whose name is a plain string literal, closed by `,` or `)`. A name built from a
 * variable, interpolation or concatenation (`'tec_' . $name`) is not a name.
 */
const HOOK_CALL = /\b(apply_filters|do_action)(_ref_array|_deprecated)?\s*\(\s*(?:'([^'$]+)'|"([^"$]+)")\s*[,)]/g

/** Every entry the action can write, as `<change>-<kind>`: the keys the `types` input takes. */
const ENTRY_KEYS = [
  'added-filters',
  'updated-filters',
  'deprecated-filters',
  'removed-filters',
  'added-actions',
  'updated-actions',
  'deprecated-actions',
  'removed-actions',
  'changed-views',
]

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
  const version = (tag) => tag.replace(/^v/, '')

  return tags
    .filter((tag) => RELEASE_TAG.test(tag))
    .sort((a, b) => compareVersions(version(a), version(b)))
    .pop()
}

/** Whitespace removed, so text rewrapped or respaced by hand still compares equal. */
const squash = (text) => text.replace(/\s+/g, '')

/**
 * What `code` steps over in PHP: the closing tag, a block comment, a line comment (`#[` opens an
 * attribute, not a comment), a quoted string and a heredoc or nowdoc.
 */
const TOKEN =
  /\?>|\/\*[\s\S]*?\*\/|(?:\/\/|#(?!\[)).*?(?=\?>|$)|'(?:[^'\\]|\\[\s\S])*'|"(?:[^"\\]|\\[\s\S])*"|<<<[ \t]*(['"]?)(\w+)\1\r?\n[\s\S]*?^[ \t]*\2\b/gm

/**
 * The PHP code of a file, with its comments and the HTML outside `<?php ... ?>` turned to spaces and
 * its strings kept, so a call in a comment or in a template's markup is not read as a call.
 *
 * @param {string} source A PHP file.
 *
 * @returns {{text: string, docblocks: {end: number, since: string[]}[]}} The code, as long as the
 *          source, and each `/**` comment: where it ends and its `@since` lines.
 */
function code(source) {
  const docblocks = []
  const pieces = []
  let at = 0
  const blankTo = (end) => {
    pieces.push(source.slice(at, end).replace(/[^\n]/g, ' '))
    at = end
  }
  // Up to and including the next `<?php` or `<?=`, or to the end of the file.
  const toPhp = (from) => {
    const open = source.indexOf('<?', from)
    blankTo(open === -1 ? source.length : open + 2)
  }

  toPhp(0)
  const token = new RegExp(TOKEN.source, TOKEN.flags)
  token.lastIndex = at

  for (let match; (match = token.exec(source)) !== null; token.lastIndex = at) {
    pieces.push(source.slice(at, match.index))
    at = match.index

    if (match[0] === '?>') {
      toPhp(at + 2)
    } else if (/^(\/[/*]|#)/.test(match[0])) {
      if (match[0].startsWith('/**')) {
        const since = match[0].match(/@since\b.*$/gm) ?? []
        docblocks.push({ end: at + match[0].length, since: since.map((line) => squash(line.replace(/\*\/$/, ''))) })
      }
      blankTo(at + match[0].length)
    } else {
      pieces.push(match[0])
      at += match[0].length
    }
  }
  pieces.push(source.slice(at))

  return { text: pieces.join(''), docblocks }
}

/** @typedef {{live: boolean, since: Set<string>}} Hook A hook in one tree: whether it is live, and its `@since` lines. */

/**
 * The hooks a set of PHP files calls. A hook is live while one of its calls is not a `_deprecated`
 * one, and deprecated when every call is. Its `@since` lines are those of the docblock above each
 * call, when no `;`, `{` or `}` comes between the two.
 *
 * @param {string[]} sources The files.
 *
 * @returns {{filters: Map<string, Hook>, actions: Map<string, Hook>}} The hooks by name, per kind.
 *           */
function hooks(sources) {
  const found = { filters: new Map(), actions: new Map() }

  for (const source of sources) {
    const { text, docblocks } = code(source)

    for (const match of text.matchAll(HOOK_CALL)) {
      const kind = found[match[1] === 'apply_filters' ? 'filters' : 'actions']
      const name = match[3] ?? match[4]
      const hook = kind.get(name) ?? { live: false, since: new Set() }
      const docblock = docblocks.findLast((doc) => doc.end <= match.index)

      hook.live ||= match[2] !== '_deprecated'
      if (docblock && !/[;{}]/.test(text.slice(docblock.end, match.index))) {
        docblock.since.forEach((line) => hook.since.add(line))
      }
      kind.set(name, hook)
    }
  }

  return found
}

/**
 * The state of a hook in a tree.
 *
 * @param {Map<string, Hook>} kind The tree's hooks of one kind.
 * @param {string}            name The hook.
 *
 * @returns {'live'|'deprecated'|'gone'} Whether it has a call that is not deprecated, only
 *          deprecated calls, or none.
 */
function state(kind, name) {
  if (!kind.has(name)) {
    return 'gone'
  }

  return kind.get(name).live ? 'live' : 'deprecated'
}

/**
 * The entries between the tag's source and the current one.
 *
 * @param {string[]} before       The files with a hook call at the last release.
 * @param {string[]} after        The files with a hook call now.
 * @param {string[]} changedFiles The views changed since the last release, by their path in the
 *                                repository.
 *
 * @returns {{change: string, kind: string, names: string[]}[]} One entry per change and kind.
 */
function analyze(before, after, changedFiles) {
  const [old, now] = [hooks(before), hooks(after)]
  const entries = []

  // A hook that became live is added, one whose calls all became deprecated is deprecated, and one
  // with no call left, live or deprecated before, is removed. One that stayed as it was is updated
  // when its docblocks have more `@since` lines than at the tag.
  for (const kind of ['filters', 'actions']) {
    const names = { Added: [], Updated: [], Deprecated: [], Removed: [] }

    for (const name of new Set([...old[kind].keys(), ...now[kind].keys()])) {
      const [was, is] = [state(old[kind], name), state(now[kind], name)]

      if (is !== was) {
        names[{ live: 'Added', deprecated: 'Deprecated', gone: 'Removed' }[is]].push(name)
      } else if (is !== 'gone' && now[kind].get(name).since.size > old[kind].get(name).since.size) {
        names.Updated.push(name)
      }
    }

    for (const [change, list] of Object.entries(names)) {
      if (list.length) {
        entries.push({ change, kind, names: list.sort() })
      }
    }
  }

  const views = changedFiles.filter((file) => file.endsWith('.php'))
  if (views.length) {
    entries.push({ change: 'Changed', kind: 'views', names: [...new Set(views)].sort() })
  }

  return entries
}

/**
 * Reads an input of git pathspecs, one per line.
 *
 * @param {string} input The input value.
 *
 * @returns {string[]} The pathspecs, without blank lines.
 */
function readPathspecs(input) {
  return String(input ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
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
 * Reads what the repository's changelogger configures, from package.json. A file that is missing,
 * not JSON, or without a `changelogger` section gives the changelogger's defaults, as it does for
 * the changelogger itself.
 *
 * @param {string|null} packageJson The file's contents, or null when there is none.
 *
 * @returns {{changesDir: string, changelogFiles: string[], labels: Object<string, string>}} Where
 *          the pending entries live, the files the changelog is written to, and the label each
 *          type is written with.
 */
function readChangelogger(packageJson) {
  const config = readChangeloggerSection(packageJson) ?? {}

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

/** A heading of a changelog file that names a version: `= [6.18.2] 2026-01-01 =`, `= 3.9.0 =`, `### [6.18.2]`. */
const VERSION_HEADING = /^[=#].*?(?<![\d.])(\d+\.\d+\.\d+(?:\.\d+)?)(?![\d.])/gm

/**
 * The part of a changelog file written since the last release: everything above the first heading
 * that names the last release or an earlier one. An entry of an earlier release is not this
 * release's, so a view changed in both is still listed. Comparing, not looking for the last
 * release's own heading, covers a release the changelog has no section for.
 *
 * @param {string} text    The changelog file.
 * @param {string} version The last release, without a leading `v`.
 *
 * @returns {string} The text above that heading, or all of it when no heading names a release
 *          that old.
 */
function sinceLastRelease(text, version) {
  for (const heading of text.matchAll(VERSION_HEADING)) {
    if (compareVersions(heading[1], version) <= 0) {
      return text.slice(0, heading.index)
    }
  }

  return text
}

/**
 * Reads the entries the plugin already carries.
 *
 * @param {string}   cwd            The checkout.
 * @param {string}   changesDir     The directory of pending change files.
 * @param {string[]} changelogFiles The files the changelog is written to.
 * @param {string}   version        The last release, without a leading `v`.
 *
 * @returns {{lines: string[], pending: Set<string>}} What isKnown compares with.
 */
function readKnown(cwd, changesDir, changelogFiles, version) {
  const lines = changelogFiles.flatMap((file) =>
    [...sinceLastRelease(readCheckoutFile(cwd, file) ?? '', version).matchAll(/^\* (.+)$/gm)].map((match) =>
      squash(match[1])
    )
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
 * @throws {Error} When an input is refused, or the checkout is shallow and shows no release tag.
 *
 * @returns {Promise<void>}
 */
async function runAnalyzeHooks({ core, exec, env, cwd: workspace = process.cwd() }) {
  const paths = readPathspecs(env.INPUT_PATHS)
  if (paths.length === 0) {
    throw new Error(`paths is empty. Pass the directories to search for hooks, one per line, e.g. src. ${WHAT}`)
  }
  const viewsPaths = readPathspecs(env.INPUT_VIEWS_PATHS)
  const types = readTypes(env.INPUT_TYPES)
  const cwd = readWorkingDirectory(env.INPUT_WORKING_DIRECTORY, { base: workspace, what: WHAT })
  const { changesDir, changelogFiles, labels } = readChangelogger(readCheckoutFile(cwd, 'package.json'))

  const git = (args, what) => runOrFail(exec, 'git', args, { cwd, silent: true }, what)

  const tag = lastReleaseTag((await git(['tag', '--merged', 'HEAD'], 'Listing the tags')).split('\n'))
  if (!tag) {
    // A shallow checkout hides the tags behind it, which is a mistake in the workflow. A complete
    // history without a release tag is a plugin before its first release, with nothing to compare.
    const shallow = (await git(['rev-parse', '--is-shallow-repository'], 'Reading the checkout')).trim() === 'true'
    if (shallow) {
      throw new Error(
        'No release tag is reachable from HEAD, and the checkout is shallow, so the last release cannot ' +
          `be found. Check out with fetch-depth: 0. ${WHAT}`
      )
    }

    core.setOutput('tag', '')
    core.setOutput('files', '')
    core.warning(`No release tag is reachable from HEAD: there is no last release to compare with. ${WHAT}`)

    return
  }

  // git grep exits 1 when nothing matches, which is a tree without hooks, not a failure.
  const grep = async (args) => {
    const result = await exec.getExecOutput('git', ['grep', '-I', '-z', '--full-name', ...args], {
      cwd,
      silent: true,
      ignoreReturnCode: true,
    })
    if (result.exitCode > 1) {
      throw new Error(`Searching for hooks failed (exit code ${result.exitCode}):\n${result.stderr.trim()}`)
    }

    return result.stdout
  }

  // Every file under `paths` with a hook call, whole, so a name on any line after the parenthesis
  // and a call inside a comment are read right. `-e ''` matches every line, each printed after its
  // file's name and a NUL.
  // ponytail: the file names are passed as arguments, which holds for a few thousand files.
  const sources = async (...tree) => {
    const prefix = tree.length ? `${tree[0]}:` : ''
    const files = (await grep(['-l', '-E', '(apply_filters|do_action)', ...tree, '--', ...paths]))
      .split('\0')
      .filter(Boolean)
      .map((file) => `:(top,literal)${file.slice(prefix.length)}`)
    if (files.length === 0) {
      return []
    }

    const lines = new Map()
    for (const line of (await grep(['-e', '', ...tree, '--', ...files])).split('\n')) {
      const nul = line.indexOf('\0')
      if (nul !== -1) {
        const file = line.slice(0, nul)
        if (!lines.has(file)) {
          lines.set(file, [])
        }
        lines.get(file).push(line.slice(nul + 1))
      }
    }

    return [...lines.values()].map((file) => file.join('\n'))
  }

  const changed =
    viewsPaths.length === 0
      ? []
      : // --relative names a file by its path in the checkout, which git prints the same whatever the
        // form of the pathspec, `./src/views` or `src/views/`.
        (await git(['diff', '--name-only', '--relative', tag, '--', ...viewsPaths], 'Listing the changed views')).split('\n')

  const known = readKnown(cwd, changesDir, changelogFiles, tag.replace(/^v/, ''))
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

  for (const found of analyze(await sources(tag), await sources(), changed)) {
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

module.exports = { runAnalyzeHooks, lastReleaseTag, readTypes }
