'use strict'

/**
 * Downloads plugins, GitHub releases or WordPress.org, to `<destination>/<name>`.
 *
 * parsePlugins is pure and holds the validation. downloadPlugins takes the toolkit and does the
 * work, so a test can pass stand-ins and assert the commands.
 */

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { runOrFail } = require('../../lib/exec.js')

/** A GitHub repository, `owner/name`. */
const GITHUB_REPOSITORY = /^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9._-]+$/

/** A WordPress.org plugin slug. */
const WPORG_SLUG = /^[a-z0-9][a-z0-9-]*$/

/**
 * Splits the `plugins` input and checks every entry.
 *
 * @param {string} plugins One plugin per line.
 *
 * @throws {Error} When an entry is neither `owner/name` nor a slug, or two entries share a name.
 *
 * @returns {{spec: string, name: string, github: boolean}[]} The plugins, in the order given.
 */
function parsePlugins(plugins) {
  const parsed = String(plugins ?? '')
    .split(/\s+/)
    .filter(Boolean)
    .map((spec) => {
      const github = spec.includes('/')

      if (!(github ? GITHUB_REPOSITORY : WPORG_SLUG).test(spec) || spec.endsWith('.')) {
        throw new Error(`Refusing to download '${spec}': pass 'owner/name' or a WordPress.org slug.`)
      }

      return { spec, name: spec.split('/').pop(), github }
    })

  // Two plugins with one directory name would place the second over the first.
  for (const [index, { spec, name }] of parsed.entries()) {
    const clash = parsed.slice(0, index).find((earlier) => earlier.name === name)

    if (clash) {
      throw new Error(`Refusing to download '${spec}': '${clash.spec}' already goes to the directory '${name}'.`)
    }
  }

  return parsed
}

/**
 * Puts the extracted archive at `<dest>/<name>`.
 *
 * A runner that keeps the workspace parent may still hold the previous copy, and `mv` would nest the
 * new one inside it, so the old one goes first. The repository itself is never replaced.
 *
 * @param {object} options
 * @param {object} options.exec      The @actions/exec toolkit.
 * @param {string} options.dest      The directory the plugins go in.
 * @param {string} options.workspace The checkout, which must not be replaced.
 * @param {string} options.tmp       A scratch directory that holds `plugin.zip`.
 * @param {string} options.name      The directory name of the plugin.
 *
 * @throws {Error} When the target is the checkout or holds it, or the archive holds no directory.
 *
 * @returns {Promise<string>} The directory the plugin is in.
 */
async function place({ exec, dest, workspace, tmp, name }) {
  fs.mkdirSync(dest, { recursive: true })

  const target = path.join(dest, name)

  // Not only the checkout itself: a destination such as `../..` would put the target above it, and
  // the old copy is removed recursively. Both sides are resolved first, so a symlink on either path
  // cannot name the same directory by a different string.
  const resolvedTarget = path.join(fs.realpathSync(dest), name)
  const checkout = path.relative(fs.existsSync(resolvedTarget) ? fs.realpathSync(resolvedTarget) : resolvedTarget, fs.realpathSync(workspace))

  // `..` only counts as leaving the target when it is a whole path segment: `..checkout` is a
  // directory inside it.
  const outside = checkout === '..' || checkout.startsWith(`..${path.sep}`) || path.isAbsolute(checkout)

  if (checkout === '' || !outside) {
    throw new Error(`The plugin '${name}' would replace the checkout or a directory that holds it.`)
  }

  const unpacked = path.join(tmp, 'unpacked')

  fs.rmSync(target, { recursive: true, force: true })
  fs.rmSync(unpacked, { recursive: true, force: true })
  await runOrFail(exec, 'unzip', ['-q', path.join(tmp, 'plugin.zip'), '-d', unpacked], {}, `Unpacking '${name}'`)

  // Both kinds of archive hold one directory.
  const [directory] = fs
    .readdirSync(unpacked, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())

  if (!directory) {
    throw new Error(`The archive of '${name}' holds no directory.`)
  }

  await runOrFail(exec, 'mv', [path.join(unpacked, directory.name), target], {}, `Moving '${name}' into place`)

  return target
}

/**
 * Downloads each plugin and, for a GitHub repository, installs its Composer dependencies.
 *
 * @param {object}   options
 * @param {object}   options.core      The @actions/core toolkit, for the log.
 * @param {object}   options.exec      The @actions/exec toolkit.
 * @param {object[]} options.plugins   The parsed plugins.
 * @param {string}   options.workspace The checkout.
 * @param {string}   options.dest      The directory the plugins go in. Defaults to the one that
 *                                     holds the checkout.
 * @param {string}   options.tmp       A scratch directory.
 *
 * @returns {Promise<string[]>} The directories the plugins went to.
 */
async function downloadPlugins({ core, exec, plugins, workspace, tmp, dest = path.dirname(workspace) }) {
  fs.mkdirSync(dest, { recursive: true })

  const zip = path.join(tmp, 'plugin.zip')
  const placed = []

  for (const { spec, name, github } of plugins) {
    if (github) {
      const tag = (await runOrFail(exec, 'gh', ['release', 'view', '--repo', spec, '--json', 'tagName', '--jq', '.tagName'], {}, `Finding the latest release of ${spec}`)).trim()

      core.info(`${spec}: ${tag}`)
      await runOrFail(exec, 'gh', ['release', 'download', tag, '--repo', spec, '--archive', 'zip', '--output', zip, '--clobber'], {}, `Downloading ${spec} ${tag}`)
    } else {
      await runOrFail(exec, 'curl', ['-fsSL', '-o', zip, `https://downloads.wordpress.org/plugin/${spec}.latest-stable.zip`], {}, `Downloading ${spec} from WordPress.org`)
    }

    const target = await place({ exec, dest, workspace, tmp, name })

    // Only a GitHub repository the caller named: it is trusted like the caller's own code, and gets
    // the tokens. A WordPress.org zip ships its vendor directory, and its composer.json is code the
    // caller does not control: Composer would run its scripts and let its `config` choose where
    // files are written.
    if (github && fs.existsSync(path.join(target, 'composer.json'))) {
      await runOrFail(exec, 'composer', ['install', '--no-interaction', '--no-progress', '--prefer-dist', `--working-dir=${target}`], {}, `Installing the dependencies of '${name}'`)
    }

    placed.push(target)
  }

  return placed
}

/**
 * Downloads the plugins named by the inputs.
 *
 * @param {object} core The @actions/core toolkit, for the log and the `paths` output.
 * @param {object} exec The @actions/exec toolkit.
 * @param {object} env  The environment the action manifest put its inputs in.
 *
 * @throws {Error} When an entry is invalid or a download fails.
 *
 * @returns {Promise<void>} Resolves once every plugin is in place.
 */
async function run({ core, exec, env }) {
  const plugins = parsePlugins(env.INPUT_PLUGINS)

  if (plugins.length === 0) {
    core.info('No plugins to download.')
    core.setOutput('paths', '')

    return
  }

  const tmp = fs.mkdtempSync(path.join(env.RUNNER_TEMP || os.tmpdir(), 'plugins-'))

  try {
    const workspace = env.GITHUB_WORKSPACE
    const dest = env.INPUT_DESTINATION ? path.resolve(workspace, env.INPUT_DESTINATION) : undefined
    const placed = await downloadPlugins({ core, exec, plugins, workspace, tmp, dest })

    core.setOutput('paths', placed.join('\n'))
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}

module.exports = { run, downloadPlugins, parsePlugins, place }
