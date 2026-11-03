# release-publish

Publishes the GitHub release for a version at a commit: the tag and the release in one step, with
the title, the notes and the assets the caller chooses. It is the second half of a deploy, after
[release-merge](../release-merge/README.md) has merged the release and the caller has built it:

```yaml
- uses: stellarwp/plugin-toolbox/.github/actions/release-merge@v1
  id: merge
  with:
    branch: ${{ inputs.branch }}
    version: ${{ inputs.version }}

- uses: actions/checkout@v6
  with:
    ref: ${{ steps.merge.outputs.base-sha }}

# Build the plugin here, from the merged commit.

- uses: stellarwp/plugin-toolbox/.github/actions/release-publish@v1
  with:
    version: ${{ inputs.version }}
    target: ${{ steps.merge.outputs.base-sha }}
    files: |
      build/my-plugin.zip
```

`target` is the commit the release is made at: release-merge's `base-sha` output, as above, which is
also the commit checked out and built between the two actions. The tag is made at that commit,
whatever the base branch points to by the time this runs.
[`templates/workflows/release.yml`](../../../templates/workflows/release.yml) is the complete deploy
workflow around the two actions, ready to copy into a plugin repository.

The action also runs on its own, for a release a person merged by hand: check out the branch,
record its commit, and pass that as `target` (a branch name would be resolved to its tip when the
action runs, after the checkout):

```yaml
- uses: actions/checkout@v6
  with:
    ref: ${{ inputs.branch }}
    persist-credentials: false

- id: head
  run: echo "sha=$(git rev-parse HEAD)" >> "$GITHUB_OUTPUT"

- uses: stellarwp/plugin-toolbox/.github/actions/release-publish@v1
  with:
    version: ${{ inputs.version }}
    target: ${{ steps.head.outputs.sha }}
```

## What it does

In this order, stopping at the first failure:

1. Checks the inputs: the version (three or four numeric parts), the target, and that every file
   in `files` and the `notes-file` exist in the checkout.
2. Reads the release for the version. One that exists is skipped, so a run can be repeated after a
   late failure; a tag that exists without a release is refused, since publishing would release
   whatever commit the tag points at.
3. Resolves the target to a commit: a branch name becomes its tip.
4. Decides whether the release takes "Latest": it does, unless the repository's current latest
   release is a higher version, as when a hotfix goes out on an older line after a newer version
   is already released.
5. Without `files`, creates the release at the commit: tag and title, the notes from `notes-file`
   or the ones GitHub generates from the pull requests since the previous release.
6. With `files`, creates the release as a **draft**, uploads every file, then publishes it. A draft
   makes no tag, so an upload that fails is undone by deleting the draft: nothing is left behind,
   and the release is never public without its files. That is also what a repository with
   immutable releases needs, since a published release cannot be changed afterwards.

## Inputs

| Input | Required | Default | What it is |
|---|---|---|---|
| `version` | yes | | The version being released: three or four numeric parts. It becomes the tag. |
| `target` | yes | | The commit to publish at: a full commit hash, or a branch name for its tip. |
| `title` | no | the version | The release title, e.g. `Maintenance Release 6.18.3`. |
| `notes-file` | no | | A file in the checkout whose contents are the notes, e.g. this version's changelog entry. Empty: GitHub generates them. |
| `files` | no | | Assets to attach, one path per line, relative to the checkout. |
| `token` | no | `github.token` | The token the release is created with. Needs `contents: write`. See [The token](#the-token). |

## Outputs

| Output | What it is |
|---|---|
| `published` | `true` when the release was created, `skipped` when it already existed. |
| `release-url` | The release page. |
| `sha` | The commit the release was created at; empty when it already existed. |

## Running it again

A release that already exists is skipped and its URL is still reported, so a deploy that failed
after publishing is rerun as it is. An existing release is not changed: a file that was not
attached because the run died between the publish and a later step stays missing, and is added by
hand, or not at all on a repository with immutable releases. With `files`, the window is closed:
the release is only published once every file is on it.

## The token

The job needs `contents: write`. The default `github.token` is enough when the repository's tag
rules allow it to create a tag: a tag ruleset should block deletion and updates, not creation.
GiveWP's rules are the reference shape (branches protected from deletion and non-fast-forward
pushes, no tag rule), and `github.token` publishes there.

One case the default token cannot cover: a release at a commit that adds or changes a file under
`.github/workflows/` relative to the repository's default branch. GitHub requires a token allowed
to modify workflows for that (a GitHub App installation token with the Workflows permission, or a
personal access token with the `workflow` scope) and answers 404 to `github.token`. After
release-merge the commit published is the base branch's own tip, so there is no such difference and
`github.token` publishes; the case is the publish of a branch a person merged by hand, when that
branch changed a workflow.

A release published with the default `github.token` triggers no `release` workflow: GitHub does
not start workflows from events a workflow's own token caused. The run that merged and published
the release is the one that deploys it, so a repository that also has an `on: release` deploy does
not deploy it twice. **A personal access token or a GitHub App token does trigger `on: release`**:
a repository whose tag rules require one of those, because `github.token` cannot be on a ruleset's
bypass list, deploys twice unless the `on: release` workflow is given the same concurrency group
and ignores releases created by the bot, or is retired. Prefer a GitHub App installation token
minted in the run over a personal access token: it is short-lived and scoped to the run.

## How it runs

One [actions/github-script](https://github.com/actions/github-script) step runs
[`release-publish.js`](./release-publish.js). The inputs reach the script through environment
variables, never interpolated into it, so a crafted value is data rather than part of the program.
Everything goes through github-script's Octokit; the checkout is only read, for the notes file and
the assets.

The tests, `node --test` from the repository root, run the script against a recorded client and
real files in a temporary directory.
