# StellarWP Plugin Toolbox

One home for the CI that every StellarWP brand keeps rebuilding on its own.

It's a toolbox and not an actions repo because it holds more than actions. It has composite actions, full reusable workflows, and the config files every plugin repo needs. Grab whichever tools your repo needs and leave the rest.

This file is the README and the build plan. Until Phase 2 ships, anything under [The plan](#the-plan) is a proposal, not a description of what exists.

## Why

All the StellarWP brands have built their own solid CI, but it is time to merge them all into one place to reduce duplication and increase efficiency of managing these tools.

This repo will start by merging TEC and LD's Cis. Both run phpcs. Both run slic. Both package with pup, process changelogs at release, and spit out QA zips. When one team fixes something, the other team never hears about it.

TEC's lives in [the-events-calendar/actions](https://github.com/the-events-calendar/actions). LearnDash's is documented in [learndash-core/docs/continuous-integration.md](https://github.com/stellarwp/learndash-core/blob/main/docs/continuous-integration.md). And there's a third one hiding in plain sight: [stellarwp/github-actions](https://github.com/stellarwp/github-actions), which already has org-wide `phpcs.yml`, `zip.yml`, `dependency-zip.yml`, and review app workflows. TEC's `phpcs.yml` already calls into it. Nobody else uses it much.

Give and Kadence have their own setups too. They're not in the first pass, but they'll be swallowed here too eventually.

The goal is one repo any brand can point at. Shared stuff lives here. Brand-specific stuff stays configurable.

## What we're merging

### From TEC

Full write-up in [actions PR #46](https://github.com/the-events-calendar/actions/pull/46). The highlights:

- A file sync hub. `templates/` holds the real copy of each shared file, and [repo-file-sync-action](https://github.com/marketplace/actions/repo-file-sync-action) pushes it into product repos as a PR from `tec-bot`. Groups in `.github/sync.yml` keep plugin release machinery out of Laravel services.
- Composite actions: `check-php-changes`, `process-changelog`, `add-changelog`, `generate-pot`, `push-translations`, `smart-checkout`, `verify-openspec-plan`.
- PR checks: `changelogger.yml`, `phpcs.yml`, `lint.yml`, `openspec-plan.yml`, `link-project.yml`.
- Manual release workflows that each open a `[BOT]` PR instead of pushing: prepare branch, replace TBDs, sync translations, process changelog, merge forward, update WP version.
- Skip markers (`[skip-changelog]`, `[skip-phpcs]`, `[skip-lint]`) so bot PRs don't trip over checks meant for humans.
- A self-check that actionlints the templates. They never run in their own repo, so nothing else would catch a typo.

### From LearnDash

- Shared actions: `setup-bun`, `setup-slic`, `prepare-matrix`.
- PR checks: `ci-standards.yml` (phpcs, cspell, markdown, scss/js lint, ABSPATH check), `ci-compatibility.yml`, `ci-analysis.yml` (PHPStan), `ci-extra-validations.yml` (view PHPDocs, shellcheck, package names, test namespaces, changelog), `ci-release-checks.yml` (pup in production mode).
- Tests split by cost. `ci-tests-php.yml` runs on every PR. `ci-tests-acceptance.yml` only runs on release/bucket branches or when someone adds `run-acceptance-tests`.
- Release: `release.yml` fires on `v*` tags, `release-prep.yml` is manual, `zip.yml` fires on PR review.
- A label state machine (`pr-labeling.yml`, `pr-closing.yml`, `pr-monitor.yml`) that walks a PR from code review through QA to ready-to-merge.
- The best doc habit in either repo: every workflow lists the command to run it locally. We're stealing this.

## Next up: Give and Kadence

Not in v1, but on the list. Here's what they run today.

### Give

[givewp](https://github.com/impress-org/givewp) already works the way the house rules below describe. Most of its workflows are three-line `uses:` calls into [impress-org/givewp-github-actions](https://github.com/impress-org/givewp-github-actions), which makes it a fourth shared hub. That repo has reusable workflows for PHP compat, static analysis, unit and addon tests, zips, translations, and wp.org releases.

- It pins to `@master`, same risk as TEC's `@main`.
- Its zip already goes through `stellarwp/github-actions` and pup.
- E2E tests use wp-env and Playwright, not slic.
- It runs on Blacksmith runners instead of GitHub's.

### Kadence

[kadence-blocks](https://github.com/stellarwp/kadence-blocks) looks a lot like LearnDash: bun, slic, pup, phpcs, PHPStan, cspell, all written in the repo. Two things nobody else has:

- `guard-since-tbd.yml` and `replace-since-tbd.yml` use pup's built-in TBD check and replace instead of a custom script.
- `plugin-check.yml` runs the WordPress Plugin Check.

### What this means for the plan

givewp-github-actions is prior art for the reusable-workflow layer, so read it before starting Phase 3. And pup's TBD commands might replace TEC's `release-replace-tbd-entries.yml` outright.

## Same problem, two answers

These are the easy wins. Pick one implementation, delete the other.

| What | TEC | LearnDash |
|---|---|---|
| Coding standards | `phpcs.yml` via `stellarwp/github-actions` | `ci-standards.yml` |
| Tests | slic | slic, wrapped in `setup-slic` |
| Packaging checks | pup via `.puprc` | `composer -- pup check` |
| Changelog | changelogger + `bin/check-changelog.sh` | changelogger + `composer changelog-validate` |
| Version bump | `release-prepare-branch.yml` | `release-prep.yml` |
| QA zip | `stellarwp/github-actions` `zip.yml` | in-repo `zip.yml` |
| Tested-up-to bump | `release-update-wp-version.yml` | part of release prep |
| JS/CSS lint | `lint.yml` | part of `ci-standards.yml` |

## Where they actually differ

Each row needs a call. My guess is in the last column, but these are guesses.

| What | TEC | LearnDash | Probably |
|---|---|---|---|
| How workflows get into repos | File sync | Written in the repo | Reusable workflows, sync as backup |
| JS toolchain | npm + `.nvmrc` | bun | Support both |
| Release trigger | Manual chain | `v*` tag | Real decision needed |
| Static analysis | Not synced | PHPStan + compat matrix | Take LD's |
| PR labels | Project board link | Full state machine | Leave per-brand |
| Plan enforcement | OpenSpec | None | Opt-in |
| Translations | GlotPress push | None | Opt-in |
| Test matrix | [#51](https://github.com/the-events-calendar/actions/pull/51) in progress, paused for this | `prepare-matrix` | Start from LD's, fold in TEC's paused work |
| Local repro docs | No | Yes | Take LD's |
| Self-linting | Yes | N/A | Take TEC's |

## House rules

1. Reusable workflows first. A consuming repo carries a three-line `uses:` pointing here. File sync is only for files that have to physically sit in the repo (`.editorconfig`, `.nvmrc`, PR templates, lint config). This kills most of the "sync PR rotting for three weeks" problem.
2. Pin to tags. TEC points at `@main`, so merging here ships to every repo instantly with zero warning. Consumers use `@v1`. Breaking changes get `@v2`.
3. Config beats forks. Brand differences go in inputs or in files the repo already has (`.puprc`, `package.json`, `composer.json`). If a brand has to fork a workflow, the workflow is wrong.
4. Team policy is opt-in. OpenSpec, label state machines, ticket IDs in branch names: all off by default.
5. Every check lists its local command.
6. This repo lints itself hard, because a bug here hits every brand at once.

## How it fits together

Three drawers in the toolbox. You can use any one without the others.

| Layer | Lives in | What's in it |
|---|---|---|
| Composite actions | `.github/actions/` | Small single-purpose steps with no opinions: `setup-slic`, `setup-bun`, `setup-node`, `prepare-matrix`, `check-php-changes`, `smart-checkout`, `process-changelog`, `generate-pot` |
| Reusable workflows | `.github/workflows/` | Full jobs built from the actions (standards, analysis, tests, zip, release prep). Most repos will only touch this layer. |
| File sync | `templates/` + `.github/sync.yml` | Files that must exist in the target repo, grouped by brand and repo type |

Planned layout:

```
.github/
  actions/            Composite actions
  workflows/          Reusable workflows + this repo's own CI
  sync.yml            Sync groups and targets
templates/
  config/             .editorconfig, .nvmrc, .browserslistrc, lint configs
  github/             PR templates, AGENTS.md
  scripts/            bin/ scripts
  workflows/          Thin caller workflows to seed new repos
docs/
  continuous-integration.md   Per-workflow reference, LD table style
  onboarding.md               What a repo needs before it can plug in
  migrating-from-tec.md
  migrating-from-learndash.md
tests/                Self-checks
```

## The plan

Each phase ends with something people can actually use.

### Phase 0: agree on scope

- [ ] Decide what happens to `stellarwp/github-actions`. Absorb it, or keep it for infra (review apps, deploys) and put plugin CI here?
- [ ] Lock the v1 brand list. TEC and LearnDash for sure. Loop in Give and Kadence now so the interfaces don't assume two brands.
- [ ] Pick a shared bot account and token names. TEC uses `tec-bot`, `GHA_BOT_TOKEN_MANAGER`, and `GH_BOT_TOKEN`.
- [ ] Name one reviewer per brand.

### Phase 1: inventory

- [ ] List every workflow, action, and synced file on both sides with its trigger and dependencies.
- [ ] Tag each one: shared, configurable, or brand-only.
- [ ] Note every secret and outside service each one touches.
- [ ] Do a lighter pass on Give and Kadence so nothing we build blocks them later.
- [ ] Check what each brand's repos already have (`.puprc`, `package.json` sections, composer scripts). The workflows assume these exist.

### Phase 2: actions

- [ ] Port `setup-slic`, `prepare-matrix`, `setup-bun` from LearnDash.
- [ ] Port `check-php-changes`, `smart-checkout`, `process-changelog`, `add-changelog`, `generate-pot` from TEC.
- [ ] Add `setup-node` for the npm crowd.
- [ ] Turn every hard-coded repo name, slug, or branch pattern into an input.
- [ ] Self-checks: actionlint everything, unit test anything with real logic.
- [ ] Tag `v1.0.0`.

### Phase 3: reusable workflows

- [ ] `standards.yml`: phpcs, cspell, markdown, style lint. Inputs pick which run.
- [ ] `analysis.yml`: PHPStan and the PHP compat matrix.
- [ ] `tests.yml`: slic suites via `prepare-matrix`, with LD's cheap/expensive split. Review TEC's paused [#51](https://github.com/the-events-calendar/actions/pull/51) first so that work isn't lost.
- [ ] `changelog.yml`: the changelogger check.
- [ ] `zip.yml`: reconcile TEC's and LD's versions.
- [ ] `release-prep.yml`: version bump, changelog, tested-up-to.
- [ ] Document each in `docs/continuous-integration.md` with its local command.

### Phase 4: file sync

- [ ] Port the sync workflow and config from TEC.
- [ ] Group by brand and repo type.
- [ ] Only sync files that have to live in the repo.
- [ ] No symlinks in the sync list. One bad entry silently kills the whole group (TEC learned this one the hard way).
- [ ] Add failure alerts. TEC's sync fails without telling anyone.

### Phase 5: pilot

- [ ] Pick one small TEC plugin and one small LearnDash repo.
- [ ] Migrate both. Leave the old workflows in place but disabled so rollback is one commit.
- [ ] Run a full release on each.
- [ ] Fix whatever broke in the toolbox, not in the pilot repos.

### Phase 6: rollout

- [ ] Migrate the rest of TEC.
- [ ] Migrate the rest of LearnDash.
- [ ] Deprecate the duplicates in both source repos with a pointer here.
- [ ] Decide the fate of `the-events-calendar/actions`: archive it, or keep it for TEC-only stuff (OpenSpec, translations, project links).
- [ ] Onboard Give and Kadence. For Give that's mostly repointing `uses:` lines. For Kadence it's moving in-repo workflows over, same as LearnDash.

### Phase 7: keep it honest

- [ ] A changelog and release process for this repo, so consumers know what changed between tags.
- [ ] A deprecation policy for inputs and action names.
- [ ] Scheduled self-checks, so an upstream action breaking gets caught here first.

## Open questions

People need to answer these. Reading code won't.

1. Where does this live relative to `stellarwp/github-actions`? One repo, or plugin CI here and infra there?
2. Release model. TEC runs a chain of manual workflows. LearnDash tags and walks away. A config flag won't hide that difference. Pick one, or accept supporting both forever.
3. bun or npm? Both is cheap for actions and annoying for lint config.
4. Does OpenSpec go org-wide? If yes, it moves here. If no, it stays with TEC.
5. Does anyone besides LearnDash want the label state machine? It's big and tied to their QA flow.
6. Do both teams run slic the same way (same images, same WP versions)? Phase 1 answers this. It might be the hardest merge in the whole plan.
7. Give tests on wp-env + Playwright and Blacksmith runners. Does the toolbox support wp-env next to slic? Do we care which runners people use?
8. Who reviews changes here? CODEOWNERS with one person per brand is the obvious answer, but it slows everything down. Worth choosing on purpose.

## Related repos

- [the-events-calendar/actions](https://github.com/the-events-calendar/actions): TEC's sync hub and actions.
- [stellarwp/learndash-core](https://github.com/stellarwp/learndash-core): LearnDash's workflows and CI docs.
- [impress-org/givewp-github-actions](https://github.com/impress-org/givewp-github-actions): Give's shared reusable workflows.
- [stellarwp/kadence-blocks](https://github.com/stellarwp/kadence-blocks): Kadence's workflows.
- [stellarwp/github-actions](https://github.com/stellarwp/github-actions): existing org-wide reusable workflows.
- [stellarwp/pup](https://github.com/stellarwp/pup): packaging, used by every brand.
- [@stellarwp/changelogger](https://www.npmjs.com/package/@stellarwp/changelogger): changelogs, used by TEC and LearnDash.
