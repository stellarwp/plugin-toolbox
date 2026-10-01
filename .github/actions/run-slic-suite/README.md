# run-slic-suite

Runs a Codeception suite through [slic](https://github.com/stellarwp/slic), uploads the suite's
output as an artifact when it fails. Stack cleanup is a separate action.

[setup-slic](../setup-slic/) has to run earlier in the same job. This action reads the three
variables it exports: `SLIC_BIN` to call slic, `SLIC_TOOLBOX_TARGET` for the target,
and `SLIC_PHP_VERSION` for the artifact name.
Without `SLIC_BIN` the action stops with a message saying so, rather than running the suite name
as a command.

```yaml
- uses: stellarwp/plugin-toolbox/.github/actions/setup-slic@v1
  with:
    php-version: ${{ matrix.php-version }}
    target: sfwd-lms

- uses: stellarwp/plugin-toolbox/.github/actions/run-slic-suite@v1
  with:
    suite: ${{ matrix.suite }}
```

## Inputs

| Input | Required | Default | What it does |
|---|---|---|---|
| `suite` | yes | | Codeception suite to run, e.g. `wpunit` |
| `target` | no | what `setup-slic` selected | The target to select if it differs from Slic's current target. Also the default output path |
| `suite-args` | no | `''` | Extra arguments for `slic run`, e.g. `--ext DotReporter` |
| `debug` | no | `'false'` | Append Codeception's `--debug` flag for this suite |
| `upload-output-on-failure` | no | `'false'` | Upload the test output directory when the suite fails |
| `output-path` | no | Selected project's `tests/_output` directory | Override with an absolute path or a path relative to the workspace |
| `output-artifact-name` | no | see [Artifact names](#artifact-names) | Name of the uploaded artifact |

## Debug output

Set `debug: 'true'` on this action for detailed Codeception output. It is independent of
setup's `slic-debug` (Slic logging, on by default) and `xdebug` (PHP extension, off by default).
There is no inherited debug flag from setup, so each suite can choose its own verbosity.

## When to pass target

Usually never. `setup-slic` exports the target it selected as `SLIC_TOOLBOX_TARGET` and this action
reads it, so a job names its target once.

The action checks `slic using` before running the suite. If an intervening step selected a fixture
plugin, it restores the setup target automatically. If the correct target is already selected, it
skips `slic use`, avoiding unnecessary PHP-container recreation.

Pass `target` only when the suite should run against a different target from the one setup selected.

`suite-args` accepts simple whitespace-separated options such as `--ext DotReporter`. Quoted
values, shell expressions, and repeated arguments are not a supported contract. Slic's legacy
Codeception runner reconstructs a shell command, so this needs an argument-preserving interface
in Slic before the action can promise general argument-array support. The action disables local
filename expansion, but that does not change Slic's downstream command handling.

## Artifact names

The default name includes the target, PHP version, suite, job ID, matrix index, run attempt, and
a unique step identifier. This keeps outputs separate across WordPress/PHP matrix entries,
repeated suite invocations, and reruns. Unsupported characters in the generated name are replaced
with `-`. Earlier attempts' artifacts remain available until their retention period expires.

Use `output-artifact-name` when you need a specific name. Explicit names are used as supplied,
with `overwrite: true`; include the dimensions that distinguish your jobs if you do not want one
upload to replace another.

## Output path

With `upload-output-on-failure: 'true'`, the action asks Slic for the selected project's host path
and uploads its `tests/_output` directory on failure. This handles root checkouts, subdirectories,
themes, and sites without repeating the checkout layout in the suite step. If Slic omits the host
path for a custom layout and it cannot be resolved as a built-in plugin target, the action asks
for an explicit `output-path` rather than guessing.

Set `output-path` only when your tests write elsewhere. An explicit relative path is relative to
the workspace, not the project. Absolute paths are also supported:

```yaml
- uses: stellarwp/plugin-toolbox/.github/actions/run-slic-suite@v1
  with:
    suite: wpunit
    output-path: custom-test-output/
    upload-output-on-failure: 'true'
```

## Multiple suites in one job

Set up once, run each suite, then clean up once. This example assumes a persistent Linux runner
with the required tools and a Docker daemon dedicated to the job:

```yaml
jobs:
  tests:
    runs-on: [self-hosted, linux]
    steps:
      - uses: actions/checkout@v6
        with:
          path: my-plugin

      - uses: stellarwp/plugin-toolbox/.github/actions/setup-slic@v1
        with:
          target: my-plugin
          php-version: '8.3'
          composer-install: my-plugin

      - uses: stellarwp/plugin-toolbox/.github/actions/run-slic-suite@v1
        with:
          suite: wpunit
          upload-output-on-failure: 'true'

      - uses: stellarwp/plugin-toolbox/.github/actions/run-slic-suite@v1
        with:
          suite: integration
          upload-output-on-failure: 'true'

      - name: Clean up slic
        if: always()
        uses: stellarwp/plugin-toolbox/.github/actions/cleanup-slic@v1
```

Normal GitHub step conditions apply: if the first suite fails, the next suite is skipped and
cleanup still runs. Both suites use the same stack; project-specific fixture resets belong in
your tests or an intervening workflow step. On ephemeral runners, the final cleanup step is optional.

## Cleanup

On persistent runners, use [cleanup-slic](../cleanup-slic/) as the final step with `if: always()`.
Keeping cleanup separate lets multiple suites share the stack and covers setup failures too.
Ephemeral runners can omit cleanup because the VM is destroyed when the job ends.

```yaml
- name: Clean up slic
  if: always()
  uses: stellarwp/plugin-toolbox/.github/actions/cleanup-slic@v1
```

Each job must have its own Docker daemon. Parallel jobs sharing a daemon are not supported.

## Suites this action does not run

`slic run` drives Codeception. A Playwright suite is not a Codeception suite: call
`slic playwright test` in a plain `run:` step after `setup-slic` instead.
