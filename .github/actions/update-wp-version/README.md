# update-wp-version

Sets the WordPress version a plugin is tested up to and, when asked, the minimum it requires, two
minor versions behind.

```yaml
- uses: actions/checkout@v6
  with:
    ref: ${{ inputs.branch }}
    persist-credentials: false

- uses: stellarwp/plugin-toolbox/.github/actions/update-wp-version@v1
  id: wp
  with:
    tested-up-to: ${{ inputs.tested-up-to }}
    update-min-version: ${{ inputs.update-min-version }}

# Commit here: this action only writes files.
```

It commits nothing: the step that commits the release preparation carries the change.

## What it writes

| Header | `readme.txt` | Plugin file |
|---|---|---|
| `Tested up to:` | always | when the file carries the header |
| `Requires at least:` | with `update-min-version: yes` | with `update-min-version: yes` |

The minimum is the tested version two minors back, major and minor only: `6.8` and `6.8.1` both
give `6.6`.

The plugin file is the single root-level `.php` file `.puprc` lists under `paths.versions`. Some
plugins keep `Tested up to:` there as well as in `readme.txt`, as LearnDash does in `sfwd_lms.php`,
so the action sets it in both.

Only an existing header is rewritten. A file without the header is left as it is, and a missing
`readme.txt` is skipped. Only the first line carrying a header changes, so a version quoted further
down the file stays. When no file carries a header to set, the action writes a warning and passes.

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

The same file listed several times, once per regex, counts as one.

## What it refuses

Every check runs before any file is written, so a refused run changes nothing.

- `tested-up-to` that is not two or three numeric parts: `banana`, `6`, `6.8.1.2`, `v6.8`. A
  zero-padded part is refused too, such as `6.08` or `06.8`.
- `update-min-version` that is not `yes` or `no`.
- `working-directory` that is not a directory.
- With `update-min-version: yes`, a tested version whose minor is below 2: `7.0`, `7.1`, `6.1.0`.
  WordPress publishes no mapping from `7.0` back into the 6.x line, so set that minimum by hand.
- With `update-min-version: yes`, a `.puprc` that is missing, is not JSON, has no `paths.versions`,
  or does not list exactly one root-level PHP file that exists.

With `update-min-version: no` the `.puprc` is optional. Without one, or with one that does not name
a single plugin file, only `readme.txt` is updated.

## Inputs

| Input | Required | Default | What it does |
|---|---|---|---|
| `tested-up-to` | yes | | The WordPress version to set as `Tested up to`, e.g. `6.8` or `6.8.1` |
| `update-min-version` | no | `no` | `yes` also sets `Requires at least` two minor versions behind |
| `working-directory` | no | the workspace | Where the repository is checked out, relative to the workspace or absolute |

## Outputs

| Output | Example | What it is |
|---|---|---|
| `min-version` | `6.6` | The minimum version written. Empty when `update-min-version` is not `yes` |

## How it runs

One [actions/github-script](https://github.com/actions/github-script) step runs
[`update-wp-version.js`](./update-wp-version.js). There is no dependency to install and nothing to
build.

Inputs reach the script through `process.env`, never by being interpolated into it, so a version is
data and cannot become part of the program. The script runs no command: it reads and writes files.

`tests/actions/update-wp-version/update-wp-version.test.js` covers the rules above against real
temporary directories. Run `npm install` once, then `node --test`.
