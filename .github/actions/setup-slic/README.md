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
| `target` | yes | | The `slic use` target |
| `php-version` | recommended | slic resolves it | PHP version to set in slic, e.g. `8.3`. See [PHP version](#php-version) |
| `here-dir` | no | the workspace | Directory `slic here` runs in. Must be the parent of the target checkout |
| `ref` | no | `main` | slic branch, tag or commit |
| `slic-repository` | no | `stellarwp/slic` | Repository to check slic out from |
| `slic-path` | no | `slic` | Path in the workspace to check slic out into |
| `wp-version` | no | `latest` | `latest`, an explicit version like `6.6`, or `''` to keep the image's version |
| `services` | no | `''` | Extra slic services to start, e.g. `chrome`. See [Services](#services) |
| `composer-install` | no | `''` | Targets to run `slic composer install` for, one `<target> [args]` per line |
| `composer-cache-dir` | no | `''` | Host directory for `slic composer-cache set` |
| `prune-docker-networks` | no | `'false'` | Run `docker network prune -f` before each `slic use` |
| `verify-php-version` | no | `'true'` | Fail when the container's PHP does not match `php-version`. No effect when `php-version` is empty |
| `debug-enabled` | no | `'false'` | Turn slic debug on and set the `debug-flag` output. See [Debug](#debug) |

## Outputs

| Output | What it is |
|---|---|
| `slic-bin` | Absolute path to the slic binary |
| `debug-flag` | `--debug` when debug is on for this run, empty otherwise |
| `target` | The target this action selected |
| `php-version` | The PHP version the stack is running, as `major.minor` |

All three are also exported to the environment, so later steps in the job can use them without
wiring an output through.

## PHP version

Naming a `php-version` sets it and then checks it, failing the job when the container disagrees.
A matrix over PHP versions has to name one, or every leg runs the same version.

Leaving it empty hands the choice to slic, which resolves it from the target in this order:

1. the target's `slic.json` `phpVersion`
2. the target's `composer.json` `config.platform.php`

Note the second is `config.platform.php`, not `require.php`. A target that declares
`require: {"php": ">=7.4"}` and no `config.platform.php` gives slic nothing to go on.

Either way the action reads the running version back out of the container and reports it, exports
it as `SLIC_PHP_VERSION`, and returns it as the `php-version` output. A job therefore always ends
up pinned to a known version, and the only question is who chose it. When slic chose, the action
says so with a warning.

## Environment

`setup-slic` exports variables of two kinds, and the name tells you which.

### Read by slic

These are slic's own interface. slic looks each one up by name, so the spelling is not ours to
choose.

| Variable | What slic does with it |
|---|---|
| `SLIC_WP_DIR` | Where slic keeps the WordPress install |
| `SLIC_WORDPRESS_DOCKERFILE` | Which Dockerfile the WordPress container builds from |
| `SLIC_PHP_VERSION` | Pins the PHP version for the job. See below |
| `SSH_AUTH_SOCK` | Forwarded into the containers |
| `CI` | slic's `is_ci()` checks it, alongside `GITHUB_ACTION` |

### Ours

slic reads none of these. The `SLIC_TOOLBOX_` prefix keeps them from colliding with a variable slic
may add later, and with anything else sharing the job's environment, where a short unprefixed name
is one any other action or tool could set as well.

| Variable | What it is for |
|---|---|
| `SLIC_TOOLBOX_TARGET` | The target this action selected, so `run-slic-suite` needs no target of its own |
| `SLIC_TOOLBOX_DEBUG_FLAG` | `--debug`, or empty, which `run-slic-suite` appends to `slic run` |

One exception carries no prefix. `SLIC_BIN` holds the path to the slic binary. slic does not read
it. It is how a job calls slic outside these actions, as the examples in this README do.

`SSH_AGENT_PID` is set by `ssh-agent` itself, so the cleanup step can kill the agent it started.

### Why SLIC_PHP_VERSION pins the job

slic treats a value already in the environment as a command-line override, and that override beats
the version a target's `slic.json` or `composer.json` asks for. `slic php-version set
--skip-rebuild` alone only stages a version, which the first `slic use` consumes; any later `slic
use`, including one in your own step, would otherwise switch the stack to that target's own PHP
requirement.

### Why SLIC_TOOLBOX_TARGET exists

slic records the current target in its own run settings file rather than in the environment, so
there is nothing else for [run-slic-suite](../run-slic-suite/) to read it from.

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

`debug-enabled: 'true'` runs `slic debug on` and `slic config`, and sets both the `debug-flag`
output and the `SLIC_TOOLBOX_DEBUG_FLAG` environment variable to `--debug`, which `run-slic-suite`
appends to `slic run`. Anything else runs `slic xdebug off` and leaves the flag empty.

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
