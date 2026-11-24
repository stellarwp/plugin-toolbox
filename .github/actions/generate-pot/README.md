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

- if: steps.pot.outputs.changed == 'yes'
  run: echo "Commit ${{ steps.pot.outputs.pot-path }} and push it to translation here."
```

Build the assets first when the plugin ships compiled JavaScript with strings in it. The action
writes the POT and commits nothing.

On a runner that reports itself as self-hosted, such as Blacksmith, setup-php installs PHP with apt
from the Launchpad PPA, and the step fails with only `Could not setup PHP` when Launchpad is down.
Set `use_builds_cache: true` in the setup-php step's `env` to download the prebuilt PHP that
GitHub-hosted runners get instead.

## Where the POT goes

Without `pot-path`, the POT goes to `<Domain Path>/<Text Domain>.pot` under `source-path`, read from
the plugin's main file: the first top-level PHP file of `source-path`, in name order, with a
`Plugin Name` header in its first 8 KiB. A `Text Domain` of
`my-plugin` and a `Domain Path` of `/languages/` give `languages/my-plugin.pot`. The `domain`
input stands in for `Text Domain`.

A `Text Domain` read from the header and each part of the `Domain Path` take letters, digits,
dots, dashes and underscores, and do not start with a dash or a dot, so they cannot read as an
option or lead out of the plugin. The step fails before anything runs when there is no such file,
when it has no `Domain Path`, a `Domain Path` of `/`, which names the plugin's root, or one that
breaks that rule, or when `domain` is empty and the `Text Domain` is missing or breaks that rule.
Pass `pot-path` then, or `domain` for the `Text Domain`. `pot-path` overrides the
header, and the `pot-path` output reports the path used either way.

## What it runs

```
wp i18n make-pot <source-path> <pot-path> --skip-audit [--domain=…] [--headers=…] [--exclude=…]
```

A `source-path` or `pot-path` that starts with `-` is passed after `./`, so make-pot does not read it
as an option.

wp-cli is release 2.12.0, pinned in [`generate-pot.js`](generate-pot.js) with its sha512. The phar
is downloaded into the runner's temp directory, never the checkout, and checked before it runs. A
phar that does not match is deleted and the step fails. A later step of the same job reuses the
download, and checks it again.

## What is left out

Four lists are joined into `--exclude`, each entry once:

- The lines of `.distignore`, when the checkout has one: what the zip leaves out is not translated.
  Empty lines and `#` comments are skipped.
- The path of each line of the root `.gitattributes` that sets `export-ignore`, which the zip
  leaves out too. As in git, the last of `export-ignore`, `-export-ignore` and `!export-ignore` on a
  line wins. `[attr]` macro lines, quoted patterns and patterns with a `,`, which would split the
  `--exclude` value, are skipped. A `.gitattributes` in a subdirectory is not read.
- The path of each git submodule, read from `.gitmodules`. A submodule has its own text domain and
  its own POT, and its strings do not belong in this one.
- The lines of the `exclude` input, passed as given.

make-pot matches an exclusion against paths relative to `source-path`, so the `.distignore`,
`.gitattributes` and submodule paths are made relative to it first: with `source-path: src`,
`src/admin` becomes `admin`, and a path outside `src`, such as `/tests`, is dropped. A path with no
`/` in it, such as `node_modules`, is a name that matches at any depth, and is kept as it is, and so
is a path whose first part holds a `*`, such as `**/private/*.php`.

make-pot matches every exclusion at any depth, and drops a leading `/`: `/src/admin/` with
`source-path: src` becomes `admin`, which also leaves out `src/modules/admin/`, and `/tests` with
`source-path: .` also leaves out `src/tests/`. No `--exclude` value matches only at the top of the
scanned directory. When a directory deeper in the source has the same name as one `.distignore` or
`.gitattributes` leaves out, rename the deeper one.

make-pot always adds its own exclusions to these. In the i18n-command release that wp-cli 2.12.0
bundles, v2.6.5, they are `node_modules`, `.*`, `vendor`, `Gruntfile.js`, `webpack.config.js`,
`*.min.js`, `test` and `tests`.

```yaml
- uses: stellarwp/plugin-toolbox/.github/actions/generate-pot@v1
  with:
    domain: my-plugin
    headers: '{"Report-Msgid-Bugs-To": "https://example.com/support", "Last-Translator": "", "Language-Team": ""}'
    exclude: |
      *.js.map
      src/**/*.js
```

## The changed check

`changed` says whether the strings changed. make-pot writes lines that change without a string
changing, and the check leaves them out before it compares the POT with the one git tracks:

- the time (`POT-Creation-Date`), the plugin version (`Project-Id-Version`) and make-pot's own
  version (`X-Generator`), read from the header entry only: a translation entry that holds one of
  the names is compared like any other;
- the `# Copyright (C) <year>` line of the header entry;
- the `#:` references, the file and line of each string, in every entry.

| The POT | `changed` | The file |
|---|---|---|
| is not tracked by git: a new POT | `yes` | kept |
| differs from the tracked one in anything else | `yes` | kept |
| differs in those lines only, or not at all | `no` | put back with `git checkout` |

A second run therefore leaves nothing to commit. The tracked POT keeps its `#:` references until a
string changes, so they can point to lines that have moved. The check needs a git checkout, at any
depth.

## Inputs

| Input | Default | |
|---|---|---|
| `pot-path` | | Where the POT is written, relative to the checkout, e.g. `lang/my-plugin.pot`. Empty is `<Domain Path>/<Text Domain>.pot` from the plugin header, under `source-path`. |
| `source-path` | `.` | The directory scanned for strings, relative to the checkout. |
| `domain` | | The text domain, passed as `--domain`, and the POT's file name when `pot-path` is empty. Empty leaves it to make-pot. |
| `headers` | | POT headers to set, as a JSON object of strings in a string. Empty sets none. |
| `exclude` | | Extra exclusions, one per line, relative to `source-path`, added to `.distignore`, the `export-ignore` paths of `.gitattributes` and the submodule paths. |
| `working-directory` | | Where the repository is checked out. Empty is the workspace. |

## Outputs

| Output | |
|---|---|
| `pot-path` | The POT, relative to the checkout: the `pot-path` input as given, or the path read from the plugin header. |
| `changed` | `yes` when the POT is new or its strings changed, `no` when it differs in the lines [the changed check](#the-changed-check) leaves out only, or not at all. |

## How it runs

The logic is in [`generate-pot.js`](generate-pot.js), run by `actions/github-script`, so there is
no dependency to install and nothing to build. It needs `php`, `curl` and `git` on the runner.

Run its tests locally: `npm install` once in the toolbox, then
`node --test tests/actions/generate-pot/generate-pot.test.js`. They stand in for the download and
for wp-cli, and run the changed check against a real git repository.
