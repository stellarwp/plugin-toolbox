# release-merge

Merges a release and publishes it on GitHub: the release branch into the base branch, the base
branch back into develop, then the GitHub release for the version. **The base branch is `main`, or
`master` where that is the repository's name for it**, set with `base-branch`:

```yaml
- uses: actions/checkout@v6
  with:
    persist-credentials: false

- uses: stellarwp/plugin-toolbox/.github/actions/release-merge@v1
  with:
    branch: ${{ inputs.branch }}
    version: ${{ inputs.version }}
```

It is the part of a deploy that is the same for every plugin repository on a base branch plus
`develop` model. Building the plugin, uploading it anywhere and announcing it are the caller's
steps, after the action, on the checkout it leaves on the merged base branch.
[`templates/workflows/release-merge.yml`](../../../templates/workflows/release-merge.yml) is a
complete workflow around it, ready to copy into a plugin repository.

## What it does

In this order, stopping at the first failure:

1. Checks the inputs, and the version against the repository's tags. See
   [Versions it refuses](#versions-it-refuses).
2. Fetches the release branch, the base branch and develop from `origin`, with the full history
   when the checkout is shallow. Then it checks that every version file the branch's `.puprc` lists
   holds the version and, when the version is already tagged, that the tag contains the branch: a
   retry of this release goes on, a tag made from another commit is refused.
3. Merges the release branch into the base branch as a merge commit, `Merge release/… into main`
   (or `into master`), and pushes it.
4. Merges the **base branch** into develop as a merge commit, `Merge main back into develop
   (release/…)`, and pushes it. The base branch rather than the release branch, so develop
   descends from the base and consecutive releases bring one version bump each instead of
   divergent copies of the same generated lines.
5. Publishes the GitHub release: tag and title are the version, target is the base branch, the notes
   are the ones GitHub generates from the pull requests since the previous release. Skipped with
   `publish: false`.

The checkout is left on the base branch at the merged commit, clean. The merge commits are made by
`github-actions[bot]`; the pushes and the release are made by the identity of `token`, also
`github-actions[bot]` for the default token.

## Running it again

Every step is safe to run again after a late failure, which is what a retry from a release tool
does:

- A branch that already holds the other merges as "Already up to date" and pushes nothing.
- A release that already exists is skipped, and its URL is still reported in `release-url`. It
  counts as a retry only when its tag contains the release branch, that is, when it was published
  from this branch. See [Versions it refuses](#versions-it-refuses).
- A conflict resolved by hand on the branch, then pushed, is found as an already-merged branch on
  the next run, which goes on to the step that had not run.

So a run that failed publishing, or after merging the base, is rerun as it is; nothing has to be
undone first.

## When a merge conflicts

The conflicted merge is abandoned (`git merge --abort`), nothing is pushed for that branch, and the
step fails with the branch named. The branches already pushed stay pushed: a conflict merging the
base into develop leaves the release on the base. Resolve the conflict on the branch by hand, push,
and run the step again.

The log carries this line, on one line:

```
MERGE_CONFLICT: merging main into develop conflicted. Resolve it on develop by hand and push,
then run this step again. Nothing was pushed to develop.
```

and the `conflict` output names the branch. The [release
dashboard](https://github.com/stellarwp/nexcess-one) classifies the run from that line: it reads the
marker `MERGE_CONFLICT` at the start of an output line of the job log, every line of which the
runner prefixes with a timestamp. The marker is printed from the script, not written in the
workflow, so it is not in the step's echoed inputs and only appears when a merge did conflict. The
two lines git itself prints, `CONFLICT (…)` and `Automatic merge failed`, are in the log as well.

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
- **A version whose tag exists without a published release.** Publishing would release whatever
  commit the tag points at. Delete the tag or release another version.
- **A version already released from another commit.** When the tag exists with a published release
  and does not contain the release branch, the version went out before this branch, and the branch
  was never bumped past it: a branch cut from `main` right after a release still carries that
  release's version. Merging it would put a second set of changes under a version that is already
  out, so the action refuses, with the branches untouched. Give the release a new version and
  prepare the branch again. A tag that does contain the branch is a retry of this release, and the
  action goes on.

The branches are checked too: each has to be a name git accepts, the base and develop have to be
two different branches, and the release branch cannot be either of them.

## Inputs

| Input | Required | Default | What it is |
|---|---|---|---|
| `branch` | yes | | The release branch to merge, e.g. `release/M26.jigglypuff`. A branch name, fetched from `origin`. |
| `version` | yes | | The version being released: three or four numeric parts. |
| `base-branch` | no | `main` | The branch the release is merged into: `main`, or `master` where that is the repository's name for it. |
| `develop-branch` | no | `develop` | The branch the base is merged back into. |
| `publish` | no | `true` | `false` to do the two merges without the GitHub release. |
| `token` | no | `github.token` | The token for the pushes and the release. Needs `contents: write`. See [The token](#the-token). |

## Outputs

| Output | What it is |
|---|---|
| `version` | The version released. |
| `branch` | The release branch merged. |
| `conflict` | The branch a merge conflicted on, or empty. A conflict fails the step, so read it with `continue-on-error` or in a later `if: failure()` step. |
| `published` | `true` when the release was created, `skipped` when it already existed, `false` when `publish` was false. |
| `release-url` | The release page, empty when `publish` was false. |

The merge step also sets `base-branch` and `develop-branch` as step outputs, for the publish step;
the action does not expose them.

## One deploy at a time

Two releases prepared with the same version, deployed at the same time, would merge side by side:
the second's changes would land on the base under a version the first had just published, and its
publish would be skipped as already done. The action cannot stop that on its own, since both runs
start before either has a tag to find. The caller does, with a `concurrency` group shared by every
deploy of the repository, as the template sets:

```yaml
concurrency:
  group: ${{ github.workflow }}
  cancel-in-progress: false
```

The second run then waits for the first, finds the version tagged from another branch, and is
refused before merging. A repository that also deploys from another workflow gives it the same
group. GitHub keeps one run waiting per group: a third deploy started while one is already waiting
cancels the waiting one, which has to be started again.

## The token

The job needs `contents: write`, and the token is used for the fetch, the two pushes and the
release. It is handed to git through the environment of those commands only (`GIT_CONFIG_*`, the
`http.<server>/.extraheader` header actions/checkout would store), so it is never in the checkout's
`.git/config` and never on a command line in the log. Use `persist-credentials: false` on the
checkout; it matters when later steps of the same job run third-party actions.

A release published with the default `github.token` triggers no `release` workflow: GitHub does not
start workflows from events a workflow's own token caused. The run that merged the release is the
one that deploys it, so a repository that also has an `on: release` deploy does
not deploy it twice. A release that should trigger other workflows needs a token of its own.

## The checkout

The action runs in the caller's checkout, which can be on any branch and at any depth: the three
branches are fetched explicitly, and a shallow checkout is unshallowed first. Run it on a clean
checkout; it switches branches, and uncommitted changes would travel with it or stop it.

The checkout's `origin` has to be the repository the run is on: `GITHUB_REPOSITORY` is where the
tags and the release are read and written.

## How it runs

Two [actions/github-script](https://github.com/actions/github-script) steps run
[`release-merge.js`](./release-merge.js): one for the checks and the merges, one for the release.
The inputs reach the script through environment variables, never interpolated into it, so a crafted
value is data rather than part of the program. The merges are git commands in the checkout; the tag
and release reads and the publish go through github-script's Octokit.

The tests, `node --test` from the repository root, run the merges with real git against a bare
repository on disk and the API calls against a recorded client.
