# plugin-check-report

Compares a [WordPress.org Plugin Check](https://github.com/WordPress/plugin-check) results file with
a baseline: the counts of an earlier run of the same workflow. It saves this run's counts as the
next baseline and writes a short body for the pull request comment.

Most repositories do not use this action directly. They call the reusable workflow
[`.github/workflows/plugin-check.yml`](../../workflows/plugin-check.yml), which builds the plugin,
runs [wordpress/plugin-check-action](https://github.com/WordPress/plugin-check-action), runs this
action and posts the comment. A caller to copy is in
[`templates/workflows/plugin-check.yml`](../../../templates/workflows/plugin-check.yml):

```yaml
jobs:
  plugin-check:
    permissions:
      actions: read
      contents: read
      issues: write
      pull-requests: write
    uses: stellarwp/plugin-toolbox/.github/workflows/plugin-check.yml@main
    with:
      plugin-slug: my-plugin
```

## What the repository needs

- A `.puprc` whose `build` makes the plugin as it ships, and whose `zip_name` equals `plugin-slug`.
  The zip's top folder is named after `zip_name`, and Plugin Check takes the slug from the folder
  name.
- A `pup` Composer script that downloads `pup.phar` when it is missing and then runs it, so one
  `composer pup` both installs and runs pup. Kadence Blocks has:

  ```json
  "pup": [
    "test -f ./bin/pup.phar || curl -o bin/pup.phar -L -C - https://github.com/stellarwp/pup/releases/download/2.0.0/pup.phar",
    "@php bin/pup.phar"
  ]
  ```

  The script is what matters, but the path is not free yet: the workflow also runs
  `php bin/pup.phar` itself, to ask pup for the version and the zip name, so keep the phar at
  `bin/pup.phar`.

- Ignore rules that keep dev-only files out of the zip: a `.distignore`, `export-ignore` lines in
  `.gitattributes` (pup reads both), or pup's default ignore list.
- The caller file named `plugin-check.yml`. See [The baseline](#the-baseline).

The JavaScript toolchain comes from files the repository already has: `.nvmrc` sets up Node,
`package-lock.json` turns on the npm cache, and `bun.lock` or `bun.lockb` sets up bun.

## How the plugin is built

By default, with pup, the same steps the release zip uses, from the root of the checkout:

```bash
composer run -q pup > /dev/null   # downloads bin/pup.phar
composer -- pup build
version=$(php -d display_errors=0 bin/pup.phar get-version --dev)
composer -- pup package "$version"
name=$(php -d display_errors=0 bin/pup.phar zip-name "$version")
unzip -q "$name.zip" -d "$PLUGIN_CHECK_BUILD_DIR"
```

So `.puprc` and the ignore files decide what is checked. If the release needs a step the check should
see too, such as making the POT file, put it in `.puprc`'s `build`, not in the workflow.

### `build-command`, for a repository without pup

`build-command` replaces the pup steps. Prefer `.puprc` when the repository has one: a custom
command is a second place that defines the build, and the two drift apart.

The contract:

- It runs with bash, from the root of the checkout, with `-e` and `pipefail`.
- PHP, Node or bun are set up before it, as for pup. The `composer-token` and `package-token`
  secrets are in its environment.
- It must leave the plugin, as it ships, in `$PLUGIN_CHECK_BUILD_DIR/<plugin-slug>/`, with the main
  plugin file inside: `<plugin-slug>.php`, or `main-file` when the name differs.

After the build, pup or not, the workflow checks that `$PLUGIN_CHECK_BUILD_DIR/<plugin-slug>/<main-file>`
exists, and fails naming what it found instead. A folder, not a zip, because the Plugin Check action
takes a folder and its slug from the folder name; asking for a zip would only add an unzip and a
guess at the top folder.

```yaml
    with:
      plugin-slug: my-plugin
      build-command: |
        composer install --no-dev
        npm ci && npm run build
        mkdir -p "$PLUGIN_CHECK_BUILD_DIR/my-plugin"
        rsync -a --exclude-from=.distignore ./ "$PLUGIN_CHECK_BUILD_DIR/my-plugin/"
```

## The baseline

The baseline is never a committed file. It is the `baseline.json` in the `plugin-check-report`
artifact of an earlier run of the same workflow file:

- A pull request compares with the run for its base commit. For a stacked pull request that is
  the run of the pull request below it. A run still going is waited for, up to 20 minutes.
- If that run has no baseline (it was cancelled, say), the newest run on the target branch is used.
  More errors than that older run only warn, because the target may have changed since.
- A push compares with the run before it on the same branch.
- With no earlier run at all, nothing is compared and the check passes with a warning. A failed
  lookup (an API or download error) fails instead, so an outage never passes as "no baseline".

Only runs of the repository's own branches count. A pull request from a fork has a run of the same
workflow, and the runs list matches it by branch name and commit, so a fork's run on a branch called
`develop` would look like a run of `develop`. Its artifact is whatever the fork's workflow uploaded,
so runs whose head commit is in another repository are skipped.

The earlier runs are found by the caller's workflow file name, read from `GITHUB_WORKFLOW_REF`.
Renaming the caller file starts again with no baseline. Artifacts expire after the repository's
retention period (90 days by default), so a branch with no run for that long starts with none too.

For a pull request to have a baseline, the branch it targets needs runs: list it under `push` in
the caller.

## Modes

- `baseline` (default): fail only when a rule has more errors than the baseline. More warnings, or
  fewer of either, only add a notice. The totals can go down while one rule goes up, so the check
  looks at each rule.
- `strict`: fail on any error. The comment still compares with the baseline. Switch to it once a
  plugin reaches zero errors; a new plugin with zero errors should start there.

## Excluding checks

Some Plugin Check checks do not fit a plugin. Name them in a `.plugin-check.json` at the root of
the repository:

```json
{
  "exclude-checks": ["late_escaping", "i18n_usage"]
}
```

One check name per entry, with no spaces or commas. Other keys are ignored, so the file can hold
more settings later. A missing file, a missing key or an empty list excludes nothing. A file that is
not valid JSON, or whose entries are not check names, fails the run in seconds, before the build starts,
with a message that says what to fix.

The workflow's `exclude-checks` input does the same, one check per line. **When the input names any
check, it replaces the file** (the file is not even read). When it is empty, the file is used.

The same list is available for a local run. This prints the flag `wp plugin check` takes, or
nothing when no check is excluded:

```bash
node .github/actions/plugin-check-report/plugin-check-report.js exclude-checks
# --exclude-checks=late_escaping,i18n_usage

npx wp-env run cli wp plugin check my-plugin --format=json \
  $(node .github/actions/plugin-check-report/plugin-check-report.js exclude-checks) > results.txt
```

It reads `.plugin-check.json` in the current folder, or the file named after it. The environment
variable `EXCLUDE_CHECKS` plays the part of the workflow input.

## The comment

One comment per pull request, replaced on every run, found by a hidden first line:
`<!-- plugin-check:<owner>/<repo> -->`. It says "in progress" while the check runs, then shows the
result, the totals, up to five rules that went up, and links to the run and the artifact. It never
grows past 15 lines. Pull requests from forks get no comment: their token cannot write.

The workflow writes it with the [pr-comment](../pr-comment/) action. The comment is found by its
first line, not by its author.

The action builds the body. Under the status line it puts a "Check Finished" badge with the time in
Eastern Time (`06:08 PM EDT` in summer, `EST` in winter), made by `finishBadge()` in
`plugin-check-report.js`, so no caller passes one. When the build or the check broke and there was
nothing to compare, the action writes a short body instead, "Plugin Check could not run" with the
same badge and a link to the run, so "in progress" never stays on the pull request. A body the
compare wrote is never replaced.

## The check name

A job in a called workflow reports as `<caller job id> / <job name>`. With the template's job id,
the check to require in branch protection is `plugin-check / Plugin Check`.

## Inputs of the workflow

| Input | Default | What it does |
|---|---|---|
| `plugin-slug` | required | The plugin's folder name. Equals `zip_name` in `.puprc` |
| `main-file` | `<plugin-slug>.php` | The main plugin file, checked after the build |
| `build-command` | empty: pup | A bash command that builds the plugin instead of pup. See [`build-command`](#build-command-for-a-repository-without-pup) |
| `runs-on` | `ubuntu-latest` | Runner of the job that builds and checks, of runner version 2.336.0 or newer (the job uses `$/`) |
| `php-version` | `7.4` | PHP that builds `vendor/`. Use the oldest the plugin supports |
| `exclude-checks` | empty | Checks to skip, one per line. Replaces `.plugin-check.json` when it names any. See [Excluding checks](#excluding-checks) |
| `cache-paths` | empty | Build caches kept between runs, one path per line, relative to the repository |
| `mode` | `baseline` | `baseline` or `strict`. See [Modes](#modes) |
| `submodules` | `false` | Passed to `actions/checkout` |

| Secret | Becomes, in the build step only |
|---|---|
| `composer-token` | `COMPOSER_AUTH` with a `github-oauth` entry |
| `package-token` | `NODE_AUTH_TOKEN`, `BUN_AUTH_TOKEN` and `GITHUB_TOKEN` |

The secrets never reach the job's environment, so the third-party Plugin Check step that runs later
in the same job does not see them there.

### Permissions the caller grants

```yaml
permissions:
  actions: read         # read earlier runs and download their baseline
  contents: read        # check out the repository
  issues: write         # the sticky comment
  pull-requests: write  # the sticky comment
```

A called workflow can only lower these. If the caller grants less than a job asks for, GitHub does
not start the run. The job that runs the Plugin Check action lowers itself to `contents: read`.

## Inputs of the action

| Input | Required | Default | What it does |
|---|---|---|---|
| `results` | yes | | The results file. A missing file fails the compare |
| `comment-file` | no | none | Where to write the comment body |
| `mode` | no | `baseline` | `baseline` or `strict` |
| `comment-marker` | no | `<!-- plugin-check:<owner>/<repo> -->` | First line of the comment body |
| `baseline-wait` | no | `1200` | Seconds to wait for the base commit's run. A whole number, or the check fails |
| `token` | no | `github.token` | Needs `actions: read` |

| Output | What it is |
|---|---|
| `artifact-url` | The `plugin-check-report` artifact of this run |
| `baseline-url` | The run the baseline came from. Empty with no baseline |

## Running it locally

You need Node 20 or newer, and for the baseline the GitHub CLI signed in (`gh auth login`). Run
`npm install` once in the toolbox checkout, which installs the GitHub client the lookup uses. The
`compare` and `fetch` commands take the same arguments and environment variables as the two bash
scripts did.

1. Build the plugin and run Plugin Check in a local WordPress, for example with wp-env:

   ```bash
   npx wp-env start
   npx wp-env run cli wp plugin check my-plugin --format=json > results.txt
   ```

   Keep only the command's output in the file. A notice from wp-env at the top fails the compare
   with "not Plugin Check output", on purpose.

2. Get a baseline from the branch you compare with:

   ```bash
   GITHUB_REPOSITORY=my-org/my-plugin \
     node .github/actions/plugin-check-report/plugin-check-report.js fetch develop baseline.json
   ```

   The token comes from `GITHUB_TOKEN`, else `GH_TOKEN`, else `gh auth token`. The exit status is 0
   when a baseline was written, 1 when no run has one, and 2 when the lookup itself failed.

3. Compare:

   ```bash
   PLUGIN_CHECK_BASELINE=baseline.json \
     node .github/actions/plugin-check-report/plugin-check-report.js compare --comment-file comment.md results.txt
   ```

   Exit 0 means the check passes. `comment.md` holds what the pull request would show. Add
   `PLUGIN_CHECK_MODE=strict` to see the strict result. Skip step 2 to see the counts with no
   baseline. `compare --update results.txt` writes the baseline for a results file instead.

## Differences from the earlier bash scripts

The first version of this action was two bash scripts. The JavaScript that replaced them gives the
same results on every input Plugin Check can produce. These differences are on purpose, and only
show with a hand-edited baseline or an odd results file, except the first two:

- The mode `ratchet` is now called `baseline`. The old word is refused, and the message says what
  to use.
- The `workflow-file` input is gone. The runs that hold the baseline are the calling workflow's,
  which the run itself knows.
- The `badge-url` input is gone. The action makes the "Check Finished" badge itself, and also writes
  the "could not run" body that a shell step in the workflow wrote before. Both look as they did.
- A rule with an empty code is counted like any other. Bash misread its row and showed wrong totals.
- A count in the baseline that is not a whole number (such as `1.5`) fails the compare with exit
  status 1. Bash printed an arithmetic error and passed with zero totals. A count written as `1.0`
  or `1e2` is read as the whole number it is.

- A baseline count above 9007199254740991 (2^53 - 1) fails the compare with exit status 5 and says
  so. JavaScript cannot hold a larger number exactly, so a comment would show another number. Bash
  compared them exactly.

## How it is tested

The work is in `plugin-check-report.js`: small functions that take plain values, so a test calls
them directly. `tests/actions/plugin-check-report/` has five files, run with `node --test`:

- `compare.test.js` runs the compare in-process on the sample results files in `fixtures/`, and
  checks the comment, the job summary and the annotations against the exact files in
  `fixtures/expected/`. Those files were written by the original bash script, so they pin that the
  JavaScript prints what it printed.
- `fetch.test.js` runs the lookup against a real GitHub client with the network replaced by written
  answers, a fake clock for the wait, and a stand-in for the `gh` download.
- `action.test.js` calls the step functions the way `actions/github-script` does.
- `badge.test.js` checks the badge URL against what the old shell step printed, from the real
  `date` command, for both sides of both daylight saving changes, midnight, noon and the end of a
  year. It also covers the "could not run" body.
- `exclude.test.js` covers the config file and the input, every way the file can be wrong, and the
  command line.

No `jq` or `bash` is needed.
