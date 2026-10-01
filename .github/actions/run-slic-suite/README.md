# run-slic-suite

Runs a Codeception suite through [slic](https://github.com/stellarwp/slic), uploads the suite's
output as an artifact when it fails. Stack cleanup is a separate action.

[setup-slic](../setup-slic/) has to run earlier in the same job. This action reads the four
variables it exports: `SLIC_BIN` to call slic, `SLIC_TOOLBOX_TARGET` for the target,
`SLIC_PHP_VERSION` for the artifact name, and `SLIC_TOOLBOX_DEBUG_FLAG` to pass on to `slic run`.
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
| `upload-output-on-failure` | no | `'false'` | Upload the test output directory when the suite fails |
| `output-path` | no | `<target>/tests/_output/` | Directory to upload |
| `output-artifact-name` | no | see [Artifact names](#artifact-names) | Name of the uploaded artifact |

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

The default is `test-output-<target>-php<version>-<suite>`, where the version is read from
`SLIC_PHP_VERSION`, which [setup-slic](../setup-slic/) exports as `major.minor` once it knows which
PHP the stack is running. Characters an
artifact name cannot hold are replaced with `-`, so a target such as `the-events-calendar/common`
becomes `the-events-calendar-common`.

The name carries all three dimensions because the upload passes `overwrite: true`. That is what lets
a re-run of a failed job replace the output from its earlier attempt, since artifacts belong to the
workflow run rather than the attempt. The same setting means two jobs sharing a name would not
collide loudly: the later upload would delete the earlier job's output. A job that varies on
something beyond target, PHP version and suite therefore has to set `output-artifact-name`.

## Output path

`output-path` is relative to the workspace, not to the target. It defaults to
`<target>/tests/_output/`, which is correct when the target is checked out into a subdirectory named
after it. Set it explicitly on any other layout:

```yaml
- uses: stellarwp/plugin-toolbox/.github/actions/run-slic-suite@v1
  with:
    suite: ${{ matrix.suite }}
    suite-args: --ext DotReporter
    output-path: tests/_output/
    upload-output-on-failure: 'true'
```

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
