# resolve-floating-tags

Works out which floating version tags a released version should own. `1.2.3` owns `v1` and `v1.2`.

It writes nothing. Pair it with [move-git-tags](../move-git-tags/), which takes its `tags` output
as input:

```yaml
- name: Resolve the floating tags for this release
  id: floating
  uses: stellarwp/plugin-toolbox/.github/actions/resolve-floating-tags@v1
  with:
    tag: ${{ github.event.release.tag_name }}
    is-prerelease: ${{ github.event.release.prerelease }}

- name: Move them onto the released commit
  uses: stellarwp/plugin-toolbox/.github/actions/move-git-tags@v1
  with:
    tags: ${{ steps.floating.outputs.tags }}
```

The two are separate so that either half can be used alone: a repo with its own tag-writing step
can read `tags` from here, and a repo that wants to move a `stable` or `latest` tag can call
move-git-tags without this action.

## Inputs

| Input | Required | Default | What it does |
|---|---|---|---|
| `tag` | yes | | The release tag, with or without a leading `v`, e.g. `1.2.3` or `v1.2.3` |
| `levels` | no | `'major minor'` | Which tags to resolve: `major` for `v1`, `minor` for `v1.2` |
| `is-prerelease` | no | `'false'` | Resolve nothing when `true`. See [Prereleases](#prereleases) |
| `require-newest` | no | `'true'` | Hold a tag back when a newer release owns it. See [Why a tag stays put](#why-a-tag-stays-put) |
| `repository` | no | current repo | The `<owner>/<repo>` whose releases to compare against |
| `token` | no | `github.token` | Reads the release list. Read access is enough, and it is unused when `require-newest` is off |

## Outputs

| Output | Example | What it is |
|---|---|---|
| `tags` | `v1 v1.2` | The floating tags this version should own. Empty when it should own none |
| `skipped` | `v1` | Tags a newer release already owns |
| `version` | `1.2.3` | The version without its leading `v`. Empty when the tag was rejected |
| `major` | `1` | The major number |
| `minor` | `2` | The minor number |

## Why a tag stays put

`v1` means "the newest 1.x", so it has to move when 1.3.0 ships and stay where it is when a patch
lands on an older line. With `require-newest` on, each tag moves only when the release being
published is the newest one that tag covers.

Publishing 1.2.4 when 1.3.0 is already out resolves to `v1.2` alone. `v1` is reported in `skipped`
and keeps pointing at 1.3.0.

Each tag is compared only against releases in its own line, so a newer major does not hold a lower
one back. With 2.1.0 released, publishing 1.2.4 as the newest 1.x still resolves both `v1` and
`v1.2`. That is deliberate: someone pinned to `@v1` asked for the 1.x line and should get a
backported patch on it.

Turn `require-newest` off to move the tags on every release regardless. That is only correct on a
repo that never patches an older line.

## Prereleases

Two things have to be true for a prerelease to be skipped, because either one can happen alone.

A tag with a suffix, `1.3.0-rc.1`, is not three dot-separated numbers, so the pattern rejects it on
its own.

A tag that is a plain `1.3.0` but marked as a prerelease on GitHub looks like any other version, so
pass `is-prerelease: ${{ github.event.release.prerelease }}` and it resolves nothing.

## Tag prefixes

A release tag is accepted either way, `1.2.3` or `v1.2.3`, so a repo does not have to settle its
convention before this works. Both resolve to `v1` and `v1.2`: the floating tags always carry the
`v`, because that is what a `uses:` line resolves.

Mixed conventions in one repo's history are also fine. The comparison runs on the version with the
`v` stripped, so `1.2.4` and `v1.2.10` sort against each other correctly.

## Repos with no Releases

`require-newest` reads GitHub Releases through `gh release list`, not git tags, because that is
where the prerelease and draft flags live.

A repo that pushes tags without publishing Releases has nothing for the check to read. The release
being published is then absent from the list, and rather than resolving nothing, the action resolves
the tag anyway. Set `require-newest: 'false'` on such a repo to say so outright and skip the API
call.

The read is capped at the 200 most recent releases. They come back newest first, so the newest
release of an older line is never the entry that falls off the end.

## Version numbers with more than three parts

Only `X.Y.Z` is accepted. A two-part `1.2` or a four-part `1.2.3.4` resolves nothing and says so
with a notice, rather than guessing which numbers are the major and the minor.
