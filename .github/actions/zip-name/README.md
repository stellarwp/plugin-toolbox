# zip-name

Resolves the name of the zip a build will produce, before the build: the version the checkout
holds, the pre-release suffix of a QA build, and the slug pup gives the zip.

```yaml
- uses: actions/checkout@v6
  with:
    ref: ${{ inputs.ref }}
    persist-credentials: false

- uses: stellarwp/plugin-toolbox/.github/actions/zip-name@v1
  id: name
  with:
    production: ${{ inputs.production }}
    prerelease: ${{ inputs.prerelease }}

# Ask the bucket for ${{ steps.name.outputs.zip-name }}.zip here, and skip the build when it has it.

- uses: stellarwp/plugin-toolbox/.github/actions/release-zip@v1
  with:
    version: ${{ steps.name.outputs.version }}
    production: ${{ inputs.production }}
```

The name is known before the build so a caller can ask the S3 bucket whether that zip already
exists and skip the build, which is how the Slack packaging bot works today. That is why naming and
building are two actions. [`templates/workflows/zip.yml`](../../../templates/workflows/zip.yml) is a
complete workflow around the two, ready to copy into a plugin repository.

## What it names

| `production` | `prerelease` | `sequence` | `version` | `zip-name` |
|---|---|---|---|---|
| `yes` | ignored | ignored | `4.19.0.1` | `give.4.19.0.1` |
| `no` | `dev` | | `4.19.0.1-dev-1792689067-fbcf8681` | `give.4.19.0.1-dev-1792689067-fbcf8681` |
| `no` | `rc` | | `4.19.0.1-rc-1792689067-fbcf8681` | `give.4.19.0.1-rc-1792689067-fbcf8681` |
| `no` | `rc` | `2` | `4.19.0.1-rc-2` | `give.4.19.0.1-rc-2` |

The base version is what `pup get-version` reads: the first file `.puprc` lists under
`paths.versions`. The slug is what `pup zip-name` gives: `zip_name` in `.puprc`, or without one the
name in `composer.json` with the vendor removed. pup is asked for both, so the rules live in one
place.

The suffix is the build's, not the version's. The version on the branch, in the tag and in the
GitHub release stays `4.19.0.1`; the suffix exists in the zip name and, once release-zip has run, in
the version files inside the zip. A `dev` build with no `sequence` carries `-dev-<timestamp>-<hash>`,
the suffix `pup get-version --dev` gives: the committer timestamp of HEAD and its 8-character hash,
read with the same two git commands pup runs, so a default QA build is named as every QA build was
until now. The other labels take the place of `dev`. A `sequence` takes the place of the timestamp
and the hash, for a build numbered by hand, `rc-1`, `rc-2`; nothing counts up on its own, since
that would need state somewhere. Keep one scheme for a version's pre-release cycle: `version_compare`
reads the part after the label as a number, so `4.19.0.1-rc-2` sorts below
`4.19.0.1-rc-1792689067-fbcf8681`, and a site that installed the timestamped RC is not offered the
numbered one.

Hyphens throughout, as pup writes them. In PHP's `version_compare`, which WordPress uses to decide
whether an update applies, `-`, `.` and `_` are the same separator and `dev < alpha < beta < RC <
final`, so `4.19.0.1-rc-1 < 4.19.0.1` and a site running the RC gets the final release. Never `+`:
in a URL it is a space, and the zip links break.

## What the repository needs

A `.puprc` with the version files and the zip name:

```json
{
  "zip_name": "give",
  "paths": {
    "versions": [
      { "file": "give.php", "regex": "(Version: )(.+)" },
      { "file": "give.php", "regex": "(define\\( 'GIVE_VERSION', ')([^']+)" },
      { "file": "readme.txt", "regex": "(Stable tag: )(.+)" }
    ]
  }
}
```

`zip_name` may be left out when `composer.json` has a `name`; pup takes the part after the slash.
Without either, `pup zip-name` fails and so does the action.

The checkout has to be on the ref to build, with its commit: the action reads `.puprc` and the
version files from the working tree, and the commit's timestamp and hash from git. The template
checks out `ref` first.

## What it refuses

Before anything is downloaded or run:

- `production` that is not `yes` or `no`. The template declares it as a `choice` of the two, but the
  action checks the value itself, so a dispatch by hand or by a tool gets the same answer.
- On a QA build (`production: no`), `prerelease` that is not `dev`, `alpha`, `beta` or `rc`. Empty
  counts as `dev`.
- On a QA build, `sequence` that is not empty or digits from 1 with no leading zero: `0`, `02`,
  `abc`, `rc-2`.
- `working-directory` that is not a directory.
- A missing `.puprc`, one that is not JSON, or one with no `paths.versions`.
- `pup-version` that is neither a release number such as `2.0.0` nor `latest`.

After the version is read, before the suffix is built:

- `expected-version` that differs from the version the files hold. The action prints
  `VERSION_MISMATCH: expected 4.19.0.2, but the version files hold 4.19.0.1.` on a line of its own,
  where the release dashboard looks for it, and fails. The build was asked for a ref that is not the
  one prepared for that version, or the preparation did not run.
- A version pup could not read: an empty answer, or `unknown`, which pup prints when the regex of
  the first version file matches nothing.

And at the end, a name from `pup zip-name` that does not end in `.<version>`, which means the name
is not the one the S3 check and the upload would look for.

With `production: yes`, `prerelease` and `sequence` are ignored whatever they hold, not read and
not refused: the action writes a warning naming what the form carried, and names the clean zip.
`production` is the master switch; a form filled in by habit, or with a typo in `sequence`, still
produces the right production build.

## Inputs

| Input | Required | Default | What it does |
|---|---|---|---|
| `production` | no | `no` | `yes` names the clean zip and ignores the two below; `no` names a QA build |
| `prerelease` | no | `dev` | The label of a QA build: `dev`, `alpha`, `beta` or `rc` |
| `sequence` | no | | The number of a build numbered by hand, in place of the timestamp and hash. One scheme per pre-release cycle; see [What it names](#what-it-names) |
| `expected-version` | no | | The version the files have to hold; see [What it refuses](#what-it-refuses) |
| `working-directory` | no | the workspace | Where the repository is checked out, relative to the workspace or absolute, e.g. `source`. The `.puprc`, the version files and the commit are read there. The caller's own value, trusted like the checkout's `ref` |
| `pup-version` | no | `latest` | The pup release to run: a number such as `2.0.0`, or `latest`. See [Which pup runs](#which-pup-runs) |
| `token` | no | `github.token` | Authenticates the `latest` lookup. A pinned `pup-version` never uses it |

## Outputs

| Output | Example | What it is |
|---|---|---|
| `base-version` | `4.19.0.1` | The version the files hold |
| `version` | `4.19.0.1-rc-1792689067-fbcf8681` | The version the build carries, suffix included. Pass it to release-zip |
| `zip-name` | `give.4.19.0.1-rc-1792689067-fbcf8681` | The zip name without `.zip` |
| `prerelease` | `rc` | The label the build carries. Empty for a production build, so a step can read `== 'dev'` without looking at `production` |

## Which pup runs

`pup-version` pins a pup release (`2.0.0`) or tracks the newest one (`latest`, the default). A
pinned release downloads straight from its release page. `latest` reads the newest release through
the GitHub API, authenticated with `token` so the runner's shared unauthenticated quota is not
spent.

The release itself decides whether the action can run it: the action sends a HEAD request to the
release's `pup.phar` asset. Every release from 1.2.4 to 2.0.0 publishes one; the phar downloads
into the runner's temp directory and runs on the runner's PHP. A release without one is not
supported yet: the step fails, saying so and naming a pin to use instead. A pinned release that
does not exist, such as a mistyped number, fails the step with "is not a release".

A phar an earlier step of the same job downloaded is reused, so release-zip after zip-name
downloads nothing; a download that fails leaves no file behind to be reused by mistake.

How pup is resolved, downloaded and run is shared with release-prep and release-zip, in
[`.github/lib/pup.js`](../../lib/pup.js). When the TypeScript line of pup publishes a distribution,
that file changes and this action runs it without an edit of its own. Pass release-zip the same
`pup-version`, so the zip is named by the pup that read the version.

## How it runs

One [actions/github-script](https://github.com/actions/github-script) step runs
[`zip-name.js`](./zip-name.js). github-script supplies the Node runtime and `exec`; there is no
dependency to install and no bundle to build.

The script is loaded by path rather than inlined in the manifest because github-script's `require`
resolves against the workspace of the repository being built, not this action's directory. The
path comes from `${{ github.action_path }}`.

Inputs reach the script through `process.env`, never by being interpolated into it, so a version
or a label is data and cannot become part of the program. The commands run with their arguments as
a list, without a shell.

`tests/actions/zip-name/zip-name.test.js` covers the rules above against a stand-in for `exec`,
and one test runs the two git reads for real, against a repository made for it, to fix that the
`dev` suffix is the one `DevSuffix.php` would build from the same commit. Run `npm install` once,
then `node --test`.
