'use strict'

/**
 * Merges a release: the release branch into the base branch (`main`, or `master` where that is the
 * name), the base branch back into develop, then publishes the GitHub release for the version.
 *
 * The action runs in two github-script steps, so there are two entry points. runMerge checks the
 * inputs and the version against the repository's tags, then does the two merges with git in the
 * caller's checkout and pushes them; runPublish creates the GitHub release through the Octokit
 * github-script supplies. The functions they are built from are pure, apart from the git commands run
 * through `exec` and the API calls, so a test can run them against a local remote and assert the
 * requests.
 *
 * Every step is safe to run again after a late failure: a branch that already holds the release
 * merges as a no-op, and a release that already exists is skipped.
 */

const { STELLARWP_VERSION_PATTERN } = require('../../lib/versions.js')
const { readRepository, isNotFound, tagExists } = require('../../lib/github.js')
const { runOrFail } = require('../../lib/exec.js')
const { readVersionFiles, versionIn } = require('../../lib/puprc.js')

/** The identity the merge commits are made with: the one GitHub gives the default token. */
const BOT_IDENTITY = {
  name: 'github-actions[bot]',
  email: '41898282+github-actions[bot]@users.noreply.github.com',
}

/**
 * The lines git prints when a merge stops on a conflict: one `CONFLICT (…)` per file, then the
 * closing line. The release dashboard reads the same two strings from the job log as its fallback.
 */
const CONFLICT_OUTPUT = /CONFLICT \(|Automatic merge failed/

/**
 * Reads the version to release, refusing anything but three or four numeric parts.
 *
 * A pre-release is refused: the version becomes the tag and the title of a published release, and a
 * beta or RC is not released this way. The release dashboard validates versions with this rule, and
 * release-prep does under the stellarwp changelog versioning.
 *
 * @param {string} version The `version` input.
 *
 * @throws {Error} When it is empty or not of that shape.
 *
 * @returns {string} The version, without surrounding whitespace.
 */
function validateVersion(version) {
  const trimmed = String(version ?? '').trim()

  if (trimmed === '') {
    throw new Error(
      'No version was given. The run was dispatched without one, which is what a release with no ' +
        "version set sends: set the release's version and run this step again. Nothing was merged."
    )
  }

  if (!STELLARWP_VERSION_PATTERN.test(trimmed)) {
    throw new Error(
      `'${trimmed}' is not a version this action can release. It takes three or four numeric parts, ` +
        'such as 4.17.0 or 4.17.0.1: no pre-release suffix and no leading v, because the version ' +
        'becomes the tag and the title of the published release. Nothing was merged.'
    )
  }

  return trimmed
}

/**
 * Checks the shape of a branch input. Whether git accepts the name is checked by git, in runMerge.
 *
 * @param {string} branch The input value.
 * @param {string} input  Which input it is, for the message: `branch`, `base-branch` or
 *                        `develop-branch`.
 *
 * @throws {Error} When it is empty or a full ref.
 *
 * @returns {string} The branch name, without surrounding whitespace.
 */
function validateBranch(branch, input) {
  const trimmed = String(branch ?? '').trim()

  if (trimmed === '') {
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

/**
 * Reads the `publish` input.
 *
 * @param {string} input The input: empty, `true` or `false`.
 *
 * @throws {Error} When it is anything else.
 *
 * @returns {boolean} Whether to publish the GitHub release; true for an empty input.
 */
function readPublish(input) {
  const trimmed = String(input ?? '').trim().toLowerCase()

  if (trimmed === '' || trimmed === 'true') {
    return true
  }

  if (trimmed === 'false') {
    return false
  }

  throw new Error(`publish '${trimmed}' is not a value this action takes: pass true or false.`)
}

/**
 * The header git sends to authenticate as the token, the same one actions/checkout stores when it
 * persists credentials.
 *
 * @param {string} token The token.
 *
 * @returns {string} The `AUTHORIZATION: basic …` header.
 */
function authorizationHeader(token) {
  return `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`
}

/**
 * The environment that hands git the token for one command, scoped to the server the run is on.
 *
 * Git reads `GIT_CONFIG_COUNT` and the numbered key/value pairs as configuration for that process
 * only, so the token reaches the fetch and the pushes and nothing else: it is never written to
 * .git/config, where a later step of the same job would find it, and it is never on a command line,
 * which @actions/exec echoes into the log.
 *
 * @param {string} token     The token.
 * @param {string} serverUrl The GitHub server, `https://github.com` or a GitHub Enterprise URL.
 *
 * @returns {object} The three variables.
 */
function gitAuthEnv(token, serverUrl) {
  const server = String(serverUrl || 'https://github.com').replace(/\/+$/, '')

  return {
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: `http.${server}/.extraheader`,
    GIT_CONFIG_VALUE_0: authorizationHeader(token),
  }
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
 * Whether a failed `git merge` stopped on a conflict, as opposed to failing for any other reason.
 *
 * @param {{exitCode: number, stdout: string, stderr: string}} result What the merge returned.
 *
 * @returns {boolean} True for a conflict.
 */
function isConflict(result) {
  return result.exitCode !== 0 && CONFLICT_OUTPUT.test(`${result.stdout}\n${result.stderr}`)
}

/**
 * Checks the version against the repository's tags before anything is merged.
 *
 * A version that was never tagged is the common case. One whose tag exists with a published release
 * may be a retry after a late failure; runMerge decides that once the tag is fetched, by checking
 * that the tag contains the branch. One whose tag exists without a release would make the publish
 * step reuse whatever commit the tag points at, so it is refused here, with the base and develop
 * untouched.
 *
 * @param {object} options
 * @param {object} options.github  The Octokit github-script supplies.
 * @param {string} options.owner   The repository owner.
 * @param {string} options.repo    The repository name.
 * @param {string} options.version The version, validated.
 *
 * @throws {Error} When the tag exists without a release, or a read fails for any reason but 404.
 *
 * @returns {Promise<{tagged: boolean, releaseUrl: string|null}>} Whether the tag exists, and the
 *          published release's URL when it does.
 */
async function runPreflight({ github, owner, repo, version }) {
  if (!(await tagExists({ github, owner, repo, version, what: 'Nothing was merged.' }))) {
    return { tagged: false, releaseUrl: null }
  }

  try {
    const { data: release } = await github.rest.repos.getReleaseByTag({ owner, repo, tag: version })

    return { tagged: true, releaseUrl: release.html_url }
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
 * Reads a file from a ref of the checkout, without checking it out.
 *
 * @param {object} exec The @actions/exec toolkit.
 * @param {string} cwd  The checkout.
 * @param {string} ref  The ref, e.g. `origin/release/M26.test`.
 * @param {string} file The path in the repository.
 *
 * @returns {Promise<string|null>} The contents, or null when the ref has no such file.
 */
async function fileAt(exec, cwd, ref, file) {
  const result = await exec.getExecOutput('git', ['show', `${ref}:${file}`], { cwd, ignoreReturnCode: true, silent: true })

  return result.exitCode === 0 ? result.stdout : null
}

/**
 * Checks that the version to release is the one the release branch holds, in every file .puprc lists
 * under paths.versions. The tag and the title of the release come from `version`, so a value other
 * than what release-prep wrote into the branch would publish the code under the wrong version.
 *
 * @param {object} options
 * @param {object} options.exec    The @actions/exec toolkit.
 * @param {string} options.cwd     The checkout.
 * @param {string} options.branch  The release branch, fetched as `origin/<branch>`.
 * @param {string} options.version The version to release, validated.
 *
 * @throws {Error} When the branch has no usable .puprc, a version file holds no version, or any of
 *                 them holds a different version.
 *
 * @returns {Promise<void>} Resolves when every version file holds `version`.
 */
async function assertBranchHoldsVersion({ exec, cwd, branch, version }) {
  const ref = `origin/${branch}`
  const files = readVersionFiles(await fileAt(exec, cwd, ref, '.puprc'), 'Nothing was merged.')

  for (const { file, regex } of files) {
    const content = await fileAt(exec, cwd, ref, file)
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
 * Runs a git command in the checkout and fails with its output when it exits non-zero.
 *
 * @param {object}   exec    The @actions/exec toolkit.
 * @param {string[]} args    The git arguments.
 * @param {object}   options Options for @actions/exec, `cwd` among them.
 * @param {string}   what    What the command does, to open the error message.
 *
 * @throws {Error} When git exits non-zero.
 *
 * @returns {Promise<string>} What git printed to stdout.
 */
function gitOrFail(exec, args, options, what) {
  return runOrFail(exec, 'git', args, options, what)
}

/**
 * Merges one branch into the branch the checkout is on, as a merge commit, and pushes it.
 *
 * A branch that already holds the other merges as "Already up to date" and pushes nothing, which is
 * what a retry after a late failure finds. A conflict abandons the merge, prints the MERGE_CONFLICT
 * marker on a line of its own, where the release dashboard looks for it, and fails.
 *
 * @param {object} options
 * @param {object} options.core    The @actions/core toolkit.
 * @param {object} options.exec    The @actions/exec toolkit.
 * @param {string} options.cwd     The checkout.
 * @param {object} options.authEnv The environment that hands git the token, for the push.
 * @param {string} options.from    The ref to merge, e.g. `origin/release/M26.test`.
 * @param {string} options.into    The branch the checkout is on, e.g. `main`.
 * @param {string} options.message The merge commit message.
 * @param {string} options.label   How to name `from` in the log, e.g. `release/M26.test`.
 *
 * @throws {Error} When the merge conflicts or fails, or the push fails.
 *
 * @returns {Promise<boolean>} True when a merge commit was made, false when there was nothing to merge.
 */
async function mergeAndPush({ core, exec, cwd, authEnv, from, into, message, label }) {
  const identity = ['-c', `user.name=${BOT_IDENTITY.name}`, '-c', `user.email=${BOT_IDENTITY.email}`]
  const result = await exec.getExecOutput('git', [...identity, 'merge', '--no-ff', '-m', message, from], {
    cwd,
    ignoreReturnCode: true,
  })

  if (isConflict(result)) {
    // The abort leaves the checkout clean, so a later step can still use it. core.info prints a
    // plain line: the marker has to open an output line to count, see the README.
    await exec.getExecOutput('git', ['merge', '--abort'], { cwd, ignoreReturnCode: true })
    core.setOutput('conflict', into)
    core.info(
      `MERGE_CONFLICT: merging ${label} into ${into} conflicted. Resolve it on ${into} by hand and ` +
        `push, then run this step again. Nothing was pushed to ${into}.`
    )
    throw new Error(
      `Merging ${label} into ${into} stopped on a conflict. Resolve it on ${into} by hand and push, ` +
        `then run this step again: the merges already done are kept. Nothing was pushed to ${into}.`
    )
  }

  if (result.exitCode !== 0) {
    const output = [result.stdout, result.stderr].map((text) => text.trim()).filter(Boolean)

    throw new Error(`Merging ${label} into ${into} failed (exit code ${result.exitCode}):\n${output.join('\n')}`)
  }

  const merged = !/Already up to date/.test(result.stdout)
  if (!merged) {
    core.info(`${into} already has ${label}: nothing to merge.`)
  }

  await gitOrFail(exec, ['push', 'origin', `HEAD:refs/heads/${into}`], { cwd, env: authEnv }, `Pushing ${into}`)

  return merged
}

/**
 * Checks the inputs and the version, then merges the release branch into the base branch and the
 * base branch back into develop, pushing each. The version has to be the one the release branch
 * holds in every file its .puprc lists, so the tag matches the code.
 *
 * The base branch, not the release branch, is merged into develop: develop then descends from the
 * base, and consecutive releases bring one version bump each instead of divergent copies of the same
 * lines. Both merges are `--no-ff`, so each release is one merge commit in the history.
 *
 * The checkout is the caller's, on any branch and at any depth: the three branches are fetched, with
 * the full history when the checkout is shallow, and the checkout is left on the base branch at the
 * merged commit, for the steps that build the release from it.
 *
 * @param {object} options
 * @param {object} options.github The Octokit github-script supplies, for the tag and release reads.
 * @param {object} options.core   The @actions/core toolkit, for the log, the outputs and the summary.
 * @param {object} options.exec   The @actions/exec toolkit.
 * @param {object} options.env    The environment the action manifest put its inputs in.
 * @param {string} options.cwd    The checkout, the working directory by default.
 *
 * @throws {Error} When an input is wrong, the tag exists without a release, a merge conflicts or
 *                 fails, or a fetch or push fails.
 *
 * @returns {Promise<void>} Resolves once both branches are pushed and the outputs are set.
 */
async function runMerge({ github, core, exec, env, cwd = process.cwd() }) {
  const branch = validateBranch(env.INPUT_BRANCH, 'branch')
  const version = validateVersion(env.INPUT_VERSION)
  const base = validateBranch(env.INPUT_BASE_BRANCH, 'base-branch')
  const develop = validateBranch(env.INPUT_DEVELOP_BRANCH, 'develop-branch')
  // Read by the publish step; checked here so a wrong value fails before anything is merged.
  readPublish(env.INPUT_PUBLISH)
  const { owner, repo } = readRepository(env, 'Nothing was merged.')

  if (base === develop) {
    throw new Error(`base-branch and develop-branch are both '${base}'; they have to be two branches. Nothing was merged.`)
  }
  if (branch === base || branch === develop) {
    throw new Error(`branch '${branch}' is also the ${branch === base ? 'base' : 'develop'} branch. Nothing was merged.`)
  }

  for (const name of [branch, base, develop]) {
    const check = await exec.getExecOutput('git', ['check-ref-format', `refs/heads/${name}`], {
      cwd,
      ignoreReturnCode: true,
      silent: true,
    })
    if (check.exitCode !== 0) {
      throw new Error(`'${name}' is not a valid branch name. Nothing was merged.`)
    }
  }

  const { tagged, releaseUrl } = await runPreflight({ github, owner, repo, version })

  const token = String(env.INPUT_TOKEN || '')
  const authEnv = { ...env, ...gitAuthEnv(token, env.GITHUB_SERVER_URL) }
  if (token) {
    core.setSecret(authorizationHeader(token))
  }

  // A shallow checkout, the actions/checkout default, has no history for the merges to find a base
  // in; `--unshallow` fetches it along with the branches.
  const shallow = (await exec.getExecOutput('git', ['rev-parse', '--is-shallow-repository'], { cwd, silent: true })).stdout.trim()
  const refspecs = [branch, base, develop].map((name) => `+refs/heads/${name}:refs/remotes/origin/${name}`)
  if (tagged) {
    refspecs.push(`+refs/tags/${version}:refs/tags/${version}`)
  }
  await gitOrFail(
    exec,
    ['fetch', ...(shallow === 'true' ? ['--unshallow'] : []), 'origin', ...refspecs],
    { cwd, env: authEnv },
    'Fetching the branches'
  )

  await assertBranchHoldsVersion({ exec, cwd, branch, version })

  // A tag with a published release is a retry only when that release came from this branch: its
  // commit then contains the branch, and the merges below find nothing to do. A tag that does not
  // contain the branch is an earlier release of the same version, which the branch was never bumped
  // past; merging it would put a second set of changes under a version that is already out.
  if (tagged) {
    const ancestry = await exec.getExecOutput(
      'git',
      ['merge-base', '--is-ancestor', `origin/${branch}`, `refs/tags/${version}^{commit}`],
      { cwd, ignoreReturnCode: true, silent: true }
    )
    if (ancestry.exitCode === 1) {
      throw new Error(
        `The tag ${version} already exists and does not contain ${branch}: ${version} was released ` +
          `from another commit, and the branch was never bumped past it. Give the release a new ` +
          'version and prepare the branch again. Nothing was merged.'
      )
    }
    if (ancestry.exitCode !== 0) {
      throw new Error(`Comparing ${branch} with the tag ${version} failed (exit code ${ancestry.exitCode}). Nothing was merged.`)
    }
    core.info(`${version} is already published (${releaseUrl}) from ${branch}; the publish step will skip it.`)
  }

  await gitOrFail(exec, ['checkout', '--quiet', '-B', base, `origin/${base}`], { cwd }, `Checking out ${base}`)
  const mergedBase = await mergeAndPush({
    core,
    exec,
    cwd,
    authEnv,
    from: `origin/${branch}`,
    into: base,
    message: mergeMessage(branch, base),
    label: branch,
  })

  await gitOrFail(exec, ['checkout', '--quiet', '-B', develop, `origin/${develop}`], { cwd }, `Checking out ${develop}`)
  const mergedDevelop = await mergeAndPush({
    core,
    exec,
    cwd,
    authEnv,
    from: base,
    into: develop,
    message: `Merge ${base} back into ${develop} (${branch})`,
    label: base,
  })

  await gitOrFail(exec, ['checkout', '--quiet', base], { cwd }, `Checking out ${base}`)

  core.setOutput('branch', branch)
  core.setOutput('version', version)
  core.setOutput('base-branch', base)
  core.setOutput('develop-branch', develop)
  core.setOutput('conflict', '')

  const did = (merged, from, into) => (merged ? `merged \`${from}\` into \`${into}\`` : `\`${into}\` already had \`${from}\``)
  await core.summary
    .addRaw(`Release ${version}: ${did(mergedBase, branch, base)}, ${did(mergedDevelop, base, develop)}.`, true)
    .write()
}

/**
 * Publishes the GitHub release for the version, unless `publish` is false or it already exists.
 *
 * The release is read again here rather than taken from the merge step's outputs, so a release
 * created in between, by a retry or another run, is found. Its notes are the ones GitHub generates
 * from the pull requests since the previous release.
 *
 * @param {object} options
 * @param {object} options.github The Octokit github-script supplies, authenticated with the token.
 * @param {object} options.core   The @actions/core toolkit, for the log, the outputs and the summary.
 * @param {object} options.env    The environment the action manifest put the merge step's outputs in.
 *
 * @throws {Error} When `publish` is not true or false, or an API call fails.
 *
 * @returns {Promise<void>} Resolves once the release exists, or was found unnecessary.
 */
async function runPublish({ github, core, env }) {
  const publish = readPublish(env.INPUT_PUBLISH)
  const version = validateVersion(env.INPUT_VERSION)
  const base = validateBranch(env.INPUT_BASE_BRANCH, 'base-branch')

  if (!publish) {
    core.info(`publish is false: the GitHub release for ${version} was not created.`)
    core.setOutput('published', 'false')
    core.setOutput('release-url', '')

    return
  }

  const { owner, repo } = readRepository(env, 'Nothing was published.')

  let existing = null
  try {
    existing = (await github.rest.repos.getReleaseByTag({ owner, repo, tag: version })).data
  } catch (error) {
    if (!isNotFound(error)) {
      throw new Error(
        `Reading the release for ${version} failed (HTTP ${error.status}): ${error.message}. Nothing was published.`
      )
    }
  }

  if (existing) {
    core.info(`${version} is already published (${existing.html_url}): nothing to publish.`)
    core.setOutput('published', 'skipped')
    core.setOutput('release-url', existing.html_url)
    await core.summary.addRaw(`Release ${version} was already published: ${existing.html_url}`, true).write()

    return
  }

  const { data: notes } = await github.rest.repos.generateReleaseNotes({
    owner,
    repo,
    tag_name: version,
    target_commitish: base,
  })
  const { data: release } = await github.rest.repos.createRelease({
    owner,
    repo,
    tag_name: version,
    target_commitish: base,
    name: version,
    body: notes.body,
  })

  core.info(`Published ${version}: ${release.html_url}`)
  core.setOutput('published', 'true')
  core.setOutput('release-url', release.html_url)
  await core.summary.addRaw(`Published release ${version} on \`${base}\`: ${release.html_url}`, true).write()
}

module.exports = {
  runMerge,
  runPublish,
  runPreflight,
  validateVersion,
  validateBranch,
  readPublish,
  authorizationHeader,
  gitAuthEnv,
  mergeMessage,
  isConflict,
  BOT_IDENTITY,
}
