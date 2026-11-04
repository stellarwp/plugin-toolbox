'use strict'

/**
 * Reading the version files a repository's .puprc declares, shared by the toolbox actions. Loaded by a
 * path relative to each action's directory, like versions.js.
 *
 * pup bumps the version in every file listed under `paths.versions`, each with a regex whose first
 * group is the text before the version and whose second group is the version itself. The same
 * entries let an action read the version a branch holds without running pup.
 */

/**
 * Reads the version files .puprc declares.
 *
 * @param {string|null} text The contents of .puprc, or null when the branch has none.
 * @param {string}      what What was not done, to close the error message, e.g. `Nothing was merged.`
 *
 * @throws {Error} When there is no .puprc, it is not JSON, or it declares no version files.
 *
 * @returns {{file: string, regex: string}[]} The files and the regex that finds the version in each.
 */
function readVersionFiles(text, what) {
  if (text === null) {
    throw new Error(
      'No .puprc on the branch, so the version its files hold cannot be read. The version files come ' +
        `from paths.versions in .puprc; see the release-prep action's README. ${what}`
    )
  }

  let config
  try {
    config = JSON.parse(text)
  } catch (error) {
    throw new Error(`.puprc is not valid JSON (${error.message}). ${what}`)
  }

  const versions = config?.paths?.versions
  if (!Array.isArray(versions) || versions.length === 0) {
    throw new Error(`.puprc has no paths.versions, so there is no version file to read. ${what}`)
  }

  for (const entry of versions) {
    if (typeof entry?.file !== 'string' || typeof entry?.regex !== 'string') {
      throw new Error(`.puprc lists a paths.versions entry without a file and a regex. ${what}`)
    }
  }

  return versions.map(({ file, regex }) => ({ file, regex }))
}

/**
 * The version a file holds, found with the regex .puprc gives for it: the second group, the way pup
 * reads and rewrites it.
 *
 * @param {string} content The file.
 * @param {string} regex   The regex from .puprc, two groups: the text before the version, the version.
 *
 * @throws {Error} When the regex is not one JavaScript accepts.
 *
 * @returns {string|null} The version, trimmed, or null when the regex matches nothing.
 */
function versionIn(content, regex) {
  const match = new RegExp(regex).exec(content)

  return match && match[2] !== undefined ? match[2].trim() : null
}

module.exports = { readVersionFiles, versionIn }
