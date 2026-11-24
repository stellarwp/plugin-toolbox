# update-wp-version

Sets the WordPress version a plugin is tested up to and, when asked, the minimum it requires: a
version given, or the WordPress release two before the tested one.

```yaml
- uses: actions/checkout@v6
  with:
    ref: ${{ inputs.branch }}
    persist-credentials: false

- uses: stellarwp/plugin-toolbox/.github/actions/update-wp-version@v1
  id: wp
  with:
    # Empty sets the latest WordPress release, major and minor only.
    tested-up-to: ${{ inputs.tested-up-to }}
    # Empty leaves Requires at least; `auto` sets it two releases back; `6.9` sets exactly that.
    min-version: ${{ inputs.min-version }}

# Commit here, when steps.wp.outputs.changed is 'true': this action only writes files.
```

It commits nothing: the step that commits the release preparation carries the change.

## What it writes

| Header | `readme.txt` | Plugin file |
|---|---|---|
| `Tested up to:` | always | when the file carries the header |
| `Requires at least:` | when `min-version` is set | when `min-version` is set |

An empty `tested-up-to` is the major and minor version of the latest WordPress release: the first
offer `https://api.wordpress.org/core/version-check/1.7/` returns, so `7.1.5` is written as `7.1`.
WordPress.org reads `Tested up to` by major and minor, so `7.1` covers every `7.1.x` release. A
version passed in is written as it is.

`min-version` takes a version, which is set as it is, or `auto`. `auto` is the WordPress release two
before the tested one, major and minor only, counted through the releases
`https://api.wordpress.org/core/stable-check/1.0/` lists: `6.8` and `6.8.1` both give `6.6`, `7.0`
gives `6.8`, and `2.0` gives `1.2`, as `1.5` came between them. Only `auto` sends this request.
`auto` never lowers a minimum: a file at `6.9` stays at `6.9` when `auto` gives `6.8`, and the run
reports it. A version given exactly is set as it is, so passing `6.7` is how a plugin lowers its
minimum on purpose.

The `min-version` output and the summary's minimum line show the `Requires at least` version the
files hold after the run. When `auto` kept a higher version in one file, that is the version shown;
when readme.txt and the plugin file end with different versions, the higher one is shown. When no
file carries the header, the output is empty.

The plugin file is the single root-level `.php` file `.puprc` lists under `paths.versions`. Some
plugins keep `Tested up to:` there as well as in `readme.txt`, so the action sets it in both.

Only an existing header is rewritten. A file without the header is left as it is, and a missing
`readme.txt` is skipped. Only the first line carrying a header changes, so a version quoted further
down the file stays. `Tested up to` is never lowered: a file at `7.1.4` stays at `7.1.4` when
`tested-up-to` is `7.1`, and the run reports it. The whole value is
replaced, so `Tested up to: 6.8-RC1` becomes `Tested up to: 6.8`. When no file carries a header to set, the action writes a warning and passes.

The log and the job summary say, for each header each file carries, whether it changed from one
version to another, was already at the version, or was left above it. The `changed` output is
`true` when any file was written.

## What the repository needs

Nothing to set `Tested up to:` in `readme.txt`. For the plugin file, a `.puprc` that lists it:

```json
{
  "paths": {
    "versions": [
      { "file": "my-plugin.php", "regex": "(Version: )(.+)" },
      { "file": "readme.txt", "regex": "(Stable tag: )(.+)" }
    ]
  }
}
```

The same file listed several times, once per regex, counts as one. A leading `./` is allowed:
`./my-plugin.php` is the same root file.

## What it refuses

Every check runs before any file is written, so a refused run changes nothing.

- `tested-up-to` that is not two or three numeric parts: `banana`, `6`, `6.8.1.2`, `v6.8`. A
  zero-padded part is refused too, such as `6.08` or `06.8`.
- An empty `tested-up-to` when the latest release cannot be looked up: the request fails, the
  answer is not JSON, or its first offer holds no such version.
- `min-version` that is not empty, `auto`, or a version of the same shape as `tested-up-to`, or a
  version above `tested-up-to`.
- `min-version: auto` when the release list cannot be looked up: the request fails, the answer is
  not JSON, or it is not an object listing releases as keys.
- `min-version: auto` with a tested version whose major and minor is not a release the list holds,
  such as a version not released yet, or that has fewer than two releases before it, such as
  `1.2`. Pass `min-version` as a version in these cases.
- `working-directory` that is not a directory.
- With `min-version` set, a `.puprc` that is missing, is not JSON, has no `paths.versions`, or does
  not list exactly one root-level PHP file that exists.

With `min-version` empty the `.puprc` is optional. Without one, or with one that does not name
a single plugin file, only `readme.txt` is updated.

## Inputs

| Input | Required | Default | What it does |
|---|---|---|---|
| `tested-up-to` | no | the latest release | The WordPress version to set as `Tested up to`, e.g. `6.8` or `6.8.1`. Empty looks up the latest WordPress release and writes its major and minor version |
| `min-version` | no | | The `Requires at least` version: empty leaves it, `auto` sets it to the WordPress release two before `tested-up-to` without lowering a higher one, a version such as `6.9` sets exactly that |
| `working-directory` | no | the workspace | Where the repository is checked out, relative to the workspace or absolute |

## Outputs

| Output | Example | What it is |
|---|---|---|
| `min-version` | `6.6` | The `Requires at least` version the files hold after the run: the version set, or a higher one `auto` kept; the higher one when the files differ. Empty when the `min-version` input is empty or no file carries the header |
| `changed` | `true` | `true` when a file was written, `false` when every header was already at its version, was left above it, or no file carries one |

## How it runs

One [actions/github-script](https://github.com/actions/github-script) step runs
[`update-wp-version.js`](./update-wp-version.js). There is no dependency to install and nothing to
build.

Inputs reach the script through `process.env`, never by being interpolated into it, so a version is
data and cannot become part of the program. The script runs no command: it reads and writes files,
with an empty `tested-up-to` it sends one request to `api.wordpress.org/core/version-check`, and
with `min-version: auto` one to `api.wordpress.org/core/stable-check`.

`tests/actions/update-wp-version/update-wp-version.test.js` covers the rules above against real
temporary directories. Run `npm install` once, then `node --test`.
