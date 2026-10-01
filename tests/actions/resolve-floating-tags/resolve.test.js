'use strict'

const { describe, it } = require('node:test')
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

describe('resolve-floating-tags', () => {
  describe('compareVersions', () => {
    it('puts 1.10.0 above 1.9.0, which a string comparison does not', () => {
      assert.equal(compareVersions('1.10.0', '1.9.0'), 1)
      assert.equal(compareVersions('1.2.10.0', '1.2.9.9'), 1)
    })

    it('puts a hotfix above the release it patches', () => {
      assert.equal(compareVersions('1.2.3.1', '1.2.3'), 1)
    })

    it('counts a missing trailing part as zero', () => {
      assert.equal(compareVersions('1.2.3', '1.2.3.0'), 0)
    })

    it('orders a lower minor below a higher one', () => {
      assert.equal(compareVersions('1.2.3', '1.3.0'), -1)
    })
  })

  describe('isInLine', () => {
    it('includes a release of the line', () => {
      assert.equal(isInLine('1.2.3', [1]), true)
      assert.equal(isInLine('1.2.3', [1, 2]), true)
    })

    it('includes a hotfix in its minor line', () => {
      assert.equal(isInLine('1.2.3.1', [1, 2]), true)
    })

    it('excludes a longer number that only looks like a prefix', () => {
      assert.equal(isInLine('122.3.4', [1, 2]), false)
      assert.equal(isInLine('1.22.3', [1, 2]), false)
      assert.equal(isInLine('10.0.0', [1]), false)
    })

    it('excludes the name of the line itself', () => {
      assert.equal(isInLine('1.2', [1, 2]), false)
    })
  })

  describe('toVersion', () => {
    it('drops a leading v', () => {
      assert.equal(toVersion('v1.2.3'), '1.2.3')
    })

    it('drops build metadata', () => {
      assert.equal(toVersion('1.4.0+build.7'), '1.4.0')
    })

    it('keeps a prerelease suffix, so the version fails the numeric test', () => {
      assert.equal(toVersion('1.4.0-rc.1'), '1.4.0-rc.1')
    })
  })

  describe('each tag is decided on its own line', () => {
    it('gives every requested tag to the newest release', () => {
      const tagNames = ['1.0.0', '1.2.1', '1.3.0', '2.0.0']

      assert.equal(resolve({ tag: '1.3.0', tagNames }), 'v1 v1.3 | ')
      assert.equal(resolve({ tag: 'v1.3.0', tagNames }), 'v1 v1.3 | ', 'a v prefix reads the same')
    })

    it('gives a patch on an older line its minor tag and leaves the major alone', () => {
      assert.equal(resolve({ tag: '1.2.5', tagNames: ['1.3.0', '1.2.5'] }), 'v1.2 | v1')
    })

    it('does not move a tag backwards when a release is published out of order', () => {
      assert.equal(resolve({ tag: '1.1.1', tagNames: ['1.2.0', '1.1.1'] }), 'v1.1 | v1')
    })

    it('does not let a newer major hold a lower line back', () => {
      assert.equal(resolve({ tag: '1.2.4', tagNames: ['2.1.0', '1.2.4'] }), 'v1 v1.2 | ')
    })

    it('still compares a version that would fall past a release-list cap', () => {
      // Reading releases rather than tags missed 1.5.0 here, because a release list is ordered by
      // publication date and capped, and moved v1 back onto 1.2.5.
      assert.equal(
        resolve({ tag: '1.2.5', tagNames: ['3.1.0', '3.0.0', '2.9.0', '1.5.0', '1.2.5'] }),
        'v1.2 | v1'
      )
    })
  })

  describe('a fourth version part is a hotfix in the same minor line', () => {
    it('gives the minor tag to the hotfix', () => {
      assert.equal(resolve({ tag: '1.2.3.1', tagNames: ['1.2.2', '1.2.3', '1.2.3.1'] }), 'v1 v1.2 | ')
    })

    it('moves nothing when the patch is republished after its hotfix', () => {
      assert.equal(resolve({ tag: '1.2.3', tagNames: ['1.2.3', '1.2.3.1', '1.3.0'] }), ' | v1 v1.2')
    })

    it('gives the tags to the next patch after a hotfix', () => {
      assert.equal(resolve({ tag: '1.2.4', tagNames: ['1.2.3', '1.2.3.1', '1.2.4'] }), 'v1 v1.2 | ')
    })
  })

  describe('the versions it accepts', () => {
    it('needs at least three parts, so a floating tag is never the release tag', () => {
      assert.equal(resolve({ tag: '1.2', tagNames: [] }), ' | ')
      assert.equal(
        resolveFloatingTags({ tag: '1.2', tagNames: [] }).notices[0].message,
        'Resolved no floating tags: 1.2 has 2 parts; at least three are needed.'
      )
    })

    it('resolves nothing for a tag that is not a numeric version', () => {
      for (const tag of ['nonsense', 'v1', 'latest', '1.2.3-', 'v.1.2']) {
        assert.equal(resolve({ tag, tagNames: ['1.3.0'] }), ' | ', `${tag} resolves nothing`)
      }
    })
  })

  describe('levels', () => {
    const tagNames = ['1.2.1', '1.3.0']

    it('resolves only the major when asked for it', () => {
      assert.equal(resolve({ tag: '1.3.0', levels: 'major', tagNames }), 'v1 | ')
    })

    it('resolves only the minor when asked for it', () => {
      assert.equal(resolve({ tag: '1.3.0', levels: 'minor', tagNames }), 'v1.3 | ')
    })

    it('ignores the order they are written in, and a repeat', () => {
      assert.equal(resolve({ tag: '1.3.0', levels: 'minor major minor', tagNames }), 'v1 v1.3 | ')
    })

    it('fails on an unknown level rather than resolving a shorter set', () => {
      assert.throws(
        () => resolveFloatingTags({ tag: '1.3.0', levels: 'major hotfix' }),
        /Unknown level 'hotfix'/
      )
    })

    it('fails when no level is named', () => {
      assert.throws(
        () => resolveFloatingTags({ tag: '1.3.0', levels: '   ' }),
        /named no floating tags/
      )
    })
  })

  describe('prereleases', () => {
    it('reads build metadata as a released version, not a prerelease', () => {
      assert.equal(resolve({ tag: '1.4.0+build.7', tagNames: ['1.3.0', '1.4.0+build.7'] }), 'v1 v1.4 | ')
    })

    it('resolves nothing for a suffixed tag', () => {
      assert.equal(resolve({ tag: '1.4.0-rc.1', tagNames: ['1.3.0'] }), ' | ')
    })

    it('resolves nothing for a plain version GitHub marks as a prerelease', () => {
      assert.equal(
        resolve({ tag: '1.3.0', tagNames: ['1.2.1', '1.3.0'], flaggedPrerelease: true }),
        ' | '
      )
    })

    describe('with allow-prereleases on', () => {
      const allowPrereleases = true

      it('gives a tag to a line that has had no released version', () => {
        assert.equal(
          resolve({ tag: '1.4.0-rc.1', tagNames: ['1.3.0', '1.4.0-rc.1'], allowPrereleases }),
          'v1.4 | v1',
          'v1.4 has nothing released behind it; v1 stays on 1.3.0'
        )
      })

      it('lets one prerelease replace another', () => {
        assert.equal(
          resolve({
            tag: '1.4.0-rc.2',
            tagNames: ['1.3.0', '1.4.0-rc.1', '1.4.0-rc.2'],
            allowPrereleases,
          }),
          'v1.4 | v1'
        )
      })

      it('gives a brand new major line to its own prerelease', () => {
        assert.equal(
          resolve({ tag: '2.0.0-rc.1', tagNames: ['1.3.0', '2.0.0-rc.1'], allowPrereleases }),
          'v2 v2.0 | '
        )
      })

      it('leaves the major alone when a higher line has shipped', () => {
        assert.equal(
          resolve({ tag: '1.4.0-rc.1', tagNames: ['1.5.0', '1.4.0-rc.1'], allowPrereleases }),
          'v1.4 | v1'
        )
      })

      it('is not the released version that blocks itself', () => {
        assert.equal(
          resolve({
            tag: '1.3.0',
            tagNames: ['1.2.1', '1.3.0'],
            flaggedPrerelease: true,
            allowPrereleases,
          }),
          'v1.3 | v1'
        )
      })

      it('never takes a tag from the released version of the same number', () => {
        assert.equal(
          resolve({
            tag: '1.4.0-rc.1',
            tagNames: ['1.3.0', '1.4.0', '1.4.0-rc.1'],
            allowPrereleases,
          }),
          ' | v1 v1.4',
          'a released 1.4.0 keeps v1.4 when its own rc is published afterwards'
        )
      })

      it('never takes a tag once its line has had a released version', () => {
        assert.equal(
          resolve({
            tag: '1.4.1-rc.1',
            tagNames: ['1.3.0', '1.4.0', '1.4.1-rc.1'],
            allowPrereleases,
          }),
          ' | v1 v1.4'
        )
      })
    })

    it('never lets an outstanding prerelease block a released version', () => {
      assert.equal(resolve({ tag: '1.3.1', tagNames: ['1.3.0', '1.3.1', '1.9.0-rc.1'] }), 'v1 v1.3 | ')
    })
  })

  describe('when the tags cannot be read', () => {
    it('resolves every requested tag on the released tag alone', () => {
      assert.equal(resolve({ tag: '1.3.0', tagNames: [] }), 'v1 v1.3 | ')
    })
  })

  describe('the version output', () => {
    it('carries the released version without its v', () => {
      assert.equal(resolveFloatingTags({ tag: 'v1.2.3', tagNames: [] }).version, '1.2.3')
    })

    it('is empty when the tag was rejected', () => {
      assert.equal(resolveFloatingTags({ tag: 'nonsense', tagNames: [] }).version, '')
    })
  })
})
