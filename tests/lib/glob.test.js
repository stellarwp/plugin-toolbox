'use strict'

const { describe, it } = require('node:test')
const assert = require('node:assert')

const { globToRegExp } = require('../../.github/lib/glob.js')

describe('glob', () => {
  describe('globToRegExp', () => {
    it('lets * cross directories, like bash does', () => {
      assert.ok(globToRegExp('*.php').test('src/Deep/File.php'))
      assert.ok(!globToRegExp('*.php').test('src/File.phps'))
    })

    it('matches the whole path', () => {
      assert.ok(!globToRegExp('composer.json').test('vendor/composer.json'))
      assert.ok(globToRegExp('*composer.json').test('vendor/composer.json'))
    })

    it('reads ? as one character and [..] as a set', () => {
      assert.ok(globToRegExp('file?.php').test('file1.php'))
      assert.ok(!globToRegExp('file?.php').test('file12.php'))
      assert.ok(globToRegExp('file[12].php').test('file2.php'))
      assert.ok(!globToRegExp('file[!12].php').test('file2.php'))
    })

    it('treats regex characters as plain text', () => {
      assert.ok(globToRegExp('a+b(1).php').test('a+b(1).php'))
      assert.ok(!globToRegExp('a.php').test('aXphp'))
    })
  })
})
