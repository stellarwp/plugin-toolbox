'use strict'

/**
 * Works out which floating version tags a released version should own.
 *
 * resolveFloatingTags is pure: it takes the repository's tag names as data and returns the
 * decision, so every rule below can be tested without the API. run() is the thin wrapper that
 * fetches what it needs and writes the outputs.
 */

/** A version is numbers separated by dots, at least two of them. */
const NUMERIC_VERSION = /^\d+(\.\d+)+$/

/** How many leading parts of the version each level's tag name carries. */
const LEVEL_DEPTHS = { major: 1, minor: 2 }

/**
 * Turns a tag name into the version it stands for: drops a leading `v` and any build metadata.
 * A prerelease suffix is left in place, so the result of a prerelease tag fails NUMERIC_VERSION
 * and is excluded from every comparison.
 *
 * @param {string} tagName A tag name, e.g. `v1.2.3`, `1.4.0+build.7` or `1.4.0-rc.1`.
 *
 * @returns {string} The version it stands for, e.g. `1.2.3`, `1.4.0` or `1.4.0-rc.1`.
 */
function toVersion(tagName) {
  return tagName.replace(/^v/, '').replace(/\+.*$/, '')
}

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
 * Whether a version belongs to the line a floating tag covers. The line is named by its leading
 * parts, and a member has to carry at least one part beyond them: 1.2.3 and 1.2.3.1 are both in the
 * 1.2 line, 1.2 itself is not, and neither is 122.3.4. Comparing part by part is what keeps a
 * longer number out of a shorter line.
 *
 * @param {string}   version    A numeric version, e.g. `1.2.3`.
 * @param {number[]} linePrefix The numbers naming the line, e.g. `[1, 2]` for the v1.2 tag.
 *
 * @returns {boolean} Whether the version is a release of that line.
 */
function isInLine(version, linePrefix) {
  const parts = toParts(version)

  return parts.length > linePrefix.length && linePrefix.every((part, i) => parts[i] === part)
}

/**
 * Reads a release tag into the three forms the rules need, and the numbers of the shortest.
 *
 * Each exists for a different job. For `v1.4.0-rc.1`, the shape a tag usually takes:
 *
 * - `version` is `1.4.0-rc.1`: the tag without its `v`. This is what the release is called, so it is
 *   the name the notices use and the version the action reports.
 * - `releaseVersion` is `1.4.0-rc.1` as well, there being no build metadata to drop. This is how the
 *   tag reads once toVersion has normalised the repository's tag list, so it is the name that
 *   excludes the release from its own comparison.
 * - `core` is `1.4.0`: the numbers alone. Versions are compared by this, and floating tag names are
 *   built from it.
 *
 * Comparing the two shorter forms is the prerelease test, because they differ by the prerelease
 * suffix and nothing else.
 *
 * `releaseVersion` is a form of its own only to account for build metadata, which semver allows and
 * says to ignore when ordering versions. Few tags carry any. One that did would otherwise read as a
 * prerelease, its core differing from the whole tag, and would fail to exclude itself from its own
 * comparison, since the tag list holds it with the metadata stripped. A tag carrying both is the
 * only shape where all three forms differ: `v1.4.0-rc.1+build.7` reads as `1.4.0-rc.1+build.7`,
 * `1.4.0-rc.1` and `1.4.0`.
 *
 * @param {string} tag The release tag, with or without a leading `v`.
 *
 * @returns {{version: string, releaseVersion: string, core: string, parts: number[],
 *          reason: string}} The three forms and the core's numbers, or a `reason` naming why the tag
 *          owns no floating tags at all.
 */
function readReleaseTag(tag) {
  const version = String(tag).replace(/^v/, '')
  const releaseVersion = version.replace(/\+.*$/, '')
  const core = releaseVersion.replace(/-.*$/, '')

  if (!NUMERIC_VERSION.test(core)) {
    return { reason: `${tag} is not a numeric version.` }
  }

  const parts = toParts(core)

  /**
   * Three parts is the floor so that the deepest floating tag, v<major>.<minor>, is always a
   * shorter name than the release tag. A release tagged 1.2 would collide with v1.2. There is no
   * upper limit: a fourth part is a hotfix, and isInLine reads it as another release of the same
   * minor line rather than a line of its own.
   */
  if (parts.length < 3) {
    return { reason: `${tag} has ${parts.length} parts; at least three are needed.` }
  }

  return { version, releaseVersion, core, parts }
}

/**
 * Turns the `levels` input into the lengths of the floating tags to resolve.
 *
 * Every name is checked before any tag is decided, so a typo fails the job rather than quietly
 * writing a shorter set of tags than the caller asked for.
 *
 * @param {string} levels Space separated level names, e.g. `major minor`.
 *
 * @throws {Error} When a name is not a known level, or when none are named.
 *
 * @returns {number[]} How many leading version parts each requested tag carries, shortest first.
 */
function readLevels(levels) {
  const depths = new Set()

  for (const level of String(levels).trim().split(/\s+/).filter(Boolean)) {
    const depth = LEVEL_DEPTHS[level]

    if (!depth) {
      throw new Error(`Unknown level '${level}' in levels. Use 'major', 'minor' or both.`)
    }

    depths.add(depth)
  }

  if (depths.size === 0) {
    throw new Error('levels named no floating tags to resolve.')
  }

  return [...depths].sort((a, b) => a - b)
}

/**
 * The released versions a floating tag can be held back by.
 *
 * A tag name carries no prerelease flag, so a tag that is a plain version counts as a released
 * version even when GitHub marks its release as a prerelease; a suffixed tag never counts, because
 * it fails NUMERIC_VERSION.
 *
 * The release being published is dropped by its own name rather than by its core version. A release
 * marked as a prerelease while tagged a plain 1.3.0 would otherwise be the released version that
 * blocks itself. Matching on the core instead would drop a released 1.4.0 when 1.4.0-rc.1 is
 * published, and that 1.4.0 is exactly what has to block it.
 *
 * @param {string[]} tagNames  Every tag name in the repository.
 * @param {string}   excluding The name of the release being published, without build metadata.
 *
 * @returns {string[]} The versions to compare against.
 */
function releasedVersions(tagNames, excluding) {
  return tagNames
    .map(toVersion)
    .filter((candidate) => NUMERIC_VERSION.test(candidate) && candidate !== excluding)
}

/**
 * A decision that a floating tag keeps pointing where it already does.
 *
 * @param {string} floating The tag's name.
 * @param {string} message  Why it is not moving, for the log.
 *
 * @returns {{floating: string, owned: boolean, notice: object}} The decision decideTag returns.
 */
function staysPut(floating, message) {
  return { floating, owned: false, notice: { level: 'notice', message } }
}

/**
 * Decides whether one floating tag moves to the release being published.
 *
 * @param {number[]} linePrefix The numbers naming the line, e.g. `[1, 2]` for the v1.2 tag.
 * @param {string[]} released   The released versions to compare against.
 * @param {object}   release    `{core, version, isPrerelease}` for the release being published.
 *
 * @returns {{floating: string, owned: boolean, notice: object}} The tag's name, whether this release
 *          owns it, and the notice explaining why when it does not.
 */
function decideTag(linePrefix, released, { core, version, isPrerelease }) {
  const floating = `v${linePrefix.join('.')}`
  const line = released.filter((candidate) => isInLine(candidate, linePrefix))

  // Nothing released in this line: the first release of a new line, or a repository whose tags
  // could not be read. Nothing can be newer, so the tag moves either way.
  if (line.length === 0) {
    return { floating, owned: true }
  }

  const newest = line.reduce((a, b) => (compareVersions(a, b) >= 0 ? a : b))

  /**
   * A prerelease never takes a tag away from a released version. Anyone pinned to a line that has
   * already had one expects a released version from it, so only a line that has never had one may
   * point at a prerelease. A 1.4.0-rc.1 therefore takes v1.4, which has nothing released behind it,
   * and leaves v1 on 1.3.0.
   */
  if (isPrerelease) {
    return staysPut(floating, `${floating} stays on ${newest}: ${version} is a prerelease.`)
  }

  if (compareVersions(newest, core) > 0) {
    return staysPut(floating, `${floating} stays where it is: ${newest} is newer than ${version}.`)
  }

  return { floating, owned: true }
}

/**
 * Decides the floating tags for one release.
 *
 * @param {string}   tag               The release tag, with or without a leading `v`.
 * @param {boolean}  flaggedPrerelease Whether GitHub marks that release as a prerelease.
 * @param {string[]} tagNames          Every tag name in the repository, to compare the release
 *                                     against.
 * @param {string}   levels            Space separated level names, e.g. `major minor`.
 * @param {boolean}  allowPrereleases  Let a prerelease own a tag whose line has had no release.
 *
 * @throws {Error} When levels names something other than a known level.
 *
 * @returns {{tags: string[], skipped: string[], version: string, notices: object[]}} The tags this
 *          version should own, the ones a newer release already owns, the version itself, and the
 *          messages the caller should log.
 */
function resolveFloatingTags({
  tag,
  flaggedPrerelease = false,
  tagNames = [],
  levels = 'major minor',
  allowPrereleases = false,
}) {
  const notices = []
  const nothingToDo = (reason) => {
    notices.push({ level: 'notice', message: `Resolved no floating tags: ${reason}` })

    return { tags: [], skipped: [], version: '', notices }
  }

  const release = readReleaseTag(tag)

  if (release.reason) {
    return nothingToDo(release.reason)
  }

  const depths = readLevels(levels)
  const isPrerelease = release.core !== release.releaseVersion || flaggedPrerelease

  if (isPrerelease && !allowPrereleases) {
    return nothingToDo(`${tag} is a prerelease. Set allow-prereleases to change that.`)
  }

  const released = releasedVersions(tagNames, release.releaseVersion)
  const tags = []
  const skipped = []

  for (const depth of depths) {
    const linePrefix = release.parts.slice(0, depth)
    const decision = decideTag(linePrefix, released, { ...release, isPrerelease })

    if (decision.owned) {
      tags.push(decision.floating)
      continue
    }

    skipped.push(decision.floating)
    notices.push(decision.notice)
  }

  return { tags, skipped, version: release.version, notices }
}

/**
 * Every tag name in the repository, over as many pages as it takes.
 *
 * A failure is reported as a warning rather than thrown, because resolving from the released tag
 * alone is better than failing the release: see the action's README.
 *
 * @param {object} github An Octokit, as actions/github-script supplies it.
 * @param {object} core   The @actions/core toolkit, for the warning.
 * @param {string} owner  The repository owner.
 * @param {string} repo   The repository name.
 *
 * @returns {Promise<string[]>} The tag names, or an empty list when they could not be read.
 */
async function readTagNames({ github, core, owner, repo }) {
  try {
    const tags = await github.paginate(github.rest.repos.listTags, { owner, repo, per_page: 100 })

    return tags.map((tag) => tag.name)
  } catch (error) {
    core.warning(
      `Could not read ${owner}/${repo}'s tags (${error.message}). ` +
        'Resolving from the tag name alone.'
    )

    return []
  }
}

/**
 * Whether GitHub marks the release behind a tag as a prerelease.
 *
 * A tag with no release behind it answers 404, which counts as not a prerelease, so a repository
 * that pushes tags without publishing Releases still resolves. Any other failure is warned about
 * and also read as not a prerelease.
 *
 * @param {object} github An Octokit, as actions/github-script supplies it.
 * @param {object} core   The @actions/core toolkit, for the warning.
 * @param {string} owner  The repository owner.
 * @param {string} repo   The repository name.
 * @param {string} tag    The tag to look the release up by.
 *
 * @returns {Promise<boolean>} Whether that release is marked as a prerelease.
 */
async function readPrereleaseFlag({ github, core, owner, repo, tag }) {
  try {
    const release = await github.rest.repos.getReleaseByTag({ owner, repo, tag })

    return release.data.prerelease
  } catch (error) {
    if (error.status !== 404) {
      core.warning(`Could not read the release for ${tag} (${error.message}).`)
    }

    return false
  }
}

/**
 * Reads what the repository has, resolves the floating tags and writes the action's outputs.
 *
 * @param {object} github An Octokit, as actions/github-script supplies it.
 * @param {object} core   The @actions/core toolkit, for the log and the outputs.
 * @param {object} env    The environment the action manifest put its inputs in.
 *
 * @returns {Promise<void>} Resolves once the outputs are set.
 */
async function run({ github, core, env }) {
  const repository = env.INPUT_REPOSITORY || env.GITHUB_REPOSITORY
  const [owner, repo] = repository.split('/')
  const tag = env.INPUT_TAG

  const tagNames = await readTagNames({ github, core, owner, repo })
  const flaggedPrerelease = await readPrereleaseFlag({ github, core, owner, repo, tag })

  const resolved = resolveFloatingTags({
    tag,
    flaggedPrerelease,
    tagNames,
    levels: env.INPUT_LEVELS,
    allowPrereleases: env.INPUT_ALLOW_PRERELEASES === 'true',
  })

  for (const notice of resolved.notices) {
    core[notice.level](notice.message)
  }

  core.info(`Resolved for ${resolved.version || tag}: ${resolved.tags.join(' ') || 'none'}`)

  core.setOutput('tags', resolved.tags.join(' '))
  core.setOutput('skipped', resolved.skipped.join(' '))
  core.setOutput('version', resolved.version)
}

module.exports = {
  run,
  resolveFloatingTags,
  readReleaseTag,
  readLevels,
  releasedVersions,
  decideTag,
  staysPut,
  compareVersions,
  isInLine,
  toVersion,
  toParts,
  NUMERIC_VERSION,
}
