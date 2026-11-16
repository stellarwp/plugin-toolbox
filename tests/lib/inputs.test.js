'use strict'

const { describe, it } = require('node:test')
const assert = require('node:assert')

const { lines, words } = require('../../.github/lib/inputs.js')

describe('inputs', () => {
  describe('lines', () => {
    it('splits on newlines, trims each line and drops empties', () => {
      assert.deepEqual(lines('  a \r\n\nb\n'), ['a', 'b'])
      assert.deepEqual(lines(undefined), [])
    })

    it('keeps spaces inside a line', () => {
      assert.deepEqual(lines('src/my plugin/*.php\n*.js'), ['src/my plugin/*.php', '*.js'])
    })
  })

  describe('words', () => {
    it('splits on any whitespace and drops empties', () => {
      assert.deepEqual(words('a\n b\t\nc \n'), ['a', 'b', 'c'])
      assert.deepEqual(words(undefined), [])
    })
  })
})
