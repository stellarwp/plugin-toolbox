# release-prep

Prepares a release branch. It bumps the version, replaces the `@since TBD` placeholders and writes the
changelog, then commits that and pushes it to the branch:

```yaml
- uses: actions/checkout@v6
  with:
    ref: ${{ inputs.ref }}
    persist-credentials: false

- uses: stellarwp/plugin-toolbox/.github/actions/release-prep@v1
  with:
    ref: ${{ inputs.ref }}
    version: ${{ inputs.version }}
```

It opens no pull request. The commit lands on the release branch itself, and is reviewed wherever the
release is reviewed, typically the pull request from the release branch to the main branch.

[`templates/workflows/release-prep.yml`](../../../templates/workflows/release-prep.yml) is a complete
workflow around it, ready to copy into a plugin repository.

## What it changes

Three tools do the work, in this order, from the root of the checkout:

1. `pup replace-version <version>` rewrites the version in every file the `.puprc` lists under
   `paths.versions`.
2. `pup replace-tbd <version>` replaces the TBD placeholders (`@since TBD`, `@deprecated TBD`,
   `_deprecated_function( __METHOD__, 'TBD' )` and the like) in the directories the `.puprc` lists under
   `checks.tbd.dirs`.
3. The [changelogger action](https://github.com/stellarwp/changelogger) writes the pending entries in
   `changelog/` into the changelog files and deletes them, with the version and the date.

Then everything the working tree changed is committed as `Prepare <ref> (<version>)` by
`github-actions[bot]` and pushed to `ref`. Everything means everything, so run the action on a clean
checkout, and put any step that writes tracked files after it.

pup is downloaded from its GitHub release, pinned by `pup-version`, into the runner's temp directory,
so it never ends up in the commit. It runs on the runner's PHP.

## What the repository needs

A `.puprc` that lists the version files, and the directories that hold the TBD placeholders:

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

The action checks the first before running anything, because pup does not: a missing `.puprc`, one that
is not JSON, and one with no `paths.versions` all make pup change nothing and exit 0, and the branch
would be pushed with the old version. Each of them fails the job here with the branch untouched.

Two gaps are warnings rather than failures, since the job can still do something useful:

- No `checks.tbd.dirs`: pup falls back to its default and replaces TBDs under `src/` only.
- No `changelogger` section: the changelogger falls back to its defaults and writes a keepachangelog
  `changelog.md` with semver versioning.

A writing strategy given as a `.js` file is loaded from the checkout, so it has to be there before the
action runs. One written in TypeScript has to be built in an earlier step.

## Versions it refuses

The version has to be three or four numeric parts, such as `4.17.0` or `4.17.0.1`. That is what the
changelogger's `stellarwp` versioning accepts, so a version the changelog step would fail on is refused
before pup has touched anything.

- **An empty version is refused.** A tool that dispatches the workflow for a release with no version set
  sends an empty one. When the workflow declares `version` as required, as the template does, GitHub
  refuses that dispatch itself with HTTP 422 ("Required input 'version' not provided") and no run starts.
  When a workflow declares it optional, the run starts and the action fails it with "No version was
  given". Either way the release needs a version before the step is run again.
- **A pre-release is refused.** `4.17.0-beta.1` is rejected by the `stellarwp` versioning, so the action
  cannot prepare one, even though it is a valid tag name.

- **A version lower than the branch's is refused.** pup reads the version the branch already has
  (`pup get-version`, the first file in `paths.versions`), and preparing `4.17.0` on a branch at
  `4.18.0` fails: it would bump the plugin backwards, so either the version or the branch is wrong. The
  same version is accepted, since that is what re-running a preparation finds. When the version files
  hold something that isn't a numeric version, such as `dev`, the job only warns; when pup can't find a
  version at all, it fails, as `replace-version` would.

Each refusal happens before anything is changed, as does a `date` that is not `YYYY-MM-DD`, a `ref`
that is not a valid branch name, and a checkout that is not on `ref`.

## Inputs

| Input | Required | Default | What it does |
|---|---|---|---|
| `ref` | yes | | The release branch to push to, e.g. `release/4.17.0`. A branch name, not `refs/heads/…`. The checkout has to be on it; see [Pushing](#pushing) |
| `version` | yes | | The version to prepare, e.g. `4.17.0`. See [Versions it refuses](#versions-it-refuses) |
| `date` | no | today, in UTC | The changelog date as `YYYY-MM-DD`. Empty or `today` writes today |
| `token` | no | `github.token` | The token the commit is pushed with. See [Pushing](#pushing) |
| `pup-version` | no | `2.0.0` | The pup release to run. It needs `replace-version` and `replace-tbd`, which came with 2.0.0 |

## Outputs

| Output | Example | What it is |
|---|---|---|
| `version` | `4.17.0` | The version prepared |
| `date` | `2026-10-08` | The date written in the changelog |
| `commit` | `3f2a…` | The commit pushed to the branch. Empty when nothing changed |
| `files` | `my-plugin.php` | The files the commit changed, one per line. Empty when nothing changed |

## Running it again

Preparing a version the branch already holds changes nothing: the versions match, no TBDs are left and
`changelog/` is empty. The action then commits and pushes nothing, and succeeds, so a retry of a
finished preparation is harmless.

## The date

The changelogger action writes the date exactly as it is given. `today` would land in the changelog as
the word, and an empty value as an empty date. So the action resolves both to today's date, in UTC,
before the changelog step runs, and that is the date the `date` output reports.

## Pushing

The job needs `contents: write`:

```yaml
jobs:
  prepare:
    permissions:
      contents: write
```

The action pushes with `token` itself, to `HEAD:refs/heads/<ref>`, so the checkout can and should use
`persist-credentials: false`. The token reaches git through the environment of that one push, never
on its command line, which the log echoes, and never in `.git/config`, where a later step could read it.
It is masked in the log, together with the encoded credential built from it.

A checkout that keeps its credentials does not get in the way. actions/checkout stores its token under
the same `http.<server>/.extraheader` key, and git sends every value of that key, so the push would
carry two Authorization headers and GitHub would refuse it. The action clears that key for its push
before adding its own header, so only `token` is sent.

The push is a fast-forward. If the branch moved after the checkout, the push is refused and the job
fails with git's output, rather than overwriting what landed.

The checkout has to be on `ref` itself, and the action checks that before it changes anything. Pushing
from another branch would also be a fast-forward whenever the release branch is an ancestor of it,
for instance a run started from `main` whose checkout was given no `ref`, and the release would pick
up every commit of that branch. A detached checkout, of a tag or a commit, is refused for the same
reason.

Pass a PAT or app token as `token` when a ruleset on the release branches blocks `github.token`, or when
a workflow in the repository has to run on the push. GitHub creates no workflow run for a push made
with `GITHUB_TOKEN`.

## How it runs

Two [actions/github-script](https://github.com/actions/github-script) steps run `release-prep.js`, with
the changelogger action between them. The first validates the inputs and the `.puprc`, then runs pup.
The second commits and pushes. github-script supplies the Node runtime and `exec`, so there is no
dependency to install and no bundle to build: the file in the repository is the file that runs.

The script is loaded by path rather than inlined in the manifest, because github-script's `require`
resolves against the workspace of the repository being built, not this action's directory. The path
comes from `${{ github.action_path }}`.

Inputs reach the script through `process.env`, never by being interpolated into it, so a version or a
branch name is data and cannot become part of the program. The commands run with their arguments as a
list, without a shell.

`tests/actions/release-prep/release-prep.test.js` covers the rules above. The pup steps run against a
stand-in for `exec`; the commit and push run real git against a local repository. Run `npm install`
once, then `node --test`.
