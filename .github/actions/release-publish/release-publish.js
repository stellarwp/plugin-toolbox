'use strict'

/**
 * Publishes the GitHub release for a version at a given commit: tag and release in one step, with
 * the title, the notes and the assets the caller chooses.
 *
 * It is the second half of a deploy, after release-merge has merged the release and the caller has
 * built it: `target` is the commit release-merge left on the base branch (`base-sha`), or the tip of
 * a branch a person merged by hand. The release is created at that commit, not at whatever a branch
 * points to when this runs.
 *
 * With assets, the release is created as a draft, the assets are uploaded, and the draft is
 * published last: a draft makes no tag, so an upload that fails leaves nothing behind once the draft
 * is deleted, and the release is never public without its files. That is also what a repository
 * with immutable releases needs, since a published release cannot be changed afterwards.
 *
 * Running it again after a late failure is safe: a release that already exists is skipped.
 */

const fs = require('node:fs')
const path = require('node:path')

const { STELLARWP_VERSION_PATTERN, compareVersions, validateVersion: validateReleaseVersion } = require('../../lib/versions.js')
const { readRepository, isNotFound, tagExists } = require('../../lib/github.js')

/** Closes every error message: nothing of this action's was done. */
const NOTHING = 'Nothing was published.'

/**
 * Reads the version to release: the shared rule, with this action's closing line.
 *
 * @param {string} version The `version` input.
 *
 * @throws {Error} When it is empty or not three or four numeric parts.
 *
 * @returns {string} The version, without surrounding whitespace.
 */
function validateVersion(version) {
  return validateReleaseVersion(version, NOTHING)
}

/**
 * Reads the `target` input: the commit the release is made at, as a full hash or a branch name.
 *
 * @param {string} target The input value.
 *
 * @throws {Error} When it is empty or a full ref.
 *
 * @returns {string} The target, without surrounding whitespace.
 */
function readTarget(target) {
  const trimmed = String(target ?? '').trim()

  if (trimmed === '') {
    throw new Error(
      "No target was given: pass the commit to publish at, release-merge's base-sha output or a branch " +
        `name. ${NOTHING}`
    )
  }

  if (trimmed.startsWith('refs/')) {
    throw new Error(`Refusing target '${trimmed}': pass a commit hash or a branch name, not a ref. ${NOTHING}`)
  }

  return trimmed
}

/**
 * Whether a target is a full commit hash, which needs no lookup.
 *
 * @param {string} target The target.
 *
 * @returns {boolean} True for 40 hex digits.
 */
function isSha(target) {
  return /^[0-9a-f]{40}$/.test(target)
}

/**
 * The commit a target names: the hash itself, or the tip of the branch.
 *
 * @param {object} options
 * @param {object} options.github The Octokit github-script supplies.
 * @param {string} options.owner  The repository owner.
 * @param {string} options.repo   The repository name.
 * @param {string} options.target The target, from readTarget.
 *
 * @throws {Error} When it is neither a hash nor a branch of the repository.
 *
 * @returns {Promise<string>} The commit hash.
 */
async function resolveTarget({ github, owner, repo, target }) {
  if (isSha(target)) {
    return target
  }

  try {
    const { data } = await github.rest.repos.getBranch({ owner, repo, branch: target })

    return data.commit.sha
  } catch (error) {
    if (isNotFound(error)) {
      throw new Error(`'${target}' is not a commit hash, and the repository has no branch by that name. ${NOTHING}`)
    }

    throw new Error(`Reading branch ${target} failed (HTTP ${error.status}): ${error.message}. ${NOTHING}`)
  }
}

/**
 * Reads the `title` input, the version when it is empty.
 *
 * @param {string} title   The input value.
 * @param {string} version The version, validated.
 *
 * @returns {string} The release title.
 */
function readTitle(title, version) {
  const trimmed = String(title ?? '').trim()

  return trimmed === '' ? version : trimmed
}

/**
 * Reads the notes file, when one was given.
 *
 * @param {string} input The `notes-file` input, a path relative to the checkout.
 * @param {string} cwd   The checkout.
 *
 * @throws {Error} When the file is not there.
 *
 * @returns {string|null} The notes, or null to let GitHub generate them.
 */
function readNotesFile(input, cwd) {
  const file = String(input ?? '').trim()

  if (file === '') {
    return null
  }

  try {
    return fs.readFileSync(path.resolve(cwd, file), 'utf8')
  } catch (error) {
    throw new Error(`The notes file ${file} could not be read: ${error.message}. ${NOTHING}`)
  }
}

/**
 * Reads the `files` input: the assets to attach, one path per line, relative to the checkout. Every
 * one is checked before anything is created, so a missing file fails the run with nothing to undo.
 *
 * @param {string} input The input value.
 * @param {string} cwd   The checkout.
 *
 * @throws {Error} When a path is not a file.
 *
 * @returns {{name: string, file: string, size: number}[]} The assets, in the order given.
 */
function readFiles(input, cwd) {
  const lines = String(input ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)

  return lines.map((line) => {
    const file = path.resolve(cwd, line)
    let stat
    try {
      stat = fs.statSync(file)
    } catch {
      stat = null
    }
    if (!stat?.isFile()) {
      throw new Error(`${line}, listed in files, is not a file in the checkout. ${NOTHING}`)
    }

    return { name: path.basename(file), file, size: stat.size }
  })
}

/**
 * The tag of the repository's current latest release, or null when it has none.
 *
 * @param {object} options
 * @param {object} options.github The Octokit github-script supplies.
 * @param {string} options.owner  The repository owner.
 * @param {string} options.repo   The repository name.
 *
 * @throws {Error} When the read fails for any reason but 404.
 *
 * @returns {Promise<string|null>} The latest release's tag.
 */
async function latestReleaseTag({ github, owner, repo }) {
  try {
    const { data } = await github.rest.repos.getLatestRelease({ owner, repo })

    return data.tag_name
  } catch (error) {
    if (isNotFound(error)) {
      return null
    }

    throw new Error(`Reading the latest release failed (HTTP ${error.status}): ${error.message}. ${NOTHING}`)
  }
}

/**
 * The repository's releases, every page.
 *
 * @param {object} options
 * @param {object} options.github The Octokit github-script supplies.
 * @param {string} options.owner  The repository owner.
 * @param {string} options.repo   The repository name.
 *
 * @throws {Error} When the read fails.
 *
 * @returns {Promise<object[]>} The releases as the API lists them, drafts included.
 */
async function listReleases({ github, owner, repo }) {
  try {
    return await github.paginate(github.rest.repos.listReleases, { owner, repo, per_page: 100 })
  } catch (error) {
    throw new Error(`Listing the releases failed (HTTP ${error.status}): ${error.message}. ${NOTHING}`)
  }
}

/**
 * The published version right below the one being released: where its generated notes start.
 *
 * GitHub's own choice of a previous tag is not documented, so for a hotfix on an older line
 * (`2.1.38.3` after `2.1.46` is out) the notes could cover the changes since `2.1.46`. Choosing it
 * here makes the range the one the version number says: the highest published version below this
 * one, `2.1.38.2`. Drafts and tags that are not plain versions are skipped.
 *
 * @param {string}   version  The version being released.
 * @param {object[]} releases The releases listReleases returned.
 *
 * @returns {string|null} The tag to start the notes from, or null when no release is below.
 */
function previousVersion(version, releases) {
  return (
    releases
      .filter((release) => !release.draft && STELLARWP_VERSION_PATTERN.test(release.tag_name))
      .map((release) => release.tag_name)
      .filter((tag) => compareVersions(tag, version) < 0)
      .sort(compareVersions)
      .at(-1) ?? null
  )
}

/**
 * Deletes a draft release, reporting whether it worked rather than assuming so.
 *
 * @param {object} options
 * @param {object} options.github The Octokit github-script supplies.
 * @param {string} options.owner  The repository owner.
 * @param {string} options.repo   The repository name.
 * @param {object} options.draft  The draft, as the API returned it.
 *
 * @returns {Promise<string>} A sentence for the error message: that the draft was deleted, or that
 *          it was not and where to delete it by hand.
 */
async function deleteDraft({ github, owner, repo, draft }) {
  try {
    await github.rest.repos.deleteRelease({ owner, repo, release_id: draft.id })

    return 'The draft was deleted and no tag was made.'
  } catch (error) {
    return (
      `The draft could not be deleted (HTTP ${error.status}): delete it by hand at ${draft.html_url}. ` +
      'No tag was made.'
    )
  }
}

/**
 * Whether the new release takes "Latest": yes, unless the current latest is a higher version, as
 * when a hotfix goes out on an older line after a newer version is released. A latest whose tag is
 * not a plain version (a `v` prefix, a name) is not compared, and the new release takes it.
 *
 * @param {string}      version The version being released.
 * @param {string|null} latest  The current latest release's tag.
 *
 * @returns {'true'|'false'} The `make_latest` value the API takes.
 */
function makeLatest(version, latest) {
  if (latest && STELLARWP_VERSION_PATTERN.test(latest) && compareVersions(version, latest) < 0) {
    return 'false'
  }

  return 'true'
}

/**
 * Publishes the release, unless it already exists.
 *
 * @param {object} options
 * @param {object} options.github The Octokit github-script supplies, authenticated with the token.
 * @param {object} options.core   The @actions/core toolkit, for the log, the outputs and the summary.
 * @param {object} options.env    The environment the action manifest put its inputs in.
 * @param {string} options.cwd    The checkout, the working directory by default.
 *
 * @throws {Error} When an input is wrong, a file is missing, the tag exists without a release, or
 *                 an API call fails.
 *
 * @returns {Promise<void>} Resolves once the release exists, or was found to exist already.
 */
async function runPublish({ github, core, env, cwd = process.cwd() }) {
  const version = validateVersion(env.INPUT_VERSION)
  const target = readTarget(env.INPUT_TARGET)
  const title = readTitle(env.INPUT_TITLE, version)
  const notes = readNotesFile(env.INPUT_NOTES_FILE, cwd)
  const files = readFiles(env.INPUT_FILES, cwd)
  const { owner, repo } = readRepository(env, NOTHING)

  let existing = null
  try {
    existing = (await github.rest.repos.getReleaseByTag({ owner, repo, tag: version })).data
  } catch (error) {
    if (!isNotFound(error)) {
      throw new Error(`Reading the release for ${version} failed (HTTP ${error.status}): ${error.message}. ${NOTHING}`)
    }
  }

  if (existing) {
    core.info(`${version} is already published (${existing.html_url}): nothing to publish.`)
    core.setOutput('published', 'skipped')
    core.setOutput('release-url', existing.html_url)
    core.setOutput('sha', '')
    await core.summary.addRaw(`Release ${version} was already published: ${existing.html_url}`, true).write()

    return
  }

  if (await tagExists({ github, owner, repo, version, what: NOTHING })) {
    throw new Error(
      `The tag ${version} already exists, but there is no published release for it, so publishing ` +
        `would release whatever commit the tag points at. Delete the tag or release another version. ${NOTHING}`
    )
  }

  const sha = await resolveTarget({ github, owner, repo, target })
  const latest = makeLatest(version, await latestReleaseTag({ github, owner, repo }))
  if (latest === 'false') {
    core.info(`${version} is below the current latest release, so it is published without taking "Latest".`)
  }

  // A draft of this version left by a run that was cancelled while uploading, or whose publish
  // failed before the draft could be deleted. getReleaseByTag does not return drafts, so a rerun
  // would otherwise leave it there and add a second one.
  const releases = await listReleases({ github, owner, repo })
  for (const stale of releases.filter((release) => release.draft && release.tag_name === version)) {
    try {
      await github.rest.repos.deleteRelease({ owner, repo, release_id: stale.id })
      core.info(`Deleted a draft of ${version} left behind by an earlier run (${stale.html_url}).`)
    } catch (error) {
      core.warning(
        `A draft of ${version} left behind by an earlier run could not be deleted (HTTP ${error.status}): ` +
          `delete it by hand at ${stale.html_url}.`
      )
    }
  }

  let body = notes
  if (body === null) {
    const previous = previousVersion(version, releases)
    core.info(
      previous
        ? `The notes cover the changes since ${previous}.`
        : 'No published release is below this version: GitHub chooses where the notes start.'
    )
    body = (
      await github.rest.repos.generateReleaseNotes({
        owner,
        repo,
        tag_name: version,
        target_commitish: sha,
        ...(previous ? { previous_tag_name: previous } : {}),
      })
    ).data.body
  }

  let release
  if (files.length === 0) {
    release = (
      await github.rest.repos.createRelease({
        owner,
        repo,
        tag_name: version,
        target_commitish: sha,
        name: title,
        body,
        make_latest: latest,
      })
    ).data
  } else {
    // A draft makes no tag, so a failed upload can be undone by deleting it, and the release is
    // never public without its files.
    const draft = (
      await github.rest.repos.createRelease({
        owner,
        repo,
        tag_name: version,
        target_commitish: sha,
        name: title,
        body,
        draft: true,
      })
    ).data

    for (const asset of files) {
      try {
        await github.rest.repos.uploadReleaseAsset({
          owner,
          repo,
          release_id: draft.id,
          name: asset.name,
          data: fs.readFileSync(asset.file),
          headers: { 'content-type': 'application/octet-stream', 'content-length': asset.size },
        })
      } catch (error) {
        const deleted = await deleteDraft({ github, owner, repo, draft })
        throw new Error(
          `Uploading ${asset.name} to the release failed (HTTP ${error.status}): ${error.message}. ${deleted} ${NOTHING}`
        )
      }
      core.info(`Attached ${asset.name}.`)
    }

    // Publishing the draft is what makes the tag, so this is the call a tag ruleset refuses. The
    // draft is deleted here too, or a rerun would find none by the tag and leave it behind.
    try {
      release = (
        await github.rest.repos.updateRelease({ owner, repo, release_id: draft.id, draft: false, make_latest: latest })
      ).data
    } catch (error) {
      const deleted = await deleteDraft({ github, owner, repo, draft })
      throw new Error(`Publishing the draft failed (HTTP ${error.status}): ${error.message}. ${deleted} ${NOTHING}`)
    }
  }

  core.info(`Published ${version} at ${sha.slice(0, 7)}: ${release.html_url}`)
  core.setOutput('published', 'true')
  core.setOutput('release-url', release.html_url)
  core.setOutput('sha', sha)
  const attached = files.length === 0 ? '' : ` with ${files.map((asset) => `\`${asset.name}\``).join(', ')}`
  await core.summary.addRaw(`Published release ${version} at \`${sha.slice(0, 7)}\`${attached}: ${release.html_url}`, true).write()
}

module.exports = {
  runPublish,
  validateVersion,
  readTarget,
  resolveTarget,
  readTitle,
  readNotesFile,
  readFiles,
  makeLatest,
  previousVersion,
}
