'use strict'

const { describe, it } = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const {
  run,
  readBlueprintList,
  validateZipUrl,
  loadBlueprint,
  fillPlaceholders,
  prepareVariant,
  validateVariants,
  playgroundUrl,
  formatStamp,
  badgeUrl,
  buildComment,
  checkCommentLength,
  readyComment,
  DEFAULT_BLUEPRINT,
  MAX_COMMENT_LENGTH,
  COMMENT_FILE,
} = require('../../../.github/actions/playground-preview/playground-preview.js')
const { coreWithOutputs } = require('../../support/actions.js')

const SCRIPT = path.join(__dirname, '../../../.github/actions/playground-preview/playground-preview.js')
const FIXTURES = path.join(__dirname, 'fixtures')
const TEMPLATES = path.join(__dirname, '../../../templates/playground')

const ZIP_URL = 'https://evnt.is/test-zip?file=my-plugin.1.2.0-dev-1793396265-15e470cb.zip'
const SHA = '15e470cb0123456789abcdef0123456789abcdef'
const MARKER = '<!-- playground-preview:example-org/my-plugin -->'

/** 22:43 UTC on a winter day: 05:43 PM EST in New York. */
const WINTER = new Date('2026-01-15T22:43:00Z')

/** 21:43 UTC on a summer day: 05:43 PM EDT in New York. */
const SUMMER = new Date('2026-07-15T21:43:00Z')

/**
 * Decodes the blueprint a Playground link carries, the way Playground does: base64, then UTF-8.
 *
 * @param {string} url A link from playgroundUrl.
 *
 * @returns {object} The blueprint.
 */
function decodeLink(url) {
  assert.ok(url.startsWith('https://playground.wordpress.net/#'), `not a Playground hash link: ${url}`)

  return JSON.parse(Buffer.from(url.split('#')[1], 'base64').toString('utf8'))
}

/**
 * A temporary directory holding the given files, standing in for the checkout.
 *
 * @param {object} files Each relative path mapped to its contents. An object is written as JSON.
 *
 * @returns {string} The directory.
 */
function checkoutWith(files = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'playground-preview-'))

  for (const [name, contents] of Object.entries(files)) {
    const full = path.join(dir, name)
    fs.mkdirSync(path.dirname(full), { recursive: true })
    fs.writeFileSync(full, typeof contents === 'string' ? contents : JSON.stringify(contents))
  }

  return dir
}

/**
 * A blueprint that installs the zip, with optional meta.
 *
 * @param {object} meta  The meta object, or undefined for none.
 * @param {object} extra More top-level keys.
 *
 * @returns {object} The blueprint.
 */
function blueprintWith(meta, extra = {}) {
  return {
    ...(meta ? { meta } : {}),
    steps: [{ step: 'installPlugin', pluginData: { resource: 'url', url: '{{ZIP_URL}}' }, options: { activate: true } }],
    ...extra,
  }
}

/**
 * The environment the action manifest hands the script, over valid inputs.
 *
 * @param {object} overrides Values to change.
 *
 * @returns {object} The environment.
 */
function actionEnv(overrides = {}) {
  return {
    GITHUB_REPOSITORY: 'example-org/my-plugin',
    GITHUB_SERVER_URL: 'https://github.com',
    GITHUB_RUN_ID: '777',
    INPUT_STATUS: 'ready',
    INPUT_ZIP_URL: ZIP_URL,
    INPUT_BLUEPRINTS: '',
    INPUT_COMMENT_MARKER: '',
    INPUT_TIME_ZONE: 'America/New_York',
    INPUT_SHA: SHA,
    RUNNER_TEMP: fs.mkdtempSync(path.join(os.tmpdir(), 'playground-preview-temp-')),
    ...overrides,
  }
}

describe('playground-preview.js', () => {
  describe('readBlueprintList', () => {
    it('reads one path per line and skips blank lines', () => {
      assert.deepEqual(readBlueprintList('  a.json\n\n b.json \n'), ['a.json', 'b.json'])
    })

    it('reads an empty input as no files, which means the default blueprint', () => {
      assert.deepEqual(readBlueprintList(''), [])
      assert.deepEqual(readBlueprintList(undefined), [])
    })
  })

  describe('validateZipUrl', () => {
    it('takes an https URL', () => {
      assert.equal(validateZipUrl(` ${ZIP_URL} `), ZIP_URL)
    })

    it('refuses an empty value, which is what a failed zip name lookup gives', () => {
      assert.throws(() => validateZipUrl(''), /is not an https URL/)
    })

    it('refuses http, which the browser would block inside Playground', () => {
      assert.throws(() => validateZipUrl('http://example.com/my-plugin.zip'), /is not an https URL/)
    })
  })

  describe('loadBlueprint', () => {
    it('reads a file relative to the checkout', () => {
      const dir = checkoutWith({ '.github/playground/blueprint.json': blueprintWith() })

      assert.equal(loadBlueprint('.github/playground/blueprint.json', dir).steps.length, 1)
    })

    it('fails on a missing file and names it', () => {
      assert.throws(
        () => loadBlueprint('.github/playground/missing.json', checkoutWith()),
        /The blueprint file \.github\/playground\/missing\.json does not exist/
      )
    })

    it('fails on a file that is not JSON and says why', () => {
      const dir = checkoutWith({ 'broken.json': '{"steps": [,]}' })

      assert.throws(() => loadBlueprint('broken.json', dir), /The blueprint file broken\.json is not valid JSON: /)
    })

    it('fails on JSON that is not an object', () => {
      const dir = checkoutWith({ 'list.json': '[]' })

      assert.throws(() => loadBlueprint('list.json', dir), /has to hold a JSON object/)
    })
  })

  describe('fillPlaceholders', () => {
    it('replaces the placeholder in every string, however deep', () => {
      const filled = fillPlaceholders(
        { a: '{{ZIP_URL}}', b: [{ c: 'x {{ZIP_URL}} y' }], d: 3, e: true, f: null },
        { ZIP_URL: 'https://z' },
        'f.json'
      )

      assert.deepEqual(filled, { a: 'https://z', b: [{ c: 'x https://z y' }], d: 3, e: true, f: null })
    })

    it('keeps the JSON valid when the value has quotes and backslashes', () => {
      const value = 'https://example.com/a"b\\c.zip'
      const filled = fillPlaceholders({ url: '{{ZIP_URL}}' }, { ZIP_URL: value }, 'f.json')

      assert.equal(JSON.parse(JSON.stringify(filled)).url, value)
    })

    it('fails on a placeholder it does not fill, which is most likely a typo', () => {
      assert.throws(
        () => fillPlaceholders({ url: '{{ZIP_ULR}}' }, { ZIP_URL: 'https://z' }, 'f.json'),
        /f\.json uses \{\{ZIP_ULR\}\}, which this action does not fill\. It fills \{\{ZIP_URL\}\}\./
      )
    })

    it('leaves braces that are not a placeholder alone, such as PHP in a WP-CLI step', () => {
      const command = "wp eval 'echo json_encode([\"a\" => \"{{b}}\"]); $x = \"${y}\";'"

      assert.equal(fillPlaceholders(command, { ZIP_URL: 'https://z' }, 'f.json'), command)
    })
  })

  describe('prepareVariant', () => {
    it('reads the label and the note from meta, then removes meta and $schema', () => {
      const variant = prepareVariant(
        'sample.json',
        blueprintWith({ title: ' With sample data ', description: 'Opens slower.' }, { $schema: 'https://playground.wordpress.net/blueprint-schema.json' }),
        ZIP_URL
      )

      assert.equal(variant.title, 'With sample data')
      assert.equal(variant.description, 'Opens slower.')
      assert.equal(variant.blueprint.meta, undefined, 'meta would need meta.author to pass the schema')
      assert.equal(variant.blueprint.$schema, undefined)
      assert.equal(variant.blueprint.steps[0].pluginData.url, ZIP_URL)
    })

    it('fails when the blueprint never installs the zip', () => {
      assert.throws(
        () => prepareVariant('other.json', { steps: [{ step: 'login', username: 'admin' }] }, ZIP_URL),
        /other\.json does not use \{\{ZIP_URL\}\}/
      )
    })
  })

  describe('validateVariants', () => {
    const variant = (file, title) => ({ file, title, description: '', blueprint: {} })

    it('takes one untitled blueprint next to titled ones', () => {
      assert.doesNotThrow(() => validateVariants([variant('a.json', ''), variant('b.json', 'With sample data')]))
    })

    it('fails on two untitled blueprints, which would give two links with the same label', () => {
      assert.throws(() => validateVariants([variant('a.json', ''), variant('b.json', '')]), /a\.json and b\.json have no meta\.title/)
    })

    it('fails on two blueprints with the same title', () => {
      assert.throws(
        () => validateVariants([variant('a.json', 'Shop'), variant('b.json', 'Shop')]),
        /a\.json and b\.json have the same meta\.title 'Shop'/
      )
    })
  })

  describe('playgroundUrl', () => {
    it('puts the blueprint in the hash as base64 JSON', () => {
      const blueprint = { landingPage: '/wp-admin/', steps: [] }

      assert.deepEqual(decodeLink(playgroundUrl(blueprint)), blueprint)
    })

    it('keeps non-ASCII text, which Playground decodes as UTF-8', () => {
      const blueprint = { steps: [{ step: 'wp-cli', command: 'wp option update blogname "Café ✓"' }] }

      assert.deepEqual(decodeLink(playgroundUrl(blueprint)), blueprint)
      assert.match(playgroundUrl(blueprint), /^[\x21-\x7e]+$/, 'only printable ASCII in the link')
    })
  })

  describe('formatStamp and badgeUrl', () => {
    it('prints the time like date "+%m/%d %I:%M %p %Z", with EST in winter and EDT in summer', () => {
      assert.equal(formatStamp(WINTER, 'America/New_York'), '01/15 05:43 PM EST')
      assert.equal(formatStamp(SUMMER, 'America/New_York'), '07/15 05:43 PM EDT')
    })

    it('takes another time zone', () => {
      assert.equal(formatStamp(WINTER, 'America/Chicago'), '01/15 04:43 PM CST')
    })

    it('fails on a time zone that does not exist', () => {
      assert.throws(() => formatStamp(WINTER, 'America/Atlantis'), /'America\/Atlantis' is not a time zone/)
    })

    it('encodes spaces and slashes, and doubles dashes so shields.io does not split on them', () => {
      assert.equal(
        badgeUrl('Build Started', '01/15 02:43 PM GMT-3', 'blue'),
        'https://img.shields.io/badge/Build%20Started-01%2F15%2002%3A43%20PM%20GMT--3-blue'
      )
    })
  })

  describe('buildComment', () => {
    it('writes "building" with the marker first and the short commit', () => {
      const body = buildComment({ status: 'building', marker: MARKER, sha: SHA, stamp: '01/15 05:43 PM EST' })

      assert.equal(
        body,
        [
          MARKER,
          '🏗️ Playground preview building for commit 15e470c',
          '',
          '![Build timestamp](https://img.shields.io/badge/Build%20Started-01%2F15%2005%3A43%20PM%20EST-blue)',
          '',
          'This takes a few minutes.',
          '',
        ].join('\n')
      )
    })

    it('writes "failed" with a link to the run', () => {
      const body = buildComment({
        status: 'failed',
        marker: MARKER,
        sha: SHA,
        stamp: '01/15 05:43 PM EST',
        runUrl: 'https://github.com/example-org/my-plugin/actions/runs/777',
      })

      assert.ok(body.startsWith(`${MARKER}\n❌ Playground preview build failed for commit 15e470c\n`))
      assert.match(body, /Build%20Failed-.*-red\)/)
      assert.match(body, /See the \[workflow run\]\(https:\/\/github\.com\/example-org\/my-plugin\/actions\/runs\/777\) for the error\./)
    })

    it('writes one link per blueprint, the zip link, then the notes', () => {
      const variants = [
        { file: 'a.json', title: '', description: 'Debug output is on.', blueprint: { steps: [] } },
        { file: 'b.json', title: 'With [sample] data', description: 'Opens slower.', blueprint: { steps: [1] } },
      ]
      const lines = buildComment({ status: 'ready', marker: MARKER, sha: SHA, stamp: 's', variants, zipUrl: ZIP_URL }).split('\n')

      assert.equal(lines[0], MARKER)
      assert.equal(lines[1], '🎉 Playground preview ready for commit 15e470c')
      assert.equal(lines[3], '![Build timestamp](https://img.shields.io/badge/Built-s-darkgreen)')
      assert.equal(lines[5], `- 🛝 [Try in WordPress Playground](${playgroundUrl({ steps: [] })})`)
      assert.equal(lines[6], `- 🛝 [Try in WordPress Playground (With \\[sample\\] data)](${playgroundUrl({ steps: [1] })})`)
      assert.equal(lines[7], `- 💾 [Download zip](${ZIP_URL})`)
      assert.equal(lines[9], 'Debug output is on.')
      assert.equal(lines[10], '**With [sample] data:** Opens slower.')
    })
  })

  describe('checkCommentLength', () => {
    it('passes a comment GitHub accepts', () => {
      assert.doesNotThrow(() => checkCommentLength('x'.repeat(MAX_COMMENT_LENGTH), []))
    })

    it('fails a longer one and names each link length', () => {
      const variants = [{ file: 'big.json', blueprint: { a: 'b' } }]

      assert.throws(
        () => checkCommentLength('x'.repeat(MAX_COMMENT_LENGTH + 1), variants),
        /would be 65537 characters, and GitHub takes at most 65536\. Link lengths: big\.json: \d+\./
      )
    })
  })

  describe('readyComment', () => {
    it('uses the default blueprint when no file is listed', () => {
      const { variants } = readyComment({ files: [], cwd: checkoutWith(), zipUrl: ZIP_URL, marker: MARKER, sha: SHA, stamp: 's' })

      assert.equal(variants.length, 1)
      assert.equal(variants[0].file, DEFAULT_BLUEPRINT)
      const steps = variants[0].blueprint.steps
      assert.deepEqual(steps.find((step) => step.step === 'defineWpConfigConsts').consts, { WP_DEBUG: true, WP_DEBUG_DISPLAY: true })
      assert.deepEqual(steps.find((step) => step.step === 'installPlugin'), {
        step: 'installPlugin',
        pluginData: { resource: 'url', url: ZIP_URL },
        options: { activate: true },
      })
    })

    it('builds the two example blueprints from templates/ into two links', () => {
      const files = [path.join(TEMPLATES, 'blueprint.json'), path.join(TEMPLATES, 'blueprint-sample-data.json')]
      const { body, variants } = readyComment({ files, cwd: '/', zipUrl: ZIP_URL, marker: MARKER, sha: SHA, stamp: 's' })

      assert.deepEqual(variants.map((variant) => variant.title), ['', 'With sample data'])
      assert.equal(body.match(/🛝/g).length, 2)
      const seeded = decodeLink(body.match(/\(With sample data\)\]\((.+?)\)/)[1])
      assert.ok(seeded.steps.some((step) => step.step === 'wp-cli'), 'the WP-CLI steps survive')
    })

    it('fails when a blueprint would make the comment too long', () => {
      const big = blueprintWith(undefined, { landingPage: `/${'x'.repeat(60000)}` })
      const dir = checkoutWith({ 'big.json': big })

      assert.throws(() => readyComment({ files: ['big.json'], cwd: dir, zipUrl: ZIP_URL, marker: MARKER, sha: SHA, stamp: 's' }), /GitHub takes at most 65536/)
    })
  })

  describe('run', () => {
    /** What the `comment-file` output points to. */
    const written = (outputs) => fs.readFileSync(outputs()['comment-file'], 'utf8')

    it('writes the links under the marker named after the repository', async (t) => {
      const { core, outputs, summary } = await coreWithOutputs(t)
      const env = actionEnv({ GITHUB_WORKSPACE: checkoutWith() })

      await run({ core, env, now: WINTER })

      assert.equal(outputs()['comment-file'], path.join(env.RUNNER_TEMP, COMMENT_FILE))
      const body = written(outputs)
      assert.ok(body.startsWith('<!-- playground-preview:example-org/my-plugin -->\n🎉 Playground preview ready for commit 15e470c\n'))
      assert.match(body, /Built-01%2F15%2005%3A43%20PM%20EST-darkgreen/)
      assert.match(summary(), /Playground preview ready/, 'the links are in the job summary too')
    })

    it('uses the marker it is given', async (t) => {
      const { core, outputs } = await coreWithOutputs(t)

      await run({ core, env: actionEnv({ INPUT_STATUS: 'building', INPUT_COMMENT_MARKER: '<!-- custom -->' }), now: WINTER })

      assert.ok(written(outputs).startsWith('<!-- custom -->\n🏗️ Playground preview building'))
    })

    it('links "failed" to this run', async (t) => {
      const { core, outputs } = await coreWithOutputs(t)

      await run({ core, env: actionEnv({ INPUT_STATUS: 'failed', INPUT_ZIP_URL: '' }), now: WINTER })

      assert.match(written(outputs), /\(https:\/\/github\.com\/example-org\/my-plugin\/actions\/runs\/777\)/)
    })

    it('replaces the file of an earlier status, so the next step reads the newest text', async (t) => {
      const { core, outputs } = await coreWithOutputs(t)
      const env = actionEnv({ INPUT_STATUS: 'building' })

      await run({ core, env, now: WINTER })
      await run({ core, env: { ...env, INPUT_STATUS: 'failed' }, now: WINTER })

      assert.match(written(outputs), /build failed for commit 15e470c/)
    })

    it('refuses an unknown status and writes nothing', async (t) => {
      const { core, outputs } = await coreWithOutputs(t)
      const env = actionEnv({ INPUT_STATUS: 'done' })

      await assert.rejects(run({ core, env }), /Unknown status 'done'/)
      assert.equal(fs.existsSync(path.join(env.RUNNER_TEMP, COMMENT_FILE)), false)
      assert.equal(outputs()['comment-file'], undefined)
    })

    it('writes nothing when a blueprint is broken, so the "failed" job can say so', async (t) => {
      const { core, outputs } = await coreWithOutputs(t)
      const dir = checkoutWith({ 'bad.json': 'not json' })
      const env = actionEnv({ GITHUB_WORKSPACE: dir, INPUT_BLUEPRINTS: 'bad.json' })

      await assert.rejects(run({ core, env }), /bad\.json is not valid JSON/)
      assert.equal(fs.existsSync(path.join(env.RUNNER_TEMP, COMMENT_FILE)), false)
      assert.equal(outputs()['comment-file'], undefined)
    })

    it('does not call the GitHub API, so it needs no token', async (t) => {
      const { core } = await coreWithOutputs(t)

      await assert.doesNotReject(run({ core, env: actionEnv({ INPUT_STATUS: 'building' }), now: WINTER }))
    })
  })

  describe('as a script', () => {
    it('prints the comment for local blueprint files and posts nothing', () => {
      const result = spawnSync('node', [SCRIPT, '--zip-url', ZIP_URL, path.join(FIXTURES, 'minimal.json')], {
        encoding: 'utf8',
        env: { PATH: process.env.PATH },
      })

      assert.equal(result.status, 0, result.stderr)
      assert.match(result.stdout, /^<!-- playground-preview:local -->\n🎉 Playground preview ready for commit local\n/)
      assert.match(result.stdout, /- 🛝 \[Try in WordPress Playground\]\(https:\/\/playground\.wordpress\.net\/#/)
    })

    it('exits 1 with the reason on a bad blueprint', () => {
      const result = spawnSync('node', [SCRIPT, '--zip-url', ZIP_URL, path.join(FIXTURES, 'no-zip.json')], {
        encoding: 'utf8',
        env: { PATH: process.env.PATH },
      })

      assert.equal(result.status, 1)
      assert.match(result.stderr, /no-zip\.json does not use \{\{ZIP_URL\}\}/)
    })
  })
})
