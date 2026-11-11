'use strict'

/**
 * Merges a release: the release branch into the base branch (`main`, or `master` where that is the
 * name), then the base branch back into develop. Publishing the GitHub release is the caller's,
 * after this action and its build, at the commit this one leaves on the base (`base-sha`).
 *
 * runMerge checks the inputs and the version against the repository's tags, then asks GitHub for
 * the two merges. Everything goes through the Octokit github-script supplies: the action reads and
 * writes no checkout, so a test runs it against a recorded client and asserts the requests.
 *
 * Every step is safe to run again after a late failure: a branch that already holds the release
 * merges as a no-op.
 */

const { validateVersion: validateReleaseVersion } = require('../../lib/versions.js')
const { readRepository, isNotFound, readTag } = require('../../lib/github.js')
const { readVersionFiles, versionIn } = require('../../lib/puprc.js')

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
  return validateReleaseVersion(version, 'Nothing was merged.')
}

/**
 * Checks the shape of a branch input. Whether the repository has the branch is checked against the
 * API, in runMerge.
 *
 * @param {string}  branch           The input value.
 * @param {string}  input            Which input it is, for the message: `branch`, `base-branch` or
 *                                   `develop-branch`.
 * @param {object}  options
 * @param {boolean} options.optional Whether an empty value is allowed, for `develop-branch`: a
 *                                   repository without a develop branch leaves it empty.
 *
 * @throws {Error} When it is empty and required, or a full ref.
 *
 * @returns {string|null} The branch name, without surrounding whitespace; null for an empty
 *          optional one.
 */
function validateBranch(branch, input, { optional = false } = {}) {
  const trimmed = String(branch ?? '').trim()

  if (trimmed === '') {
    if (optional) {
      return null
    }
    throw new Error(`No ${input} was given: pass a branch name, such as release/M26.test. Nothing was merged.`)
  }

  if (trimmed.startsWith('refs/')) {
    throw new Error(
      `Refusing ${input} '${trimmed}': pass the branch name, e.g. '${trimmed.replace(/^refs\/heads\//, '')}'. ` +
        'Nothing was merged.'
    )
  }

  return trimmed
}

/** A full commit hash, the only form `head` takes: a branch name would be read at run time again. */
const COMMIT_PATTERN = /^[0-9a-f]{40}$/

/**
 * Reads the `head` input: the commit the release branch has to be at, or nothing.
 *
 * A deploy that waits for an approval merges the branch's tip when the approval comes, which may
 * not be the commit the run was started on. The caller passes that commit (`github.sha` in a
 * workflow_dispatch run) and a branch that moved in between is refused instead of merged.
 *
 * @param {string} head The input value.
 *
 * @throws {Error} When it is neither empty nor a full commit hash.
 *
 * @returns {string|null} The hash, lower-cased, or null for an empty value.
 */
function readHead(head) {
  const trimmed = String(head ?? '')
    .trim()
    .toLowerCase()

  if (trimmed === '') {
    return null
  }

  if (!COMMIT_PATTERN.test(trimmed)) {
    throw new Error(
      `head '${trimmed}' is not a full commit hash. Pass the commit the release branch has to be at, ` +
        'such as github.sha, or leave it empty. Nothing was merged.'
    )
  }

  return trimmed
}

/**
 * The message of a merge commit.
 *
 * @param {string} from The branch merged.
 * @param {string} into The branch it was merged into.
 *
 * @returns {string} The message.
 */
function mergeMessage(from, into) {
  return `Merge ${from} into ${into}`
}

/**
 * Whether a failed merge request is GitHub reporting a conflict, as opposed to any other refusal.
 *
 * The merge endpoint answers 409 for two things: a conflict between the branches, and a base that
 * moved while the merge was being made. Only the first is a conflict for the caller to resolve.
 *
 * @param {Error} error The Octokit error.
 *
 * @returns {boolean} True for a conflict.
 */
function isConflict(error) {
  return error?.status === 409 && /conflict/i.test(String(error.message))
}

/**
 * Checks the version against the repository's tags before anything is merged.
 *
 * A version that was never tagged is the common case. One whose tag exists with a published release
 * may be a retry after a late failure; runMerge decides that by checking that the tag contains the
 * branch. One whose tag exists without a release would make the publish reuse whatever commit the
 * tag points at, so it is refused here, with the base and develop untouched.
 *
 * @param {object} options
 * @param {object} options.github  The Octokit github-script supplies.
 * @param {string} options.owner   The repository owner.
 * @param {string} options.repo    The repository name.
 * @param {string} options.version The version, validated.
 *
 * @throws {Error} When the tag exists without a release, or a read fails for any reason but 404.
 *
 * @returns {Promise<{tagged: boolean, tagSha: string|null, releaseUrl: string|null}>} Whether the
 *          tag exists, the commit it points at, and the published release's URL when it does.
 */
async function runPreflight({ github, owner, repo, version }) {
  const tagSha = await readTag({ github, owner, repo, version, what: 'Nothing was merged.' })
  if (tagSha === null) {
    return { tagged: false, tagSha: null, releaseUrl: null }
  }

  try {
    const { data: release } = await github.rest.repos.getReleaseByTag({ owner, repo, tag: version })

    return { tagged: true, tagSha, releaseUrl: release.html_url }
  } catch (error) {
    if (isNotFound(error)) {
      throw new Error(
        `The tag ${version} already exists, but there is no published release for it, so publishing ` +
          'would release whatever commit the tag points at. Delete the tag or release another ' +
          'version. Nothing was merged.'
      )
    }

    throw new Error(
      `Reading the release for ${version} failed (HTTP ${error.status}): ${error.message}. Nothing was merged.`
    )
  }
}

/**
 * Checks that the repository has a branch, and reads its tip.
 *
 * Read before any file is read from the branch: a 404 on a file read cannot tell a missing file
 * from a missing branch.
 *
 * @param {object} options
 * @param {object} options.github The Octokit github-script supplies.
 * @param {string} options.owner  The repository owner.
 * @param {string} options.repo   The repository name.
 * @param {string} options.branch The branch name.
 *
 * @throws {Error} When the repository has no such branch, or the read fails.
 *
 * @returns {Promise<string>} The commit the branch points at.
 */
async function readBranchTip({ github, owner, repo, branch }) {
  try {
    return (await github.rest.repos.getBranch({ owner, repo, branch })).data.commit.sha
  } catch (error) {
    if (isNotFound(error)) {
      throw new Error(`'${branch}' is not a branch of ${owner}/${repo}. Nothing was merged.`)
    }

    throw new Error(`Reading branch ${branch} failed (HTTP ${error.status}): ${error.message}. Nothing was merged.`)
  }
}

/**
 * Reads a file from a branch of the repository.
 *
 * @param {object} options
 * @param {object} options.github The Octokit github-script supplies.
 * @param {string} options.owner  The repository owner.
 * @param {string} options.repo   The repository name.
 * @param {string} options.branch The branch, known to exist, for the message.
 * @param {string} options.ref    The commit to read at: the branch's tip as it was read, so every
 *                                read sees the same commit whatever is pushed to the branch meanwhile.
 * @param {string} options.file   The path in the repository.
 *
 * @throws {Error} When the read fails for any reason but 404.
 *
 * @returns {Promise<string|null>} The contents, or null when the branch has no such file (or the
 *          path is a directory).
 */
async function fileAt({ github, owner, repo, branch, ref, file }) {
  let data
  try {
    data = (await github.rest.repos.getContent({ owner, repo, path: file, ref })).data
  } catch (error) {
    if (isNotFound(error)) {
      return null
    }

    throw new Error(`Reading ${file} on ${branch} failed (HTTP ${error.status}): ${error.message}. Nothing was merged.`)
  }

  if (Array.isArray(data) || data.type !== 'file') {
    return null
  }

  return Buffer.from(data.content, 'base64').toString('utf8')
}

/**
 * Checks that the version to release is the one the release branch holds, in every file .puprc lists
 * under paths.versions. The tag and the title of the release come from `version`, so a value other
 * than what release-prep wrote into the branch would publish the code under the wrong version.
 *
 * @param {object} options
 * @param {object} options.github  The Octokit github-script supplies.
 * @param {string} options.owner   The repository owner.
 * @param {string} options.repo    The repository name.
 * @param {string} options.branch  The release branch, for the messages.
 * @param {string} options.ref     The commit to read the files at: the branch's tip as it was read.
 * @param {string} options.version The version to release, validated.
 *
 * @throws {Error} When the branch has no usable .puprc, a version file holds no version, or any of
 *                 them holds a different version.
 *
 * @returns {Promise<void>} Resolves when every version file holds `version`.
 */
async function assertBranchHoldsVersion({ github, owner, repo, branch, ref, version }) {
  const read = (file) => fileAt({ github, owner, repo, branch, ref, file })
  const files = readVersionFiles(await read('.puprc'), 'Nothing was merged.')

  for (const { file, regex } of files) {
    const content = await read(file)
    if (content === null) {
      throw new Error(`${file}, which .puprc lists under paths.versions, is not on ${branch}. Nothing was merged.`)
    }

    let found
    try {
      found = versionIn(content, regex)
    } catch (error) {
      throw new Error(
        `The regex .puprc gives for ${file} (${regex}) is not one JavaScript accepts: ${error.message}. ` +
          'Nothing was merged.'
      )
    }
    if (found === null) {
      throw new Error(
        `${file} on ${branch} holds no version where .puprc expects one (${regex}). Nothing was merged.`
      )
    }
    if (found !== version) {
      throw new Error(
        `${branch} holds ${found} in ${file}, not ${version}. The version to release has to be the one ` +
          'the branch was prepared with; check the version, or prepare the branch again. Nothing was merged.'
      )
    }
  }
}

/**
 * Whether a commit contains a branch: the tag of a published version, against the release branch.
 *
 * @param {object} options
 * @param {object} options.github The Octokit github-script supplies.
 * @param {string} options.owner  The repository owner.
 * @param {string} options.repo   The repository name.
 * @param {string} options.branch The branch, for the message.
 * @param {string} options.ref    The branch's tip as it was read, a hash: what the commit has to
 *                                contain, so a push to the branch meanwhile changes nothing here.
 * @param {string} options.sha    The commit; a hash rather than the tag's name, which a branch of
 *                                the same name would shadow.
 *
 * @throws {Error} When the comparison fails.
 *
 * @returns {Promise<boolean>} True when the commit is the branch's tip or descends from it.
 */
async function commitContainsBranch({ github, owner, repo, branch, ref, sha }) {
  try {
    const { data } = await github.rest.repos.compareCommitsWithBasehead({ owner, repo, basehead: `${ref}...${sha}` })

    return data.status === 'ahead' || data.status === 'identical'
  } catch (error) {
    throw new Error(`Comparing ${branch} with ${sha} failed (HTTP ${error.status}): ${error.message}. Nothing was merged.`)
  }
}

/**
 * Whether a commit is the one that merged the branch: one of its parents is the branch's tip. The
 * API never fast-forwards, so the merge of a release branch into the base is always a merge commit
 * with the branch's tip as a parent; a commit pushed on top of it, bump or not, has other parents.
 *
 * @param {object} options
 * @param {object} options.github The Octokit github-script supplies.
 * @param {string} options.owner  The repository owner.
 * @param {string} options.repo   The repository name.
 * @param {string} options.branch The branch, for the message.
 * @param {string} options.ref    The branch's tip as it was read, a hash.
 * @param {string} options.sha    The commit to read, a hash: the base's tip as it was read.
 *
 * @throws {Error} When the read fails.
 *
 * @returns {Promise<boolean>} True when `ref` is one of the commit's parents.
 */
async function commitMergesBranch({ github, owner, repo, branch, ref, sha }) {
  try {
    const { data } = await github.rest.repos.getCommit({ owner, repo, ref: sha })

    return (data.parents ?? []).some((parent) => parent.sha === ref)
  } catch (error) {
    throw new Error(`Reading ${sha} to check it merged ${branch} failed (HTTP ${error.status}): ${error.message}. Nothing was merged.`)
  }
}

/**
 * Merges one branch, or commit, into another as a merge commit, through the API.
 *
 * GitHub makes the merge commit under the token's identity and signs it. A base that already holds
 * the head answers 204 and nothing is written, which is what a retry after a late failure finds. A
 * conflict prints the MERGE_CONFLICT marker on a line of its own, where the release dashboard looks
 * for it, and fails; nothing is written for that branch.
 *
 * @param {object} options
 * @param {object} options.github  The Octokit github-script supplies.
 * @param {object} options.core    The @actions/core toolkit.
 * @param {string} options.owner   The repository owner.
 * @param {string} options.repo    The repository name.
 * @param {string} options.into    The branch merged into, e.g. `main`.
 * @param {string} options.head    What is merged: a branch name or a commit hash.
 * @param {string} options.message The merge commit message.
 * @param {string} options.label   How to name `head` in the log, e.g. `release/M26.test`.
 *
 * @throws {Error} When the merge conflicts or GitHub refuses it.
 *
 * @returns {Promise<{merged: boolean, sha: string}>} Whether a merge commit was made, and the commit
 *          `into` points at afterwards: the merge commit, or its tip when there was nothing to merge.
 */
async function mergeInto({ github, core, owner, repo, into, head, message, label }) {
  let response
  try {
    response = await github.rest.repos.merge({ owner, repo, base: into, head, commit_message: message })
  } catch (error) {
    if (isConflict(error)) {
      // core.info prints a plain line: the marker has to open an output line to count, see the README.
      core.setOutput('conflict', into)
      core.info(
        `MERGE_CONFLICT: merging ${label} into ${into} conflicted. Resolve it on ${into} by hand and ` +
          `push, then run this step again. Nothing was merged into ${into}.`
      )
      throw new Error(
        `Merging ${label} into ${into} stopped on a conflict. Resolve it on ${into} by hand and push, ` +
          `then run this step again: the merges already done are kept. Nothing was merged into ${into}.`
      )
    }

    if (error?.status === 409) {
      throw new Error(
        `Merging ${label} into ${into} was refused: ${into} moved while the merge was being made ` +
          `(${error.message}). Run this step again; the merges already done are kept.`
      )
    }

    throw new Error(`Merging ${label} into ${into} failed (HTTP ${error?.status}): ${error?.message}`)
  }

  if (response.status === 204) {
    core.info(`${into} already has ${label}: nothing to merge.`)

    return { merged: false, sha: await readBranchTip({ github, owner, repo, branch: into }) }
  }

  return { merged: true, sha: response.data.sha }
}

/**
 * Checks the inputs and the version, then merges the release branch into the base branch and the
 * base branch back into develop. The version has to be the one the release branch holds in every
 * file its .puprc lists, so the tag matches the code.
 *
 * The base branch, not the release branch, is merged into develop: develop then descends from the
 * base, and consecutive releases bring one version bump each instead of divergent copies of the same
 * lines. The API always makes a merge commit, never a fast-forward, so each release is one merge
 * commit in the history. A repository without a develop branch leaves `develop-branch` empty, and
 * only the first merge is made.
 *
 * Nothing is read from or written to a checkout: the caller checks out `base-sha` afterwards for
 * the steps that build the release from it.
 *
 * @param {object} options
 * @param {object} options.github The Octokit github-script supplies, built from the token.
 * @param {object} options.core   The @actions/core toolkit, for the log, the outputs and the summary.
 * @param {object} options.env    The environment the action manifest put its inputs in.
 *
 * @throws {Error} When an input is wrong, a branch is missing, the tag exists without a release, a
 *                 merge conflicts, or a read or a merge fails.
 *
 * @returns {Promise<void>} Resolves once both merges are made and the outputs are set,
 *          `already-published` among them: `yes` when the version's release already existed when the step started.
 */
async function runMerge({ github, core, env }) {
  const branch = validateBranch(env.INPUT_BRANCH, 'branch')
  const version = validateVersion(env.INPUT_VERSION)
  const base = validateBranch(env.INPUT_BASE_BRANCH, 'base-branch')
  const develop = validateBranch(env.INPUT_DEVELOP_BRANCH, 'develop-branch', { optional: true })
  const head = readHead(env.INPUT_HEAD)
  const { owner, repo } = readRepository(env, 'Nothing was merged.')

  if (develop !== null && base === develop) {
    throw new Error(`base-branch and develop-branch are both '${base}'; they have to be two branches. Nothing was merged.`)
  }
  if (branch === base || branch === develop) {
    throw new Error(`branch '${branch}' is also the ${branch === base ? 'base' : 'develop'} branch. Nothing was merged.`)
  }

  const { tagged, tagSha, releaseUrl } = await runPreflight({ github, owner, repo, version })

  // The release branch's tip is read once and that commit is what the version files are read at,
  // what the tag is compared against and what is merged. Read by name at each step, a commit pushed
  // to the branch between the version check and the merge would reach the base unchecked; a tag
  // named like the branch could also change what a read by name returns.
  const branchSha = await readBranchTip({ github, owner, repo, branch })
  if (head !== null && head !== branchSha) {
    throw new Error(
      `${branch} is at ${branchSha}, not at ${head}, the commit this run was started on: the branch ` +
        'moved after the run started, so its tip is not the commit that was built and reviewed. Start ' +
        'the deploy again on the branch as it is now. Nothing was merged.'
    )
  }
  for (const name of develop === null ? [base] : [base, develop]) {
    await readBranchTip({ github, owner, repo, branch: name })
  }

  await assertBranchHoldsVersion({ github, owner, repo, branch, ref: branchSha, version })

  // A tag with a published release is a retry only when that release came from this branch: its
  // commit then contains the branch, and the merges below find nothing to do. A tag that does not
  // contain the branch is an earlier release of the same version, which the branch was never bumped
  // past; merging it would put a second set of changes under a version that is already out.
  if (tagged) {
    if (!(await commitContainsBranch({ github, owner, repo, branch, ref: branchSha, sha: tagSha }))) {
      throw new Error(
        `The tag ${version} already exists and does not contain ${branch}: ${version} was released ` +
          `from another commit, and the branch was never bumped past it. Give the release a new ` +
          'version and prepare the branch again. Nothing was merged.'
      )
    }
    core.info(`${version} is already published (${releaseUrl}) from ${branch}: nothing to publish again.`)
  }

  const { merged: mergedBase, sha: mergedSha } = await mergeInto({
    github,
    core,
    owner,
    repo,
    into: base,
    head: branchSha,
    message: mergeMessage(branch, base),
    label: branch,
  })

  // base-sha is the commit the release is published at and built from. A merge that was made is
  // that merge commit, which holds the version the branch was just checked for. A retry that found
  // the merge done gets the base's tip, and that tip is only this release while nothing has been
  // merged or pushed since: a publish that failed after the deploy, then another release, then a
  // retry would build the later release's code and publish it under this version, since the
  // caller's deploy and publish each skip what they find done. So when the version is already
  // published, the retry builds the commit the tag was made from, what was published, and the base
  // moving on changes nothing; when it is not, the tip has to be the commit that merged the branch.
  let baseSha = mergedSha
  if (!mergedBase) {
    if (tagged) {
      baseSha = tagSha
      core.info(`${version} builds at ${tagSha}, the commit it was published from.`)
    } else if (!(await commitMergesBranch({ github, owner, repo, branch, ref: branchSha, sha: mergedSha }))) {
      throw new Error(
        `${base} already had ${branch} and has moved on since: its tip ${mergedSha} is not the commit that merged ` +
          `${branch}, so a build from it would publish other changes under ${version}. There is nothing left ` +
          `to merge for ${version}; finish it by hand at the commit that merged ${branch} into ${base}, or ` +
          'release another version. Nothing was merged.'
      )
    }
  }

  // The second merge takes that commit, not the base's name, so develop receives exactly what is
  // being released even if the base moves on.
  let mergedDevelop = null
  if (develop === null) {
    core.info(`develop-branch is empty: ${base} is not merged back into a develop branch.`)
  } else {
    mergedDevelop = (
      await mergeInto({
        github,
        core,
        owner,
        repo,
        into: develop,
        head: baseSha,
        message: `Merge ${base} back into ${develop} (${branch})`,
        label: base,
      })
    ).merged
  }

  const did = (merged, from, into) => (merged ? `merged \`${from}\` into \`${into}\`` : `\`${into}\` already had \`${from}\``)
  const developPart = develop === null ? 'no develop branch to merge back into' : did(mergedDevelop, base, develop)
  await core.summary.addRaw(`Release ${version}: ${did(mergedBase, branch, base)}, ${developPart}.`, true).write()

  // These outputs are the last thing the step writes: a step that failed, on the summary above or
  // anywhere before, leaves them empty, so a caller that reads `already-published == 'no'` under
  // `continue-on-error` skips its writes without checking the step's outcome as well. `conflict`
  // is the one output a failure sets, in mergeInto, before it throws on a merge conflict.
  core.setOutput('branch', branch)
  core.setOutput('version', version)
  core.setOutput('base-branch', base)
  core.setOutput('base-sha', baseSha)
  core.setOutput('develop-branch', develop ?? '')
  core.setOutput('conflict', '')
  // Whether the version was already published when the step started, so a caller can skip what
  // its deploy would otherwise repeat on a published retry: release-publish skips the release by
  // itself, but a zip copied to a site or a version written there is not idempotent.
  core.setOutput('already-published', tagged ? 'yes' : 'no')
}

module.exports = {
  runMerge,
  runPreflight,
  validateVersion,
  validateBranch,
  readHead,
  mergeMessage,
  isConflict,
}
