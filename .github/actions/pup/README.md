# pup

Installs [pup](https://github.com/stellarwp/pup) from its GitHub release and, when asked, reads the
version and the zip name from it. Every action in this repository that needs pup uses this one, so
pup is downloaded, checked and read the same way everywhere, and no action depends on where a
repository keeps its own copy.

pup is a PHP archive. It is downloaded into the runner's temp directory and run with the runner's
PHP, so it never ends up in a commit or a zip.

```yaml
- uses: actions/checkout@v7

- name: Install pup and read the zip name
  id: pup
  uses: stellarwp/plugin-toolbox/.github/actions/pup@main
  with:
    pup-version: '2.0.0'
    read: zip-name
    dev: 'true'

- run: echo "${{ steps.pup.outputs.zip-name }}.zip"
```

Inside this repository, call it as `uses: $/.github/actions/pup`.

## Inputs

| Input | Default | What it does |
|---|---|---|
| `pup-version` | `2.0.0` | The pup release: a number such as `2.0.0`, or `latest`. See [Which pup](#which-pup) |
| `read` | empty | Empty installs only. `version` also runs `pup get-version`. `zip-name` also runs `pup zip-name` for that version. Both need a checkout |
| `dev` | `false` | `true` reads the development build version, `pup get-version --dev`, which has the commit in it. Only used when `read` is set |
| `token` | `github.token` | Authenticates the `latest` lookup. A pinned release makes no API call |

## Outputs

| Output | What it is |
|---|---|
| `phar` | Path of `pup.phar`. Run any pup command with `php "$PHAR" <command>` |
| `release` | The release that was installed. `latest` becomes its number |
| `version` | What `pup get-version` printed. Empty unless `read` is set |
| `zip-name` | The zip's name, without `.zip`. Empty unless `read` is `zip-name` |

Both values are the last line pup printed, so a PHP notice printed before it is never part of them.
PHP's errors go to stderr (`display_errors=stderr`) for the same reason.

## Which pup

`pup-version` pins a release or tracks the newest one with `latest`. A pinned release downloads
straight from its release page. `latest` asks the GitHub API for the newest release.

The release must ship a `pup.phar` asset, which every release from 1.2.4 to 2.0.0 does. The action
checks that with a HEAD request. A release without a phar fails with a message naming a pin to use
instead, and a number that is not a release at all (a typo) fails with "is not a release".

Use the release the repository's own `composer pup` script downloads. The zip name pup makes can
depend on its release, and the name read here has to equal the name of the zip the repository's own
build made.

Within one job the phar is downloaded once. A second use of the action, or of the script below,
finds the file and reuses it.

## From another action's script

`pup.js` is a plain Node module. Its functions take the `exec` toolkit, so a script that
github-script runs can pass the one it was given:

```js
const { installPup, getVersion, zipName, runPup } = require('../pup/pup.js')

const { phar } = await installPup({ core, exec, version: '2.0.0', token: '', env: process.env })
const version = await getVersion({ exec, phar, cwd, dev: true })
const name = await zipName({ exec, phar, cwd, version })
const output = await runPup({ exec, phar, cwd, args: ['check'] })
```

`runPup` runs any pup command and returns what it printed, or throws with the output when pup exits
non-zero. The module also exports `downloadPhar`, `pharPath`, `validatePupVersion`,
`resolvePupRelease`, `resolvePupDistribution`, `pupDownloadUrl` and `pupReleaseUrl`. Release prep
uses them for its own steps.

The path is relative to the file that requires it. github-script's own `require` resolves against
the workspace of the repository being built, which is why an action's manifest passes
`${{ github.action_path }}`.

## How it runs

The logic is in `pup.js`, run by actions/github-script, which supplies the Node runtime and `exec`.
There is no dependency to install and no bundle to build: the file in the repository is the file
that runs. Inputs reach the script through `process.env`, never by being interpolated into it.
`tests/actions/pup/pup.test.js` runs it against a stand-in for `exec` and for `fetch`. Run
`npm install` once, then `node --test`.
