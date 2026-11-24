# analyze-hooks

Files the actions and filters a release adds, updates, deprecates or removes, and the views it
adds, changes or removes, as pending changelog entries, so the release notes name them.

```yaml
- uses: actions/checkout@v6
  with:
    ref: ${{ inputs.branch }}
    persist-credentials: false
    # The last release tag and the tree it points at are read from history.
    fetch-depth: 0

- uses: stellarwp/plugin-toolbox/.github/actions/analyze-hooks@v1

# Write the changelog and commit here, e.g. with the release-prep action: this action only writes
# change files.
```

Run it before the changelog is written, so its entries are processed with the rest. It commits
nothing: the step that commits the release preparation carries the files.

## What it writes

The checkout is compared with the last release tag reachable from `HEAD`: the newest tag of three
or four numeric parts, with or without a leading `v` (`6.18.3`, `v5.3.0`, `4.19.1.1`). A tag such as
`6.18.3-rc1` or `ft-002` is not a release.

| File in the changes directory | Entry |
|---|---|
| `analyze-hooks-added-filters.yaml` | ``Added filters: `a`, `b` `` |
| `analyze-hooks-updated-filters.yaml` | ``Updated filters: `a` `` |
| `analyze-hooks-deprecated-filters.yaml` | ``Deprecated filters: `a` `` |
| `analyze-hooks-removed-filters.yaml` | ``Removed filters: `a` `` |
| `analyze-hooks-added-actions.yaml` | ``Added actions: `a` `` |
| `analyze-hooks-updated-actions.yaml` | ``Updated actions: `a` `` |
| `analyze-hooks-deprecated-actions.yaml` | ``Deprecated actions: `a` `` |
| `analyze-hooks-removed-actions.yaml` | ``Removed actions: `a` `` |
| `analyze-hooks-added-views.yaml` | ``Added views: `src/views/v2/month.php` `` |
| `analyze-hooks-changed-views.yaml` | ``Changed views: `src/views/v2/list.php` `` |
| `analyze-hooks-removed-views.yaml` | ``Removed views: `src/views/v2/day.php` `` |

Each is a `patch` entry of type `tweak`, and a kind with nothing to list writes no file.

- **Hooks** are the `apply_filters`, `apply_filters_ref_array`, `apply_filters_deprecated`,
  `do_action`, `do_action_ref_array` and `do_action_deprecated` calls under `paths` whose name is a
  complete string literal. A name built
  from a variable, interpolation or concatenation is not listed, and neither is a call inside a
  comment, inside a string, or in the HTML of a template outside `<?php ... ?>`. The name can be on any line after
  the parenthesis. A hook is live while one of its calls is not a `_deprecated` one, deprecated when
  every call is, and gone when it has none. A hook is added when it is live now and was not at the
  tag, deprecated when it is deprecated now and was not, and removed when it is gone now and was
  live or deprecated. A hook that moved, or that still has another call elsewhere, is not listed.
  A call under a docblock that says `This filter is documented in` or `This action is documented in`
  re-uses a hook documented in another file, often in WordPress itself. It does not make a hook
  added or updated, and while it is there the hook is not listed as removed.
- **Updated hooks** are hooks in the same state in both trees whose docblocks have a `@since` line
  now that they did not have at the tag: a change to a hook's signature is recorded as one more
  line, such as `@since TBD Added the $type parameter.` The lines of every call's docblock are read
  together. A docblock belongs to a call when its `*/` is on the line directly above the line of
  the call, so a hook in an array or a template without a docblock of its own is not updated by the
  docblock of the hook or file above it.
- **Views** are the `.php` files matched by `views-paths` that were added, changed or removed since
  the tag. A renamed view is changed, under its new path. Each is named by its path in the
  checkout, `.php` included, so a reader with an override of the file finds it by that path.

The files are rewritten on every run, so a second run changes nothing and an entry whose change was
reverted is removed. An entry is not written again when another pending change file holds it, or
when a changelog file already carries it above the heading of the last release, or of the newest
release before it when the changelog has no section for that one: the lines a run
after the changelog was written finds. A changelog file carries an entry when a `* ` or `- ` line
has the entry's label and lists every one of its names in backticks. The label is the text before
the names, such as `Added filters:`, or for an entry with a type of its own, a label the
changelogger writes that type with, from `types` or `typeLabelOverrides`. The label can also be in
the heading above the line, where the `keepachangelog` strategy writes it. Text around the names,
such as a closing period or other names on the same line, does not matter. An entry of an earlier
release does not count, so a view changed in two releases is listed in both.

## What the repository needs

- A checkout with full history and tags: `fetch-depth: 0`. A shallow checkout that shows no release
  tag fails the step. A complete history with no release tag is a plugin before its first release:
  the action writes nothing and warns.
- A changelogger. The changes directory (`changesDir`, `changelog` by default), the files the
  changelog is written to and the labels of each type (`types` and `typeLabelOverrides`) are read
  from the `changelogger` section of `package.json`. Without one, the entries go to `changelog/`.

## A changelogger with its own types

A repository whose changelogger has a type per kind of change passes them as `types`. An entry with
a type of its own holds the names only, since the type's label already says what they are:

```yaml
- uses: stellarwp/plugin-toolbox/.github/actions/analyze-hooks@v1
  with:
    # PHP files only: a markdown file can quote a hook call.
    paths: |
      *.php
      :!vendor
      :!vendor-prefixed
    views-paths: |
      themes/ld30/templates
      themes/legacy/templates
      src/views
      includes/*/templates/*
    types: >-
      {"added-filters": "tweak: added filters", "updated-filters": "tweak: updated filters",
      "deprecated-filters": "deprecated: deprecated filters",
      "added-actions": "tweak: added actions", "updated-actions": "tweak: updated actions",
      "deprecated-actions": "deprecated: deprecated actions",
      "added-views": "tweak: added templates", "changed-views": "tweak: updated templates",
      "removed-views": "deprecated: deprecated templates"}
```

With these types a changed template is written as
``Tweak - Updated templates: `themes/ld30/templates/course.php` ``. An entry left out of `types`, here
the removed hooks, stays a `tweak` reading `Removed filters: …`.

## Inputs

| Input | Default | |
|---|---|---|
| `paths` | `src` | Where to search for hooks, one git pathspec per line. `*.php` matches every PHP file, `:!vendor` excludes a directory. |
| `views-paths` | `src/views` | Where the templates a theme can override live, one git pathspec per line. A `*` matches across directories: `includes/*/templates/*`. Empty lists no view. |
| `types` | | The changelog type per entry, as a JSON object in a string. Keys: `added-filters`, `updated-filters`, `deprecated-filters`, `removed-filters`, `added-actions`, `updated-actions`, `deprecated-actions`, `removed-actions`, `added-views`, `changed-views`, `removed-views`. |
| `working-directory` | | Where the repository is checked out. Empty is the workspace. |

## Outputs

| Output | |
|---|---|
| `tag` | The last release tag the checkout was compared with. |
| `files` | The change files written, one per line. Empty when nothing changed. |

## How it runs

The logic is in [`analyze-hooks.js`](analyze-hooks.js), run by `actions/github-script`, so there is
no dependency to install and nothing to build. It only reads git and writes change files, so it is
safe to run on any checkout.

Run its tests locally: `npm install` once in the toolbox, then
`node --test tests/actions/analyze-hooks/analyze-hooks.test.js`. They run the action against a real
git repository.
