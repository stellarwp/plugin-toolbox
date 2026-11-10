'use strict'

const { describe, it } = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const report = require('../../../.github/actions/plugin-check-report/plugin-check-report.js')
const { actionsFor } = require('../../support/actions.js')

const URL_START = 'https://img.shields.io/badge/Check%20Finished-'

/**
 * The URL for each moment, as the real `date` command makes it, as the "Check Started" badge in the
 * workflow does:
 *
 *   stamp=$(LC_ALL=C TZ='America/New_York' date -r <epoch> '+%m/%d %I:%M %p %Z')
 *   stamp=${stamp// /%20}; stamp=${stamp//\//%2F}
 *   echo "https://img.shields.io/badge/Check%20Finished-${stamp}-darkgreen"
 *
 * The moments are the ones where a clock formatter goes wrong: both sides of both daylight saving
 * changes, the repeated hour of the fall change, midnight, noon and the end of a year.
 */
const MOMENTS = [
  ['winter, noon-ish', '2026-01-15T17:08:00Z', '01%2F15%2012:08%20PM%20EST'],
  ['summer', '2026-07-04T22:05:00Z', '07%2F04%2006:05%20PM%20EDT'],
  ['just before spring forward', '2026-03-08T06:59:59Z', '03%2F08%2001:59%20AM%20EST'],
  ['spring forward', '2026-03-08T07:00:00Z', '03%2F08%2003:00%20AM%20EDT'],
  ['repeated hour, first pass', '2026-11-01T05:30:00Z', '11%2F01%2001:30%20AM%20EDT'],
  ['just before fall back', '2026-11-01T05:59:59Z', '11%2F01%2001:59%20AM%20EDT'],
  ['fall back', '2026-11-01T06:00:00Z', '11%2F01%2001:00%20AM%20EST'],
  ['repeated hour, second pass', '2026-11-01T06:30:00Z', '11%2F01%2001:30%20AM%20EST'],
  ['midnight', '2026-01-15T05:00:00Z', '01%2F15%2012:00%20AM%20EST'],
  ['noon', '2026-01-15T17:00:00Z', '01%2F15%2012:00%20PM%20EST'],
  ['the last minute of a year', '2027-01-01T04:59:00Z', '12%2F31%2011:59%20PM%20EST'],
]

describe('finishBadge', () => {
  for (const [name, moment, stamp] of MOMENTS) {
    it(`makes the URL for ${name}`, () => {
      assert.equal(report.finishBadge(new Date(moment)), `${URL_START}${stamp}-darkgreen`)
    })
  }

  it('uses America/New_York unless told otherwise', () => {
    assert.equal(report.BADGE_TIME_ZONE, 'America/New_York')
    assert.equal(report.finishBadge(new Date('2026-07-04T22:05:00Z')), report.finishBadge(new Date('2026-07-04T22:05:00Z'), 'America/New_York'))
  })

  it('reads the clock when no moment is given', () => {
    assert.match(report.finishBadge(), /^https:\/\/img\.shields\.io\/badge\/Check%20Finished-\d\d%2F\d\d%20\d\d:\d\d%20[AP]M%20E[SD]T-darkgreen$/)
  })

  it('escapes only the spaces and the slash, only those two characters', () => {
    const url = report.finishBadge(new Date('2026-07-04T22:05:00Z'))

    assert.doesNotMatch(url, / |\/\d/)
    assert.match(url, /06:05%20PM/)
  })
})

describe('the badge in the comment', () => {
  const FIXTURES = path.join(__dirname, 'fixtures')
  const env = (extra = {}) => ({
    RESULTS: path.join(FIXTURES, 'same-as-baseline.txt'),
    PLUGIN_CHECK_BASELINE: path.join(FIXTURES, 'baseline.json'),
    RUN_URL: 'https://example.test/run/1',
    ...extra,
  })

  it('shows the finish badge under the status line, whatever the caller passed', async (t) => {
    const { core } = await actionsFor(t)
    const commentFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-check-badge-')), 'comment.md')

    const status = report.runCompare({
      core,
      env: env({ COMMENT_FILE: commentFile, COMMENT_BADGE: 'https://example.test/other.svg' }),
      now: new Date('2026-07-04T22:05:00Z'),
    })

    assert.equal(status, 0)
    const lines = fs.readFileSync(commentFile, 'utf8').split('\n')
    assert.match(lines[1], /^✅ Plugin Check passed/)
    assert.equal(lines[3], `![Plugin Check finished](${URL_START}07%2F04%2006:05%20PM%20EDT-darkgreen)`)
  })
})

describe('runCouldNotRun', () => {
  const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-check-fallback-'))
  const env = (file, extra = {}) => ({
    COMMENT_FILE: file,
    COMMENT_MARKER: '<!-- plugin-check:example-org/my-plugin -->',
    RUN_URL: 'https://github.com/example-org/my-plugin/actions/runs/7',
    ...extra,
  })

  it('writes the comment when the compare wrote none', async (t) => {
    const { core } = await actionsFor(t)
    const file = path.join(temp(), 'comment.md')

    const status = report.runCouldNotRun({ core, env: env(file), now: new Date('2026-07-04T22:05:00Z') })

    assert.equal(status, 0)
    assert.equal(
      fs.readFileSync(file, 'utf8'),
      [
        '<!-- plugin-check:example-org/my-plugin -->',
        '❌ Plugin Check could not run',
        '',
        `![Plugin Check finished](${URL_START}07%2F04%2006:05%20PM%20EDT-darkgreen)`,
        '',
        '📎 [Run](https://github.com/example-org/my-plugin/actions/runs/7)',
        '',
      ].join('\n')
    )
  })

  it('writes it over an empty file, as `[ ! -s file ]` did', async (t) => {
    const { core } = await actionsFor(t)
    const file = path.join(temp(), 'comment.md')
    fs.writeFileSync(file, '')

    report.runCouldNotRun({ core, env: env(file) })

    assert.match(fs.readFileSync(file, 'utf8'), /❌ Plugin Check could not run/)
  })

  it('leaves a comment the compare wrote', async (t) => {
    const { core } = await actionsFor(t)
    const file = path.join(temp(), 'comment.md')
    fs.writeFileSync(file, '<!-- marker -->\n❌ Plugin Check failed\n')

    const status = report.runCouldNotRun({ core, env: env(file) })

    assert.equal(status, 0)
    assert.equal(fs.readFileSync(file, 'utf8'), '<!-- marker -->\n❌ Plugin Check failed\n')
  })

  it('does nothing when no comment is asked for', async (t) => {
    const { core } = await actionsFor(t)

    assert.equal(report.runCouldNotRun({ core, env: env('') }), 0)
  })

  it('names the marker after the repository when none is given', async (t) => {
    const { core } = await actionsFor(t)
    const file = path.join(temp(), 'comment.md')

    report.runCouldNotRun({ core, env: env(file, { COMMENT_MARKER: '', GITHUB_REPOSITORY: 'example-org/my-plugin' }) })

    assert.match(fs.readFileSync(file, 'utf8'), /^<!-- plugin-check:example-org\/my-plugin -->\n/)
  })

  it('fails the step, naming the file, when it cannot be written', async (t) => {
    const { core, logged } = await actionsFor(t)

    const status = report.runCouldNotRun({ core, env: env('/nonexistent-folder/comment.md') })

    assert.equal(status, 1)
    assert.match(logged(), /::error title=Plugin Check::Could not write \/nonexistent-folder\/comment\.md/)
  })
})
