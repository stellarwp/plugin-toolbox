# skip-drafts

Says whether the run is a draft pull request from a branch you want to leave alone until it is ready,
such as `release/` or `bucket/` branches that are updated all the time. The workflow decides what
skipping means, usually an `if:` on the steps that follow.

[`phpstan.yml`](../../workflows/phpstan.yml) uses it, and any other workflow can too:

```yaml
- name: Check for a draft to skip
  id: draft
  uses: stellarwp/plugin-toolbox/.github/actions/skip-drafts@v1
  with:
    prefixes: |
      release/
      bucket/

- name: Run the checks
  if: steps.draft.outputs.skip != 'true'
  run: composer test
```

Inside this repository, call it as `uses: $/.github/actions/skip-drafts`.

The workflow has to listen for `ready_for_review`, or a draft that was skipped does not run when it
is marked ready:

```yaml
on:
  pull_request:
    types: [opened, ready_for_review, reopened, synchronize]
```

## Inputs

| Input | Required | Default | What it does |
|---|---|---|---|
| `prefixes` | no | empty | Branch prefixes, one per line. A draft whose branch starts with one of them is skipped: `release/` skips a draft of `release/1.2`. An empty string (`''`) skips no draft |

## Outputs

| Output | Example | What it is |
|---|---|---|
| `skip` | `true` | `true` for a draft pull request from a branch that starts with a prefix. `false` for any other pull request, and for anything that is not a pull request |

## The rules

| Situation | `skip` |
|---|---|
| Anything but a pull request, such as a push or a manual run | `false` |
| A pull request that is ready for review | `false` |
| A draft whose branch starts with a prefix | `true` |
| A draft from any other branch | `false` |

The prefix has to match the start of the branch name: `release/` does not match `hotfix/release/1`.

## How it runs

The logic is in `skip.js`, run by [actions/github-script](https://github.com/actions/github-script),
so there is nothing to install and no bundle to build: the file in the repository is the file that
runs.

The script is loaded by path rather than inlined in the manifest, because github-script's `require`
resolves against the workspace of the repository being built, not this action's directory. The path
comes from `${{ github.action_path }}`.

Inputs reach the script through `process.env`, never by being interpolated into it, so a branch name
is data and cannot become part of the program.

`tests/actions/skip-drafts/skip.test.js` covers the rules above. Run `npm install` once, then
`node --test`.
