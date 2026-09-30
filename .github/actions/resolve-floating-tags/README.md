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
| `allow-prereleases` | no | `'false'` | Let a prerelease own a tag whose line has had no stable release. See [Prereleases](#prereleases) |
| `repository` | no | current repo | The `<owner>/<repo>` whose releases to read |
| `token` | no | `github.token` | Reads the release list. Read access is enough |

## Outputs

| Output | Example | What it is |
|---|---|---|
| `tags` | `v1 v1.2` | The floating tags this version should own, shortest first. Empty when it should own none |
| `skipped` | `v1` | Tags a newer release of the same line already owns |
| `version` | `1.2.3` | The version without its leading `v`. Empty when the tag was rejected |

## Each tag is resolved on its own

A tag is resolved only when no stable release of **its own line** is newer than the version being
released. The two tags are decided separately, so a release often takes one and not the other.

Releases 1.2.4 and 1.3.0 exist, so `v1` points at 1.3.0. Publishing 1.2.5, a patch on the older
line:

| Tag | Line it covers | Newest in that line | Result |
|---|---|---|---|
| `v1` | every 1.x | 1.3.0 | stays at 1.3.0 |
| `v1.2` | every 1.2.x | 1.2.5, the release being published | moves to 1.2.5 |

So consumers pinned to `@v1.2` get the patch, and consumers pinned to `@v1` keep 1.3.0 rather than
being moved back to older code. `v1` appears in `skipped` and `tags` holds `v1.2` alone.

This is also what makes publishing out of order safe. Cutting 1.1.1 while `v1` points at 1.2.0 moves
`v1.1` and leaves `v1` alone.

A newer **major** never holds a lower one back, because it is not in the same line. With 2.1.0
released, publishing 1.2.4 as the newest 1.x still resolves both `v1` and `v1.2`. Someone pinned to
`@v1` asked for the 1.x line, so a backport on it is theirs.

## Hotfix versions with a fourth part

A fourth part is read as another release of the same minor line, not a line of its own. A repo that
adds one only when a hotfix exists needs no configuration for it:

| Releases | `v1.2` points at | `v1` points at |
|---|---|---|
| 1.2.3 | 1.2.3 | 1.2.3 |
| 1.2.3, 1.2.3.1 | 1.2.3.1 | 1.2.3.1 |
| 1.2.3, 1.2.3.1, 1.2.4 | 1.2.4 | 1.2.4 |

Publishing the hotfix 1.2.3.1 moves `v1.2` to it, because it is the newest release of the 1.2 line.
Re-publishing 1.2.3 afterwards moves nothing, because the hotfix is newer.

There is no `patch` level and no `v1.2.3` tag. A hotfix is the newest patch of its minor, which the
line comparison already handles.

## Version numbers this accepts

At least three dot-separated numbers, with or without a leading `v`. Three or four parts are both
ordinary; `1.2.10.0` sorts above `1.2.9.9` as it should.

Three is the floor so that the deepest floating tag is always a shorter name than the release tag
itself. A release tagged `1.2` would want a `v1.2` floating tag, which on a `v`-prefixed repo is the
release tag. A two-part tag resolves nothing and says so with a notice.

A release tag is accepted either way, `1.2.3` or `v1.2.3`, so a repo does not have to settle its
convention before this works. Both resolve to `v1` and `v1.2`: the floating tags always carry the
`v`, because that is what a `uses:` line resolves. Mixed conventions across a repo's history are
fine, since every version is compared with the `v` stripped.

## Prereleases

A prerelease is skipped by default, and it is detected without the caller passing anything.

Two signals are read, because either can occur alone. A tag with a suffix, `1.3.0-rc.1`, is a
prerelease on its own. A tag that is a plain `1.3.0` but marked as a prerelease on GitHub is not
visibly different, so the flag is read from the release list, which this action fetches anyway.

Build metadata is not a prerelease. `1.4.0+build.7` is a stable 1.4.0 and owns the tags a stable
1.4.0 would. The metadata is not part of a tag name, so it resolves `v1` and `v1.4`.

`allow-prereleases: 'true'` lets a prerelease own a floating tag, but only one whose line has had no
stable release yet. A prerelease never takes a tag away from a stable release.

That is what makes the flag useful rather than dangerous. Publishing 1.4.0-rc.1 while the newest
stable release is 1.3.0:

| Tag | Line it covers | Stable release in that line | Result |
|---|---|---|---|
| `v1` | every 1.x | 1.3.0 | stays at 1.3.0 |
| `v1.4` | every 1.4.x | none yet | moves to 1.4.0-rc.1 |

So `@v1.4` is how someone opts into testing the 1.4 line before it ships, and `@v1` keeps handing
everyone else the newest stable release.

Each rc replaces the one before it on `v1.4`, and the stable release then takes the tag off the last
rc. Only stable releases are counted when finding the newest in a line, so rc.1 never stands in
rc.2's way, and neither of them holds 1.4.0 back:

| Publishing | Stable releases so far | `v1` | `v1.4` |
|---|---|---|---|
| 1.4.0-rc.1 | 1.3.0 | stays at 1.3.0 | created, at rc.1 |
| 1.4.0-rc.2 | 1.3.0 | stays at 1.3.0 | moves to rc.2, replacing rc.1 |
| 1.4.0 | 1.3.0, 1.4.0 | moves to 1.4.0 | moves to 1.4.0, replacing rc.2 |
| 1.4.1-rc.1 | 1.3.0, 1.4.0 | stays at 1.4.0 | stays at 1.4.0 |

The last row is the rule at work in the other direction. A line that has never had a stable release
is the whole test, not which version is higher, so once 1.4.0 has shipped the 1.4 line has a stable
release in it and no later 1.4 prerelease can take either tag. Publishing an rc out of order behaves
the same way:

| Publishing | Stable releases | `v1` | `v1.4` |
|---|---|---|---|
| 1.4.0-rc.1 | 1.5.0 | stays at 1.5.0 | created, at rc.1 |
| 1.4.0-rc.1 | 1.4.0, already shipped | stays at 1.4.0 | stays at 1.4.0 |

Prereleases of one version are not ordered against each other, so republishing 1.4.0-rc.1 after
rc.2 moves `v1.4` back to rc.1. Ordering them would mean comparing prerelease identifiers by semver
precedence, which `sort -V` does not do. Stable releases are ordered, and are never moved backwards.

The same rule gives a brand new major line to its own prerelease. Publishing 2.0.0-rc.1 with no
stable 2.x released resolves `v2` and `v2.0`, since nothing stable is behind either tag.

A prerelease never blocks a stable release either. Only stable releases are considered when working
out the newest release of a line, so an outstanding 1.9.0-rc.1 does not hold `v1` back from a stable
1.3.1.

## Repos with no Releases

The comparison reads GitHub Releases through `gh release list`, not git tags, because that is where
the prerelease and draft flags live. Drafts are left out, since their tag does not exist yet.

A repo that pushes tags without publishing Releases has nothing for the comparison to read. The
release being published is then absent from the list, so nothing can be newer than it and the tags
resolve on the tag name alone. The same path runs when the read fails outright, with a warning.

The read is capped at the 200 most recent releases. They come back newest first, so the newest
release of an older line is never the entry that falls off the end.
