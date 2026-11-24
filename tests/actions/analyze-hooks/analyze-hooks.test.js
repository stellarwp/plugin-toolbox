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
      env: { INPUT_PATHS: 'src', INPUT_VIEWS_PATHS: 'src/views', ...inputs },
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
      'analyze-hooks-changed-views.yaml': entry('Changed views: `src/views/v2/list.php`'),
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

  it('lists a hook that became deprecated as deprecated, and one deleted after it was deprecated as removed', async (t) => {
    write(
      'src/Tribe/Deprecated.php',
      "<?php\n$a = apply_filters( 'tec_to_deprecate', $a );\ndo_action_deprecated( 'tec_was_deprecated', [], '6.0.0' );\n"
    )
    commit('deprecated hooks')
    git('tag', '6.18.3')
    write('src/Tribe/Deprecated.php', "<?php\n$a = apply_filters_deprecated( 'tec_to_deprecate', [ $a ], '6.19.0' );\n")
    commit('deprecate one, delete the other')
    await run(t)

    const written = entries()
    assert.deepStrictEqual(Object.keys(written), ['analyze-hooks-deprecated-filters.yaml', 'analyze-hooks-removed-actions.yaml'])
    assert.strictEqual(written['analyze-hooks-deprecated-filters.yaml'], entry('Deprecated filters: `tec_to_deprecate`'))
    assert.strictEqual(written['analyze-hooks-removed-actions.yaml'], entry('Removed actions: `tec_was_deprecated`'))
  })

  it('lists a hook whose docblocks gained a @since line as updated', async (t) => {
    const docblock = (...since) => `/**\n * A hook.\n *\n${since.map((line) => ` * @since ${line}\n`).join('')} */\n`
    write(
      'src/Tribe/Updated.php',
      `<?php\n${docblock('5.1.0')}$label = apply_filters( 'tec_updated', $label );\n${docblock('5.0.0')}do_action( 'tec_same' );\n`
    )
    commit('documented hooks')
    git('tag', '6.18.3')
    write(
      'src/Tribe/Updated.php',
      [
        '<?php',
        `${docblock('5.1.0', 'TBD Added the $type parameter.')}$label = apply_filters(`,
        "\t'tec_updated', $label, $type );",
        // The same @since on a second call, and one on a docblock that a statement separates.
        `${docblock('5.0.0')}do_action( 'tec_same' );`,
        `${docblock('9.9.9')}$x = 1;\ndo_action( 'tec_same' );`,
        '',
      ].join('\n')
    )
    commit('update one')
    await run(t)

    assert.deepStrictEqual(entries(), { 'analyze-hooks-updated-filters.yaml': entry('Updated filters: `tec_updated`') })
  })

  it('lists a hook as updated when a new @since line replaces one that went with a deleted call', async (t) => {
    const call = (since) => `/**\n * A hook.\n *\n * @since ${since}\n */\ndo_action( 'tec_swapped' );\n`
    write('src/Tribe/Swapped.php', `<?php\n${call('1.0.0')}${call('2.0.0')}`)
    commit('two calls')
    git('tag', '6.18.3')
    write('src/Tribe/Swapped.php', `<?php\n/**\n * A hook.\n *\n * @since 1.0.0\n * @since 3.0.0\n */\ndo_action( 'tec_swapped' );\n`)
    commit('one call, one more @since')
    await run(t)

    assert.deepStrictEqual(entries(), { 'analyze-hooks-updated-actions.yaml': entry('Updated actions: `tec_swapped`') })
  })

  it('reads a docblock as a call\'s only when it ends on the line above the call', async (t) => {
    const docblock = (...since) => `/**\n * A hook.\n *\n${since.map((line) => ` * @since ${line}\n`).join('')} */\n`
    const array = (...since) =>
      `<?php\n$a = [\n${docblock(...since)}'x' => apply_filters( 'tec_x', 1 ),\n'y' => apply_filters( 'tec_y', 2 ),\n];\n`
    const template = (...since) =>
      `<?php\n${docblock(...since)}?>\n<div>\n<?php do_action( 'tribe_template_before_example' ); ?>\n</div>\n`
    write('src/Tribe/Array.php', array('5.0.0'))
    write('src/views/v2/example.php', template('5.0.0'))
    commit('an array and a template')
    git('tag', '6.18.3')
    write('src/Tribe/Array.php', array('5.0.0', 'TBD Added a param.'))
    write('src/views/v2/example.php', template('5.0.0', 'TBD Changed the markup.'))
    commit('new @since lines')
    await run(t, { INPUT_PATHS: 'src', INPUT_VIEWS_PATHS: '' })

    assert.deepStrictEqual(entries(), { 'analyze-hooks-updated-filters.yaml': entry('Updated filters: `tec_x`') })
  })

  it('does not add, update or remove a hook through a call documented in another file', async (t) => {
    const reuse = (kind) => `/** This ${kind} is documented in src/Tribe/Main.php */\n`
    write('src/Tribe/Reuse.php', `<?php\n${reuse('action')}do_action( 'tec_removed_action' );\n`)
    write('src/Tribe/Main.php', `${AFTER}do_action( 'tec_removed_action' );\n`)
    commit('an original and a re-use')
    git('tag', '6.18.3')
    write(
      'src/Tribe/Reuse.php',
      `<?php\n${reuse('action')}do_action( 'tec_removed_action' );\n/** THIS FILTER IS DOCUMENTED IN wp-includes/post-template.php\n * @since 9.9.9\n */\n$c = apply_filters( 'the_content', $c );\n`
    )
    write('src/Tribe/Main.php', AFTER)
    commit('remove the original, re-use a core filter')
    await run(t)

    assert.deepStrictEqual(entries(), {})
  })

  it('reads an entry as written when a line lists its names, whatever the strategy wrote around them', async (t) => {
    write(
      'package.json',
      JSON.stringify({
        changelogger: {
          types: { 'tweak: added filters': 'Tweak - Added filters:', 'tweak: added actions': 'Tweak - Added actions:' },
          typeLabelOverrides: { keepachangelog: { 'tweak: removed filters': 'Removed filters' } },
        },
      })
    )
    write(
      'changelog.md',
      [
        '## [6.18.3] - 2026-02-01',
        '',
        // A period after the names, and a hook added by hand on the same line.
        '* Tweak - Added filters: `hand_written`, `tec_added_a`, `tec_added_b`.',
        // One of the two names only.
        '* Tweak - Added actions: `tec_added_action`.',
        // keepachangelog: a `- ` bullet, the label in the heading above it.
        '### Removed filters',
        '- `tec_removed_filter`',
        '### Changed',
        '- Removed actions: `tec_removed_action`',
        '',
        '## [6.18.2] - 2026-01-01',
        '',
      ].join('\n')
    )
    await run(t, {
      INPUT_TYPES: '{"added-filters": "tweak: added filters", "added-actions": "tweak: added actions", "removed-filters": "tweak: removed filters"}',
    })

    assert.deepStrictEqual(Object.keys(entries()), ['analyze-hooks-added-actions.yaml', 'analyze-hooks-changed-views.yaml'])
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
    write('changelog.md', '= [6.18.3] =\n\n* Tweak - Changed views: `src/views/v2/list.php`\n\n= [6.18.2] =\n\n* Fix - A fix.\n')
    write('changelog/by-hand.yaml', 'significance: patch\ntype: tweak\nentry: "Removed actions: `tec_removed_action`"\n')
    await run(t)

    const written = Object.keys(entries())
    assert.ok(!written.includes('analyze-hooks-changed-views.yaml'))
    assert.ok(!written.includes('analyze-hooks-removed-actions.yaml'))
    assert.ok(written.includes('analyze-hooks-added-actions.yaml'))
  })

  it('still lists a change an earlier release also made', async (t) => {
    write('readme.txt', 'Stable tag: 6.18.2\n\n== Changelog ==\n\n= [6.18.2] 2026-01-01 =\n\n* Tweak - Changed views: `src/views/v2/list.php`\n')
    await run(t)

    assert.ok('analyze-hooks-changed-views.yaml' in entries())
  })

  it('still lists it when the changelog has no section for the last release', async (t) => {
    write('changelog.md', '### [6.18.1] 2026-01-01\n\n* Tweak - Changed views: `src/views/v2/list.php`\n')
    await run(t)

    assert.ok('analyze-hooks-changed-views.yaml' in entries())
  })

  it('reads a hook whose name is on the line after the parenthesis', async (t) => {
    write('src/Tribe/Wrapped.php', "<?php\n$a = apply_filters(\n\t'tec_wrapped',\n\t$a\n);\n")
    commit('wrapped')
    await run(t)

    assert.match(entries()['analyze-hooks-added-filters.yaml'], /`tec_wrapped`/)
  })

  it('reads a hook whose name is two lines below the parenthesis', async (t) => {
    write('src/Tribe/Three.php', "<?php\ndo_action(\n\t'tec_three'\n);\n")
    commit('three lines')
    await run(t)

    assert.match(entries()['analyze-hooks-added-actions.yaml'], /`tec_three`/)
  })

  it('ignores a call in a comment or in the HTML of a template, and keeps one after a string', async (t) => {
    write('src/Tribe/Main.php', AFTER.replace("do_action( \"tec_added_action\", $x );", "// do_action( 'tec_removed_action' );"))
    write(
      'src/Tribe/Comments.php',
      [
        '<?php',
        "# do_action( 'tec_hash' );",
        "/* apply_filters( 'tec_block', $a ); */",
        "$s = '// not a comment'; do_action( 'tec_after_string' );",
        "$sample = \"do_action( 'tec_in_string' );\"; $code = 'apply_filters( \\'tec_quoted\\', $a );';",
        "?><p>Don't do_action( 'tec_html' );</p><?php do_action( 'tec_in_template' ); ?>",
        '',
      ].join('\n')
    )
    commit('comments')
    await run(t)

    const written = entries()
    assert.strictEqual(
      written['analyze-hooks-added-actions.yaml'],
      entry('Added actions: `tec_added_ref`, `tec_after_string`, `tec_in_template`')
    )
    assert.strictEqual(written['analyze-hooks-removed-actions.yaml'], entry('Removed actions: `tec_removed_action`'))
    assert.ok(!written['analyze-hooks-added-filters.yaml'].includes('tec_block'))
    assert.ok(!written['analyze-hooks-added-filters.yaml'].includes('tec_quoted'))
  })

  it('writes nothing, with a warning, before the first release', async (t) => {
    git('tag', '-d', '6.18.2')
    const { outputs } = await run(t)

    assert.deepStrictEqual(entries(), {})
    assert.strictEqual(outputs.tag, '')
  })

  it('fails when a shallow checkout shows no release tag', async (t) => {
    const full = repo
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'toolbox-analyze-hooks-shallow-'))
    execFileSync('git', ['clone', '-q', '--depth', '1', '--no-tags', `file://${full}`, repo], { env: GIT_ENV, stdio: 'pipe' })
    fs.rmSync(full, { recursive: true, force: true })

    await assert.rejects(run(t), /the checkout is shallow/)
  })

  it('searches every path it is given, a glob included, and honours an exclusion', async (t) => {
    write('includes/legacy.php', "<?php\ndo_action( 'give_legacy' );\n")
    write('vendor/lib.php', "<?php\ndo_action( 'vendor_hook' );\n")
    write('docs/hooks.md', "Call `do_action( 'docs_hook' );`.\n")
    commit('more code')
    await run(t, { INPUT_PATHS: '*.php\n:!vendor', INPUT_VIEWS_PATHS: '' })

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
    await run(t, { INPUT_VIEWS_PATHS: 'themes/ld30/templates/' })

    assert.deepStrictEqual(entries()['analyze-hooks-added-views.yaml'], entry('Added views: `themes/ld30/templates/course.php`'))
  })

  it('lists added, changed and removed views apart, a renamed view as changed', async (t) => {
    write('src/views/v2/week.php', '<?php\n// The week view, long enough for git to see the rename.\n')
    commit('week')
    git('tag', '6.18.3')
    git('mv', 'src/views/v2/week.php', 'src/views/v2/weekly.php')
    git('rm', '-q', 'src/views/v2/day.php')
    write('src/views/v2/month.php', '<?php // month\n')
    write('src/views/v2/list.php', '<?php // list, changed again\n')
    commit('views')
    await run(t)

    assert.deepStrictEqual(entries(), {
      'analyze-hooks-added-views.yaml': entry('Added views: `src/views/v2/month.php`'),
      'analyze-hooks-changed-views.yaml': entry('Changed views: `src/views/v2/list.php`, `src/views/v2/weekly.php`'),
      'analyze-hooks-removed-views.yaml': entry('Removed views: `src/views/v2/day.php`'),
    })
  })

  it('lists the views of every path it is given, a glob included', async (t) => {
    write('includes/courses/templates/course.php', '<?php // course\n')
    write('includes/courses/other.php', '<?php // not a view\n')
    commit('templates')
    await run(t, { INPUT_VIEWS_PATHS: 'src/views\n\nincludes/*/templates/*\n' })

    const written = entries()
    assert.strictEqual(written['analyze-hooks-added-views.yaml'], entry('Added views: `includes/courses/templates/course.php`'))
    assert.strictEqual(written['analyze-hooks-changed-views.yaml'], entry('Changed views: `src/views/v2/list.php`'))
  })

  it('reads a views path that starts with ./', async (t) => {
    await run(t, { INPUT_VIEWS_PATHS: './src/views' })

    assert.strictEqual(entries()['analyze-hooks-changed-views.yaml'], entry('Changed views: `src/views/v2/list.php`'))
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

  it('writes to the changelogger defaults when package.json is not JSON', async (t) => {
    write('package.json', '{ not json')
    await run(t)

    assert.ok('analyze-hooks-added-actions.yaml' in entries('changelog'))
  })

  it('refuses an empty paths input', async (t) => {
    await assert.rejects(run(t, { INPUT_PATHS: '\n \n' }), /paths is empty/)
  })

  it('refuses a types input that is not an object of known keys', () => {
    assert.throws(() => readTypes('[]'), /not a JSON object/)
    assert.throws(() => readTypes('{nope'), /not valid JSON/)
    assert.throws(() => readTypes('{"added-hooks": "tweak"}'), /unknown key 'added-hooks'/)
    assert.throws(() => readTypes('{"added-filters": ""}'), /not a changelog type/)
    assert.deepStrictEqual(readTypes('{"deprecated-actions": "deprecated: deprecated actions", "removed-views": "deprecated: deprecated templates"}'), {
      'deprecated-actions': 'deprecated: deprecated actions',
      'removed-views': 'deprecated: deprecated templates',
    })
  })

  it('orders release tags by their numeric parts', () => {
    assert.strictEqual(lastReleaseTag(['6.9.0', '6.10.0', '6.10.0.1', 'v6.2.0', '6.11.0-rc1', 'ft-002', '']), '6.10.0.1')
    assert.strictEqual(lastReleaseTag(['ft-002']), undefined)
  })
})
