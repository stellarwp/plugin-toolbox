'use strict'

/**
 * Reads the stellarwp/changelogger configuration, shared by the toolbox actions. Loaded by a path
 * relative to each action's directory, like versions.js.
 */

/**
 * The `changelogger` section of `package.json`.
 *
 * A file that is missing, not JSON, or without the section gives null: the changelogger itself
 * then runs on its defaults, and the actions follow it.
 *
 * @param {string|null} text The contents of `package.json`, or null when there is none.
 *
 * @returns {object|null} The section, or null when there is none to read.
 */
function readChangeloggerSection(text) {
  if (text === null) {
    return null
  }

  try {
    const section = JSON.parse(text)?.changelogger

    return section !== null && typeof section === 'object' && !Array.isArray(section) ? section : null
  } catch {
    return null
  }
}

module.exports = { readChangeloggerSection }
