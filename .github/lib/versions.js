'use strict'

/**
 * Numeric version parts, shared by the toolbox actions.
 *
 * One implementation lives here so every action orders versions the same way. The actions load
 * this file through a path relative to their own directory, so it ships inside the same
 * repository checkout the runner already fetches for the action: there is nothing to publish
 * and nothing for a caller to install.
 */

/**
 * Three or four numeric parts, the shape the stellarwp changelog versioning accepts and the one the
 * release-merge action publishes. That strategy also accepts an empty part (it reads it as 0, so it
 * would take 2.1..21); this pattern rejects that. A version of this shape is also always a valid tag
 * name.
 */
const STELLARWP_VERSION_PATTERN = /^\d+\.\d+\.\d+(\.\d+)?$/

/**
 * Splits a version into its numbers, for comparing one part against another.
 *
 * @param {string} version A numeric version, e.g. `1.2.3`.
 *
 * @returns {number[]} Its parts, e.g. `[1, 2, 3]`.
 */
function toParts(version) {
  return version.split('.').map(Number)
}

/**
 * Orders two versions by their numbers. 1.10.0 is above 1.9.0, and 1.2.3.1 above 1.2.3, neither of
 * which a string comparison gets right. Missing trailing parts count as zero, so 1.2.3 and 1.2.3.0
 * are the same version.
 *
 * The semver package cannot express a version with four parts: 1.2.3.4 is invalid with or without
 * its `loose` option, and comparing one throws. `coerce` drops the fourth part, so a 1.2.3.1 hotfix
 * would compare equal to the 1.2.3 it patches and v1.2 would stop moving to a hotfix. A dependency
 * would also have to be installed by every repository calling an action that uses this, since
 * github-script resolves one from the calling repository's directory.
 *
 * semver does have prerelease precedence, ordering 1.4.0-rc.1 below 1.4.0, and this does not. No
 * suffixed version reaches this function: the actions keep only numeric versions by the time they
 * compare.
 *
 * @param {string} a A numeric version.
 * @param {string} b The version to compare it against.
 *
 * @returns {number} -1 when `a` is lower, 1 when it is higher, 0 when they are the same version.
 */
function compareVersions(a, b) {
  const left = toParts(a)
  const right = toParts(b)

  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const difference = (left[i] ?? 0) - (right[i] ?? 0)
    if (difference !== 0) {
      return difference < 0 ? -1 : 1
    }
  }

  return 0
}

/**
 * Reads a version to release, refusing anything but three or four numeric parts.
 *
 * A pre-release is refused: the version becomes the tag and the title of a published release, and a
 * beta or RC is not released this way. The release dashboard validates versions with this rule, and
 * release-prep does under the stellarwp changelog versioning.
 *
 * @param {string} version The `version` input.
 * @param {string} what    What was not done, to close the message, e.g. `Nothing was merged.`
 *
 * @throws {Error} When it is empty or not of that shape.
 *
 * @returns {string} The version, without surrounding whitespace.
 */
function validateVersion(version, what) {
  const trimmed = String(version ?? '').trim()

  if (trimmed === '') {
    throw new Error(
      'No version was given. The run was dispatched without one, which is what a release with no ' +
        `version set sends: set the release's version and run this step again. ${what}`
    )
  }

  if (!STELLARWP_VERSION_PATTERN.test(trimmed)) {
    throw new Error(
      `'${trimmed}' is not a version this action can release. It takes three or four numeric parts, ` +
        'such as 4.17.0 or 4.17.0.1: no pre-release suffix and no leading v, because the version ' +
        `becomes the tag and the title of the published release. ${what}`
    )
  }

  return trimmed
}

module.exports = { toParts, compareVersions, validateVersion, STELLARWP_VERSION_PATTERN }
