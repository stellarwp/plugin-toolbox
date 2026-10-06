# WordPress.org SVN release actions

Three composite actions that release a plugin to plugins.svn.wordpress.org from a built ZIP. They split a release into a prepared tag, a separate switch of the stable pointer, and trunk housekeeping afterwards:

| Action | Inputs | What it does |
|---|---|---|
| `tag` | `plugin-slug`, `zip-url` | Creates `tags/<version>` in one commit, as a copy of the current stable tag that matches the ZIP exactly. Only changed files are uploaded. trunk and the stable pointer don't move. |
| `set-stable` | `plugin-slug`, `version` | Copies `tags/<version>/readme.txt` over `trunk/readme.txt` in one server-side commit. WordPress.org reads the Stable Tag from that file, so this is the release. |
| `update-trunk` | `plugin-slug`, `version` | Replaces trunk with `tags/<version>` in one atomic server-side commit. Housekeeping after the release. |

All three also take `wporg-username` and `wporg-password`. The version always comes from the plugin's PHP header (`Version:`), never from the ZIP's file name.

## Read this first

- **This is not WordPress.org's documented flow.** [Using Subversion](https://developer.wordpress.org/plugins/wordpress-org/how-to-use-subversion/) updates trunk first and copies trunk to a tag. These actions prepare the tag first, on purpose, so that it can be checked before anything points at it.
- **A new tag is public the moment it exists.** It is not private staging. If [Release Confirmation](https://developer.wordpress.org/plugins/wordpress-org/release-confirmation-emails/) is on, WordPress.org may see the new tag and email about a pending release before `set-stable` runs. Never confirm a tag that `tag` did not verify.
- **`tag` takes one commit.** It prepares the new tag in a local working copy and commits it once, so `tags/<version>` appears complete or not at all. If the outcome of that commit is unclear, the action says so loudly and never cleans up or reuses the tag. See [Recovery](#recovery).
- **Released tags never change.** `tag` refuses a version whose tag already exists, under any spelling (`1.2` and `1.2.0` are the same version).

## Order

```text
tag  ->  QA the new tag, approve  ->  set-stable  ->  update-trunk
```

- QA `tags/<version>` at the `revision` the tag job reports, not just the ZIP you started from. Pass that revision as `expected-revision`, as the example does, and both later actions refuse a tag that changed after QA.
- `update-trunk` also replaces `trunk/readme.txt`, so it refuses to run until `set-stable` has pointed trunk's Stable Tag at the version. It can't release anything by itself.
- `set-stable` has no upgrade-only rule. Pointing it at an older tag rolls the release back.

## Example

A plugin repository's release workflow. The `concurrency` lock and the protected `environment` are the caller's job: a composite action can't enforce either.

```yaml
# A plugin repository's release workflow. Replace my-plugin, and replace
# <full-commit-sha> with a full commit SHA of stellarwp/plugin-toolbox.
name: Release to WordPress.org

on:
  workflow_dispatch:
    inputs:
      plugin-slug:
        description: The plugin's wordpress.org slug
        required: true
      zip-url:
        description: HTTPS URL of the built plugin ZIP (prefer a short-lived signed URL)
        required: true

# One release at a time per plugin, held for the whole sequence. This lock only
# covers workflows in this repository: release each plugin from one place.
concurrency:
  group: wporg-${{ inputs.plugin-slug }}
  cancel-in-progress: false

permissions:
  contents: read

jobs:
  tag:
    runs-on: ubuntu-24.04
    outputs:
      version: ${{ steps.tag.outputs.version }}
      revision: ${{ steps.tag.outputs.revision }}
    steps:
      - name: Install Subversion
        run: sudo apt-get update && sudo apt-get install -y --no-install-recommends subversion
      - id: tag
        uses: stellarwp/plugin-toolbox/.github/actions/wporg-svn/tag@<full-commit-sha>
        with:
          plugin-slug: ${{ inputs.plugin-slug }}
          zip-url: ${{ inputs.zip-url }}
          wporg-username: ${{ secrets.WPORG_USERNAME }}
          wporg-password: ${{ secrets.WPORG_PASSWORD }}

  release:
    needs: tag
    runs-on: ubuntu-24.04
    # A protected environment: its reviewers QA tags/<version> at the tag job's
    # revision output before approving this job.
    environment: wordpress-org
    steps:
      - name: Install Subversion
        run: sudo apt-get update && sudo apt-get install -y --no-install-recommends subversion
      - uses: stellarwp/plugin-toolbox/.github/actions/wporg-svn/set-stable@<full-commit-sha>
        with:
          plugin-slug: ${{ inputs.plugin-slug }}
          version: ${{ needs.tag.outputs.version }}
          expected-revision: ${{ needs.tag.outputs.revision }}
          wporg-username: ${{ secrets.WPORG_USERNAME }}
          wporg-password: ${{ secrets.WPORG_PASSWORD }}
      - uses: stellarwp/plugin-toolbox/.github/actions/wporg-svn/update-trunk@<full-commit-sha>
        with:
          plugin-slug: ${{ inputs.plugin-slug }}
          version: ${{ needs.tag.outputs.version }}
          expected-revision: ${{ needs.tag.outputs.revision }}
          wporg-username: ${{ secrets.WPORG_USERNAME }}
          wporg-password: ${{ secrets.WPORG_PASSWORD }}
```

[GitHub concurrency](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency) only covers one repository, isn't first-in-first-out, and is no lock on SVN. Release each plugin from one workflow in one repository. Don't add job-level locks with the same group while the workflow holds it.

## Inputs and outputs

| Input | Used by | Value |
|---|---|---|
| `plugin-slug` | all | The wordpress.org slug: lowercase letters and digits, single hyphens between them. |
| `zip-url` | `tag` | HTTPS URL of the ZIP. Pass a private URL from a secret, or mask it in an earlier step: see [Security](#security). |
| `version` | `set-stable`, `update-trunk` | The `version` output of `tag`. |
| `expected-revision` | `set-stable`, `update-trunk` | Optional: the `revision` output of `tag`. When set, the action refuses unless `tags/<version>` last changed at exactly that revision, so what gets released is the tag that was QA'd. Leave it empty for a manual run or a rollback. |
| `wporg-username` | all | `${{ secrets.WPORG_USERNAME }}`: an account with commit access to the plugin. |
| `wporg-password` | all | `${{ secrets.WPORG_PASSWORD }}`: that account's [SVN password](https://make.wordpress.org/plugins/2024/09/04/upcoming-security-changes-for-plugin-and-theme-authors-on-wordpress-org/), not its login password. |

Every action outputs `version` and `revision` once it has verified its result. A failed action outputs nothing.

| Output | Meaning |
|---|---|
| `version` | The version released (`tag`: read from the plugin header). |
| `revision` | `tag`: the commit that created the new tag. `set-stable`, `update-trunk`: their commit. For a verified no-op, the revision that was checked; the step summary says it was a no-op. |
| `previous-stable` | `tag` only: the tag it copied from. |

## Requirements

An Ubuntu runner with bash, Subversion 1.10 or newer (`svn`, and `svnmucc` for `set-stable` and `update-trunk`), Python 3.8 or newer, and, for `tag`, curl. Ubuntu runner images may not include Subversion: install the `subversion` package as in the example. Each action checks its tools and stops with a clear error if one is missing or the runner isn't Linux.

## What gets checked

Before any write, every action pins one repository revision and reads everything at that revision. A failed read always stops the action: an authentication, TLS, connection or permission error is never taken to mean a path is absent.

`tag`:

- trunk's readme names a numeric stable tag S, and `tags/S` exists. A stable tag of `trunk` (a first release) is not supported.
- The ZIP passes every check in [ZIP limits](#zip-limits). The plugin header version V is numeric and newer than S, and the ZIP's readme Stable Tag is exactly V.
- `tags/V` doesn't exist under any spelling, and the copy of `tags/S` sets no property that changes file bytes (`svn:eol-style`, `svn:keywords`, `svn:special`, `svn:externals`).
- It copies `tags/S` at the pinned revision into an otherwise empty working copy as `tags/V`, syncs the ZIP byte for byte (additions, deletions, dotfiles, file/directory swaps), adds files even where ignore patterns would hide them, and re-validates the version, readme and full tree. An artifact identical to `tags/S` is refused.
- Just before the commit it checks again that the stable pointer, `tags/S` and the absence of `tags/V` haven't changed. If someone creates `tags/V` before the commit lands, the commit fails instead of overwriting it.
- After the commit it exports the committed tag and compares it with the ZIP again.

`set-stable`: `tags/V/readme.txt` and `trunk/readme.txt` are regular files without byte-changing properties, and the tag readme's Stable Tag is exactly V. The write is pinned to the snapshot revision, so a competing change to `trunk/readme.txt` makes it fail instead of being overwritten. Identical bytes are a verified no-op.

`update-trunk`: `trunk` and `tags/V` exist, and trunk's readme already names V as its Stable Tag. The remove and copy are one commit, copying `tags/V` as it was at the snapshot revision, and a change anywhere inside trunk since then makes the whole commit fail. The result is compared on the server, files and properties both. A trunk that already matches is a verified no-op.

## ZIP limits

| Limit | Value |
|---|---|
| Download | HTTPS only, redirects too (at most 5); 30 s to connect, 10 min per attempt, 3 retries |
| ZIP size | 256 MiB |
| Entries | 50,000 |
| Expanded size | 1 GiB |
| Expansion ratio | 100 to 1 |

Every entry is checked before anything is extracted. Rejected:

- absolute paths, `..`, backslashes, empty or `.` path segments, and names that only differ by case or Unicode form;
- control characters;
- names that aren't valid UTF-8. Names without the ZIP's UTF-8 flag are read as UTF-8, which is what Info-ZIP's `zip` on macOS and Linux writes;
- entries with two different names, where an Info-ZIP Unicode Path field disagrees with the header;
- symlinks and other special files;
- encrypted entries;
- `.svn` or `.git` anywhere.

The ZIP is either the plugin itself or one wrapper directory of any name holding it. `__MACOSX/` and `.DS_Store` are skipped as packaging noise. The plugin root must hold `readme.txt` and exactly one root-level PHP file with a `Plugin Name` header. That file must have exactly one `Version` header in its first 8 KiB, the same window WordPress reads.

New files are added without SVN auto-props, including any a repository inherits. Like any `svn add`, binary files still get `svn:mime-type: application/octet-stream`. Nothing else is set, `svn:executable` included. Files carried over from the previous tag keep their properties. Before committing, `tag` checks that nothing in the new tag sets a property that changes file bytes.

## Limitations

- **Not supported:** first releases, prerelease versions (`1.2-beta`), building the ZIP, confirming a release on WordPress.org, and Git tags or releases.
- **Races are narrowed, not prevented.** The pinned base revision protects only the paths each action writes. The rechecks shrink the windows. Neither replaces running one release at a time.
- **Success means the commit landed and was verified.** WordPress.org processing, ZIP building and Release Confirmation happen afterwards and aren't checked.
- **Not tested against wordpress.org writes.** The tests write only to throwaway local repositories; reads were checked against real plugins. Still unverified:
  - authentication with an SVN password;
  - out-of-date detection over HTTPS;
  - real lost responses;
  - whether wordpress.org's server-side rules accept a new tag committed as a copy with changes, the shape common deploy scripts use.

  Supervise the first real release, with this page at hand.

## Recovery

A failure prints an error naming the stage and the revisions known so far, and repeats it in the step summary. Don't rerun a write blindly: each action has already inspected the server after a failed write and says what it found.

**Nothing was written.** Every check runs before the only write, so any failure before the commit, and `the commit failed ... tags/V does not exist`, mean nothing changed. Fix the cause and rerun.

**`tag` can't vouch for `tags/V`.** One of these:

- `... cannot confirm that it created it`: the commit reported an error, but `tags/V` now exists. Either the response got lost after the commit landed, or someone else created the tag.
- `The commit's outcome is unknown`: the job stopped during the commit, usually because it was cancelled. If `tags/V` doesn't exist, nothing was written; rerun.
- `tags/V was created at rN but not verified`: the commit landed, but comparing the committed tag with the ZIP failed or didn't finish.

Then:

1. Don't confirm it in Release Confirmation, and don't run `set-stable` for it.
2. Look at what happened (reads only):

   ```sh
   svn log -v -l 5 https://plugins.svn.wordpress.org/<slug>/tags/<V>
   svn diff --summarize https://plugins.svn.wordpress.org/<slug>/tags/<S> https://plugins.svn.wordpress.org/<slug>/tags/<V>
   ```

3. A maintainer decides what to do: release it once someone has compared it with the ZIP, or delete it and run `tag` again. Deleting is a write to the live plugin, so it needs that maintainer's explicit go-ahead:

   ```sh
   svn rm -m "Remove unverified tag <V>" https://plugins.svn.wordpress.org/<slug>/tags/<V>
   ```

   If WordPress.org already lists the tag as a pending release, follow its Release Confirmation guidance for a release you won't ship.

**`set-stable` or `update-trunk` failed.**

- `... does not match ...; check who else is committing`: the write failed, and the target doesn't hold the release. Usually another commit got there first or the server refused the write; `svn log` shows which. Find out who else is releasing before you rerun.
- `... now matches ... Rerunning is safe`: the write most likely landed but its response was lost. A rerun verifies it and reports a no-op.

## Security

- The password reaches `svn` and `svnmucc` on stdin only. It isn't in any process's arguments or in its child processes' environment. Each action masks it, along with the ZIP URL.
- The actions never print the ZIP URL. They mask it too, but only from their own steps on: GitHub logs a step's `with:` inputs before the action runs. If the URL must stay private, pass it from a secret, or mask it with `::add-mask::` in an earlier step. Nothing sends WordPress.org credentials to the ZIP host, and curl ignores `.curlrc`.
- SVN runs non-interactively with a private, throwaway config directory and no credential cache. Certificate checks are never skipped. Temporary files are removed on success, failure and cancellation.
- Nothing from the ZIP runs: no PHP, scripts or hooks.
- The credentials are repository secrets, because the `tag` job writes to SVN without an approval gate. The protected environment in the example gates the release job's approval; it doesn't protect the secrets. Anyone who can push a workflow to the repository can read repository secrets, so limit who can push, and never let the secrets reach workflows that run pull request code from forks. Prefer short-lived signed ZIP URLs: `workflow_dispatch` inputs are visible to anyone who can see the run.

## Tests

Locally, with Subversion, Python 3 and openssl installed:

```sh
python3 -m unittest discover -s tests/wporg-svn -v
shellcheck -x .github/actions/wporg-svn/*/*.sh .github/actions/wporg-svn/lib/svn.sh tests/wporg-svn/guard/bin/*
actionlint && actionlint .github/actions/wporg-svn/examples/release.yml
```

The tests run the real scripts against throwaway `file://` repositories and a local HTTPS server. A test-only guard (`tests/wporg-svn/guard`) sits first on `PATH` and refuses any SVN write whose target isn't `file://`.

Read-only checks against real plugins are opt-in. They read from wordpress.org, and every write goes to a local repository:

```sh
WPORG_LIVE=1 python3 -m unittest discover -s tests/wporg-svn -p test_live.py -v
```
