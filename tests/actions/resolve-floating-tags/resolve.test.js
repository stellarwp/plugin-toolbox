'use strict'

const test = require('node:test')
const assert = require('node:assert')

const {
  resolveFloatingTags,
  compareVersions,
  isInLine,
  toVersion,
} = require('../../../.github/actions/resolve-floating-tags/resolve.js')

/** Returns the resolution as `tags | skipped`, so a case reads as one line. */
function resolve(options) {
  const { tags, skipped } = resolveFloatingTags(options)

  return `${tags.join(' ')} | ${skipped.join(' ')}`
}

test('compareVersions orders by number, not by string', () => {
  assert.equal(compareVersions('1.10.0', '1.9.0'), 1, '1.10.0 is above 1.9.0')
  assert.equal(compareVersions('1.2.3.1', '1.2.3'), 1, 'a hotfix is above its release')
  assert.equal(compareVersions('1.2.10.0', '1.2.9.9'), 1)
  assert.equal(compareVersions('1.2.3', '1.2.3.0'), 0, 'a missing part counts as zero')
  assert.equal(compareVersions('1.2.3', '1.3.0'), -1)
})

test('isInLine keeps a longer number out of a shorter line', () => {
  assert.equal(isInLine('1.2.3', [1]), true)
  assert.equal(isInLine('1.2.3', [1, 2]), true)
  assert.equal(isInLine('1.2.3.1', [1, 2]), true, 'a hotfix is in its minor line')
  assert.equal(isInLine('122.3.4', [1, 2]), false, '122 is not 1.2')
  assert.equal(isInLine('1.22.3', [1, 2]), false, '1.22 is not 1.2')
  assert.equal(isInLine('10.0.0', [1]), false, '10 is not 1')
  assert.equal(isInLine('1.2', [1, 2]), false, 'a line does not contain its own name')
})

test('toVersion drops a leading v and build metadata, but keeps a prerelease suffix', () => {
  assert.equal(toVersion('v1.2.3'), '1.2.3')
  assert.equal(toVersion('1.4.0+build.7'), '1.4.0')
  assert.equal(toVersion('1.4.0-rc.1'), '1.4.0-rc.1')
})

test('the newest release of a line takes its tag', () => {
  const tagNames = ['1.0.0', '1.2.1', '1.3.0', '2.0.0']

  assert.equal(resolve({ tag: '1.3.0', tagNames }), 'v1 v1.3 | ')
  assert.equal(resolve({ tag: 'v1.3.0', tagNames }), 'v1 v1.3 | ', 'a v prefix reads the same')
})

test('a patch on an older line takes its minor tag and leaves the major alone', () => {
  assert.equal(
    resolve({ tag: '1.2.5', tagNames: ['1.3.0', '1.2.5'] }),
    'v1.2 | v1',
    'v1 stays on 1.3.0'
  )
})

test('publishing out of order does not move a tag backwards', () => {
  assert.equal(resolve({ tag: '1.1.1', tagNames: ['1.2.0', '1.1.1'] }), 'v1.1 | v1')
})

test('a newer major does not hold a lower line back', () => {
  assert.equal(resolve({ tag: '1.2.4', tagNames: ['2.1.0', '1.2.4'] }), 'v1 v1.2 | ')
})

test('a version published past a release-list cap is still compared', () => {
  // The bug this guards: 1.5.0 is old enough to fall past `gh release list --limit`, so reading
  // releases rather than tags found nothing newer and moved v1 back onto 1.2.5.
  assert.equal(
    resolve({ tag: '1.2.5', tagNames: ['3.1.0', '3.0.0', '2.9.0', '1.5.0', '1.2.5'] }),
    'v1.2 | v1'
  )
})

test('a fourth part is a hotfix within the same minor line', () => {
  assert.equal(
    resolve({ tag: '1.2.3.1', tagNames: ['1.2.2', '1.2.3', '1.2.3.1'] }),
    'v1 v1.2 | ',
    'the hotfix is the newest of the 1.2 line'
  )
  assert.equal(
    resolve({ tag: '1.2.3', tagNames: ['1.2.3', '1.2.3.1', '1.3.0'] }),
    ' | v1 v1.2',
    're-publishing 1.2.3 after the hotfix moves nothing'
  )
  assert.equal(resolve({ tag: '1.2.4', tagNames: ['1.2.3', '1.2.3.1', '1.2.4'] }), 'v1 v1.2 | ')
})

test('a version needs at least three parts', () => {
  assert.equal(resolve({ tag: '1.2', tagNames: [] }), ' | ')
  assert.equal(resolveFloatingTags({ tag: '1.2', tagNames: [] }).notices[0].message,
    'Resolved no floating tags: 1.2 has 2 parts; at least three are needed.')
})

test('a tag that is not a numeric version resolves nothing', () => {
  for (const tag of ['nonsense', 'v1', 'latest', '1.2.3-', 'v.1.2']) {
    assert.equal(resolve({ tag, tagNames: ['1.3.0'] }), ' | ', `${tag} resolves nothing`)
  }
})

test('levels select which tags are resolved', () => {
  const tagNames = ['1.2.1', '1.3.0']

  assert.equal(resolve({ tag: '1.3.0', levels: 'major', tagNames }), 'v1 | ')
  assert.equal(resolve({ tag: '1.3.0', levels: 'minor', tagNames }), 'v1.3 | ')
  assert.equal(
    resolve({ tag: '1.3.0', levels: 'minor major minor', tagNames }),
    'v1 v1.3 | ',
    'order does not matter and a repeat resolves one tag'
  )
})

test('an unknown or empty level fails rather than resolving a shorter set', () => {
  assert.throws(
    () => resolveFloatingTags({ tag: '1.3.0', levels: 'major hotfix' }),
    /Unknown level 'hotfix'/
  )
  assert.throws(() => resolveFloatingTags({ tag: '1.3.0', levels: '   ' }), /named no floating tags/)
})

test('build metadata is a released version, not a prerelease', () => {
  assert.equal(
    resolve({ tag: '1.4.0+build.7', tagNames: ['1.3.0', '1.4.0+build.7'] }),
    'v1 v1.4 | ',
    'a 1.4.0+build.7 owns what a 1.4.0 owns'
  )
})

test('prereleases resolve nothing by default', () => {
  assert.equal(resolve({ tag: '1.4.0-rc.1', tagNames: ['1.3.0'] }), ' | ', 'a suffix says so')
  assert.equal(
    resolve({ tag: '1.3.0', tagNames: ['1.2.1', '1.3.0'], flaggedPrerelease: true }),
    ' | ',
    "GitHub's flag says so for a plain version"
  )
})

test('an allowed prerelease takes a line that has had no release, and only that', () => {
  const allowPrereleases = true

  assert.equal(
    resolve({ tag: '1.4.0-rc.1', tagNames: ['1.3.0', '1.4.0-rc.1'], allowPrereleases }),
    'v1.4 | v1',
    'v1.4 has nothing released behind it; v1 stays on 1.3.0'
  )
  assert.equal(
    resolve({ tag: '1.4.0-rc.2', tagNames: ['1.3.0', '1.4.0-rc.1', '1.4.0-rc.2'], allowPrereleases }),
    'v1.4 | v1',
    'rc.1 does not block rc.2'
  )
  assert.equal(
    resolve({ tag: '1.4.0-rc.1', tagNames: ['1.5.0', '1.4.0-rc.1'], allowPrereleases }),
    'v1.4 | v1'
  )
  assert.equal(
    resolve({ tag: '2.0.0-rc.1', tagNames: ['1.3.0', '2.0.0-rc.1'], allowPrereleases }),
    'v2 v2.0 | ',
    'a brand new major line has nothing released behind it'
  )
  assert.equal(
    resolve({
      tag: '1.3.0',
      tagNames: ['1.2.1', '1.3.0'],
      flaggedPrerelease: true,
      allowPrereleases,
    }),
    'v1.3 | v1',
    'a flagged prerelease is not the released version that blocks itself'
  )
})

test('an allowed prerelease never takes a tag from a released version', () => {
  const allowPrereleases = true

  assert.equal(
    resolve({ tag: '1.4.0-rc.1', tagNames: ['1.3.0', '1.4.0', '1.4.0-rc.1'], allowPrereleases }),
    ' | v1 v1.4',
    'a released 1.4.0 keeps v1.4 when its own rc is published afterwards'
  )
  assert.equal(
    resolve({ tag: '1.4.1-rc.1', tagNames: ['1.3.0', '1.4.0', '1.4.1-rc.1'], allowPrereleases }),
    ' | v1 v1.4',
    'the 1.4 line has had a release, so no later 1.4 prerelease takes it'
  )
})

test('a suffixed tag never blocks a released version', () => {
  assert.equal(
    resolve({ tag: '1.3.1', tagNames: ['1.3.0', '1.3.1', '1.9.0-rc.1'] }),
    'v1 v1.3 | ',
    'an outstanding 1.9.0-rc.1 does not hold v1 back'
  )
})

test('unreadable tags resolve on the released tag alone', () => {
  assert.equal(resolve({ tag: '1.3.0', tagNames: [] }), 'v1 v1.3 | ')
})

test('the version output carries the released version without its v', () => {
  assert.equal(resolveFloatingTags({ tag: 'v1.2.3', tagNames: [] }).version, '1.2.3')
  assert.equal(resolveFloatingTags({ tag: 'nonsense', tagNames: [] }).version, '')
})
