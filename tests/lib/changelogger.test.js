'use strict'

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')

const { readChangeloggerSection } = require('../../.github/lib/changelogger.js')

describe('readChangeloggerSection', () => {
  it('returns the section', () => {
    assert.deepEqual(readChangeloggerSection('{"changelogger":{"changesDir":"changes"}}'), { changesDir: 'changes' })
  })

  it('returns null without a file, valid JSON or a section object, as the changelogger falls back to its defaults', () => {
    for (const text of [null, 'not json', '{"name":"x"}', '{"changelogger":"x"}', '{"changelogger":[]}', 'null']) {
      assert.equal(readChangeloggerSection(text), null, String(text))
    }
  })
})
