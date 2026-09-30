# run-slic-suite

Runs a Codeception suite through [slic](https://github.com/stellarwp/slic), uploads the suite's
output as an artifact when it fails, and optionally tears the stack down.

[setup-slic](../setup-slic/) has to run earlier in the same job. It exports `SLIC_BIN` and
`DEBUG_FLAG`, which this action reads. Without `SLIC_BIN` the action fails with a message saying so
rather than running the suite name as a command.

```yaml
- uses: stellarwp/plugin-toolbox/.github/actions/setup-slic@v1
  with:
    php-version: ${{ matrix.php-version }}
    target: sfwd-lms

- uses: stellarwp/plugin-toolbox/.github/actions/run-slic-suite@v1
  with:
    suite: ${{ matrix.suite }}
    target: sfwd-lms
```

## Inputs

| Input | Required | Default | What it does |
|---|---|---|---|
| `suite` | yes | | Codeception suite to run, e.g. `wpunit` |
| `target` | yes | | The `slic use` target, re-selected before the suite runs. Also the default output path |
| `suite-args` | no | `''` | Extra arguments for `slic run`, e.g. `--ext DotReporter` |
| `upload-output-on-failure` | no | `'false'` | Upload the test output directory when the suite fails |
| `output-path` | no | `<target>/tests/_output/` | Directory to upload |
| `output-artifact-name` | no | see [Artifact names](#artifact-names) | Name of the uploaded artifact |
| `run-cleanup` | no | `'false'` | Run `slic down` and kill the ssh-agent at the end |

## Why target is required

The action runs `slic use <target>` before `slic run`. `setup-slic` already selects the target, but
anything in between that calls `slic use` for another target, such as installing a fixture plugin's
dependencies, leaves the wrong one selected and the suite runs against it.

## Artifact names

The default is `test-output-<target>-php<version>-<suite>`, where the version is read from
`SLIC_PHP_VERSION`, which [setup-slic](../setup-slic/) exports when it pins the stack. Characters an
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
    target: the-events-calendar
    suite-args: --ext DotReporter
    output-path: tests/_output/
    upload-output-on-failure: 'true'
    run-cleanup: 'true'
```

## Suites this action does not run

`slic run` drives Codeception. A Playwright suite is not a Codeception suite: call
`slic playwright test` in a plain `run:` step after `setup-slic` instead.
