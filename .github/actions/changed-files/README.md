# changed-files

Says whether a pull request changes files you care about, so a workflow can skip work the change
cannot affect. A pull request that changes none of the files you list is not `changed`, and a push or
a manual run always is, so the work it guards still runs. It needs no checkout: the files of a pull
request come from the API.

[`phpstan.yml`](../../workflows/phpstan.yml) uses it with the globs of the files PHPStan reads, and
any other workflow can pass its own:

```yaml
- name: Check for changes that matter
  id: changes
  uses: stellarwp/plugin-toolbox/.github/actions/changed-files@v1
  with:
    changed-files: |
      *.php
      *composer.lock

- name: Run PHPStan
  if: steps.changes.outputs.changed == 'true'
  run: composer phpstan
```

Inside this repository, call it as `uses: $/.github/actions/changed-files`.

## Inputs

| Input | Required | Default | What it does |
|---|---|---|---|
| `changed-files` | no | empty | Globs, one per line. A pull request is `changed` only when it changes a file one of them matches. An empty string (`''`) is always `changed`. See [The globs](#the-globs) |
| `token` | no | `github.token` | Lists the files of the pull request. See [Permissions](#permissions) |

## Outputs

| Output | Example | What it is |
|---|---|---|
| `changed` | `true` | `true` when the pull request changes a matching file, and for anything that is not a pull request. `false` when the work can be skipped |

## The rules

The first row that fits decides:

| Situation | `changed` |
|---|---|
| Anything but a pull request, such as a push or a manual run | `true` |
| `changed-files` is an empty string (`''`) | `true` |
| The pull request changes 3,000 files or more, more than the files API lists | `true` |
| The pull request changes a file a glob matches, or the caller workflow file | `true` |
| Nothing matches | `false` |

The caller workflow file is the workflow that called this action, whatever it is named, so a change
to the workflow itself always gets checked.

## The globs

The matching is `globToRegExp` in [`.github/lib/glob.js`](../../lib/glob.js). A glob is matched against the whole path, and `*` also matches `/`, so `*.php` is every PHP file, in
any directory. `?` is one character and `[...]` a set of characters, as in bash: `[abc]`, `[a-z]` or `[!abc]`. POSIX classes such as `[[:digit:]]` are not supported. A renamed file counts under its old
name too, so moving a file out of a matched path still runs the analysis.

## Permissions

The job needs `pull-requests: read`, which is not the default when a workflow sets
`permissions: contents: read` at the top:

```yaml
jobs:
  phpstan:
    permissions:
      contents: read
      pull-requests: read
```

`github.token` is the token of the workflow that runs this action, so a repo calling it needs no
secret.

## How it runs

The logic is in `changes.js`, run by [actions/github-script](https://github.com/actions/github-script),
which supplies the Node runtime and an Octokit already authenticated with `token`. There is no
dependency to install and no bundle to build: the file in the repository is the file that runs.

The script is loaded by path rather than inlined in the manifest, because github-script's `require`
resolves against the workspace of the repository being built, not this action's directory. The path
comes from `${{ github.action_path }}`.

Inputs reach the script through `process.env`, never by being interpolated into it, so a glob or a
branch name is data and cannot become part of the program.

`tests/actions/changed-files/changes.test.js` covers the rules above. It drives the real Octokit
with the network replaced, so the assertions are the requests this action would send. Run
`npm install` once, then `node --test`.
