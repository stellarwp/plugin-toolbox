# download-plugins

Downloads WordPress plugins from GitHub releases or WordPress.org into a directory on the runner.
Use it when a workflow needs plugins that are not part of the repository it checked out, such as a
plugin a test suite depends on or code a static analysis has to read.

```yaml
- name: Download the plugins
  uses: stellarwp/plugin-toolbox/.github/actions/download-plugins@v1
  with:
    plugins: |
      woocommerce
      stellarwp/woocommerce-subscriptions
    token: ${{ secrets.GH_BOT_TOKEN }}
```

Inside this repository, call it as `uses: $/.github/actions/download-plugins`.

By default each plugin is placed next to the checkout, as `../<name>`. `destination` picks another
directory:

```yaml
- uses: stellarwp/plugin-toolbox/.github/actions/download-plugins@v1
  with:
    plugins: woocommerce
    destination: tests/_plugins
```

[`phpstan.yml`](../../workflows/phpstan.yml) uses the default, so the `scanDirectories` setting in
the PHPStan config reaches the plugins as `../<name>`.

## Inputs

| Input | Required | Default | What it does |
|---|---|---|---|
| `plugins` | no | empty | The plugins to download, one per line. See [What a line can be](#what-a-line-can-be). An empty string (`''`) downloads nothing and succeeds |
| `token` | no | empty, which uses `github.token` for `gh` | Reads private releases and private Composer packages. See [Permissions](#permissions) |
| `destination` | no | the directory that holds the checkout | Where the plugins go, as `<destination>/<name>`. Relative to the workspace or absolute, and created when missing |

## Outputs

| Output | Example | What it is |
|---|---|---|
| `paths` | `/home/runner/work/woocommerce` | The absolute directory of each plugin placed, one per line |

## What a line can be

| Line | Where it comes from | Directory name |
|---|---|---|
| `owner/name` | The latest release of that GitHub repository, downloaded with `gh`: its built `.zip` asset when it has one, else the source archive. See [Release assets](#release-assets) | `name` |
| `woocommerce` | The latest stable release of that WordPress.org plugin | `woocommerce` |

Anything else, such as a path or a name with other characters, fails before anything is downloaded. So do two lines whose directory name is the same, such as `acme/calendar` and `community/calendar`, because the second would replace the first.

## What it does for each plugin

- Downloads and unpacks the archive, and places it at `<destination>/<name>`.
- Replaces a copy a previous job left there, so the new one is never nested inside the old one.
- Fails when the plugin would land on the checkout or on a directory that holds it, even through a symlink, because the old copy is deleted first and the checkout is never replaced.
- Runs `composer install` in a GitHub plugin that has a `composer.json` and came from a source archive, with `token` for private packages. A release asset and a WordPress.org plugin never get it: their zips ship `vendor/`, and `composer install` would not reproduce a build (such as Strauss's `vendor-prefixed/`) but could undo it. A WordPress.org plugin's `composer.json` is also code the caller does not control.

## Release assets

The tag's source archive has no build output, so for `owner/name` the action first reads the latest release's assets:

- Zip names marking source or auxiliary files (`source`, `src`, `dev`, `test`, `docs`) are ignored, and so is anything that is not a `.zip`.
- One zip left: that is the plugin. Several left: the one whose name starts with the repository name is taken when it is the only one; otherwise the run fails and lists them, rather than guess.
- No zip left: the source archive is downloaded and `composer install` runs, exactly as before.

The directory inside the zip does not matter. `stellarwp/learndash-core` publishes `sfwd-lms.<version>.zip` holding `sfwd-lms/`, and it is still placed at `../learndash-core`. The asset is downloaded with the same `token` as the release lookup.

## Permissions

The workflow token cannot read another private repository. A private `owner/name` plugin, or a
private Composer package one of the plugins requires, needs a PAT or app token passed as `token`.
An empty `token` makes `gh` use `github.token` and gives Composer no token, which is enough for public
releases and for WordPress.org.

## How it runs

The logic is in `download.js`, run by [actions/github-script](https://github.com/actions/github-script),
which supplies the Node runtime. The downloads are the `gh`, `curl`, `unzip` and `composer` commands
the runner already has. There is no dependency to install and no bundle to build: the file in the
repository is the file that runs.

The script is loaded by path rather than inlined in the manifest, because github-script's `require`
resolves against the workspace of the repository being built, not this action's directory. The path
comes from `${{ github.action_path }}`.

Inputs reach the script through `process.env`, never by being interpolated into it, so a plugin name
is data and cannot become part of the program.

`tests/actions/download-plugins/download.test.js` covers the rules above, with stand-ins for the
commands so no network is needed. Run `npm install` once, then `node --test`.
