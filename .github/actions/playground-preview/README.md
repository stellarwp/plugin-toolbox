# playground-preview

Writes one comment on a pull request with links that open the pull request's build in
[WordPress Playground](https://playground.wordpress.net/), a throwaway WordPress in the browser,
and a link to download the zip. While the zip is built the comment says "building". If the build
fails it says "failed", with a link to the run.

Most repositories do not use this action directly. They call the reusable workflow
[`.github/workflows/playground-preview.yml`](../../workflows/playground-preview.yml), which builds
the zip, runs this action and keeps the comment up to date. A caller to copy is in
[`templates/workflows/playground-preview.yml`](../../../templates/workflows/playground-preview.yml):

```yaml
on:
  pull_request:
    types: [opened, reopened, synchronize]

concurrency:
  group: playground-preview-${{ github.event.pull_request.number }}
  cancel-in-progress: true

permissions:
  contents: read

jobs:
  playground-preview:
    permissions:
      contents: read
      pull-requests: write
    uses: stellarwp/plugin-toolbox/.github/workflows/playground-preview.yml@main
    secrets:
      s3-bucket: ${{ secrets.ZIP_S3_BUCKET }}
      s3-access-key-id: ${{ secrets.ZIP_S3_ACCESS_KEY_ID }}
      s3-secret-access-key: ${{ secrets.ZIP_S3_SECRET_ACCESS_KEY }}
      s3-region: ${{ secrets.ZIP_S3_REGION }}
      s3-endpoint: ${{ secrets.ZIP_S3_ENDPOINT }}
```

## What the repository needs

- A `.puprc` that builds the plugin, as for the release zip. The zip is built by
  [stellarwp/github-actions' `zip.yml`](https://github.com/stellarwp/github-actions/blob/main/.github/workflows/zip.yml)
  with pup.
- A `pup` Composer script that puts `pup.phar` in `bin/` and runs it:

  ```json
  "pup": [
    "test -f ./bin/pup.phar || curl -o bin/pup.phar -L -C - https://github.com/stellarwp/pup/releases/download/2.0.0/pup.phar",
    "@php bin/pup.phar"
  ]
  ```

- The bucket secrets, passed one by one. `secrets: inherit` only works when the caller and this
  repository are in the same organization.
- Nothing else for the default preview. Blueprint files only if you want more than the default.

## The comment

```
🎉 Playground preview ready for commit 15e470c

[Built 01/15 05:43 PM EST]

- 🛝 Try in WordPress Playground
- 🛝 Try in WordPress Playground (With sample data)
- 💾 Download zip

Debug output is on.
With sample data: 100 sample orders in test mode. Opens a few minutes slower.
```

One comment per pull request, replaced on every push. It is found by a hidden first line,
`<!-- playground-preview:<owner>/<repo> -->`. Pull requests from forks get no preview: their runs
cannot see the bucket secrets, and their token cannot write a comment.

## Blueprints

A [blueprint](https://wordpress.github.io/wordpress-playground/blueprints/) is a JSON file that
tells Playground what to set up. Each blueprint file is one link in the comment.

With no `blueprints` input, the default blueprint next to this action is used. It works for any
plugin: it installs the zip, activates it, turns on `WP_DEBUG` and `WP_DEBUG_DISPLAY`, logs in and
opens the plugins screen.

Anything specific to a plugin goes in the plugin's own blueprint file, not in a workflow input: the
landing page, the theme, extra plugins, WP-CLI steps, PHP and WordPress versions. Put the files in
the repository, for example in `.github/playground/`, and list them:

```yaml
    with:
      blueprints: |
        .github/playground/blueprint.json
        .github/playground/blueprint-sample-data.json
```

Two examples to copy are in [`templates/playground/`](../../../templates/playground/).

The rules:

- `{{ZIP_URL}}` is replaced with the link to the pull request's zip. Every blueprint has to use it,
  usually in an `installPlugin` step. A file without it fails the run, because its link would not
  show the pull request at all.
- Any other `{{NAME}}` in capitals fails the run, so a typo does not reach Playground. Other text,
  such as PHP in a `wp eval` command, is left alone.
- `meta.title` is the link's label: `Try in WordPress Playground (<title>)`. A file without one gets
  `Try in WordPress Playground`. With several files, at most one may have no title, and no two may
  share one.
- `meta.description` is a short note under the links.
- `meta` and `$schema` are removed before the blueprint goes into the link. Playground does not use
  them, and Playground's schema would also ask for `meta.author`. An editor that reads `$schema`
  may warn about the missing `author` and `title`; the warning does not matter here.

## The link

The blueprint goes into the link itself, as base64 JSON in the URL hash:
`https://playground.wordpress.net/#eyJzdGVwcyI6...`. Nothing is hosted anywhere, and private
repositories work the same as public ones.

- The hash never leaves the browser, so no server limit on the length of a request applies.
- base64 is plain ASCII, so a Markdown link keeps it as it is, and it is shorter than
  percent-encoded JSON. Playground reads the bytes as UTF-8, so text like `Café` survives.
- A blueprint with sample data and an extra plugin makes a link of about 1,300 characters.

The limit that applies first is GitHub's: a comment can hold at most 65,536 characters. When the
links would make the comment longer, the run fails and names each link's length. Make the largest
blueprint smaller, for example by moving setup into a plugin or a WP-CLI command.

## The zip link

pup names the zip after the version, the commit time and the commit hash, for example
`my-plugin.1.2.0-dev-1793396265-15e470cb.zip`. The shared zip workflow has no outputs, so the
reusable workflow asks pup for the same name again after the build, and adds it to `zip-link-base`
(`https://evnt.is/test-zip?file=` by default, the public link to the packaging bucket).

To skip the build and use a zip from elsewhere, pass `zip-url`. No secret is needed then. This is
how a repository with its own zip workflow uses this, and how to test it without bucket secrets.

## The check names

A job in a called workflow reports as `<caller job id> / <job name>`. With the template's job id,
the checks are `playground-preview / Playground preview start`, `playground-preview / Zip / ...`,
`playground-preview / Playground preview` and, after a failure, `playground-preview / Playground
preview failed`. Update branch protection if it required the old names.

## Inputs of the workflow

| Input | Default | What it does |
|---|---|---|
| `blueprints` | empty: the default blueprint | Blueprint files, one per line. Each is one link |
| `php-version` | `7.4` | PHP that builds `vendor/`. Use the oldest the plugin supports |
| `i18n` | `no` | `yes` runs `pup i18n` in the build |
| `additional-commands` | empty | Run after `pup build`, before `pup package`. Prefer `.puprc` |
| `zip-url` | empty: build the zip | Use this zip instead of building one |
| `zip-link-base` | `https://evnt.is/test-zip?file=` | Public link to the bucket. The zip name is added to the end |
| `runs-on` | `ubuntu-latest` | Runner of the job that posts the links |
| `time-zone` | `America/New_York` | Time zone of the badge |

| Secret | Needed | What it does |
|---|---|---|
| `s3-bucket`, `s3-access-key-id`, `s3-secret-access-key`, `s3-region`, `s3-endpoint` | unless `zip-url` is set | Upload the zip. A missing one fails the first job with its name |
| `bot-token` | no | Checks out the repository for the build. Defaults to the workflow's token |
| `jenkins-secret` | no | The shared zip workflow requires it, for Slack messages this workflow never sends |
| `composer-token` | no | Private Composer packages |
| `package-token` | no | Private npm or bun packages |

### Permissions the caller grants

```yaml
permissions:
  contents: read        # check out the repository
  pull-requests: write  # the sticky comment
```

A called workflow can only lower these. If the caller grants less than a job asks for, GitHub does
not start the run.

## Inputs of the action

| Input | Required | Default | What it does |
|---|---|---|---|
| `status` | yes | | `building`, `ready` or `failed` |
| `zip-url` | for `ready` | | The zip. Must be https |
| `blueprints` | no | the default blueprint | Blueprint files, read from the checkout |
| `comment-marker` | no | `<!-- playground-preview:<owner>/<repo> -->` | First line of the comment |
| `time-zone` | no | `America/New_York` | Time zone of the badge |
| `sha` | no | the pull request's head commit | The commit the comment names |
| `pull-request` | no | the pull request of the event | Where to comment |
| `token` | no | `github.token` | Needs `pull-requests: write` |

## Running it locally

You need Node 20 or newer. From a checkout of this repository, print the comment for any zip and
your blueprint files:

```bash
node .github/actions/playground-preview/playground-preview.js \
  --zip-url 'https://evnt.is/test-zip?file=my-plugin.1.2.0-dev-1793396265-15e470cb.zip' \
  ../my-plugin/.github/playground/blueprint.json \
  ../my-plugin/.github/playground/blueprint-sample-data.json
```

With no file, the default blueprint is used. Nothing is posted. Open a link from the output to try
the blueprint. A file that breaks a rule above exits 1 with the reason.

## How it is tested

`tests/actions/playground-preview/` loads the script in `node --test`, with the real
`@actions/core` and a real Octokit whose network is replaced, so the tests assert the API requests
the action would send. It also runs the script from the command line. Run `npm install` once, then
`node --test`.
