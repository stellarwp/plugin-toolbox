# release-zip

Builds and packages a version of the plugin with pup, from the root of the checkout:

```yaml
- uses: stellarwp/plugin-toolbox/.github/actions/zip-name@v1
  id: name
  with:
    production: ${{ inputs.production }}
    prerelease: ${{ inputs.prerelease }}

- uses: stellarwp/plugin-toolbox/.github/actions/release-zip@v1
  id: zip
  with:
    version: ${{ steps.name.outputs.version }}
    production: ${{ inputs.production }}

- uses: actions/upload-artifact@v7
  with:
    name: ${{ steps.zip.outputs.zip-name }}
    path: ${{ steps.zip.outputs.zip-path }}
```

The version is the one zip-name resolved, pre-release suffix included. Naming and building are two
actions so a caller can ask the S3 bucket for the name and skip the build; see
[zip-name](../zip-name/README.md). [`templates/workflows/zip.yml`](../../../templates/workflows/zip.yml)
is a complete workflow around the two, ready to copy into a plugin repository.

## What it does

Four pup commands run, in this order, from the root of the checkout:

1. `pup build` runs the build commands `.puprc` lists under `build`: `composer install`,
   `npm run build`, whatever the plugin needs before it ships.
2. `pup check` runs the checks `.puprc` lists under `checks`, the `TBD` check and the
   version-conflict check among them. Strict on a production build, so a `TBD` left behind fails
   the build; with `--dev` on a QA build, where each check's `fail_method_dev` applies, a warning by
   default. Skipped with `check: no`.
3. `pup i18n` downloads the finished translations the `i18n` section of `.puprc` points at. Nothing
   happens without the section. Skipped with `i18n: no`. It does not generate the POT file; a
   plugin that ships one generates it in a step of its own, before this action.
4. `pup package <version>` writes `version` into every file `.puprc` lists under `paths.versions`,
   syncs the files `.distignore` or `.distfiles` keep into `.pup-zip/`, zips them as
   `<zip-name>.zip` in the root of the checkout, and restores the version files with git. The
   checkout is left as it was; only the zip carries the suffix.

A command that fails fails the step with pup's output in the log, and the commands after it do not
run. The action then asks `pup zip-name <version>` for the name pup gave the zip and checks that the
file is there, so the `zip-path` output always names a file that exists.

The build commands run with the step's environment. A build that installs private composer packages
gets `COMPOSER_AUTH` from the caller's step:

```yaml
- uses: stellarwp/plugin-toolbox/.github/actions/release-zip@v1
  with:
    version: ${{ steps.name.outputs.version }}
  env:
    COMPOSER_AUTH: >-
      ${{ secrets.COMPOSER_TOKEN != '' && format('{{"github-oauth": {{"github.com": "{0}"}}}}', secrets.COMPOSER_TOKEN) || '' }}
```

## What the repository needs

A `.puprc` with the version files, the zip name and the build commands, and the PHP, Node and other
tools the build commands run, set up by the caller before this action. pup itself runs on the
runner's PHP; the template sets up the oldest PHP the plugin supports, so the vendor directory
`pup build` installs runs on it.

```json
{
  "zip_name": "give",
  "build": ["composer install --no-dev", "npm ci", "npm run build"],
  "paths": {
    "versions": [
      { "file": "give.php", "regex": "(Version: )(.+)" },
      { "file": "readme.txt", "regex": "(Stable tag: )(.+)" }
    ]
  },
  "checks": {
    "tbd": { "dirs": ["src"] },
    "version-conflict": {}
  }
}
```

The action checks the `.puprc` before downloading anything: a missing file, one that is not JSON,
or one with no `paths.versions` fails the step before pup runs, as zip-name does.

## What it refuses

Before anything is downloaded or run:

- An empty `version`. The template passes zip-name's `version` output, which is never empty.
- `production`, `check` or `i18n` that is not `yes` or `no`.
- A missing or unusable `.puprc`.

After the build, a zip that is not where pup said it would be: `pup package` exited 0 but
`<zip-name>.zip` is not in the root of the checkout. That points at `zip_name` in `.puprc`, or the
name in `composer.json`.

## Inputs

| Input | Required | Default | What it does |
|---|---|---|---|
| `version` | yes | | The version the zip carries, zip-name's `version` output |
| `production` | no | `no` | `yes` runs `pup check` strict; `no` runs it with `--dev` |
| `check` | no | `yes` | Whether `pup check` runs |
| `i18n` | no | `yes` | Whether `pup i18n` runs |
| `pup-version` | no | `latest` | The pup release to run: a number such as `2.0.0`, or `latest`. Pass the same value zip-name got. See [Which pup runs](#which-pup-runs) |
| `token` | no | `github.token` | Authenticates the `latest` lookup. A pinned `pup-version` never uses it |

## Outputs

| Output | Example | What it is |
|---|---|---|
| `zip-name` | `give.4.19.0.1-rc-1792689067-fbcf8681` | The zip name without `.zip`, as `pup zip-name` gives it |
| `zip-path` | `/home/runner/work/give/give/give.4.19.0.1-rc-1792689067-fbcf8681.zip` | The zip, as an absolute path |

## Which pup runs

`pup-version` pins a pup release (`2.0.0`) or tracks the newest one (`latest`, the default). A
pinned release downloads straight from its release page; `latest` reads the newest release through
the GitHub API, authenticated with `token`. The release has to publish a `pup.phar` asset, which
every release from 1.2.4 to 2.0.0 does; one without it fails the step and names a pin to use. How
pup is resolved, downloaded and run is shared with release-prep and zip-name, in
[`.github/lib/pup.js`](../../lib/pup.js).

## How it runs

One [actions/github-script](https://github.com/actions/github-script) step runs
[`release-zip.js`](./release-zip.js). github-script supplies the Node runtime and `exec`; there is
no dependency to install and no bundle to build. The script is loaded by path because
github-script's `require` resolves against the workspace of the repository being built, not this
action's directory.

Inputs reach the script through `process.env`, never by being interpolated into it, so a version is
data and cannot become part of the program. The commands run with their arguments as a list,
without a shell. `pup build`, `check`, `i18n` and `package` print to the log; only `pup zip-name`,
whose output the action reads, runs silently.

`tests/actions/release-zip/release-zip.test.js` covers the rules above against a stand-in for
`exec`. Run `npm install` once, then `node --test`.
