'use strict'

/**
 * Checks what the push-translations action was given, before anything is sent to the translations
 * server, and names the file the import output is written to.
 *
 * The later steps of action.yml copy the POT with rsync and run `wp glotpress import-originals`
 * over ssh. The rsync action builds a shell command from its inputs, and the import is a remote
 * shell command, so every value that reaches either one has to match an allow-list first. Those
 * steps use the outputs set here, never the raw inputs.
 *
 * readInputs is pure, so a test can call it with an environment.
 */

const crypto = require('node:crypto')

/** What was not done, to close every error message. */
const WHAT = 'Nothing was sent to the translations server.'

/**
 * One part of a path: letters, digits, `.`, `_` and `-`, not starting with `.` or `-`. So no part
 * is `..`, a hidden file or a command option, and none holds a space or a shell metacharacter.
 */
const PART = '[A-Za-z0-9_][A-Za-z0-9._-]*'

/** One or more parts joined by `/`. */
const PARTS = `${PART}(?:/${PART})*`

/**
 * What each input has to match, and how to say what it is. The first capture group is the value
 * the action uses, so a trailing `/` is dropped. `secret` keeps the value out of the message.
 */
const RULES = {
  project: {
    pattern: new RegExp(`^(${PARTS})$`),
    shape: 'a GlotPress project path, such as the-events-calendar or givewp/give',
  },
  'pot-path': {
    pattern: new RegExp(`^((?:${PART}/)*${PART}\\.pot)$`),
    shape: 'the path of a .pot file relative to the workspace, such as languages/give.pot',
  },
  'remote-folder': {
    pattern: new RegExp(`^(${PARTS})/?$`),
    shape: 'a folder name under pot-location, such as tec or givewp',
  },
  'site-directory': {
    pattern: new RegExp(`^(/?${PARTS})/?$`),
    shape: 'a directory on the server, absolute or relative to the home of user, such as translations.stellarwp.com/html/',
  },
  'result-url': {
    pattern: new RegExp(`^(https://[A-Za-z0-9][A-Za-z0-9.-]*(?:/${PART})*)/?$`),
    shape: 'an https URL of a folder, with no query, such as https://translations.stellarwp.com/bot-output/',
  },
  host: {
    pattern: /^([A-Za-z0-9][A-Za-z0-9.-]*)$/,
    shape: 'a host name or an IPv4 address',
    secret: true,
  },
  user: {
    pattern: new RegExp(`^(${PART})$`),
    shape: 'a user name',
    secret: true,
  },
  'pot-location': {
    pattern: new RegExp(`^(/${PARTS})/?$`),
    shape: 'an absolute directory on the server, such as /home/user/pots/',
    secret: true,
  },
  // Only handed to the rsync and ssh actions as a key, never part of a command: any text will do.
  'ssh-key': { pattern: /^([\s\S]+)$/, shape: 'a private key', secret: true },
}

/** A build id: 32 lowercase hex characters. */
const BUILD_ID = /^[a-f0-9]{32}$/

/**
 * Reads one input and checks it against its rule.
 *
 * @param {object} env  The environment, holding the inputs as `INPUT_*`.
 * @param {string} name The input's name, as action.yml spells it.
 *
 * @throws {Error} When the value is empty or does not match.
 *
 * @returns {string} The value the action uses.
 */
function readInput(env, name) {
  const { pattern, shape, secret } = RULES[name]
  const value = String(env[`INPUT_${name.toUpperCase().replace(/-/g, '_')}`] ?? '').trim()

  if (value === '') {
    throw new Error(`${name} is empty. Pass ${shape}. ${WHAT}`)
  }

  const match = pattern.exec(value)
  if (!match) {
    // A value from a secret is masked in the log anyway, but is not repeated here either.
    throw new Error(`${name} ${secret ? '' : `'${value}' `}is not ${shape}. ${WHAT}`)
  }

  return match[1]
}

/**
 * Checks every input and builds the values the later steps use.
 *
 * @param {object} env     The environment, holding the inputs as `INPUT_*`.
 * @param {string} buildId What makes the output file's name unique and hard to guess. Random by
 *                         default; a test passes its own.
 *
 * @throws {Error} When an input, or the build id, is refused.
 *
 * @returns {Object<string, string>} The step's outputs, by name.
 */
function readInputs(env, buildId = crypto.randomBytes(16).toString('hex')) {
  const read = Object.fromEntries(Object.keys(RULES).map((name) => [name, readInput(env, name)]))

  if (!BUILD_ID.test(buildId)) {
    throw new Error(`The build id is not 32 hex characters. ${WHAT}`)
  }

  const potFile = read['pot-path'].split('/').pop()
  const remotePath = `${read['pot-location']}/${read['remote-folder']}/`
  const resultFile = `${potFile.slice(0, -'.pot'.length)}-${buildId}`

  // host, user and ssh-key are checked but not returned: the later steps take them from the inputs.
  return {
    project: read.project,
    'pot-path': read['pot-path'],
    'remote-path': remotePath,
    'remote-pot': `${remotePath}${potFile}`,
    'site-directory': read['site-directory'],
    'result-file': resultFile,
    'result-url': `${read['result-url']}/${resultFile}`,
  }
}

/**
 * Runs the check and sets the outputs.
 *
 * @param {object} options
 * @param {object} options.core The @actions/core toolkit, for the outputs and the summary.
 * @param {object} options.env  The environment, holding the inputs as `INPUT_*`.
 *
 * @throws {Error} When an input is refused.
 *
 * @returns {Promise<void>}
 */
async function runPushTranslations({ core, env }) {
  const outputs = readInputs(env)

  for (const [name, value] of Object.entries(outputs)) {
    core.setOutput(name, value)
  }

  await core.summary.addRaw(`## Translations build: \`${outputs['result-file']}\``, true).write()
}

/**
 * Reads what the import printed back from the site, and sets it as the `glotpress-result` output.
 *
 * The URL was built by the check step from checked values. It is checked again for https here,
 * since the request is made with whatever this step is handed.
 *
 * @param {object}   options
 * @param {object}   options.core      The @actions/core toolkit, for the output and the summary.
 * @param {object}   options.env       The environment, holding `RESULT_URL`.
 * @param {Function} options.fetchImpl The fetch to use, the runtime's by default.
 *
 * @throws {Error} When the URL is not https, or the site does not answer 200.
 *
 * @returns {Promise<void>}
 */
async function runReadResult({ core, env, fetchImpl = globalThis.fetch }) {
  const url = String(env.RESULT_URL ?? '')

  if (!url.startsWith('https://')) {
    throw new Error('The import output has no https URL to be read from. The import ran, and its output was not read.')
  }

  const response = await fetchImpl(url, { redirect: 'error', signal: AbortSignal.timeout(60000) })

  if (!response.ok) {
    throw new Error(
      `Reading the import output answered ${response.status}. The import ran, and its output was not read.`
    )
  }

  const result = (await response.text()).trim()

  core.setOutput('glotpress-result', result)
  await core.summary.addHeading('Results from GlotPress', 2).addCodeBlock(result).write()
}

module.exports = { runPushTranslations, runReadResult, readInputs }
