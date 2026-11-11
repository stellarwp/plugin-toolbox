# analyze-hooks

Files the actions and filters a release adds or removes, and the views it changes, as pending
changelog entries, so the release notes name them.

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
| `analyze-hooks-removed-filters.yaml` | ``Removed filters: `a` `` |
| `analyze-hooks-added-actions.yaml` | ``Added actions: `a` `` |
| `analyze-hooks-removed-actions.yaml` | ``Removed actions: `a` `` |
| `analyze-hooks-changed-views.yaml` | ``Changed views: `v2/list` `` |

Each is a `patch` entry of type `tweak`, and a kind with nothing to list writes no file.

- **Hooks** are the `apply_filters`, `apply_filters_ref_array`, `do_action` and
  `do_action_ref_array` calls under `paths` whose name is a complete string literal. A name built
  from a variable, interpolation or concatenation is not listed. The name has to be on the line
  of the call or on the next one. A hook is added when the current
  tree has it and the tag's tree does not, and removed the other way round, so a hook that moved,
  or that still has another call elsewhere, is not listed.
- **Views** are the `.php` files under `views-path` that changed since the tag, named by their path
  under that directory without `.php`.

The files are rewritten on every run, so a second run changes nothing and an entry whose change was
reverted is removed. An entry is not written again when another pending change file holds it, or
when a changelog file already carries it above the heading of the last release, or of the newest
release before it when the changelog has no section for that one: the lines a run
after the changelog was written finds. An entry of an earlier release does not count, so a view
changed in two releases is listed in both.

## What the repository needs

- A checkout with full history and tags: `fetch-depth: 0`. Without a release tag reachable from
  `HEAD` the action fails.
- A changelogger. The changes directory (`changesDir`, `changelog` by default), the files the
  changelog is written to and the label of each type are read from the `changelogger` section of
  `package.json`. Without one, the entries go to `changelog/`.

## A changelogger with its own types

A repository whose changelogger has a type per kind of change passes them as `types`. An entry with
a type of its own holds the names only, since the type's label already says what they are:

```yaml
- uses: stellarwp/plugin-toolbox/.github/actions/analyze-hooks@v1
  with:
    paths: |
      .
      :!vendor
      :!vendor-prefixed
    views-path: themes/ld30/templates
    types: >-
      {"added-filters": "tweak: added filters", "added-actions": "tweak: added actions",
      "changed-views": "tweak: updated templates"}
```

An entry left out of `types`, here the removed hooks, stays a `tweak` reading `Removed filters: …`.

## Inputs

| Input | Default | |
|---|---|---|
| `paths` | `src` | Where to search for hooks, one git pathspec per line. `:!vendor` excludes a directory. |
| `views-path` | `src/views` | The directory of the templates a theme can override. Empty lists no view. |
| `types` | | The changelog type per entry, as a JSON object in a string. Keys: `added-filters`, `removed-filters`, `added-actions`, `removed-actions`, `changed-views`. |
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
