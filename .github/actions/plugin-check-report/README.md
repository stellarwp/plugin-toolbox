# plugin-check-report

Compares a [WordPress.org Plugin Check](https://github.com/WordPress/plugin-check) results file with
a baseline: the number of errors and warnings per rule, kept in a file the repository commits,
`.plugin-check-baseline.json`. It writes a short body for the pull request comment, and a new
baseline to copy into the repository.

Most repositories do not use this action directly. They call the reusable workflow
[`.github/workflows/plugin-check.yml`](../../workflows/plugin-check.yml), which builds the plugin,
runs [wordpress/plugin-check-action](https://github.com/WordPress/plugin-check-action), runs this
action and posts the comment. A caller to copy is in
[`templates/workflows/plugin-check.yml`](../../../templates/workflows/plugin-check.yml):

```yaml
jobs:
  plugin-check:
    permissions:
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
- Nothing for pup itself. The workflow downloads it in the shared [zip-name](../zip-name/) and [release-zip](../release-zip/) actions, so the
  repository needs no copy of `pup.phar` and no `pup` Composer script. Set the `pup-version` input
  to the release the repository's own release build uses, so the check sees the same files.
- Ignore rules that keep dev-only files out of the zip: a `.distignore`, `export-ignore` lines in
  `.gitattributes` (pup reads both), or pup's default ignore list.
- A baseline file, `.plugin-check-baseline.json` at the root. Without it the check still works, but
  slower: see [The baseline](#the-baseline). Keep it out of the zip: Plugin Check flags hidden files,
  and pup's default ignore list already drops them.

The JavaScript toolchain comes from files the repository already has: `.nvmrc` sets up Node,
`package-lock.json` turns on the npm cache, and `bun.lock` or `bun.lockb` sets up bun.

## How the plugin is built

By default, with pup, the same QA build the release zip makes, from the root of the checkout (the
`source/` folder of the job). Two shared actions do it: [zip-name](../zip-name/) reads the version
and names the zip (`production: no`, `prerelease: dev`), and [release-zip](../release-zip/) runs
`pup build` and `pup package <version>` with `check: no` and `i18n: no`, since this workflow needs
neither. The workflow then unpacks the zip into `$PLUGIN_CHECK_BUILD_DIR`.

One pup release (the `pup-version` input) reads the version, builds, packages and names the zip, so
the name looked for is always the name the package step made.

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

The baseline is `.plugin-check-baseline.json`, a file the repository commits:

```json
{
  "errors": {
    "WordPress.Security.EscapeOutput.OutputNotEscaped": 12
  },
  "warnings": {
    "WordPress.DB.DirectDatabaseQuery.DirectQuery": 3
  }
}
```

It holds a count for each rule code, and no file names or line numbers, so it only changes when a
rule gains or loses an error somewhere, not when code moves. Only a rule with more errors than the
file allows fails the check.

A pull request is compared with the file in its own checkout, the pull request merged into its
target. So a pull request that fixes errors lowers the file in the same diff, and one that adds an
error on purpose raises it in the same diff, where a reviewer sees it. The comment says "This pull
request changes the baseline file" when it does. The tradeoff: a pull request can raise a count to
hide a new error. The change is in the diff, in a file with an obvious name. To require a reviewer
for it, add a line such as `/.plugin-check-baseline.json @my-org/leads` to CODEOWNERS.

A push is compared with the file at that commit, so a merge that adds errors fails on the target
branch, where the whole team sees it.

### Making and updating the file

Every run uploads the `plugin-check-report` artifact, with a `baseline.json` made from that run's
results. To start the file, or to lower it after errors were fixed, download that artifact and copy
the file. The job summary shows the command with the run number filled in:

```bash
gh run download <run-id> --repo my-org/my-plugin --name plugin-check-report --dir /tmp/plugin-check
cp /tmp/plugin-check/baseline.json .plugin-check-baseline.json
```

Or locally, from the plugin's root, with the results of a local Plugin Check run:

```bash
node .github/actions/plugin-check-report/plugin-check-report.js update results.txt
```

The workflow never commits the file itself. That would need a write token on every pull request,
could not push to a fork, and would change the baseline without the person who owns the change.

When error counts go down and the file is not updated, the check passes with a notice and the
comment asks for the update. Slack in the file lets a later pull request add errors back, so it is
worth lowering the file when errors are fixed. If two pull requests change the same count, git
reports a conflict in the file: merge the target branch, then make the file again from the new run
instead of merging the numbers by hand.

### With no baseline file

The check is slower, not weaker:

- **A pull request** (in `baseline` mode) builds and checks the target branch's commit too, in a
  second job that runs in parallel with the first, and compares with those results. The comment's
  column is then "Target branch", and a line says there is no baseline file. If the target branch
  cannot be built or checked, the check fails with a message that says so: it never passes without a
  baseline. The cost is a second build and Plugin Check run, so the job minutes double, though the
  wait does not.
- **A push** has no target to compare with. The counts are reported and the check passes with a
  warning that says how to start the file.
- **`strict` mode** needs no baseline, so it builds nothing extra and says nothing.

Commit the file to stop the second build.

### A file that is not valid

A file that is not JSON (a merge conflict left markers in it, say) or not the shape above fails the
check with an error annotation that names the file and says what is wrong. The comment then says
Plugin Check could not run. Replace it with the `baseline.json` of the run's artifact.

Two more cases fail the compare, because a comment would show a number that is not the file's:

- A count that is not a whole number, such as `1.5`, fails with exit status 1. A count written as
  `1.0` or `1e2` is read as the whole number it is.
- A count above 9007199254740991 (2^53 - 1) fails with exit status 5 and says so, because
  JavaScript cannot hold a larger number exactly.

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

One line under the table says where the baseline came from when that matters: that the baseline is
the target branch's results because there is no baseline file, or that the pull request changes the
baseline file. When an error count went down, the "Rules that went down" line asks for the file to be
updated. The commands are in the job summary, not in the comment.

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
| `pup-version` | `2.0.0` | The pup release that builds the plugin, or `latest`. Use the release the repository's release build uses |
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
  contents: read        # check out the repository, and read the baseline file
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
| `baseline-file` | no | `.plugin-check-baseline.json` | The committed baseline. A relative path is read from the working directory |
| `base-results` | no | none | Results of the target branch, used as the baseline when there is no baseline file. Not used in `strict` mode |
| `base-required` | no | `false` | `true` when the caller checked the target branch: a missing `base-results` file then fails the compare |
| `baseline-changed` | no | `false` | `true` when the pull request changes the baseline file; the comment says so |

| Output | What it is |
|---|---|
| `artifact-url` | The `plugin-check-report` artifact of this run |

## Running it locally

You need Node 20 or newer. For a pull request's baseline, check out its branch: the file is in it.

1. Build the plugin and run Plugin Check in a local WordPress, for example with wp-env. The excluded
   checks come from the same `.plugin-check.json` as in CI:

   ```bash
   npx wp-env start
   npx wp-env run cli wp plugin check my-plugin --format=json \
     $(node .github/actions/plugin-check-report/plugin-check-report.js exclude-checks) > results.txt
   ```

   Keep only the command's output in the file. A notice from wp-env at the top fails the compare
   with "not Plugin Check output", on purpose.

2. Compare, from the plugin's root, where `.plugin-check-baseline.json` is:

   ```bash
   node .github/actions/plugin-check-report/plugin-check-report.js compare --comment-file comment.md results.txt
   ```

   Exit 0 means the check passes. `comment.md` holds what the pull request would show. Add
   `PLUGIN_CHECK_MODE=strict` to see the strict result, or `PLUGIN_CHECK_BASELINE=path` to use
   another file. With no baseline file, the counts are shown and nothing is compared.

3. To make or update the file from these results:

   ```bash
   node .github/actions/plugin-check-report/plugin-check-report.js update results.txt
   ```

   `update` is short for `compare --update`. It writes `.plugin-check-baseline.json` in the current
   folder, with the same text as the `baseline.json` of the CI artifact.

## How it is tested

The work is in `plugin-check-report.js`: small functions that take plain values, so a test calls
them directly. `tests/actions/plugin-check-report/` has four files, run with `node --test`:

- `compare.test.js` runs the compare in-process on the sample results files in `fixtures/`, and
  checks the comment, the job summary and the annotations against the exact files in
  `fixtures/expected/`, listed in `expected-output.js`. It also covers the missing file, the target
  branch as a baseline, the invalid file and the command line.
- `action.test.js` calls the step functions the way `actions/github-script` does.
- `badge.test.js` checks the badge URL against what the real `date` command prints, for both sides
  of both daylight saving changes, midnight, noon and the end of a year. It also covers the "could
  not run" body.
- `exclude.test.js` covers the config file and the input, every way the file can be wrong, and the
  command line.
