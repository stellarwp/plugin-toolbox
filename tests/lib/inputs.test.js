'use strict'

const { describe, it } = require('node:test')
const assert = require('node:assert')

const { words } = require('../../.github/lib/inputs.js')

describe('inputs', () => {
  describe('words', () => {
    it('splits on any whitespace and drops empties', () => {
      assert.deepEqual(words('a\n b\t\nc \n'), ['a', 'b', 'c'])
      assert.deepEqual(words(undefined), [])
    })
  })
})
