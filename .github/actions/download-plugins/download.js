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

/** A GitHub repository, `owner/name`. */
const GITHUB_REPOSITORY = /^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9._-]+$/

/** A WordPress.org plugin slug. */
const WPORG_SLUG = /^[a-z0-9][a-z0-9-]*$/

/**
 * Splits the `plugins` input and checks every entry.
 *
 * @param {string} plugins One plugin per line.
 *
 * @throws {Error} When an entry is neither `owner/name` nor a slug.
 *
 * @returns {{spec: string, name: string, github: boolean}[]} The plugins, in the order given.
 */
function parsePlugins(plugins) {
  return String(plugins ?? '')
    .split(/\s+/)
    .filter(Boolean)
    .map((spec) => {
      const github = spec.includes('/')

      if (!(github ? GITHUB_REPOSITORY : WPORG_SLUG).test(spec) || spec.endsWith('.')) {
        throw new Error(`Refusing to download '${spec}': pass 'owner/name' or a WordPress.org slug.`)
      }

      return { spec, name: spec.split('/').pop(), github }
    })
}

/**
 * The environment without the variables that carry a token.
 *
 * @param {object} env The environment to copy.
 *
 * @returns {object} A copy without `GH_TOKEN` and `COMPOSER_AUTH`.
 */
function withoutTokens(env) {
  const { GH_TOKEN, COMPOSER_AUTH, ...rest } = env

  return rest
}

/**
 * Runs a command and fails with its name when it exits non-zero.
 *
 * @param {object}   exec    The @actions/exec toolkit.
 * @param {string}   command The program.
 * @param {string[]} args    Its arguments.
 * @param {object}   options Passed to @actions/exec.
 *
 * @returns {Promise<string>} What the command printed to stdout.
 */
async function sh(exec, command, args, options = {}) {
  const { stdout } = await exec.getExecOutput(command, args, options)

  return stdout.trim()
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
 * @throws {Error} When the name is the checkout's own, or the archive holds no directory.
 *
 * @returns {Promise<string>} The directory the plugin is in.
 */
async function place({ exec, dest, workspace, tmp, name }) {
  const target = path.join(dest, name)

  if (target === workspace) {
    throw new Error(`The plugin '${name}' has the same directory name as this repository.`)
  }

  const unpacked = path.join(tmp, 'unpacked')

  fs.rmSync(target, { recursive: true, force: true })
  fs.rmSync(unpacked, { recursive: true, force: true })
  await sh(exec, 'unzip', ['-q', path.join(tmp, 'plugin.zip'), '-d', unpacked])

  // Both kinds of archive hold one directory.
  const [directory] = fs
    .readdirSync(unpacked, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())

  if (!directory) {
    throw new Error(`The archive of '${name}' holds no directory.`)
  }

  await sh(exec, 'mv', [path.join(unpacked, directory.name), target])

  return target
}

/**
 * Downloads each plugin and installs its Composer dependencies.
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
      const tag = await sh(exec, 'gh', ['release', 'view', '--repo', spec, '--json', 'tagName', '--jq', '.tagName'])

      core.info(`${spec}: ${tag}`)
      await sh(exec, 'gh', ['release', 'download', tag, '--repo', spec, '--archive', 'zip', '--output', zip, '--clobber'])
    } else {
      await sh(exec, 'curl', ['-fsSL', '-o', zip, `https://downloads.wordpress.org/plugin/${spec}.latest-stable.zip`])
    }

    const target = await place({ exec, dest, workspace, tmp, name })

    if (fs.existsSync(path.join(target, 'composer.json'))) {
      // Composer runs the plugin's own scripts, so a WordPress.org plugin, which the caller does not
      // control, runs without the tokens. Only a GitHub repository the caller named gets them.
      const options = github ? {} : { env: withoutTokens(process.env) }

      await sh(exec, 'composer', ['install', '--no-interaction', '--no-progress', '--prefer-dist', `--working-dir=${target}`], options)
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
