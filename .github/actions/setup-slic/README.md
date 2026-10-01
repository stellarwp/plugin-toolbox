# setup-slic

Checks out [slic](https://github.com/stellarwp/slic), configures it for CI and provisions the
WordPress stack. It stops there. Running a Codeception suite is
[run-slic-suite](../run-slic-suite/), and a job that drives something other than Codeception, such
as Playwright, calls its own commands after this action instead.

```yaml
jobs:
  tests:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6
        with:
          path: my-plugin

      - uses: stellarwp/plugin-toolbox/.github/actions/setup-slic@v1
        with:
          php-version: '8.3'
          target: my-plugin
          composer-install: my-plugin --no-interaction --prefer-dist

      - uses: stellarwp/plugin-toolbox/.github/actions/run-slic-suite@v1
        with:
          suite: wpunit
          upload-output-on-failure: 'true'
```

Replace the target and suite names with your project's values. This example installs Composer
dependencies inside Slic using the selected PHP version. On persistent runners, add the
[cleanup step](#cleanup) at the end of the job. These examples use the planned `v1` release;
while testing this PR, use its branch or commit for each toolbox action.

Use Slic 2.5.1 or newer. These actions support Linux runners with Bash, Docker Compose, PHP,
Git, curl, jq and OpenSSH installed. Give each job its own Docker daemon. Slic uses shared
container names and `slic here` can tear down an existing stack, so concurrent jobs on a shared
Docker daemon are not supported.

## Updating from the initial action proposal

- Replace `debug-enabled` with independent `slic-debug` and `xdebug` setup inputs and the suite
  action's `debug` input. Slic logging now defaults to on. The `debug-flag` output and
  `SLIC_TOOLBOX_DEBUG_FLAG` environment variable are removed.

- Remove `prune-docker-networks` and `services`. Setup no longer prunes networks, and the standard
  stack already starts its dependencies.
- Remove `verify-php-version`. An explicit PHP version is always verified.
- Move `run-cleanup` out of the suite action and add [cleanup-slic](../cleanup-slic/) as a final
  step with `if: always()` when the runner needs cleanup.
- Set `wp-version: latest` explicitly if you want the newest WordPress release. The default now
  preserves the version in the image.

## Inputs

| Input | Required | Default | What it does |
|---|---|---|---|
| `target` | yes | | The `slic use` target |
| `php-version` | recommended | slic resolves it | PHP version to set in slic, e.g. `8.3`. See [PHP version](#php-version) |
| `here-dir` | no | the workspace | Directory `slic here` runs in. Must be the parent of the target checkout |
| `ref` | no | `main` | slic branch, tag or commit |
| `slic-repository` | no | `stellarwp/slic` | Repository to check slic out from |
| `slic-path` | no | `slic` | Path in the workspace to check slic out into |
| `wp-version` | no | `''` | `latest`, an explicit version like `6.6`, or `''` to keep the image's version |
| `composer-install` | no | `''` | Targets to run `slic composer install` for, one `<target> [args]` per line |
| `composer-cache` | no | `'true'` | Restore and save Composer downloads with `actions/cache@v6` |
| `composer-cache-dir` | no | auto-detect | Override the host cache directory mounted in Slic. See [Composer cache](#composer-cache) |
| `slic-debug` | no | `'true'` | Enable Slic diagnostic logging. See [Debug](#debug) |
| `xdebug` | no | `'false'` | Enable the PHP Xdebug extension for tests; disables PCOV when enabled |

## Outputs

| Output | What it is |
|---|---|
| `slic-bin` | Absolute path to the slic binary |
| `target` | The target this action selected |
| `php-version` | The PHP version the stack is running, as `major.minor` |

All three are also exported to the environment, so later steps in the job can use them without
wiring an output through.

## PHP version

Naming a `php-version` sets it and then checks it, failing the job when the container disagrees.
A matrix over PHP versions has to name one, or every leg runs the same version.

Leaving it empty hands the choice to slic, which resolves it from the target in this order:

1. an existing environment override or staged PHP version
2. the target's `.env.slic.local` PHP override
3. the target's `slic.json` `phpVersion`
4. the target's `composer.json` `config.platform.php`
5. Slic's configured default

The Composer setting is `config.platform.php`, not `require.php`. A target that declares
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

One exception carries no prefix. `SLIC_BIN` holds the path to the slic binary. slic does not read
it. It is how a job calls slic outside these actions, as the examples in this README do.

An existing usable SSH agent is reused. Otherwise setup starts an agent on a unique socket and
records its ownership for [cleanup-slic](../cleanup-slic/). It does not load private keys; provide
your own agent before setup if your dependencies need them.

### Why SLIC_PHP_VERSION pins the job

slic treats a value already in the environment as a command-line override, and that override beats
the version a target's `slic.json` or `composer.json` asks for. `slic php-version set
--skip-rebuild` alone only stages a version, which the first `slic use` consumes; any later `slic
use`, including one in your own step, would otherwise switch the stack to that target's own PHP
requirement.

### Why SLIC_TOOLBOX_TARGET exists

slic records the current target in its own run settings file rather than in the environment, so
the exported value tells [run-slic-suite](../run-slic-suite/) which target to restore. The action
uses `slic using` to check whether that target is already selected.

## Startup order

The action does not prune Docker networks. Older TEC workflows do this before target switches,
but pruning removes all unused networks on the Docker daemon, not just Slic's. If a runner has
address-pool exhaustion, diagnose it and manage cleanup separately from project selection.

The action selects the main target and resolves its PHP version before
installing Composer dependencies. That version is pinned for the rest of the job, so a shared
library's configuration cannot select a different PHP version during dependency installation.

Composer entries only call `slic use` when the target differs from Slic's current selection. After
installation, the main target is restored if needed. `run-slic-suite` performs the same check, so
running a suite for the already-selected target does not recreate the PHP containers. Switching
to a different target can still recreate containers in Slic.

Use Slic 2.5.1 or newer with `composer-cache-dir` to configure the cache without starting a stopped
stack. Older versions can start containers during that command, before target selection.

By default, the action keeps the WordPress version supplied by the image. Set `wp-version: latest`
explicitly when desired, or choose a version compatible with the job's PHP version.

`composer-install` accepts simple whitespace-separated arguments such as `--no-dev`. It is not a
shell script. Quoted values, shell expressions, and repeated arguments are not a supported
contract: Slic's legacy Composer runner also reconstructs command strings. Reliable support for
those cases needs an argument-preserving interface in Slic, not another layer of shell escaping
in this action. Host-side Composer installation is an option when it matches the intended PHP
version and requires more complex arguments.

## Composer cache

Setup configures the cache directory before starting Slic, then restores downloads after verifying
PHP and before dependency installation. It registers a post-job save using
`actions/cache@v6`. Composer still installs dependencies on every run; `vendor/` is not cached.
No extra cache step or directory input is needed for normal usage:

```yaml
- uses: stellarwp/plugin-toolbox/.github/actions/setup-slic@v1
  with:
    target: my-plugin
    composer-install: my-plugin
```

Exact cache keys include the runner OS, the main target and `composer-install` entries/options,
the verified PHP version, the selected projects' Composer manifests and lockfiles, and the UTC
week. Projects are located relative to `here-dir`, just as in the checkout examples. This covers
Common subdirectories, TEC-style sibling checkouts outside the workspace, themes with sibling
plugin dependencies, and site projects using `wp-content` or `content`. Check out all
projects and submodules before setup; unrelated projects and installed dependencies are not hashed.

PHP versions and different installation lists get separate exact keys so the first matrix job to
save does not prevent other jobs from saving their additional downloads. Restore prefixes first
try the same dependencies from an earlier week, then the same PHP/install combination, then other
PHP versions for that install list, and finally any available toolbox Composer cache for that OS.
Sharing downloaded packages is safe because Composer still installs for each environment.

Weekly rotation lets projects without lockfiles save newly downloaded package versions even when
their manifests have not changed. An exact hit is not saved again; a new key is saved when the job
succeeds. This trades some cache storage and a periodic upload for avoiding repeated downloads.
It does not pin dependency versions. Lockfiles remain the way to make installs reproducible.

The directory is chosen in this order:

1. An explicit `composer-cache-dir`.
2. Host Composer's `composer config cache-dir --absolute`, respecting `COMPOSER_CACHE_DIR`.
3. `${RUNNER_TEMP}/slic-composer-cache` when host Composer is unavailable and managed caching is on.

Relative paths are resolved from the action's starting working directory before changing to
`here-dir`, so the cache action and Docker mount use the same absolute path. Failed or empty host
Composer detection reports an error; an explicit input bypasses detection. Slic 2.5.1 or newer
is required to configure the cache without starting a stopped stack. The directory is created as
the runner user before Docker mounts it, including on the first run with no saved cache.

If your workflow already restores and saves the Composer cache through another action, disable
this action's cache management to avoid doing it twice:

```yaml
- uses: stellarwp/plugin-toolbox/.github/actions/setup-slic@v1
  with:
    target: my-plugin
    composer-cache: 'false'
    composer-cache-dir: /path/restored/by/your/cache/action
```

`composer-cache: 'false'` disables GitHub cache restore/save, not Composer's own cache. The directory
is still detected or taken from the explicit input and shared with Slic. If neither is available,
Slic's existing cache configuration is retained. Use this option too when your workflow needs a
custom key strategy, for example with custom target-directory overrides or when later steps
install additional projects not listed in
`composer-install` or vary dependency resolution in ways other than the selected PHP version.

`actions/cache@v6` uses Node 24 and requires Actions Runner 2.327.1 or newer on self-hosted runners.

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

Three independent settings control different kinds of debugging:

| Setting | Action | Default | Effect |
|---|---|---|---|
| `slic-debug` | `setup-slic` | `'true'` | Slic diagnostic logging and configuration output |
| `xdebug` | `setup-slic` | `'false'` | PHP Xdebug extension in the test containers |
| `debug` | `run-slic-suite` | `'false'` | Codeception's `--debug` output for that suite |

For example, enable Xdebug and detailed test output while turning Slic logging off:

```yaml
- uses: stellarwp/plugin-toolbox/.github/actions/setup-slic@v1
  with:
    target: my-plugin
    php-version: '8.3'
    slic-debug: 'false'
    xdebug: 'true'

- uses: stellarwp/plugin-toolbox/.github/actions/run-slic-suite@v1
  with:
    suite: wpunit
    debug: 'true'
```

Omit `slic-debug` to keep Slic logging on. Omit `xdebug` and the suite's `debug` input to leave
those features off. The suite action no longer inherits a debug flag from setup.

Setup applies `xdebug` after dependency installation and target restoration, to the containers
that tests will use. Enabling it runs `slic xdebug on --yes`, which also disables PCOV if needed.
Disabling it runs `slic xdebug off`. This input does not enable Xdebug for Composer installation,
configure an IDE connection, or request a coverage report.

Project `.env.slic.local` settings or later Slic commands can change these settings again. Keep
project configuration consistent with the workflow, particularly when switching targets later.
For Playwright or custom test commands, configure that runner's debug options in your own step.

## Playwright

The standard stack starts its dependencies, including Selenium, automatically. Extra `slic up`
commands are unnecessary. Playwright starts its own browser service when you run:

```yaml
- name: Run browser tests
  run: '"${SLIC_BIN}" playwright test'
```

Install your project's Node dependencies before that step. See
[Slic's Playwright guide](https://github.com/stellarwp/slic/blob/main/docs/playwright.md)
for browser fixtures and authentication setup.

## Cleanup

On a persistent runner, finish the job with the separate cleanup action. It works for Codeception,
Playwright and setup failures, and only stops an SSH agent created by setup:

```yaml
- name: Clean up slic
  if: always()
  uses: stellarwp/plugin-toolbox/.github/actions/cleanup-slic@v1
```

Place it after every step that needs Slic or its test artifacts. Ephemeral runners can omit it
because destroying the VM removes the containers and agent. Cleanup does not make concurrent
jobs on a shared Docker daemon safe.

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
    composer-install: |
      the-events-calendar/common --no-dev
      the-events-calendar
    composer-cache-dir: /home/runner/.cache/composer
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
