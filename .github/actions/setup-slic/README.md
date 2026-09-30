# setup-slic

Checks out [slic](https://github.com/stellarwp/slic), configures it for CI and provisions the
WordPress stack. It stops there. Running a Codeception suite is
[run-slic-suite](../run-slic-suite/), and a job that drives something other than Codeception, such
as Playwright, calls its own commands after this action instead.

```yaml
- uses: stellarwp/plugin-toolbox/.github/actions/setup-slic@v1
  with:
    php-version: ${{ matrix.php-version }}
    target: sfwd-lms
```

## Inputs

| Input | Required | Default | What it does |
|---|---|---|---|
| `php-version` | yes | | PHP version to set in slic, e.g. `8.3` |
| `target` | yes | | The `slic use` target |
| `here-dir` | no | the workspace | Directory `slic here` runs in. Must be the parent of the target checkout |
| `ref` | no | `main` | slic branch, tag or commit |
| `slic-repository` | no | `stellarwp/slic` | Repository to check slic out from |
| `slic-path` | no | `slic` | Path in the workspace to check slic out into |
| `wp-version` | no | `latest` | `latest`, an explicit version like `6.6`, or `''` to keep the image's version |
| `services` | no | `''` | Extra slic services to start, e.g. `chrome`. See [Services](#services) |
| `composer-install` | no | `''` | Targets to run `slic composer install` for, one `<target> [args]` per line |
| `composer-cache-dir` | no | `''` | Host directory for `slic composer-cache set` |
| `prune-docker-networks` | no | `'false'` | Run `docker network prune -f` before each `slic use` |
| `verify-php-version` | no | `'true'` | Fail when the container's PHP does not match `php-version` |
| `debug-enabled` | no | `'false'` | Turn slic debug on and set the `debug-flag` output. See [Debug](#debug) |

## Outputs

| Output | What it is |
|---|---|
| `slic-bin` | Absolute path to the slic binary |
| `debug-flag` | `--debug` when debug is on for this run, empty otherwise |
| `target` | The target this action selected |

All three are also exported to the environment, as `SLIC_BIN`, `DEBUG_FLAG` and
`SLIC_TOOLBOX_TARGET`, so later steps in the job can call `${SLIC_BIN}` without wiring the output
through. `setup-slic` also exports
`SLIC_WP_DIR`, `SLIC_WORDPRESS_DOCKERFILE`, `SLIC_PHP_VERSION`, `SLIC_TOOLBOX_TARGET`, `SLIC`, `CI`,
`SSH_AUTH_SOCK` and `SSH_AGENT_PID`.

`SLIC_TOOLBOX_TARGET` is how [run-slic-suite](../run-slic-suite/) knows which target to run against
without being told again. slic records the current target in its own run settings file rather than
in the environment, so there is nothing else to read it from.

`SLIC_PHP_VERSION` is what pins the PHP version for the whole job. slic reads a value that is
already in the environment as a command-line override, and that override beats the version a
target's `slic.json` or `composer.json` asks for. `slic php-version set --skip-rebuild` alone only
stages a version, which the first `slic use` consumes; any later `slic use`, including one in your
own step, would otherwise switch the stack to that target's own PHP requirement.

## Setting the site up

This action provisions slic and the WordPress stack. It does not install themes, plugins, options
or fixtures. Do that in a `run:` step between this action and
[run-slic-suite](../run-slic-suite/), where wp-cli's full flag surface is available:

```yaml
- uses: stellarwp/plugin-toolbox/.github/actions/setup-slic@v1
  with:
    php-version: ${{ matrix.php-version }}
    target: sfwd-lms

- name: Set the site up for the suite
  run: |
    ${SLIC_BIN} wp theme install twentytwenty --activate
    ${SLIC_BIN} wp plugin install elementor --activate
    ${SLIC_BIN} wp plugin install woocommerce --version=8.5.0
```

## Debug

`debug-enabled: 'true'` runs `slic debug on` and `slic config`, and sets the `debug-flag` output and
the `DEBUG_FLAG` environment variable to `--debug`, which `run-slic-suite` appends to `slic run`.
Anything else runs `slic xdebug off` and leaves the flag empty.

It is honored on every event, so a workflow can hardcode it on a branch or a scheduled run:

```yaml
- uses: stellarwp/plugin-toolbox/.github/actions/setup-slic@v1
  with:
    php-version: ${{ matrix.php-version }}
    target: sfwd-lms
    debug-enabled: 'true'
```

Wiring it to a `workflow_dispatch` input needs no event check. On any other event the expression is
empty, which is not `'true'`:

```yaml
    debug-enabled: ${{ inputs.debug_enabled }}
```

## Services

`slic up` reads one positional argument and ignores the rest, so the action runs it once per entry
in `services`.

Pass `services: chrome` to start the Selenium container the WebDriver acceptance suites connect to.

Playwright does not belong in `services`. As of slic 2.5.0 it runs on the Microsoft image in its own
`playwright` service behind a Compose profile, and `slic playwright` starts that browser server
itself. Call `slic playwright test` in a step after this action.

## Checkout layout

`slic here` takes no path argument. It reads the current working directory and makes it slic's
plugins directory, so the target checkout has to be a child of it. That drives `here-dir`.

### Target checked out into a subdirectory

The workspace is the plugins directory and the default `here-dir` is correct.

```yaml
- uses: actions/checkout@v6
  with:
    path: sfwd-lms

- uses: stellarwp/plugin-toolbox/.github/actions/setup-slic@v1
  with:
    php-version: ${{ matrix.php-version }}
    target: sfwd-lms
```

### Target checked out at the workspace root

The workspace is the target, so `here-dir` has to be its parent.

```yaml
- uses: actions/checkout@v6
  with:
    fetch-depth: 1000
    submodules: recursive

- uses: stellarwp/plugin-toolbox/.github/actions/setup-slic@v1
  with:
    php-version: '7.4'
    target: the-events-calendar
    here-dir: ${{ github.workspace }}/..
    wp-version: '6.6'
    services: chrome
    composer-install: |
      the-events-calendar/common --no-dev
      the-events-calendar
    composer-cache-dir: /home/runner/.cache/composer
    prune-docker-networks: 'true'
    verify-php-version: 'false'
```

On this layout slic itself is checked out into `slic/` inside the target. Set `slic-path` if that
collides with anything in the repo.

### Theme target

slic resolves a `use` target to a plugin, a theme or a site, so a theme repo uses this action the
same way a plugin does. The one extra requirement is the name of the `here-dir`: `slic here` points
SLIC_THEMES_DIR at the current directory only when that directory is named `themes`, and otherwise
leaves it pointing at slic's own themes directory, where the checkout is not.

```yaml
- uses: actions/checkout@v6
  with:
    path: themes/my-theme

- uses: stellarwp/plugin-toolbox/.github/actions/setup-slic@v1
  with:
    php-version: ${{ matrix.php-version }}
    target: my-theme
    here-dir: ${{ github.workspace }}/themes
```
