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
    uses: stellarwp/plugin-toolbox/.github/workflows/plugin-check.yml@v1
    with:
      plugin-slug: my-plugin
```

## What the repository needs

- A `.puprc` whose `build` makes the plugin as it ships, and whose `zip_name` equals `plugin-slug`.
  The zip's top folder is named after `zip_name`, and Plugin Check takes the slug from the folder
  name.
- A `pup` Composer script that puts `pup.phar` in `bin/` and runs it, as GiveWP and Kadence Blocks
  have:

  ```json
  "pup": [
    "test -f ./bin/pup.phar || curl -o bin/pup.phar -L -C - https://github.com/stellarwp/pup/releases/download/2.0.0/pup.phar",
    "@php bin/pup.phar"
  ]
  ```

- A `.distignore` (or pup's default ignore list) that keeps dev-only files out of the zip.
- The caller file named `plugin-check.yml`. See [The baseline](#the-baseline).

The JavaScript toolchain comes from files the repository already has: `.nvmrc` sets up Node,
`package-lock.json` turns on the npm cache, and `bun.lock` or `bun.lockb` sets up bun.

## How the plugin is built

By default, with pup, the same steps the release zip uses, from the root of the checkout:

```bash
composer run -q pup -- --version > /dev/null   # downloads bin/pup.phar
composer -- pup build
version=$(php -d display_errors=0 bin/pup.phar get-version --dev)
composer -- pup package "$version"
name=$(php -d display_errors=0 bin/pup.phar zip-name "$version")
unzip -q "$name.zip" -d "$PLUGIN_CHECK_BUILD_DIR"
```

So `.puprc` and `.distignore` decide what is checked. If the release needs a step the check should
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

The earlier runs are found by the caller's workflow file name, read from `GITHUB_WORKFLOW_REF`.
Renaming the caller file starts again with no baseline. Artifacts expire after the repository's
retention period (90 days by default), so a branch with no run for that long starts with none too.

For a pull request to have a baseline, the branch it targets needs runs: list it under `push` in
the caller.

## Modes

- `ratchet` (default): fail only when a rule has more errors than the baseline. More warnings, or
  fewer of either, only add a notice. The totals can go down while one rule goes up, so the check
  looks at each rule.
- `strict`: fail on any error. The comment still compares with the baseline. Switch to it once a
  plugin reaches zero errors; a new plugin with zero errors should start there.

## The comment

One comment per pull request, replaced on every run, found by a hidden first line:
`<!-- plugin-check:<owner>/<repo> -->`. It says "in progress" while the check runs, then shows the
result, the totals, up to five rules that went up, and links to the run and the artifact. It never
grows past 15 lines. Pull requests from forks get no comment: their token cannot write.

## The check name

A job in a called workflow reports as `<caller job id> / <job name>`. With the template's job id,
the check to require in branch protection is `plugin-check / Plugin Check`.

## Inputs of the workflow

| Input | Default | What it does |
|---|---|---|
| `plugin-slug` | required | The plugin's folder name. Equals `zip_name` in `.puprc` |
| `main-file` | `<plugin-slug>.php` | The main plugin file, checked after the build |
| `build-command` | empty: pup | A bash command that builds the plugin instead of pup. See [`build-command`](#build-command-for-a-repository-without-pup) |
| `runs-on` | `ubuntu-latest` | Runner of the job that builds and checks |
| `php-version` | `7.4` | PHP that builds `vendor/`. Use the oldest the plugin supports |
| `exclude-checks` | empty | Checks to skip, one per line, passed to the Plugin Check action |
| `cache-paths` | empty | Build caches kept between runs, one path per line, relative to the repository |
| `mode` | `ratchet` | `ratchet` or `strict`. See [Modes](#modes) |
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
| `mode` | no | `ratchet` | `ratchet` or `strict` |
| `comment-marker` | no | `<!-- plugin-check:<owner>/<repo> -->` | First line of the comment body |
| `workflow-file` | no | from `GITHUB_WORKFLOW_REF` | Whose runs hold the baseline |
| `baseline-wait` | no | `1200` | Seconds to wait for the base commit's run |
| `badge-url` | no | none | Image under the status line |
| `token` | no | `github.token` | Needs `actions: read` |

| Output | What it is |
|---|---|
| `artifact-url` | The `plugin-check-report` artifact of this run |
| `baseline-url` | The run the baseline came from. Empty with no baseline |

## Running it locally

You need `bash`, `jq`, and for the baseline the GitHub CLI signed in (`gh auth login`).

1. Build the plugin and run Plugin Check in a local WordPress, for example with wp-env:

   ```bash
   npx wp-env start
   npx wp-env run cli wp plugin check my-plugin --format=json > results.txt
   ```

   Keep only the command's output in the file. A notice from wp-env at the top fails the ratchet
   with "not Plugin Check output", on purpose.

2. Get a baseline from the branch you compare with:

   ```bash
   GITHUB_REPOSITORY=my-org/my-plugin \
     bash .github/actions/plugin-check-report/fetch-baseline.sh develop baseline.json
   ```

3. Compare:

   ```bash
   PLUGIN_CHECK_BASELINE=baseline.json \
     bash .github/actions/plugin-check-report/ratchet.sh --comment-file comment.md results.txt
   ```

   Exit 0 means the check passes. `comment.md` holds what the pull request would show. Add
   `PLUGIN_CHECK_MODE=strict` to see the strict result. Skip step 2 to see the counts with no
   baseline.

## How it is tested

`tests/actions/plugin-check-report/` runs both scripts with bash from `node --test`. `ratchet.sh`
reads the sample results files in `fixtures/`; `fetch-baseline.sh` talks to a stand-in `gh` that
answers from JSON files and records each call. Run `npm install` once, then `node --test`. They need
`jq`, which GitHub's Ubuntu runners have.
