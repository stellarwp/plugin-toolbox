# pr-comment

Finds, creates, updates or deletes a comment on a pull request or an issue. A comment that a
workflow keeps up to date is found by a hidden marker, its first line, and replaced on every run.

It calls the GitHub API through [actions/github-script](https://github.com/actions/github-script).
No third-party action is involved.

```yaml
- name: Post the result
  uses: stellarwp/plugin-toolbox/.github/actions/pr-comment@main
  with:
    marker: '<!-- my-check:example-org/my-plugin -->'
    body: |
      <!-- my-check:example-org/my-plugin -->
      The check passed.
```

Inside this repository, call it as `uses: $/.github/actions/pr-comment`.

A pull request comment is an issue comment in the API, so the action also works on issues.

## Inputs

| Input | Default | What it does |
|---|---|---|
| `operation` | `upsert` | `upsert`, `create`, `update`, `delete` or `find` |
| `marker` | empty | Hidden first line that finds the comment. Needed for `upsert` and `find`. For `update` and `delete` it finds the comment when there is no `comment-id` |
| `body` | empty | The comment text. Give `body` or `body-file`, not both |
| `body-file` | empty | Path of a file that holds the comment text. Prefer it for long text |
| `comment-id` | empty | The comment to `update` or `delete`, instead of searching by `marker` |
| `issue-number` | the pull request or issue of the event | The pull request or issue to read and write |
| `repository` | current repository | The `<owner>/<repo>` of the comment |
| `token` | `github.token` | Reads and writes the comment. See [Permissions](#permissions) |

## Outputs

| Output | What it is |
|---|---|
| `comment-id` | The comment found, created, updated or deleted. Empty when there was none |
| `comment-url` | Link to the comment. Empty when there was none, and after a delete |
| `result` | `created`, `updated`, `deleted`, `found` or `not-found` |

## Operations

- `upsert` replaces the comment that starts with `marker`, or creates one. This is the one a check
  that reports on every push wants.
- `create` always adds a comment.
- `update` replaces the text of a comment. It fails when there is no comment to update.
- `delete` removes a comment. A comment that is already gone is not an error, so a repeated run
  stays green and reports `not-found`.
- `find` only looks. It reports `not-found` and does not fail when nothing matches.

## The marker

A comment matches when its body starts with the marker. The first match, the oldest comment, wins.
The author does not matter, so the comment is still found when a caller passes a personal access
token or an app token. A person who quotes the marker writes `> <!-- ... -->`, which does not match.

Use a marker that names the repository, such as `<!-- my-check:example-org/my-plugin -->`, so two
checks never share a comment.

When `marker` is set and the body does not start with it, the action writes the marker and a line
break in front of the body, so the next search always finds the comment.

An empty marker is refused where it would be used to find a comment: it would match every comment,
and an update or a delete could hit a comment a person wrote. A marker with a line break is refused
too, since it could never be the first line.

## The text

- An empty or blank body is refused before any request, instead of as a 422 from GitHub.
- A body longer than 65,536 characters is refused before any request, with its length in the message.
- Prefer `body-file` for long text. An environment variable holds at most 128 KiB on Linux.

## Permissions

The job needs the permission to write the comment: `pull-requests: write` for a pull request, or
`issues: write` for an issue.

```yaml
permissions:
  pull-requests: write
```

`github.token` is the token of the workflow that runs the action, so a repository needs no secret to
comment on its own pull requests.

On a pull request from a fork, the workflow token is read-only. The action does not look at forks, so
skip the step for them in the workflow, as in `if: github.event.pull_request.head.repo.full_name == github.repository`.
A refused write says this in its message.

## When the API fails

The step fails with the message. The action does not hide the error. Add `continue-on-error: true` to
the step when a comment must never fail the job:

```yaml
- name: Post the result
  continue-on-error: true
  uses: stellarwp/plugin-toolbox/.github/actions/pr-comment@main
  with:
    marker: ${{ env.COMMENT_MARKER }}
    body-file: comment.md
```

## From another action's script

`pr-comment.js` is a plain Node module. Each function takes an Octokit, so a script that github-script
runs can pass the client it was given:

```js
const { upsertComment } = require('../pr-comment/pr-comment.js')

const { id, created } = await upsertComment({ github, owner, repo, issue, marker, body })
```

The module exports `findComment`, `createComment`, `updateComment`, `deleteComment` and
`upsertComment`, which read and write the same way as the operations above.

The path is relative to the file that requires it. github-script's own `require` resolves against the
workspace of the repository being built, which is why an action's manifest passes
`${{ github.action_path }}`. A file loaded that way is an ordinary module, so its own `require`
resolves against itself.

## Two jobs at once

Two jobs that upsert the same marker at the same moment can both create a comment. There is no
locking. Make the second job wait for the first with `needs`.

## How it runs

The logic is in `pr-comment.js`, run by actions/github-script, which supplies the Node runtime and an
Octokit already authenticated with `token`. There is no dependency to install and no bundle to
build: the file in the repository is the file that runs.

Inputs reach the script through `process.env`, never by being interpolated into it, so a comment body
is data and cannot become part of the program.

`tests/actions/pr-comment/pr-comment.test.js` drives the real Octokit with the network replaced, so
the assertions are the requests this action would send. Run `npm install` once, then `node --test`.
