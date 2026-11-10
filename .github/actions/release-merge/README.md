# release-merge

Merges a release: the release branch into the base branch, then the base branch back into develop,
through the GitHub API. **The base branch is `main`, or `master` where that is the repository's name
for it**, set with `base-branch`:

```yaml
- uses: stellarwp/plugin-toolbox/.github/actions/release-merge@v1
  id: merge
  with:
    branch: ${{ inputs.branch }}
    version: ${{ inputs.version }}

# The merged commit, to build the release from:
- uses: actions/checkout@v6
  with:
    ref: ${{ steps.merge.outputs.base-sha }}

# Build the plugin here, then publish the release at the merged commit:
- uses: stellarwp/plugin-toolbox/.github/actions/release-publish@v1
  with:
    version: ${{ inputs.version }}
    target: ${{ steps.merge.outputs.base-sha }}
```

Publishing the GitHub release is [release-publish](../release-publish/README.md)'s, run after this
action and after the caller's build, at the commit this action leaves on the base branch
(`base-sha`), so the release can carry the build and is published only once it exists. GiveWP's
deploy workflow is that chain: release-merge, the build, the wordpress.org deploy, then
release-publish with the zip attached.

It is the part of a deploy that is the same for every plugin repository, on a base branch plus
`develop` model or on a base branch alone (`develop-branch: ''` skips the merge back). Building the
plugin, uploading it anywhere and announcing it are the caller's steps, after the action, on a
checkout of `base-sha`.
[`templates/workflows/release.yml`](../../../templates/workflows/release.yml) is the complete deploy
workflow, this action, the checkout, the build, then release-publish, ready to copy into a plugin
repository.

## What it does

In this order, stopping at the first failure:

1. Checks the inputs, and the version against the repository's tags. See
   [Versions it refuses](#versions-it-refuses).
2. Checks that the release branch, the base branch and develop exist, then that every version file
   the branch's `.puprc` lists holds the version and, when the version is already tagged, that the
   tag contains the branch: a retry of this release goes on, a tag made from another commit is
   refused.
3. Merges the release branch into the base branch as a merge commit, `Merge release/… into main`
   (or `into master`). When the base already holds the branch, a retry, nothing is merged: the
   commit to build is then the one the tag points at when the version is already published, and
   otherwise the base's tip, which has to be the commit that merged the branch. A base that has
   moved on since, by any commit, is refused. See [Versions it refuses](#versions-it-refuses).
4. Merges the **merged commit** into develop as a merge commit, `Merge main back into develop
   (release/…)`. The base branch rather than the release branch, so develop descends from the
   base and consecutive releases bring one version bump each instead of divergent copies of the
   same generated lines. Skipped when `develop-branch` is empty, for a repository that has no
   develop branch.

The merge commit on the base branch is the `base-sha` output: what the caller checks out and builds
from, and what release-publish tags. GitHub makes both merge commits under the identity of `token`,
`github-actions[bot]` for the default token, and signs them. The API never fast-forwards, so each
release is one merge commit in the history.

The action reads and writes no checkout: it needs none before it, and leaves whatever checkout the
job has as it was. Check out `base-sha` after it for the steps that build the release.

## Running it again

Every step is safe to run again after a late failure, which is what a retry from a release tool
does:

- A branch that already holds the other merges as nothing to merge: GitHub answers that the base
  already contains the head, and nothing is written. What the caller then builds and publishes is
  the commit the tag points at, or the base's tip when there is no tag yet, which has to be the
  commit that merged the branch; see [Versions it refuses](#versions-it-refuses).
- A version already published counts as a retry only when its tag contains the release branch,
  that is, when it was published from this branch. See [Versions it refuses](#versions-it-refuses).
  release-publish then skips the release.
- A conflict resolved by hand on the branch, then pushed, is found as an already-merged branch on
  the next run, which goes on to the step that had not run.

So a run that failed after merging the base, or in a later step of the caller, is rerun as it is;
nothing has to be undone first.

## When a merge conflicts

GitHub refuses the merge, nothing is written for that branch, and the step fails with the branch
named. The branches already merged stay merged: a conflict merging the base into develop leaves the
release on the base. Resolve the conflict on the branch by hand, push, and run the step again. The
API does not say which files conflict; the merge done by hand shows them.

The log carries this line, on one line:

```
MERGE_CONFLICT: merging main into develop conflicted. Resolve it on develop by hand and push,
then run this step again. Nothing was merged into develop.
```

and the `conflict` output names the branch. The [release
dashboard](https://github.com/stellarwp/nexcess-one) classifies the run from that line: it reads the
marker `MERGE_CONFLICT` at the start of an output line of the job log, every line of which the
runner prefixes with a timestamp. The marker is printed from the script, not written in the
workflow, so it is not in the step's echoed inputs and only appears when a merge did conflict.

A merge GitHub refuses for another reason (the base branch moved while the merge was being made)
fails the step without the marker; running the step again is enough.

## Versions it refuses

- **Anything but three or four numeric parts**, such as `4.17.0` or `4.17.0.1`. A pre-release such
  as `4.17.0-beta.1` and a leading `v` are refused: the version becomes the tag and the title of the
  published release, and a beta or an RC is not released this way. The release dashboard validates
  versions with the same rule, so a version it dispatches has passed it already; release-prep
  does under the stellarwp changelog versioning.
- **A version the branch does not hold.** The release branch's `.puprc` lists the files that carry the
  version under `paths.versions`, with the regex that finds it in each, the same entries release-prep
  bumps. The action reads every one of them on the branch and refuses when any holds a different
  version, naming the file: the version becomes the tag, so it has to be the one the branch was
  prepared with. A branch without a `.puprc`, or with a file where the regex finds nothing, is
  refused too, since the version it holds cannot be read.
- **An empty version.** A tool that dispatches the workflow for a release with no version set sends
  an empty one. When the workflow declares `version` as required, GitHub refuses the dispatch
  itself; when it is optional, the action fails the run before merging.
- **A version whose tag exists without a published release.** release-publish would release
  whatever commit the tag points at. Delete the tag or release another version.
- **A version already released from another commit.** When the tag exists with a published release
  and does not contain the release branch, the version went out before this branch, and the branch
  was never bumped past it: a branch cut from `main` right after a release still carries that
  release's version. Merging it would put a second set of changes under a version that is already
  out, so the action refuses, with the branches untouched. Give the release a new version and
  prepare the branch again. A tag that does contain the branch is a retry of this release, and the
  action goes on.
- **An unpublished retry after the base has moved on.** When the base already holds the release
  branch, nothing is merged, and what the caller builds and publishes is `base-sha`. A publish that
  failed after the deploy, then another release or a commit pushed straight to the base, then a
  retry of this one would build those changes and publish them under this version: a deploy skips
  the tag it finds on wordpress.org and zips the current trunk, and release-publish tags whatever
  commit it is given. So when the version has no tag yet, the base's tip has to be the commit that
  merged the branch, the merge commit whose second parent is the branch's tip; a tip that is any
  other commit, bump or not, is refused. Finish this release by hand at the commit that merged the
  branch into the base, or release another version. A version already published is not refused:
  its retry builds the commit the tag points at, what was published, and deploy and publish skip
  what they find.

The branches are checked too: each has to exist in the repository, the base and develop have to be
two different branches (when there is a develop), and the release branch cannot be either of them.

The release branch's tip is read once, and that commit is what the version files are read at, what
a published tag is compared against, and what is merged into the base. A commit pushed to the branch
after the check is not merged by that run; run the step again for it. The branch name appears in
the merge message and in the messages, not in what the API is asked.

The tip is read when the step runs, which in a deploy that waits for an approval is later than the
run started. Pass `head`, the commit the run was started on (`github.sha` in a `workflow_dispatch`
run), and a branch whose tip is another commit is refused before anything is merged: the commit
that was built and reviewed is no longer the tip, so the deploy is started again. The template does
this; without `head`, the tip at that moment is what merges.

## Inputs

| Input | Required | Default | What it is |
|---|---|---|---|
| `branch` | yes | | The release branch to merge, e.g. `release/M26.jigglypuff`. A branch name. |
| `head` | no | | The commit the release branch has to be at, as a full hash: `github.sha`, the commit the run was started on. Empty checks nothing. See [Versions it refuses](#versions-it-refuses). |
| `version` | yes | | The version being released: three or four numeric parts. |
| `base-branch` | no | `main` | The branch the release is merged into: `main`, or `master` where that is the repository's name for it. |
| `develop-branch` | no | `develop` | The branch the base is merged back into. Empty for a repository without one: only the first merge is made. Write `develop-branch: ''` in the caller itself; a `workflow_dispatch` input left empty takes its default, so the empty value cannot be passed through one. |
| `token` | no | `github.token` | The token for the merges and the reads. Needs `contents: write`. See [The token](#the-token). |

## Outputs

| Output | What it is |
|---|---|
| `version` | The version released. |
| `branch` | The release branch merged. |
| `base-sha` | The commit on the base branch that holds the release: the merge commit, or the base's tip on a retry that found the merge done. The commit to check out and build from; pass it to release-publish as `target`. |
| `conflict` | The branch a merge conflicted on, or empty. A conflict fails the step, so read it with `continue-on-error` or in a later `if: failure()` step. |

## One deploy at a time

Two releases prepared with the same version, deployed at the same time, would merge side by side:
the second's changes would land on the base under a version the first had just published, and its
publish would be skipped as already done. The action cannot stop that on its own, since both runs
start before either has a tag to find. The caller does, with a `concurrency` group shared by every
deploy of the repository:

```yaml
concurrency:
  group: ${{ github.workflow }}
  cancel-in-progress: false
```

The second run then waits for the first, finds the version tagged from another branch, and is
refused before merging. A repository that also deploys from another workflow gives it the same
group. GitHub keeps one run waiting per group: a third deploy started while one is already waiting
cancels the waiting one, which is started again. (`queue: max` would keep every waiting run, but
actionlint 1.7 does not know the key and the plugin repositories lint their workflows with it.)

## The token

The job needs `contents: write`, and the token is used for the two merges and for the branch, tag,
release and file reads. It only ever reaches github-script's client: it is never handed to git,
never on a command line and never in the log. The caller's checkout, when there is one, can use
`persist-credentials: false`.

The default `github.token` is enough when the repository's rules allow what the action does: a
merge written straight to the base branch and to develop. The merges are made through the API, not
opened as pull requests, so a base branch that only accepts pull requests refuses the merge, with
any token that is not on the rule's bypass list; a rule that requires signed commits is satisfied,
since GitHub signs the merge commits it makes. GiveWP's rules are the reference shape: the branches
are protected from deletion and non-fast-forward pushes, and `github.token` writes the merges. The
human gate is not the token: the caller puts the job in an environment with required reviewers, and
the release branch reached this step after its review and QA approval. A repository whose rules
still need another actor should pass a GitHub App installation token minted in the run rather than
a personal access token. What the token needs for the tag is in
[release-publish → The token](../release-publish/README.md#the-token).

## How it runs

One [actions/github-script](https://github.com/actions/github-script) step runs
[`release-merge.js`](./release-merge.js): the checks and the merges, all through github-script's
Octokit. The inputs reach the script through environment variables, never interpolated into it, so
a crafted value is data rather than part of the program.

The tests, `node --test` from the repository root, run the action against a recorded client and
assert the requests it sends and the ones it does not; no git and no network.
