# cleanup-slic

Removes the stack configured by [setup-slic](../setup-slic/) and the SSH agent that action started.
An agent supplied by the caller is left running. SSH cleanup still runs if `slic down` fails,
and the action reports cleanup failures.

Use this as the final step on persistent runners, after tests and artifact collection:

```yaml
- name: Clean up slic
  if: always()
  uses: stellarwp/plugin-toolbox/.github/actions/cleanup-slic@v1
```

`slic down` removes the stack containers, networks and named volumes, including database state.
Run cleanup only after every step that needs those resources.

There are no inputs. The action reads setup's ownership markers from the job environment, so it
can clean up partial setup failures as well as Codeception or Playwright runs. If setup never
reached stack configuration or agent creation, there is nothing to clean up.

Ephemeral runners can omit it. Each job must have its own Docker daemon; Slic's container names
and stack settings do not support concurrent jobs sharing one daemon. This action does not prune
unrelated Docker resources or delete the checkout and Composer cache.
