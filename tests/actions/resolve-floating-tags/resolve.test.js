'use strict'

const { describe, it } = require('node:test')
const assert = require('node:assert')

const {
  run,
  report,
  readTagNames,
  readPrereleaseFlag,
  resolveFloatingTags,
  resolvedNothing,
  isPrereleaseRelease,
  prereleaseSkipped,
  decideTags,
  readReleaseTag,
  readLevels,
  releasedVersions,
  decideTag,
  staysPut,
  compareVersions,
  isInLine,
  toVersion,
  toParts,
} = require('../../../.github/actions/resolve-floating-tags/resolve.js')
const { actionsFor } = require('../../support/actions.js')

const REPO = { owner: 'stellarwp', repo: 'plugin-toolbox' }
const TAGS_PATH = /\/repos\/stellarwp\/plugin-toolbox\/tags(\?|$)/
const RELEASE_PATH = (tag) => `/repos/stellarwp/plugin-toolbox/releases/tags/${tag}`

/**
 * A page of the tag listing, shaped the way repos.listTags returns it.
 *
 * @param {...string} names The tag names on this page.
 *
 * @returns {object[]} One listing entry per name.
 */
function tagPage(...names) {
  return names.map((name) => ({ name, commit: { sha: 'abc123' } }))
}

/**
 * Rules for a repository whose tags come back in a single page.
 *
 * @param {string[]} names   Every tag name the repository has.
 * @param {object}   release `{tag, prerelease}` for the release behind that tag. Left out, the
 *                           release lookup answers 404, as it does for a tag with no release.
 *
 * @returns {object[]} Rules for recordingFetch.
 */
function repoWith(names, release) {
  return [
    release
      ? { method: 'GET', path: RELEASE_PATH(release.tag), body: { prerelease: release.prerelease } }
      : { method: 'GET', path: /\/releases\/tags\//, status: 404, body: { message: 'Not Found' } },
    { method: 'GET', path: TAGS_PATH, body: tagPage(...names) },
  ]
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

  describe('toParts', () => {
    it('reads each part as a number', () => {
      assert.deepEqual(toParts('1.2.3'), [1, 2, 3])
      assert.deepEqual(toParts('1.2.3.4'), [1, 2, 3, 4])
    })
  })

  describe('readReleaseTag', () => {
    it('reads the three forms of a plain version', () => {
      assert.deepEqual(readReleaseTag('1.2.3'), {
        version: '1.2.3',
        releaseVersion: '1.2.3',
        core: '1.2.3',
        parts: [1, 2, 3],
      })
    })

    it('drops a leading v from all three', () => {
      const release = readReleaseTag('v1.2.3')

      assert.equal(release.version, '1.2.3')
      assert.equal(release.core, '1.2.3')
    })

    it('keeps build metadata out of the core but inside the version', () => {
      const release = readReleaseTag('1.4.0+build.7')

      assert.equal(release.version, '1.4.0+build.7')
      assert.equal(release.releaseVersion, '1.4.0', 'metadata is not part of the release name')
      assert.equal(release.core, '1.4.0')
    })

    it('keeps a prerelease suffix in the release name but out of the core', () => {
      const release = readReleaseTag('1.4.0-rc.1')

      assert.equal(release.releaseVersion, '1.4.0-rc.1', 'the suffix is what marks a prerelease')
      assert.equal(release.core, '1.4.0')
    })

    it('tells the three forms apart on a tag carrying both', () => {
      const release = readReleaseTag('v1.4.0-rc.1+build.7')

      assert.equal(release.version, '1.4.0-rc.1+build.7', 'what the release is called')
      assert.equal(release.releaseVersion, '1.4.0-rc.1', 'how it reads in the tag list')
      assert.equal(release.core, '1.4.0', 'what versions are compared by')
    })

    it('reads a fourth part as part of the version', () => {
      assert.deepEqual(readReleaseTag('1.2.3.1').parts, [1, 2, 3, 1])
    })

    it('gives a reason instead of forms when the tag is not a numeric version', () => {
      for (const tag of ['nonsense', 'v1', 'latest', 'v.1.2', '1']) {
        assert.equal(readReleaseTag(tag).reason, `${tag} is not a numeric version.`, tag)
      }
    })

    it('reads a trailing dash as a prerelease with nothing after it', () => {
      // Not a version anyone writes, but the dash is what marks a prerelease, so 1.2.3- is read as
      // one rather than rejected. It resolves nothing unless allow-prereleases is on, like any
      // other.
      const release = readReleaseTag('1.2.3-')

      assert.equal(release.reason, undefined)
      assert.equal(release.core, '1.2.3')
      assert.equal(release.releaseVersion, '1.2.3-')
    })

    it('gives a reason naming the count when there are fewer than three parts', () => {
      assert.equal(readReleaseTag('1.2').reason, '1.2 has 2 parts; at least three are needed.')
    })
  })

  describe('readLevels', () => {
    it('reads a level as the number of version parts its tag carries', () => {
      assert.deepEqual(readLevels('major'), [1])
      assert.deepEqual(readLevels('minor'), [2])
    })

    it('returns them shortest first, whatever order they were written in', () => {
      assert.deepEqual(readLevels('minor major'), [1, 2])
    })

    it('reads a level named twice as one tag', () => {
      assert.deepEqual(readLevels('major minor major'), [1, 2])
    })

    it('ignores surrounding and repeated whitespace', () => {
      assert.deepEqual(readLevels('  major   minor  '), [1, 2])
    })

    it('throws on a name that is not a level, naming it', () => {
      assert.throws(() => readLevels('major hotfix'), /Unknown level 'hotfix'/)
    })

    it('throws when no level is named', () => {
      assert.throws(() => readLevels('   '), /named no floating tags/)
      assert.throws(() => readLevels(''), /named no floating tags/)
    })
  })

  describe('releasedVersions', () => {
    it('reads each tag as the version it stands for', () => {
      assert.deepEqual(releasedVersions(['v1.2.3', '1.4.0+build.7'], ''), ['1.2.3', '1.4.0'])
    })

    it('leaves out a tag that is not a version', () => {
      assert.deepEqual(releasedVersions(['latest', 'v1', '1.2.3'], ''), ['1.2.3'])
    })

    it('leaves out a prerelease, which carries no released version', () => {
      assert.deepEqual(releasedVersions(['1.4.0-rc.1', '1.3.0'], ''), ['1.3.0'])
    })

    it('leaves out the release being published, so it cannot block itself', () => {
      assert.deepEqual(releasedVersions(['1.3.0', '1.2.1'], '1.3.0'), ['1.2.1'])
    })

    it('keeps a released version that shares a published prerelease core', () => {
      // 1.4.0-rc.1 is published while 1.4.0 is already out. Excluding by core instead of by name
      // would drop the 1.4.0 that has to block the rc.
      assert.deepEqual(releasedVersions(['1.4.0', '1.3.0'], '1.4.0-rc.1'), ['1.4.0', '1.3.0'])
    })
  })

  describe('staysPut', () => {
    it('carries the tag, that it is not owned, and the reason to log', () => {
      assert.deepEqual(staysPut('v1', 'v1 stays where it is: 1.3.0 is newer than 1.2.5.'), {
        floating: 'v1',
        owned: false,
        notice: { level: 'notice', message: 'v1 stays where it is: 1.3.0 is newer than 1.2.5.' },
      })
    })
  })

  describe('decideTag', () => {
    const release = { core: '1.2.5', version: '1.2.5', isPrerelease: false }

    it('names the tag after the numbers of its line', () => {
      assert.equal(decideTag([1], [], release).floating, 'v1')
      assert.equal(decideTag([1, 2], [], release).floating, 'v1.2')
    })

    it('moves the tag when its line has nothing released in it', () => {
      assert.deepEqual(decideTag([1, 2], ['2.0.0'], release), { floating: 'v1.2', owned: true })
    })

    it('moves the tag when this release is the newest of its line', () => {
      assert.deepEqual(decideTag([1, 2], ['1.2.4'], release), { floating: 'v1.2', owned: true })
    })

    it('moves the tag when the newest release is the same version written longer', () => {
      /**
       * compareVersions reads 1.2.3 and 1.2.3.0 as one version, so neither holds the other back.
       * Only a strictly newer release does, which a repo that writes a fourth part for its base
       * releases depends on.
       */
      assert.deepEqual(decideTag([1, 2], ['1.2.3.0'], {
        core: '1.2.3',
        version: '1.2.3',
        isPrerelease: false,
      }), { floating: 'v1.2', owned: true })
    })

    it('leaves the tag when a newer release of the line exists, saying which', () => {
      const decision = decideTag([1], ['1.3.0'], release)

      assert.equal(decision.owned, false)
      assert.equal(decision.notice.message, 'v1 stays where it is: 1.3.0 is newer than 1.2.5.')
    })

    it('leaves the tag to a released version when this release is a prerelease', () => {
      const rc = { core: '1.4.0', version: '1.4.0-rc.1', isPrerelease: true }
      const decision = decideTag([1], ['1.3.0'], rc)

      assert.equal(decision.owned, false)
      assert.equal(decision.notice.message, 'v1 stays on 1.3.0: 1.4.0-rc.1 is a prerelease.')
    })

    it('moves the tag for a prerelease when its line has nothing released', () => {
      const rc = { core: '1.4.0', version: '1.4.0-rc.1', isPrerelease: true }

      assert.deepEqual(decideTag([1, 4], ['1.3.0'], rc), { floating: 'v1.4', owned: true })
    })
  })

  describe('readTagNames', () => {
    it('returns every tag name, over as many pages as it takes', async (t) => {
      const { github, core, requests } = await actionsFor(t, [
        {
          method: 'GET',
          path: TAGS_PATH,
          responses: [
            {
              body: tagPage('1.2.0'),
              headers: {
                link: '<https://api.github.com/repos/stellarwp/plugin-toolbox/tags?page=2>; rel="next"',
              },
            },
            { body: tagPage('1.9.0') },
          ],
        },
      ])

      const names = await readTagNames({ github, core, ...REPO })

      assert.deepEqual(names, ['1.2.0', '1.9.0'])
      assert.equal(requests.length, 2, 'it followed the Link header')
    })

    it('throws when the tags cannot be read, rather than answering with none', async (t) => {
      /**
       * No tags is also what a repository with none answers, and the comparison reads that as
       * nothing being newer, so every requested tag would move. After a failed read that takes v1
       * off the newest release and puts it on whatever was published last.
       */
      const { github } = await actionsFor(t, [
        { method: 'GET', path: TAGS_PATH, status: 403, body: { message: 'Forbidden' } },
      ])

      await assert.rejects(
        readTagNames({ github, ...REPO }),
        /Could not read stellarwp\/plugin-toolbox's tags, so no floating tag can be moved safely/
      )
    })

    it('returns no tags for a repository that has none', async (t) => {
      const { github } = await actionsFor(t, [{ method: 'GET', path: TAGS_PATH, body: [] }])

      assert.deepEqual(await readTagNames({ github, ...REPO }), [])
    })
  })

  describe('readPrereleaseFlag', () => {
    it('reports a release marked as a prerelease', async (t) => {
      const { github, core } = await actionsFor(t, [
        { method: 'GET', path: RELEASE_PATH('v1.3.0'), body: { prerelease: true } },
      ])

      assert.equal(await readPrereleaseFlag({ github, core, ...REPO, tag: 'v1.3.0' }), true)
    })

    it('reports a release that is not marked as one', async (t) => {
      const { github, core } = await actionsFor(t, [
        { method: 'GET', path: RELEASE_PATH('v1.3.0'), body: { prerelease: false } },
      ])

      assert.equal(await readPrereleaseFlag({ github, core, ...REPO, tag: 'v1.3.0' }), false)
    })

    it('reports a tag with no release behind it as not a prerelease, without warning', async (t) => {
      const { github, core, logged } = await actionsFor(t, [
        { method: 'GET', path: RELEASE_PATH('v1.3.0'), status: 404, body: { message: 'Not Found' } },
      ])

      assert.equal(await readPrereleaseFlag({ github, core, ...REPO, tag: 'v1.3.0' }), false)
      assert.equal(logged(), '', 'a repo that pushes tags without Releases is not a problem')
    })

    it('throws when the lookup fails for any other reason', async (t) => {
      // Reading it as not a prerelease would let a release GitHub has marked as one take the tags
      // while allow-prereleases is off.
      const { github } = await actionsFor(t, [
        { method: 'GET', path: RELEASE_PATH('v1.3.0'), status: 403, body: { message: 'Forbidden' } },
      ])

      await assert.rejects(
        readPrereleaseFlag({ github, ...REPO, tag: 'v1.3.0' }),
        /Could not tell whether v1\.3\.0 is a prerelease/
      )
    })
  })

  describe('resolvedNothing', () => {
    it('reports empty lists and no version', () => {
      const { tags, skipped, version } = resolvedNothing('1.2 has 2 parts; at least three are needed.')

      assert.deepEqual(tags, [])
      assert.deepEqual(skipped, [])
      assert.equal(version, '')
    })

    it('carries the reason as the one notice to log', () => {
      const { notices } = resolvedNothing('nonsense is not a numeric version.')

      assert.deepEqual(notices, [
        {
          level: 'notice',
          message: 'Resolved no floating tags: nonsense is not a numeric version.',
        },
      ])
    })
  })

  describe('isPrereleaseRelease', () => {
    it('is true for a tag with a prerelease suffix, whatever GitHub says', () => {
      const suffixed = readReleaseTag('1.4.0-rc.1')

      assert.equal(isPrereleaseRelease(suffixed, false), true)
      assert.equal(isPrereleaseRelease(suffixed, true), true)
    })

    it('falls back to GitHub for a plain version, which the tag cannot answer', () => {
      const plain = readReleaseTag('1.4.0')

      assert.equal(isPrereleaseRelease(plain, true), true)
      assert.equal(isPrereleaseRelease(plain, false), false)
    })

    it('is false for build metadata, which is not a prerelease', () => {
      assert.equal(isPrereleaseRelease(readReleaseTag('1.4.0+build.7'), false), false)
    })
  })

  describe('prereleaseSkipped', () => {
    it('names the tag and the input that would change it', () => {
      assert.equal(
        prereleaseSkipped('1.4.0-rc.1'),
        '1.4.0-rc.1 is a prerelease. Set allow-prereleases to change that.'
      )
    })
  })

  describe('decideTags', () => {
    const planFor = (tag, depths = [1, 2], prerelease = false) => ({
      release: readReleaseTag(tag),
      depths,
      prerelease,
      tagNames: [],
    })

    it('decides one tag per requested depth, shortest first', () => {
      const { tags, skipped, version } = decideTags({
        ...planFor('1.3.0'),
        tagNames: ['1.2.1', '1.3.0'],
      })

      assert.deepEqual(tags, ['v1', 'v1.3'])
      assert.deepEqual(skipped, [])
      assert.equal(version, '1.3.0')
    })

    it('decides only the depths it was given', () => {
      assert.deepEqual(decideTags(planFor('1.3.0', [1])).tags, ['v1'])
      assert.deepEqual(decideTags(planFor('1.3.0', [2])).tags, ['v1.3'])
    })

    it('collects a notice for each tag it leaves alone', () => {
      const { tags, skipped, notices } = decideTags({
        ...planFor('1.2.5'),
        tagNames: ['1.3.0', '1.2.5'],
      })

      assert.deepEqual(tags, ['v1.2'])
      assert.deepEqual(skipped, ['v1'])
      assert.equal(notices.length, 1)
      assert.match(notices[0].message, /^v1 stays where it is: 1\.3\.0 is newer/)
    })

    it('passes the prerelease decision down to each tag', () => {
      const { tags, skipped } = decideTags({
        ...planFor('1.4.0-rc.1', [1, 2], true),
        tagNames: ['1.3.0'],
      })

      assert.deepEqual(tags, ['v1.4'], 'the 1.4 line has nothing released behind it')
      assert.deepEqual(skipped, ['v1'], 'the 1.x line does, so a prerelease cannot have it')
    })
  })

  describe('report', () => {
    it('writes the three outputs a later step reads', async (t) => {
      const { core, outputs } = await actionsFor(t)

      report({
        core,
        tag: 'v1.2.5',
        resolved: { tags: ['v1.2'], skipped: ['v1'], version: '1.2.5', notices: [] },
      })

      assert.deepEqual(outputs(), { tags: 'v1.2', skipped: 'v1', version: '1.2.5' })
    })

    it('logs every notice it was given', async (t) => {
      const { core, logged } = await actionsFor(t)

      report({
        core,
        tag: 'v1.2.5',
        resolved: {
          tags: [],
          skipped: ['v1'],
          version: '1.2.5',
          notices: [{ level: 'notice', message: 'v1 stays where it is' }],
        },
      })

      assert.match(logged(), /::notice::v1 stays where it is/)
    })

    it('names the tag in the log when the version was rejected', async (t) => {
      const { core, logged } = await actionsFor(t)

      report({
        core,
        tag: 'latest',
        resolved: { tags: [], skipped: [], version: '', notices: [] },
      })

      assert.match(logged(), /Resolved for latest: none/)
    })
  })

  describe('resolveFloatingTags', () => {
    describe('each tag is decided on its own line', () => {
      const tagNames = ['1.0.0', '1.2.1', '1.3.0', '2.0.0']

      it('gives every requested tag to the newest release', () => {
        const { tags, skipped } = resolveFloatingTags({ tag: '1.3.0', tagNames })

        assert.deepEqual(tags, ['v1', 'v1.3'])
        assert.deepEqual(skipped, [])
      })

      it('reads a v-prefixed tag the same way', () => {
        const { tags, skipped } = resolveFloatingTags({ tag: 'v1.3.0', tagNames })

        assert.deepEqual(tags, ['v1', 'v1.3'])
        assert.deepEqual(skipped, [])
      })

      it('gives a patch on an older line its minor tag and leaves the major alone', () => {
        const { tags, skipped } = resolveFloatingTags({ tag: '1.2.5', tagNames: ['1.3.0', '1.2.5'] })

        assert.deepEqual(tags, ['v1.2'])
        assert.deepEqual(skipped, ['v1'])
      })

      it('does not move a tag backwards when a release is published out of order', () => {
        const { tags, skipped } = resolveFloatingTags({ tag: '1.1.1', tagNames: ['1.2.0', '1.1.1'] })

        assert.deepEqual(tags, ['v1.1'])
        assert.deepEqual(skipped, ['v1'])
      })

      it('does not let a newer major hold a lower line back', () => {
        const { tags, skipped } = resolveFloatingTags({ tag: '1.2.4', tagNames: ['2.1.0', '1.2.4'] })

        assert.deepEqual(tags, ['v1', 'v1.2'])
        assert.deepEqual(skipped, [])
      })

      it('still compares a version that would fall past a release-list cap', () => {
        // Reading releases rather than tags missed 1.5.0 here, because a release list is ordered by
        // publication date and capped, and moved v1 back onto 1.2.5.
        const { tags, skipped } = resolveFloatingTags({
          tag: '1.2.5',
          tagNames: ['3.1.0', '3.0.0', '2.9.0', '1.5.0', '1.2.5'],
        })

        assert.deepEqual(tags, ['v1.2'])
        assert.deepEqual(skipped, ['v1'])
      })
    })

    describe('a fourth version part is a hotfix in the same minor line', () => {
      it('gives the minor tag to the hotfix', () => {
        const { tags, skipped } = resolveFloatingTags({
          tag: '1.2.3.1',
          tagNames: ['1.2.2', '1.2.3', '1.2.3.1'],
        })

        assert.deepEqual(tags, ['v1', 'v1.2'])
        assert.deepEqual(skipped, [])
      })

      it('moves nothing when the patch is republished after its hotfix', () => {
        const { tags, skipped } = resolveFloatingTags({
          tag: '1.2.3',
          tagNames: ['1.2.3', '1.2.3.1', '1.3.0'],
        })

        assert.deepEqual(tags, [])
        assert.deepEqual(skipped, ['v1', 'v1.2'])
      })

      it('gives the tags to the next patch after a hotfix', () => {
        const { tags, skipped } = resolveFloatingTags({
          tag: '1.2.4',
          tagNames: ['1.2.3', '1.2.3.1', '1.2.4'],
        })

        assert.deepEqual(tags, ['v1', 'v1.2'])
        assert.deepEqual(skipped, [])
      })
    })

    /**
     * Everything the individual functions decide has its own cases above. What is left to
     * resolveFloatingTags is the order it asks them in, and that order is observable: whether a bad
     * input is reported or thrown depends entirely on which check runs first.
     */
    describe('the order it checks things in', () => {
      it('reports a bad tag rather than throwing over the levels beside it', () => {
        const { tags, notices } = resolveFloatingTags({ tag: 'latest', levels: 'major hotfix' })

        assert.deepEqual(tags, [])
        assert.match(notices[0].message, /latest is not a numeric version/)
      })

      it('throws over a bad level before deciding a prerelease is not allowed', () => {
        // Both are wrong. The level throws, so a caller fixes its own configuration first rather
        // than reading a notice that says the release was skipped.
        assert.throws(
          () => resolveFloatingTags({ tag: '1.3.0-rc.1', levels: 'major hotfix' }),
          /Unknown level 'hotfix'/
        )
      })

      it('throws over a bad level even for a release it would have resolved', () => {
        assert.throws(
          () => resolveFloatingTags({ tag: '1.3.0', levels: 'major hotfix' }),
          /Unknown level 'hotfix'/
        )
      })
    })

    // readReleaseTag owns which versions are rejected and why. What is left here is a rejection
    // becoming an empty result with the reason logged.
    describe('a rejected tag', () => {
      it('resolves nothing and reports the reason readReleaseTag gave', () => {
        const { tags, skipped, version, notices } = resolveFloatingTags({
          tag: '1.2',
          tagNames: ['1.3.0'],
        })

        assert.deepEqual(tags, [])
        assert.deepEqual(skipped, [])
        assert.equal(version, '', 'nothing is reported as the released version')
        assert.equal(
          notices[0].message,
          'Resolved no floating tags: 1.2 has 2 parts; at least three are needed.'
        )
      })
    })

    // readLevels owns which names are levels and what order they come back in. What is left here is
    // whether resolveFloatingTags acts on them.
    describe('levels', () => {
      const tagNames = ['1.2.1', '1.3.0']

      it('resolves only the major when that is the only level named', () => {
        const { tags } = resolveFloatingTags({ tag: '1.3.0', tagNames, levels: 'major' })

        assert.deepEqual(tags, ['v1'])
      })

      it('resolves only the minor when that is the only level named', () => {
        const { tags } = resolveFloatingTags({ tag: '1.3.0', tagNames, levels: 'minor' })

        assert.deepEqual(tags, ['v1.3'])
      })

      it('lets a bad level fail the call instead of resolving a shorter set', () => {
        assert.throws(
          () => resolveFloatingTags({ tag: '1.3.0', levels: 'major hotfix' }),
          /Unknown level 'hotfix'/
        )
      })
    })

    describe('prereleases', () => {
      it('reads build metadata as a released version, not a prerelease', () => {
        const { tags, skipped } = resolveFloatingTags({
          tag: '1.4.0+build.7',
          tagNames: ['1.3.0', '1.4.0+build.7'],
        })

        assert.deepEqual(tags, ['v1', 'v1.4'])
        assert.deepEqual(skipped, [])
      })

      it('resolves nothing for a suffixed tag', () => {
        const { tags, skipped } = resolveFloatingTags({
          tag: '1.4.0-rc.1',
          tagNames: ['1.3.0'],
        })

        assert.deepEqual(tags, [])
        assert.deepEqual(skipped, [], 'it stops before any tag is considered')
      })

      it('resolves nothing for a plain version GitHub marks as a prerelease', () => {
        const { tags, skipped } = resolveFloatingTags({
          tag: '1.3.0',
          flaggedPrerelease: true,
          tagNames: ['1.2.1', '1.3.0'],
        })

        assert.deepEqual(tags, [])
        assert.deepEqual(skipped, [])
      })

      it('never lets an outstanding prerelease block a released version', () => {
        const { tags, skipped } = resolveFloatingTags({
          tag: '1.3.1',
          tagNames: ['1.3.0', '1.3.1', '1.9.0-rc.1'],
        })

        assert.deepEqual(tags, ['v1', 'v1.3'])
        assert.deepEqual(skipped, [])
      })

      describe('with allow-prereleases on', () => {
        const allowPrereleases = true

        it('gives a tag to a line that has had no released version', () => {
          // v1.4 has nothing released behind it; v1 stays on 1.3.0.
          const { tags, skipped } = resolveFloatingTags({
            tag: '1.4.0-rc.1',
            tagNames: ['1.3.0', '1.4.0-rc.1'],
            allowPrereleases,
          })

          assert.deepEqual(tags, ['v1.4'])
          assert.deepEqual(skipped, ['v1'])
        })

        it('lets one prerelease replace another', () => {
          const { tags, skipped } = resolveFloatingTags({
            tag: '1.4.0-rc.2',
            tagNames: ['1.3.0', '1.4.0-rc.1', '1.4.0-rc.2'],
            allowPrereleases,
          })

          assert.deepEqual(tags, ['v1.4'])
          assert.deepEqual(skipped, ['v1'])
        })

        it('gives a brand new major line to its own prerelease', () => {
          const { tags, skipped } = resolveFloatingTags({
            tag: '2.0.0-rc.1',
            tagNames: ['1.3.0', '2.0.0-rc.1'],
            allowPrereleases,
          })

          assert.deepEqual(tags, ['v2', 'v2.0'])
          assert.deepEqual(skipped, [])
        })

        it('leaves the major alone when a higher line has shipped', () => {
          const { tags, skipped } = resolveFloatingTags({
            tag: '1.4.0-rc.1',
            tagNames: ['1.5.0', '1.4.0-rc.1'],
            allowPrereleases,
          })

          assert.deepEqual(tags, ['v1.4'])
          assert.deepEqual(skipped, ['v1'])
        })

        it('is not the released version that blocks itself', () => {
          const { tags, skipped } = resolveFloatingTags({
            tag: '1.3.0',
            flaggedPrerelease: true,
            tagNames: ['1.2.1', '1.3.0'],
            allowPrereleases,
          })

          assert.deepEqual(tags, ['v1.3'])
          assert.deepEqual(skipped, ['v1'])
        })

        it('never takes a tag from the released version of the same number', () => {
          // A released 1.4.0 keeps v1.4 when its own rc is published afterwards.
          const { tags, skipped } = resolveFloatingTags({
            tag: '1.4.0-rc.1',
            tagNames: ['1.3.0', '1.4.0', '1.4.0-rc.1'],
            allowPrereleases,
          })

          assert.deepEqual(tags, [])
          assert.deepEqual(skipped, ['v1', 'v1.4'])
        })

        it('never takes a tag once its line has had a released version', () => {
          const { tags, skipped } = resolveFloatingTags({
            tag: '1.4.1-rc.1',
            tagNames: ['1.3.0', '1.4.0', '1.4.1-rc.1'],
            allowPrereleases,
          })

          assert.deepEqual(tags, [])
          assert.deepEqual(skipped, ['v1', 'v1.4'])
        })
      })
    })

    describe('when the repository has no tags', () => {
      it('resolves every requested tag, since nothing can be newer', () => {
        // Only a repository that genuinely has none reaches this: readTagNames throws rather than
        // answering with an empty list when it could not read them.
        const { tags, skipped } = resolveFloatingTags({ tag: '1.3.0', tagNames: [] })

        assert.deepEqual(tags, ['v1', 'v1.3'])
        assert.deepEqual(skipped, [])
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

  describe('run', () => {
    it('sends no request at all for a tag that is not a version', async (t) => {
      // Nothing the API could say changes the answer, so nothing is asked.
      const { github, core, requests, outputs } = await actionsFor(t)

      await run({
        github,
        core,
        env: {
          INPUT_TAG: 'latest',
          INPUT_LEVELS: 'major minor',
          GITHUB_REPOSITORY: 'stellarwp/plugin-toolbox',
        },
      })

      assert.deepEqual(requests, [])
      assert.deepEqual(outputs(), { tags: '', skipped: '', version: '' })
    })

    it('sends no request for a suffixed prerelease it is not allowed to move', async (t) => {
      // The suffix settles both questions: it is a prerelease, and prereleases are not allowed.
      const { github, core, requests } = await actionsFor(t)

      await run({
        github,
        core,
        env: {
          INPUT_TAG: '1.4.0-rc.1',
          INPUT_LEVELS: 'major minor',
          GITHUB_REPOSITORY: 'stellarwp/plugin-toolbox',
        },
      })

      assert.deepEqual(requests, [])
    })

    it('reads the release but not the tag list when a flagged prerelease is skipped', async (t) => {
      // A plain version needs the release to know, but once it does the tag list cannot matter.
      const { github, core, requests } = await actionsFor(
        t,
        repoWith(['1.2.1', '1.3.0'], { tag: '1.3.0', prerelease: true })
      )

      await run({
        github,
        core,
        env: {
          INPUT_TAG: '1.3.0',
          INPUT_LEVELS: 'major minor',
          GITHUB_REPOSITORY: 'stellarwp/plugin-toolbox',
        },
      })

      assert.equal(requests.length, 1)
      assert.match(requests[0].path, /\/releases\/tags\//)
    })

    it('fails on a bad level before sending anything', async (t) => {
      const { github, core, requests } = await actionsFor(t)

      await assert.rejects(
        run({
          github,
          core,
          env: {
            INPUT_TAG: '1.3.0',
            INPUT_LEVELS: 'major hotfix',
            GITHUB_REPOSITORY: 'stellarwp/plugin-toolbox',
          },
        }),
        /Unknown level 'hotfix'/
      )

      assert.deepEqual(requests, [])
    })

    it('reads every tag, following pagination to the last page', async (t) => {
      const { github, requests, core, outputs } = await actionsFor(t, [
        { method: 'GET', path: /\/releases\/tags\//, status: 404, body: { message: 'Not Found' } },
        {
          method: 'GET',
          path: TAGS_PATH,
          responses: [
            {
              body: tagPage('1.2.0'),
              headers: {
                link: '<https://api.github.com/repos/stellarwp/plugin-toolbox/tags?page=2>; rel="next"',
              },
            },
            // Only reachable by following the Link header. It holds the version that has to win,
            // so a resolver that stopped at the first page would resolve v1 to 1.2.0 instead.
            { body: tagPage('1.9.0') },
          ],
        },
      ])

      await run({
        github,
        core,
        env: {
          INPUT_TAG: '1.2.0',
          INPUT_LEVELS: 'major minor',
          GITHUB_REPOSITORY: 'stellarwp/plugin-toolbox',
        },
      })

      assert.equal(requests.filter((request) => TAGS_PATH.test(request.path)).length, 2)
      assert.deepEqual(outputs(), { tags: 'v1.2', skipped: 'v1', version: '1.2.0' })
    })

    it('asks the Releases API about the tag it was given', async (t) => {
      const { github, requests, core, outputs } = await actionsFor(
        t,
        repoWith(['1.2.1', '1.3.0'], { tag: 'v1.3.0', prerelease: false })
      )

      await run({
        github,
        core,
        env: {
          INPUT_TAG: 'v1.3.0',
          INPUT_LEVELS: 'major minor',
          GITHUB_REPOSITORY: 'stellarwp/plugin-toolbox',
        },
      })

      assert.ok(
        requests.some((request) => request.path === RELEASE_PATH('v1.3.0')),
        `the release was looked up by its tag, got ${JSON.stringify(requests.map((r) => r.path))}`
      )
      assert.deepEqual(outputs(), { tags: 'v1 v1.3', skipped: '', version: '1.3.0' })
    })

    it('honours the prerelease flag the Releases API reports', async (t) => {
      const { github, core, outputs, logged } = await actionsFor(
        t,
        repoWith(['1.2.1', '1.3.0'], { tag: '1.3.0', prerelease: true })
      )

      await run({
        github,
        core,
        env: {
          INPUT_TAG: '1.3.0',
          INPUT_LEVELS: 'major minor',
          GITHUB_REPOSITORY: 'stellarwp/plugin-toolbox',
        },
      })

      assert.deepEqual(outputs(), { tags: '', skipped: '', version: '' })
      assert.match(logged(), /::notice::Resolved no floating tags: 1\.3\.0 is a prerelease/)
    })

    it('reads a tag with no release behind it as not a prerelease', async (t) => {
      const { github, core, outputs } = await actionsFor(t, repoWith(['1.2.1', '1.3.0']))

      await run({
        github,
        core,
        env: {
          INPUT_TAG: '1.3.0',
          INPUT_LEVELS: 'major minor',
          GITHUB_REPOSITORY: 'stellarwp/plugin-toolbox',
        },
      })

      assert.deepEqual(outputs(), { tags: 'v1 v1.3', skipped: '', version: '1.3.0' })
    })

    it('fails without writing an output when the tags cannot be read', async (t) => {
      const { github, core, outputs } = await actionsFor(t, [
        { method: 'GET', path: /\/releases\/tags\//, status: 404, body: { message: 'Not Found' } },
        { method: 'GET', path: TAGS_PATH, status: 403, body: { message: 'Forbidden' } },
      ])

      await assert.rejects(
        run({
          github,
          core,
          env: {
            INPUT_TAG: '1.2.5',
            INPUT_LEVELS: 'major minor',
            GITHUB_REPOSITORY: 'stellarwp/plugin-toolbox',
          },
        }),
        /no floating tag can be moved safely/
      )

      assert.deepEqual(outputs(), {}, 'move-git-tags is given nothing')
    })

    it('reads the repository it was given', async (t) => {
      const { github, requests, core } = await actionsFor(t, [
        { method: 'GET', path: /\/releases\/tags\//, status: 404, body: { message: 'Not Found' } },
        { method: 'GET', path: /\/repos\/stellarwp\/other\/tags(\?|$)/, body: tagPage('1.3.0') },
      ])

      await run({
        github,
        core,
        env: {
          INPUT_TAG: '1.3.0',
          INPUT_LEVELS: 'major',
          INPUT_REPOSITORY: 'stellarwp/other',
          GITHUB_REPOSITORY: 'stellarwp/plugin-toolbox',
        },
      })

      assert.ok(
        requests.every((request) => request.path.startsWith('/repos/stellarwp/other/')),
        `every request went to the given repository, got ${JSON.stringify(requests.map((r) => r.path))}`
      )
    })
  })
})
