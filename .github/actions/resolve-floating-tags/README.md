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

The two are separate so that either half can be used alone, and so that a repo can put its own steps
between them. See [Building between the two steps](#building-between-the-two-steps).

## Inputs

| Input | Required | Default | What it does |
|---|---|---|---|
| `tag` | yes | | The release tag, with or without a leading `v`, e.g. `1.2.3` or `v1.2.3` |
| `levels` | no | `'major minor'` | Which tags to resolve: `major` for `v1`, `minor` for `v1.2` |
| `allow-prereleases` | no | `'false'` | Let a prerelease own a tag whose line has had no stable release. See [Prereleases](#prereleases) |
| `repository` | no | current repo | The `<owner>/<repo>` whose tags and releases to read |
| `token` | no | `github.token` | Reads the repo's tags, and the prerelease flag of the tag passed in. Read access is enough |

## Outputs

| Output | Example | What it is |
|---|---|---|
| `tags` | `v1 v1.2` | The floating tags this version should own, shortest first. Empty when it should own none |
| `skipped` | `v1` | Tags a newer release of the same line already owns |
| `version` | `1.2.3` | The version without its leading `v`. Empty when the tag was rejected |

## Permissions

Reading the tags and the release needs no more than `contents: read`, which is what a workflow has by
default. A workflow that sets `permissions: {}` has to grant it.

`github.token` is the token of the workflow that runs this action, scoped to that repository, so a
repo calling this action reads its own tags with its own token and needs no secret.

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

Publishing out of order follows the same rule. Cutting 1.1.1 while `v1` points at 1.2.0 moves `v1.1`
and leaves `v1` alone.

A newer **major** never holds a lower one back, because it is not in the same line. With 2.1.0
released, publishing 1.2.4 as the newest 1.x still resolves both `v1` and `v1.2`. Someone pinned to
`@v1` asked for the 1.x line, so a backport on it goes to them.

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

## Versions below 1.0.0

A 0.x release resolves `v0` and `v0.1`. The lines are compared as any others are: a 0.1.2 backport
published while 0.2.0 is out moves `v0.1` and leaves `v0` on 0.2.0.

Semver puts breaking changes in the minor below 1.0.0, so `v0` carries them where `v1` does not.
This repo writes `v0` regardless: it tracks the newest 0.x, and a consumer pinning it receives every
0.x release, breaking or not.

`levels: minor` resolves `v0.1` and no `v0`, for a repo that does not want to publish a `v0`.

## Prereleases

A prerelease is skipped by default, and it is detected without the caller passing anything.

Two signals are read, because either can occur alone. A tag with a suffix, `1.3.0-rc.1`, is a
prerelease on its own. A tag that is a plain `1.3.0` but marked as a prerelease on GitHub is not
visibly different, so the release behind the `tag` input is asked about directly.

Build metadata is not a prerelease. `1.4.0+build.7` is a stable 1.4.0 and owns the tags a stable
1.4.0 would. The metadata is not part of a tag name, so it resolves `v1` and `v1.4`.

`allow-prereleases: 'true'` lets a prerelease own a floating tag, but only one whose line has had no
stable release yet. A prerelease never takes a tag away from a stable release.

Publishing 1.4.0-rc.1 while the newest stable release is 1.3.0:

| Tag | Line it covers | Stable release in that line | Result |
|---|---|---|---|
| `v1` | every 1.x | 1.3.0 | stays at 1.3.0 |
| `v1.4` | every 1.4.x | none yet | moves to 1.4.0-rc.1 |

So `@v1.4` is how someone opts into testing the 1.4 line before it ships, and `@v1` keeps handing
everyone else the newest stable release.

Each rc replaces the one before it on `v1.4`, and 1.4.0 then replaces the last rc. Only stable
releases are counted when finding the newest in a line, so rc.1 does not block rc.2, and neither rc
blocks 1.4.0:

| Publishing | Stable releases so far | `v1` | `v1.4` |
|---|---|---|---|
| 1.4.0-rc.1 | 1.3.0 | stays at 1.3.0 | created, at rc.1 |
| 1.4.0-rc.2 | 1.3.0 | stays at 1.3.0 | moves to rc.2, replacing rc.1 |
| 1.4.0 | 1.3.0, 1.4.0 | moves to 1.4.0 | moves to 1.4.0, replacing rc.2 |
| 1.4.1-rc.1 | 1.3.0, 1.4.0 | stays at 1.4.0 | stays at 1.4.0 |

The last row follows from the same rule. The test is whether the line has ever had a stable release,
not which version is higher, so once 1.4.0 has shipped the 1.4 line has a stable release in it and
no later 1.4 prerelease can take either tag. Publishing an rc out of order behaves the same way:

| Publishing | Stable releases | `v1` | `v1.4` |
|---|---|---|---|
| 1.4.0-rc.1 | 1.5.0 | stays at 1.5.0 | created, at rc.1 |
| 1.4.0-rc.1 | 1.4.0, already shipped | stays at 1.4.0 | stays at 1.4.0 |

Prereleases of one version are not ordered against each other, so republishing 1.4.0-rc.1 after
rc.2 moves `v1.4` back to rc.1. Ordering them would mean comparing prerelease identifiers by semver
precedence, which `sort -V` does not do. Stable releases are ordered, and are never moved backwards.

The same rule gives a brand new major line to its own prerelease. Publishing 2.0.0-rc.1 with no
stable 2.x released resolves `v2` and `v2.0`, since nothing stable is behind either tag.

A prerelease never blocks a released version either. A suffixed tag is not counted when working out
the newest version of a line, so an outstanding 1.9.0-rc.1 does not hold `v1` back from 1.3.1.

## Where the versions come from

The newest version of a line is read from the repository's git tags, through `repos.listTags` with
Octokit's `paginate`. Every tag is read, however many there are.

A release listing is not used for it. Releases come back ordered by publication date and capped by
a page limit, so on a repo with more releases than the limit a high version published long ago sits
past the end. The comparison would then find nothing newer than the release being published and move
`v1` backwards onto it. Publishing 1.2.5 on a repo whose 1.5.0 is old enough to fall past the cap is
exactly the case that breaks, and it breaks silently. Tags have no such cap, and a draft release is
excluded for free, since a draft has no tag.

The Releases API is needed for one thing: whether the release behind the `tag` input is marked as a
prerelease. That is one `repos.getReleaseByTag` call for that tag, not a listing.

A tag whose name is a plain version therefore counts as a released version, even if the release
behind it is marked as a prerelease on GitHub. A suffixed tag never counts, whatever it is marked
as. This affects only which version is treated as the newest of a line, and it errs toward holding a
floating tag where it is.

## A failed read stops the job

If the tag list or a release's prerelease flag cannot be read, the step fails and no tag is written.

An empty tag list cannot stand in for a failed one. A repository with no tags returns the same empty
list, and the comparison reads that as nothing being newer, so every requested tag would move. After
a failed read the tags move to whatever was published most recently: publishing a 1.2.5 backport
would move `v1` from 1.5.0 to 1.2.5.

An unreadable prerelease flag cannot stand in for `false` either. A release GitHub marks as a
prerelease would take the tags with `allow-prereleases` off.

Re-run the workflow to retry. No tag moved, so there is nothing to undo.

A 404 from the release lookup is not a failure. A tag with no release behind it returns one, and it
counts as not a prerelease, so a repository that pushes tags without publishing Releases is
unaffected.

## Building between the two steps

A repo that commits build output at release time has a commit to make before it knows which commit
the tags should point at. The two actions are separate partly for this: this one reads only tag
names and the release, so it can run before the build, and move-git-tags takes the commit as an
input rather than using the one the workflow started on.

```yaml
- name: Resolve the floating tags for the released version
  id: floating
  uses: stellarwp/plugin-toolbox/.github/actions/resolve-floating-tags@v1
  with:
    tag: ${{ github.event.release.tag_name }}

- name: Build, commit and push on top of the released commit
  id: build
  run: |
    # ... build, commit, and push the commit to a branch ...
    echo "sha=$(git rev-parse HEAD)" >> "$GITHUB_OUTPUT"

- name: Point the release tag and the floating tags at the build
  uses: stellarwp/plugin-toolbox/.github/actions/move-git-tags@v1
  with:
    tags: ${{ github.event.release.tag_name }} ${{ steps.floating.outputs.tags }}
    sha: ${{ steps.build.outputs.sha }}
```

The release tag is just another name to move-git-tags, so it can be moved in the same call. Moving
it through the API rather than by force-pushing is what keeps the Release attached to it.

Which tags are resolved does not depend on where the build lands. Tag names are what this action
reads, and a build commit changes what a tag points at, not what it is called, so running it before
or after the build gives the same answer.

The build commit has to be pushed before any tag can point at it. A ref can only name an object the
remote already has, so moving a tag to a commit that exists only on the runner fails.

## How it runs

The logic is in `resolve.js`, run by [actions/github-script](https://github.com/actions/github-script),
which supplies the Node runtime and an Octokit already authenticated with `token`. There is no
dependency to install and no bundle to build: the file in the repository is the file that runs, so a
change to it is reviewable as a diff.

The script is loaded by path rather than inlined in the manifest, because github-script's `require`
resolves against the workspace of the repository being built, not this action's directory. The path
comes from `${{ github.action_path }}`.

Inputs reach the script through `process.env`, never by being interpolated into it, so a tag name is
data and cannot become part of the program.

`tests/actions/resolve-floating-tags/resolve.test.js` covers the rules above. It drives the
real Octokit with the network replaced, so the assertions are the requests this action would
send. Run `bun install` once, then `node --test`.
