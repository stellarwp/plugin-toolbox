# generate-pot

Generates a plugin's POT file with `wp i18n make-pot`, and says whether its strings changed.

```yaml
- uses: actions/checkout@v6
  with:
    persist-credentials: false

# PHP has to be on the runner: wp-cli runs on it.
- uses: shivammathur/setup-php@v2
  with:
    php-version: '8.2'
    coverage: none

- id: pot
  uses: stellarwp/plugin-toolbox/.github/actions/generate-pot@v1
  with:
    pot-path: lang/my-plugin.pot

- if: steps.pot.outputs.changed == 'yes'
  run: echo "Commit ${{ steps.pot.outputs.pot-path }} and push it to translation here."
```

Build the assets first when the plugin ships compiled JavaScript with strings in it. The action
writes the POT and commits nothing.

## What it runs

```
wp i18n make-pot <source-path> <pot-path> --skip-audit [--domain=…] [--headers=…] [--exclude=…]
```

wp-cli is release 2.12.0, pinned in [`generate-pot.js`](generate-pot.js) with its sha512. The phar
is downloaded into the runner's temp directory, never the checkout, and checked before it runs. A
phar that does not match is deleted and the step fails. A later step of the same job reuses the
download, and checks it again.

## What is left out

Three lists are joined into `--exclude`, each entry once:

- The lines of `.distignore`, when the checkout has one: what the zip leaves out is not translated.
  Empty lines and `#` comments are skipped.
- The path of each git submodule, read from `.gitmodules`. A submodule has its own text domain and
  its own POT, and its strings do not belong in this one.
- The lines of the `exclude` input.

With none of them, make-pot uses its own defaults.

```yaml
- uses: stellarwp/plugin-toolbox/.github/actions/generate-pot@v1
  with:
    pot-path: languages/my-plugin.pot
    domain: my-plugin
    headers: '{"Report-Msgid-Bugs-To": "https://example.com/support", "Last-Translator": "", "Language-Team": ""}'
    exclude: |
      *.js.map
      src/**/*.js
```

## The changed check

make-pot stamps the time (`POT-Creation-Date`), the plugin version (`Project-Id-Version`) and its
own version (`X-Generator`) on every run, so the file differs each time even with the same strings.

| The POT | `changed` | The file |
|---|---|---|
| is not tracked by git: a new POT | `yes` | kept |
| differs from the tracked one in anything else | `yes` | kept |
| differs in those three header lines only, or not at all | `no` | put back with `git checkout` |

A second run therefore leaves nothing to commit. The check needs a git checkout, at any depth.

## Inputs

| Input | Default | |
|---|---|---|
| `pot-path` | required | Where the POT is written, relative to the checkout, e.g. `lang/my-plugin.pot`. |
| `source-path` | `.` | The directory scanned for strings, relative to the checkout. |
| `domain` | | The text domain, passed as `--domain`. Empty leaves it to make-pot. |
| `headers` | | POT headers to set, as a JSON object of strings in a string. Empty sets none. |
| `exclude` | | Extra exclusions, one per line, added to `.distignore` and the submodule paths. |
| `working-directory` | | Where the repository is checked out. Empty is the workspace. |

## Outputs

| Output | |
|---|---|
| `pot-path` | The POT, relative to the checkout, as given. |
| `changed` | `yes` when the POT is new or its strings changed, `no` otherwise. |

## How it runs

The logic is in [`generate-pot.js`](generate-pot.js), run by `actions/github-script`, so there is
no dependency to install and nothing to build. It needs `php`, `curl` and `git` on the runner.

Run its tests locally: `npm install` once in the toolbox, then
`node --test tests/actions/generate-pot/generate-pot.test.js`. They stand in for the download and
for wp-cli, and run the changed check against a real git repository.
