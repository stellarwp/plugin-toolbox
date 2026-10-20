# release-prep

Prepares a release branch: bumps the version, replaces the `@since TBD` placeholders, writes the
changelog, then commits and pushes the result to the branch:

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

Everything the working tree changed is then committed as `Prepare <branch> (<version>)` by
`github-actions[bot]` and pushed to `branch`. Run the action on a clean checkout, and put any step
that writes tracked files after it: the commit includes every change in the working tree.

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

Two gaps only produce a warning; the run continues:

- No `checks.tbd.dirs`: pup falls back to its default and replaces TBDs under `src/` only.
- No `changelogger` section: the changelogger uses its defaults — a keepachangelog `changelog.md`
  with semver versioning.

A writing strategy given as a `.js` file is loaded from the checkout; it has to be there before the
action runs. One written in TypeScript has to be built in an earlier step.

## Versions it refuses

The version has to be three or four numeric parts, such as `4.17.0` or `4.17.0.1`. That is the shape
the changelogger's default `stellarwp` versioning accepts. A repository with a custom changelogger
version strategy may accept other shapes, but this action still takes three or four numeric parts.
The changelog step would fail on anything else, so the action refuses it before pup has touched
anything.

- **An empty version is refused.** A tool that dispatches the workflow for a release with no version
  set sends an empty one. When the workflow declares `version` as required, as the template does,
  GitHub refuses the dispatch itself with HTTP 422 and no run starts. When the workflow declares it
  optional, the run starts and the action fails it with "No version was given". Either way the
  release needs a version before the step runs again.
- **A pre-release is refused.** `4.17.0-beta.1` is rejected by the `stellarwp` versioning, so the
  action cannot prepare one, even though it is a valid tag name. A custom version strategy that
  accepts pre-releases does not change this.
- **A version lower than the branch's is refused.** pup reads the version the branch already has
  (`pup get-version`, the first file in `paths.versions`), and preparing `4.17.0` on a branch at
  `4.18.0` would bump the plugin backwards: either the version or the branch is wrong. The same
  version is accepted; that is what re-running a preparation finds. When the version files hold
  something that is not a numeric version, such as `dev`, the job only warns. When pup cannot find a
  version at all, it fails, as `replace-version` would.

Each refusal happens before anything is changed. So do a `date` that is not `YYYY-MM-DD`, a `branch`
that is not a valid branch name, and a checkout that is not on `branch`.

## Inputs

| Input | Required | Default | What it does |
|---|---|---|---|
| `branch` | yes | | The release branch to push to, e.g. `release/M26.jigglypuff`. A branch name, not `refs/heads/…`. The checkout has to be on it; see [Pushing](#pushing) |
| `version` | yes | | The version to prepare, e.g. `4.17.0`. See [Versions it refuses](#versions-it-refuses) |
| `date` | no | today, in UTC | The changelog date as `YYYY-MM-DD`. Empty or `today` writes today |
| `token` | no | `github.token` | The token the commit is pushed with. See [Pushing](#pushing) |
| `pup-version` | no | `latest` | The pup release to run: a number such as `2.0.0`, or `latest` for the newest. See [Which pup runs](#which-pup-runs) |

## Outputs

| Output | Example | What it is |
|---|---|---|
| `version` | `4.17.0` | The version prepared |
| `date` | `2026-10-08` | The date written in the changelog |
| `commit` | `3f2a…` | The commit pushed to the branch. Empty when nothing changed |
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
release's page. The TypeScript line of pup publishes no phar and is meant to run through its own
GitHub Action. The manifest cannot carry that call behind a condition: a composite action's
`uses:` references resolve when the job is set up, not when the step runs, so a conditional
reference to an action that does not exist yet would break every run. When the TypeScript line
publishes its action, the call is wired in as the changelogger's is — one `uses:` step per pup
command, `command:` as the input:

```yaml
- uses: stellarwp/pup@v3
  with:
    command: replace-version --version=4.17.0
```

`uses:` takes a static ref, so `@v3` always resolves to the newest v3.x release of pup. The
branch-version check — the refusal of a version lower than the branch already has — runs on the
phar path only; the TS contract does not define it yet.

## Running it again

Preparing a version the branch already holds changes nothing: the versions match, no TBDs are left
and `changelog/` is empty. The action commits and pushes nothing and succeeds, so a retry of a
finished preparation is safe.

## The date

The changelogger action writes the date exactly as it is given: `today` would land in the changelog
as the word, and an empty value as an empty date. The action resolves both to today's date, in UTC,
before the changelog step runs, and that is the date the `date` output reports.

## Pushing

The job needs `contents: write`:

```yaml
jobs:
  prepare:
    permissions:
      contents: write
```

The action pushes with `token` itself, to `HEAD:refs/heads/<branch>`, so the checkout can use
`persist-credentials: false`. The token reaches git through the environment of that one push —
never on its command line, which the log would echo, and never in `.git/config`, where a later
step could read it. The token and the base64 credential built from it are masked in the log.

When the checkout keeps its own credentials, git would send two Authorization headers — its own
and the action's — and GitHub refuses the push with a 400. The action clears the
`http.<server>/.extraheader` key before adding its own header, so only `token` is sent.

The push is a fast-forward. If the branch moved after the checkout, the push is refused and the
job fails with git's output.

The checkout has to be on `branch` itself, and the action checks that before changing anything.
Pushing from another branch would also fast-forward whenever the release branch is an ancestor of
it — for instance a run started from `main` whose checkout was given no `ref` — and the release
would pick up every commit of that branch. A detached checkout is refused for the same reason.

Pass a PAT or app token as `token` when a ruleset on the release branches blocks `github.token`,
or when a workflow in the repository has to run on the push. GitHub creates no workflow run for a
push made with `GITHUB_TOKEN`.

## How it runs

Two [actions/github-script](https://github.com/actions/github-script) steps run `release-prep.js`,
with the changelogger action between them. The first validates the inputs and the `.puprc`, then
runs pup. The second commits and pushes. github-script supplies the Node runtime and `exec`; there
is no dependency to install and no bundle to build.

The script is loaded by path rather than inlined in the manifest because github-script's `require`
resolves against the workspace of the repository being built, not this action's directory. The
path comes from `${{ github.action_path }}`.

Inputs reach the script through `process.env`, never by being interpolated into it, so a version
or a branch name is data and cannot become part of the program. The commands run with their
arguments as a list, without a shell.

`tests/actions/release-prep/release-prep.test.js` covers the rules above. The pup steps run
against a stand-in for `exec`; the commit and push run real git against a local repository. Run
`npm install` once, then `node --test`.
