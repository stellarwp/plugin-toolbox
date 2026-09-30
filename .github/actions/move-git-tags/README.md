# move-git-tags

Creates or moves the named git tags so that they point at a commit. A tag that does not exist is
created, one that does is repointed.

It knows nothing about versions. [resolve-floating-tags](../resolve-floating-tags/) decides which
floating version tags a release should own and this action writes them:

```yaml
- name: Resolve the floating tags for this release
  id: floating
  uses: stellarwp/plugin-toolbox/.github/actions/resolve-floating-tags@v1
  with:
    tag: ${{ github.event.release.tag_name }}

- name: Move them onto the released commit
  uses: stellarwp/plugin-toolbox/.github/actions/move-git-tags@v1
  with:
    tags: ${{ steps.floating.outputs.tags }}
```

Any tag name works, so it also moves a `stable` or `latest` pointer, or a release tag that has to be
repointed at a build commit. `sha` defaults to the commit the run is for, so most callers pass only
the names:

```yaml
- uses: stellarwp/plugin-toolbox/.github/actions/move-git-tags@v1
  with:
    tags: stable
```

## Inputs

| Input | Required | Default | What it does |
|---|---|---|---|
| `tags` | yes | | Tag names to create or move, separated by spaces or newlines, e.g. `v1 v1.2` |
| `sha` | no | the commit the run is for | The commit the tags should point at |
| `repository` | no | current repo | The `<owner>/<repo>` to write the tags in |
| `token` | no | `github.token` | Writes the tag refs. See [Permissions](#permissions) |

## Outputs

| Output | Example | What it is |
|---|---|---|
| `created` | `v1.2` | Tags that did not exist and were created |
| `moved` | `v1` | Tags that already existed and were repointed |

## An empty tag list is not an error

`tags: ''` moves nothing and succeeds, so a caller feeding it another step's output needs no `if:`
of its own. resolve-floating-tags returns an empty `tags` whenever the release should own no
floating tags, and the job stays green.

## Permissions

The job needs `contents: write`, which is not the default when a workflow sets
`permissions: contents: read` at the top:

```yaml
jobs:
  move-floating-tags:
    permissions:
      contents: write
```

Pass a PAT or app token as `token` instead when a ruleset protects the tags in a way
`github.token` cannot satisfy. A tag protection rule that blocks the default token makes the API
call fail rather than silently skip.

## Why the API and not git push

Writing the refs through the API rather than `git push --force` means the tag name never disappears
for a moment, which is what keeps a GitHub Release attached to it. It also means the job needs no
checkout of the repo to move a tag.

Each tag is read with `git.getRef` before being written, instead of trying `git.updateRef` and
creating the tag when that fails. An update also fails for a token without permission or a protected
tag, and a fallback would report those as a successful creation. Only a 404 is read as "does not
exist"; any other status fails the job.

`getRef` is the single-ref endpoint on purpose. `listMatchingRefs` matches by prefix, so it answers
for `tags/v1` whenever a `v1.0.0` tag exists even when there is no `v1` to update:

```console
$ gh api repos/stellarwp/changelogger/git/refs/tags/0.1 --jq 'map(.ref)'
["refs/tags/0.1.0","refs/tags/0.10.0"]

$ gh api repos/stellarwp/changelogger/git/ref/tags/0.1
gh: Not Found (HTTP 404)
```

The two calls also spell the ref differently: `getRef` and `updateRef` take `tags/v1`, while
`createRef` takes the full `refs/tags/v1`.

## Tag names

Pass tag names, not refs. `refs/tags/v1` is refused, because writing it would create a tag named
`refs/tags/v1`.

A name has to start with a letter or digit and hold only letters, digits, `.`, `_`, `-` and `/`.
`..` is refused as well. Each name goes into an API path, so anything else stops the job instead of
being sent.

## Lightweight tags only

The refs are written straight to a commit, so these are lightweight tags with no tagger, date or
message of their own. A floating tag is repointed every time a release claims it, so an annotated tag
object would be replaced each time.

A release tag that has to be annotated or signed is created by whoever cuts the release, not here.

## How it runs

The logic is in `move.js`, run by [actions/github-script](https://github.com/actions/github-script),
which supplies the Node runtime and an Octokit already authenticated with `token`. There is no
dependency to install and no bundle to build: the file in the repository is the file that runs, so a
change to it is reviewable as a diff.

The script is loaded by path rather than inlined in the manifest, because github-script's `require`
resolves against the workspace of the repository being built, not this action's directory. The path
comes from `${{ github.action_path }}`.

Inputs reach the script through `process.env`, never by being interpolated into it, so a tag name is
data and cannot become part of the program.

`tests/actions/move-git-tags/move.test.js` covers the rules above. Run them with `node --test`.
