'use strict'

const { describe, it, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert')
const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const {
  runAnalyzeHooks,
  lastReleaseTag,
  readTypes,
} = require('../../../.github/actions/analyze-hooks/analyze-hooks.js')
const { coreWithOutputs, recordedRealExec } = require('../../support/actions.js')

/** A git that signs nothing, whatever the machine it runs on configures: a signed tag asks for a message. */
const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@example.com',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@example.com',
  GIT_CONFIG_COUNT: '2',
  GIT_CONFIG_KEY_0: 'tag.gpgsign',
  GIT_CONFIG_VALUE_0: 'false',
  GIT_CONFIG_KEY_1: 'commit.gpgsign',
  GIT_CONFIG_VALUE_1: 'false',
}

const BEFORE = `<?php
$a = apply_filters( 'tec_kept', $a );
$b = apply_filters( 'tec_removed_filter', $b );
do_action( 'tec_removed_action' );
$c = apply_filters( 'tec_moved', $c );
`

const AFTER = `<?php
$a = apply_filters( 'tec_kept', $a );
do_action( "tec_added_action", $x );
$d = apply_filters( 'tec_added_b', $d ) . apply_filters( 'tec_added_a', $d );
$e = apply_filters( "tec_{$dynamic}_filter", $e );
$f = apply_filters( $variable, $f );
do_action_ref_array( 'tec_added_ref', [ $x ] );
$c = apply_filters( 'tec_moved', $c, 1 );
`

/** A change file as the action writes it. */
const entry = (text, type = 'tweak') => `significance: patch\ntype: ${JSON.stringify(type)}\nentry: ${JSON.stringify(text)}\n`

describe('analyze-hooks', () => {
  let repo

  const git = (...args) => execFileSync('git', args, { cwd: repo, env: GIT_ENV, encoding: 'utf8', stdio: 'pipe' })

  const write = (name, body) => {
    fs.mkdirSync(path.dirname(path.join(repo, name)), { recursive: true })
    fs.writeFileSync(path.join(repo, name), body)
  }

  const commit = (message) => {
    git('add', '--all')
    git('commit', '-q', '--allow-empty', '-m', message)
  }

  const entries = (dir = 'changelog') =>
    Object.fromEntries(
      (fs.existsSync(path.join(repo, dir)) ? fs.readdirSync(path.join(repo, dir)) : [])
        .filter((file) => file.endsWith('.yaml'))
        .sort()
        .map((file) => [file, fs.readFileSync(path.join(repo, dir, file), 'utf8')])
    )

  const run = async (t, inputs = {}) => {
    const { core, outputs, summary } = await coreWithOutputs(t)
    const { exec } = await recordedRealExec()

    await runAnalyzeHooks({
      core,
      exec,
      cwd: repo,
      env: { INPUT_PATHS: 'src', INPUT_VIEWS_PATH: 'src/views', ...inputs },
    })

    return { outputs: outputs(), summary: summary() }
  }

  beforeEach(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'toolbox-analyze-hooks-'))
    git('init', '-q', '-b', 'main')
    write('src/Tribe/Main.php', BEFORE)
    write('src/views/v2/list.php', '<?php // list\n')
    write('src/views/v2/day.php', '<?php // day\n')
    commit('release')
    git('tag', '6.18.2')
    git('tag', 'ft-002')
    write('src/Tribe/Main.php', AFTER)
    write('src/views/v2/list.php', '<?php // list, changed\n')
    commit('work')
  })

  afterEach(() => {
    fs.rmSync(repo, { recursive: true, force: true })
  })

  it('writes one entry per kind of added and removed hook and for the changed views', async (t) => {
    const { outputs } = await run(t)

    assert.deepStrictEqual(entries(), {
      'analyze-hooks-added-actions.yaml': entry('Added actions: `tec_added_action`, `tec_added_ref`'),
      'analyze-hooks-added-filters.yaml': entry('Added filters: `tec_added_a`, `tec_added_b`'),
      'analyze-hooks-changed-views.yaml': entry('Changed views: `v2/list`'),
      'analyze-hooks-removed-actions.yaml': entry('Removed actions: `tec_removed_action`'),
      'analyze-hooks-removed-filters.yaml': entry('Removed filters: `tec_removed_filter`'),
    })
    assert.strictEqual(outputs.tag, '6.18.2')
    assert.strictEqual(outputs.files.split('\n').length, 5)
  })

  it('does not list a hook that only moved, or whose name is dynamic or concatenated', async (t) => {
    write('src/Tribe/Concat.php', "<?php\n$a = apply_filters( 'tec_' . $name, $a );\n")
    commit('concat')
    await run(t)

    const listed = Object.values(entries()).join('')
    for (const name of ['tec_moved', 'tec_kept', 'dynamic', 'variable', '`tec_`']) {
      assert.ok(!listed.includes(name), name)
    }
  })

  it('lets the whole tree decide: a hook with another call left is neither added nor removed', async (t) => {
    write('src/Tribe/Twin.php', "<?php\n$a = apply_filters( 'tec_twin', $a );\n")
    commit('twin')
    git('tag', '6.18.3')
    write('src/Tribe/Twin.php', '<?php\n')
    write('src/Tribe/Main.php', `${AFTER}$g = apply_filters( 'tec_twin', $g );\n`)
    commit('move the twin')
    await run(t)

    assert.ok(!Object.values(entries()).join('').includes('tec_twin'))
  })

  it('removes an entry from an earlier run when its change is reverted, and is stable when run twice', async (t) => {
    await run(t)
    const first = entries()
    await run(t)
    assert.deepStrictEqual(entries(), first)

    write('src/Tribe/Main.php', BEFORE)
    commit('revert')
    await run(t)
    assert.deepStrictEqual(Object.keys(entries()), ['analyze-hooks-changed-views.yaml'])
  })

  it('compares with the last release tag, with or without a leading v', async (t) => {
    git('tag', 'v6.18.3')
    const { outputs } = await run(t)

    assert.strictEqual(outputs.tag, 'v6.18.3')
    assert.deepStrictEqual(entries(), {})
  })

  it('does not write an entry a changelog file or another pending file already has', async (t) => {
    write('changelog.md', '= [6.18.3] =\n\n* Tweak - Changed views: `v2/list`\n\n= [6.18.2] =\n\n* Fix - A fix.\n')
    write('changelog/by-hand.yaml', 'significance: patch\ntype: tweak\nentry: "Removed actions: `tec_removed_action`"\n')
    await run(t)

    const written = Object.keys(entries())
    assert.ok(!written.includes('analyze-hooks-changed-views.yaml'))
    assert.ok(!written.includes('analyze-hooks-removed-actions.yaml'))
    assert.ok(written.includes('analyze-hooks-added-actions.yaml'))
  })

  it('still lists a change an earlier release also made', async (t) => {
    write('readme.txt', 'Stable tag: 6.18.2\n\n== Changelog ==\n\n= [6.18.2] 2026-01-01 =\n\n* Tweak - Changed views: `v2/list`\n')
    await run(t)

    assert.ok('analyze-hooks-changed-views.yaml' in entries())
  })

  it('reads a hook whose name is on the line after the parenthesis', async (t) => {
    write('src/Tribe/Wrapped.php', "<?php\n$a = apply_filters(\n\t'tec_wrapped',\n\t$a\n);\n")
    commit('wrapped')
    await run(t)

    assert.match(entries()['analyze-hooks-added-filters.yaml'], /`tec_wrapped`/)
  })

  it('fails when no release tag is reachable', async (t) => {
    git('tag', '-d', '6.18.2')

    await assert.rejects(run(t), /No release tag is reachable from HEAD/)
  })

  it('searches every path it is given and honours an exclusion', async (t) => {
    write('includes/legacy.php', "<?php\ndo_action( 'give_legacy' );\n")
    write('vendor/lib.php', "<?php\ndo_action( 'vendor_hook' );\n")
    commit('more code')
    await run(t, { INPUT_PATHS: '.\n:!vendor', INPUT_VIEWS_PATH: '' })

    const written = entries()
    assert.strictEqual(
      written['analyze-hooks-added-actions.yaml'],
      entry('Added actions: `give_legacy`, `tec_added_action`, `tec_added_ref`')
    )
    assert.ok(!('analyze-hooks-changed-views.yaml' in written))
  })

  it('lists the views of another directory', async (t) => {
    write('themes/ld30/templates/course.php', '<?php // course\n')
    commit('a template')
    await run(t, { INPUT_VIEWS_PATH: 'themes/ld30/templates/' })

    assert.strictEqual(entries()['analyze-hooks-changed-views.yaml'], entry('Changed views: `course`'))
  })

  it('writes the names only under a type of its own, where the changelogger keeps its change files', async (t) => {
    write(
      'package.json',
      JSON.stringify({
        changelogger: {
          changesDir: 'changes',
          changelogFile: 'changelog.txt',
          types: { 'tweak: added actions': 'Tweak - Added actions:' },
        },
      })
    )
    // The label ends the sentence itself, so the names follow it with no separator.
    write('changelog.txt', '* Tweak - Added actions: `tec_added_action`, `tec_added_ref`\n')
    await run(t, {
      INPUT_TYPES: '{"added-actions": "tweak: added actions", "added-filters": "tweak: added filters"}',
    })

    const written = entries('changes')
    assert.strictEqual(
      written['analyze-hooks-added-filters.yaml'],
      entry('`tec_added_a`, `tec_added_b`', 'tweak: added filters')
    )
    assert.ok(!('analyze-hooks-added-actions.yaml' in written), 'changelog.txt already has it')
    assert.strictEqual(written['analyze-hooks-removed-filters.yaml'], entry('Removed filters: `tec_removed_filter`'))
  })

  it('refuses a types input that is not an object of known keys', () => {
    assert.throws(() => readTypes('[]'), /not a JSON object/)
    assert.throws(() => readTypes('{nope'), /not valid JSON/)
    assert.throws(() => readTypes('{"added-hooks": "tweak"}'), /unknown key 'added-hooks'/)
    assert.throws(() => readTypes('{"added-filters": ""}'), /not a changelog type/)
  })

  it('orders release tags by their numeric parts', () => {
    assert.strictEqual(lastReleaseTag(['6.9.0', '6.10.0', '6.10.0.1', 'v6.2.0', '6.11.0-rc1', 'ft-002', '']), '6.10.0.1')
    assert.strictEqual(lastReleaseTag(['ft-002']), undefined)
  })
})
