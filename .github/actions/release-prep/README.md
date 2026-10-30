# release-prep

Prepares a release branch: bumps the version, replaces the `@since TBD` placeholders, writes the
changelog, then commits the result to the branch through the GitHub API:

```yaml
- uses: actions/checkout@v6
  with:
    ref: ${{ inputs.branch }}
    persist-credentials: false

- uses: stellarwp/plugin-toolbox/.github/actions/release-prep@v1
  with:
    branch: ${{ inputs.branch }}
    version: ${{ inputs.version }}
```

The action opens no pull request; the commit is reviewed on the release branch's own pull request.
[`templates/workflows/release-prep.yml`](../../../templates/workflows/release-prep.yml) is a complete
workflow around it, ready to copy into a plugin repository.

## What it changes

Three tools run, in this order, from the root of the checkout:

1. `pup replace-version <version>` rewrites the version in every file `.puprc` lists under
   `paths.versions`.
2. `pup replace-tbd <version>` replaces the TBD placeholders (`@since TBD`, `@deprecated TBD`,
   `_deprecated_function( __METHOD__, 'TBD' )` and the like) in the directories `.puprc` lists under
   `checks.tbd.dirs`.
3. The [changelogger action](https://github.com/stellarwp/changelogger) writes the pending entries in
   `changelog/` into the changelog files and deletes them, with the version and the date.

Everything the working tree changed is then committed to `branch` as `Prepare <branch> (<version>)`,
through the GitHub API, by the identity of `token`: `github-actions[bot]` for the default token. Run
the action on a clean checkout, and put any step that writes tracked files after it: the commit
includes every change in the working tree. See [Committing](#committing).

pup is downloaded from its GitHub release into the runner's temp directory, so it never ends up in
the commit. See [Which pup runs](#which-pup-runs).

## What the repository needs

A `.puprc` listing the version files and the directories that hold the TBD placeholders:

```json
{
  "paths": {
    "versions": [
      { "file": "my-plugin.php", "regex": "(Version: )(.+)" },
      { "file": "my-plugin.php", "regex": "(define\\( 'MY_PLUGIN_VERSION', ')([^']+)" },
      { "file": "readme.txt", "regex": "(Stable tag: )(.+)" }
    ]
  },
  "checks": {
    "tbd": {
      "dirs": ["src", "includes"]
    }
  }
}
```

A `changelogger` section in `package.json`, and the pending entries in its `changesDir`:

```json
{
  "changelogger": {
    "versioning": "stellarwp",
    "changesDir": "changelog",
    "files": [{ "path": "readme.txt", "strategy": "stellarwp-readme" }]
  }
}
```

The action checks the `.puprc` before running anything, because pup does not: a missing file, one
that is not JSON, or one with no `paths.versions` makes pup change nothing and exit 0. The job
fails on any of the three, with the branch untouched.

Three cases only produce a warning; the run continues:

- No `checks.tbd.dirs`: pup falls back to its default and replaces TBDs under `src/` only.
- No `changelogger` section: the changelogger uses its defaults — a keepachangelog `changelog.md`
  with semver versioning — and the action validates the version as semver.
- A custom versioning strategy, `versioning` set to a `.js`: the action does not
  check the version's shape. See [Versions it refuses](#versions-it-refuses).

A writing strategy given as a `.js` file is loaded from the checkout; it has to be there before the
action runs. One written in TypeScript has to be built in an earlier step.

## Versions it refuses

The version is checked against the versioning strategy the repository's changelogger configures,
`changelogger.versioning` in `package.json`, so the action refuses what the changelog step would
refuse, before pup has touched anything:

- `stellarwp`: three or four numeric parts, such as `4.17.0` or `4.17.0.1`. A pre-release such as
  `4.17.0-beta.1` is refused, even though it is a valid tag name.
- `semver`, or no `changelogger` section: `MAJOR.MINOR.PATCH` with an optional pre-release, such as
  `4.17.0` or `4.17.0-beta.1`. A fourth part, `4.17.0.1`, is refused. So is a leading `v`: the
  changelogger's semver check would take `v4.17.0`, but the version goes into the version files
  and the tag as it is given.
- A custom strategy, `versioning` set to a `.js` or `.ts` file: no shape check. The changelog step
  validates the version with that strategy, and the action warns that it did not.
- Any other `versioning` value fails the action, because the changelog step would fail on it.

The changelog step validates the version only when `changelog/` holds entries to write; without
any, it writes nothing and accepts any version. The action's check does not depend on that.

- **An empty version is refused.** A tool that dispatches the workflow for a release with no version
  set sends an empty one. When the workflow declares `version` as required, as the template does,
  GitHub refuses the dispatch itself with HTTP 422 and no run starts. When the workflow declares it
  optional, the run starts and the action fails it with "No version was given". Either way the
  release needs a version before the step runs again.
- **A version the repository has already tagged is refused.** A release branch cut from `main` right
  after a release still carries that release's version, and preparing it again would put the next
  changes under a version that is already out. The tag is read through the GitHub API with `token`,
  so the check works on the shallow checkout the template makes. Give the release a new version.
- **A version lower than the branch's is refused.** pup reads the version the branch already has
  (`pup get-version`, the first file in `paths.versions`), and preparing `4.17.0` on a branch at
  `4.18.0` would bump the plugin backwards: either the version or the branch is wrong. The same
  version is accepted; that is what re-running a preparation finds. Only the numeric start of the
  version is compared: `4.17.0-beta.1` counts as `4.17.0`, so it is accepted on a branch at `4.17.0`
  and refused on one at `4.18.0`. When the version files hold something that is not a numeric
  version, such as `dev`, or the version itself does not start with a number, the job only warns.
  When pup cannot find a version at all, it fails, as `replace-version` would.

Each refusal happens before anything is changed. So do a `date` that is not `YYYY-MM-DD`, a `branch`
outside `branch-prefixes` or not a valid branch name, and a checkout that is not on `branch`.

## Branches it refuses

The action commits to the branch it is given, and the job that runs it has write access, so a
dispatch by hand with the wrong name would put a version bump and a changelog on `develop`. `branch`
has to start with one of the prefixes `branch-prefixes` lists, `release/`, `hotfix/` or `bucket/` by
default, or the action fails before anything runs, naming the branch it got and the list:

```
Refusing to prepare 'develop': it does not start with release/, hotfix/, or bucket/. The action only
commits to a release branch; pass the branch to prepare, or set branch-prefixes to a JSON array of
the prefixes the repository uses. Nothing was changed.
```

A repository that names its release branches some other way passes its own list, as a JSON array
in a string (an action input is always a string), with any whitespace around an entry ignored:

```yaml
- uses: stellarwp/plugin-toolbox/.github/actions/release-prep@v1
  with:
    branch: ${{ inputs.branch }}
    branch-prefixes: '["rc/", "release-"]'
    version: ${{ inputs.version }}
```

An empty value keeps the default list, so a dispatch input left blank and passed through keeps the
check on. An empty array turns the check off:

```yaml
    branch-prefixes: '[]'
```

With it, any branch name git accepts is prepared. A value that is not a JSON array of prefixes,
such as `release/,hotfix/`, fails the action before anything runs.

A prefix is matched literally, from the start of the branch name, with no wildcards: `release/`
takes `release/4.20.0`; `release`, without the slash, also takes `release-4.x` and `releases/x`. The
check runs with the other input checks, before `git check-ref-format`, the `.puprc` read and the pup
download.

## Inputs

| Input | Required | Default | What it does |
|---|---|---|---|
| `branch` | yes | | The release branch to commit to, e.g. `release/M26.jigglypuff`. A branch name, not `refs/heads/…`. The checkout has to be on it; see [Committing](#committing) |
| `branch-prefixes` | no | `["release/", "hotfix/", "bucket/"]` | The prefixes `branch` has to start with, as a JSON array. Empty keeps the default; `[]` turns the check off. See [Branches it refuses](#branches-it-refuses) |
| `version` | yes | | The version to prepare, e.g. `4.17.0`. See [Versions it refuses](#versions-it-refuses) |
| `date` | no | today, in UTC | The changelog date as `YYYY-MM-DD`. Empty or `today` writes today |
| `token` | no | `github.token` | The token the commit is created with. See [Committing](#committing) |
| `pup-version` | no | `latest` | The pup release to run: a number such as `2.0.0`, or `latest` for the newest. See [Which pup runs](#which-pup-runs) |

## Outputs

| Output | Example | What it is |
|---|---|---|
| `version` | `4.17.0` | The version prepared |
| `date` | `2026-10-08` | The date written in the changelog |
| `commit` | `3f2a…` | The commit created on the branch. Empty when nothing changed |
| `files` | `my-plugin.php` | The files the commit changed, one per line. Empty when nothing changed |
| `distribution` | `phar` | Which pup distribution the release carries. `phar` on every run that succeeds, the only distribution the action runs today |

## Which pup runs

`pup-version` pins a pup release (`2.0.0`) or tracks the newest one (`latest`, the default). A
pinned release downloads straight from its release page. `latest` reads the newest release through
the GitHub API, authenticated with `token` so the runner's shared unauthenticated quota is not
spent.

The release itself decides whether the action can run it, not a version comparison: the action
sends a HEAD request to the release's `pup.phar` asset. Every release from 1.2.4 to 2.0.0
publishes one; the phar downloads into the runner's temp directory and runs on the runner's PHP.
A release without one is not supported yet: the prepare step fails, saying so and naming a pin
to use instead. A pinned release that does not exist, such as a mistyped number, fails the step
with "is not a release"; the action tells the two apart with a second HEAD request, to the
release's page.

The TypeScript line of pup publishes no phar. How the action will call it is open until that
line ships a distribution: through pup's own GitHub Action, or straight from the script with the
arguments the phar takes. The manifest cannot carry the first behind a condition today, because a
composite action's `uses:` references resolve when the job is set up, not when the step runs, so
a reference to an action that does not exist yet breaks every run; the second needs something
published to call. Either way the change is local to the script, and the action's inputs and
outputs stay as they are. The branch-version check — the refusal of a version lower than the
branch already has — runs on the phar path only; the TS contract does not define it yet.

## Running it again

Preparing a version the branch already holds changes nothing: the versions match, no TBDs are left
and `changelog/` is empty. The action commits nothing and succeeds, so a retry of a finished
preparation is safe, as long as the version has not been tagged in between: once the release is out,
preparing its version again is refused.

## The date

The changelogger action writes the date exactly as it is given: `today` would land in the changelog
as the word, and an empty value as an empty date. The action resolves both to today's date, in UTC,
before the changelog step runs, and that is the date the `date` output reports.

## Committing

The job needs `contents: write`:

```yaml
jobs:
  prepare:
    permissions:
      contents: write
```

The commit is created through the GitHub API with `token`, not pushed with git. The action lists
the changes with git (`git add --all`, then `git diff --cached --raw`), uploads each changed file
as a blob, builds a tree on the checkout's own tree, creates a commit whose parent is the
checkout's own head, and points `branch` at it. Nothing is pushed, so the checkout can use
`persist-credentials: false`, and no token reaches git or the log. GitHub signs commits created
this way, so they show as verified.

The ref update is not forced. If the branch moved after the checkout, GitHub refuses the update
as it would refuse a push, the job fails saying so, and the files of the checkout are never
written over newer ones.

The checkout itself is left as it was: its HEAD stays on the commit it had, with the prepared
files in the working tree. A later step that reads the branch with git sees the commit before the
preparation; the `commit` output holds the new one.

The commit goes to the repository the workflow runs in (`GITHUB_REPOSITORY`). Only regular files
are uploaded; a changed symlink or submodule fails the step, naming the path.

The checkout has to be on `branch` itself, and the action checks that before changing anything.
Committing from another branch would carry that branch's commits into the release whenever the
release branch is an ancestor of it — for instance a run started from `main` whose checkout was
given no `ref`. A detached checkout is refused for the same reason.

Pass a PAT or app token as `token` when a ruleset on the release branches blocks `github.token`,
or when a workflow in the repository has to run on the commit. GitHub creates no workflow run for
a commit made with `GITHUB_TOKEN`.

## How it runs

Two [actions/github-script](https://github.com/actions/github-script) steps run `release-prep.js`,
with the changelogger action between them. The first validates the inputs, the `.puprc` and the
changelogger strategy, then runs pup. The second commits through the API. github-script supplies
the Node runtime, `exec` and the `github` client, built from `token`; there is no dependency
to install and no bundle to build.

The script is loaded by path rather than inlined in the manifest because github-script's `require`
resolves against the workspace of the repository being built, not this action's directory. The
path comes from `${{ github.action_path }}`.

Inputs reach the script through `process.env`, never by being interpolated into it, so a version
or a branch name is data and cannot become part of the program. The commands run with their
arguments as a list, without a shell.

`tests/actions/release-prep/release-prep.test.js` covers the rules above. The pup steps run
against a stand-in for `exec`; the commit step runs real git against a local checkout to list the
changes, and sends the commit to an Octokit whose network is a stand-in that records every
request. Run `npm install` once, then `node --test`.
