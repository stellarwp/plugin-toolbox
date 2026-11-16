# update-wp-version

Sets the WordPress version a plugin is tested up to and, when asked, the minimum it requires: a
version given, or two minor versions behind.

```yaml
- uses: actions/checkout@v6
  with:
    ref: ${{ inputs.branch }}
    persist-credentials: false

- uses: stellarwp/plugin-toolbox/.github/actions/update-wp-version@v1
  id: wp
  with:
    # Empty sets the latest WordPress release.
    tested-up-to: ${{ inputs.tested-up-to }}
    # Empty leaves Requires at least; `auto` sets it two minors back; `6.9` sets exactly that.
    min-version: ${{ inputs.min-version }}

# Commit here: this action only writes files.
```

It commits nothing: the step that commits the release preparation carries the change.

## What it writes

| Header | `readme.txt` | Plugin file |
|---|---|---|
| `Tested up to:` | always | when the file carries the header |
| `Requires at least:` | when `min-version` is set | when `min-version` is set |

An empty `tested-up-to` is the latest WordPress release: the first offer
`https://api.wordpress.org/core/version-check/1.7/` returns. A version passed in is used as it is.

`min-version` takes a version, which is set as it is, or `auto`. `auto` is the tested version two
minors back, major and minor only: `6.8` and `6.8.1` both give `6.6`. WordPress runs each major from
x.0 to x.9 and then moves to the next (6.9 was followed by 7.0), so `auto` counts back across a
major the same way: `7.0` gives `6.8` and `7.1` gives `6.9`.

The plugin file is the single root-level `.php` file `.puprc` lists under `paths.versions`. Some
plugins keep `Tested up to:` there as well as in `readme.txt`, as LearnDash does in `sfwd_lms.php`,
so the action sets it in both.

Only an existing header is rewritten. A file without the header is left as it is, and a missing
`readme.txt` is skipped. Only the first line carrying a header changes, so a version quoted further
down the file stays. The whole value is
replaced, so `Tested up to: 6.8-RC1` becomes `Tested up to: 6.8`. When no file carries a header to set, the action writes a warning and passes.

The job summary lists the versions and the files updated.

## What the repository needs

Nothing to set `Tested up to:` in `readme.txt`. For the plugin file, a `.puprc` that lists it:

```json
{
  "paths": {
    "versions": [
      { "file": "the-events-calendar.php", "regex": "(Version: )(.+)" },
      { "file": "readme.txt", "regex": "(Stable tag: )(.+)" }
    ]
  }
}
```

The same file listed several times, once per regex, counts as one. A leading `./` is allowed:
`./the-events-calendar.php` is the same root file.

## What it refuses

Every check runs before any file is written, so a refused run changes nothing.

- `tested-up-to` that is not two or three numeric parts: `banana`, `6`, `6.8.1.2`, `v6.8`. A
  zero-padded part is refused too, such as `6.08` or `06.8`.
- An empty `tested-up-to` when the latest release cannot be looked up: the request fails, the
  answer is not JSON, or its first offer holds no such version.
- `min-version` that is not empty, `auto`, or a version of the same shape as `tested-up-to`, or a
  version above `tested-up-to`.
- `min-version: auto` with a tested version below `1.2`, which has no minimum two minors back.
- `working-directory` that is not a directory.
- With `min-version` set, a `.puprc` that is missing, is not JSON, has no `paths.versions`, or does
  not list exactly one root-level PHP file that exists.

With `min-version` empty the `.puprc` is optional. Without one, or with one that does not name
a single plugin file, only `readme.txt` is updated.

## Inputs

| Input | Required | Default | What it does |
|---|---|---|---|
| `tested-up-to` | no | the latest release | The WordPress version to set as `Tested up to`, e.g. `6.8` or `6.8.1`. Empty looks up the latest WordPress release |
| `min-version` | no | | The `Requires at least` version: empty leaves it, `auto` sets it two minor versions behind `tested-up-to`, a version such as `6.9` sets exactly that |
| `working-directory` | no | the workspace | Where the repository is checked out, relative to the workspace or absolute |

## Outputs

| Output | Example | What it is |
|---|---|---|
| `min-version` | `6.6` | The minimum version set. Empty when the `min-version` input is empty |

## How it runs

One [actions/github-script](https://github.com/actions/github-script) step runs
[`update-wp-version.js`](./update-wp-version.js). There is no dependency to install and nothing to
build.

Inputs reach the script through `process.env`, never by being interpolated into it, so a version is
data and cannot become part of the program. The script runs no command: it reads and writes files,
and with an empty `tested-up-to` it sends one request to `api.wordpress.org`.

`tests/actions/update-wp-version/update-wp-version.test.js` covers the rules above against real
temporary directories. Run `npm install` once, then `node --test`.
