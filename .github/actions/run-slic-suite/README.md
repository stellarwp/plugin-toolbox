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
```

## Inputs

| Input | Required | Default | What it does |
|---|---|---|---|
| `suite` | yes | | Codeception suite to run, e.g. `wpunit` |
| `target` | no | what `setup-slic` selected | The `slic use` target, re-selected before the suite runs. Also the default output path |
| `suite-args` | no | `''` | Extra arguments for `slic run`, e.g. `--ext DotReporter` |
| `upload-output-on-failure` | no | `'false'` | Upload the test output directory when the suite fails |
| `output-path` | no | `<target>/tests/_output/` | Directory to upload |
| `output-artifact-name` | no | see [Artifact names](#artifact-names) | Name of the uploaded artifact |
| `run-cleanup` | no | `'false'` | Run `slic down` and kill the ssh-agent at the end. See [Cleanup](#cleanup) |

## When to pass target

Usually never. `setup-slic` exports the target it selected as `SLIC_TOOLBOX_TARGET` and this action
reads it, so a job names its target once.

Pass it when a step between the two actions ran `slic use` for a different target, such as
installing a fixture plugin's dependencies. slic records the current target in its own run settings
file rather than in the environment, so this action cannot detect that switch; it re-selects
whatever target it resolves before running the suite.

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
    suite-args: --ext DotReporter
    output-path: tests/_output/
    upload-output-on-failure: 'true'
    run-cleanup: 'true'
```

## Cleanup

`run-cleanup: 'true'` runs `slic down`, kills the ssh-agent and removes its socket. It runs whether
the suite passed or failed, and a failing teardown still reports the suite's own exit status.

It is off by default because a GitHub-hosted or Blacksmith runner is a fresh VM that is destroyed
when the job ends, taking the containers and the agent with it. Tearing them down first only spends
time.

Turn it on for a runner that outlives the job, such as a self-hosted one, where containers, volumes,
networks and the ssh-agent would otherwise leak into whatever job lands on that machine next.

A matrix is not a reason to leave it off. Each leg is a separate job on a separate runner, so no
stack is shared between them and nothing carries over either way.

A job that calls [setup-slic](../setup-slic/) without this action, a Playwright job for example, has
no cleanup input to set. On a persistent runner it needs its own step:

```yaml
- name: Tear the stack down
  if: always()
  run: ${SLIC_BIN} down
```

## Suites this action does not run

`slic run` drives Codeception. A Playwright suite is not a Codeception suite: call
`slic playwright test` in a plain `run:` step after `setup-slic` instead.
