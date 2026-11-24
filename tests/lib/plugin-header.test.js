'use strict'

const { describe, it, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { readPluginHeader } = require('../../.github/lib/plugin-header.js')

describe('readPluginHeader', () => {
  let dir

  const write = (name, body) => {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true })
    fs.writeFileSync(path.join(dir, name), body)
  }

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-header-'))
  })

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('reads the Text Domain and Domain Path of the top-level PHP file with a Plugin Name', () => {
    write('helpers.php', '<?php\n// Helpers.\n')
    write('give.php', '<?php\n/**\n * Plugin Name: Give\n * Text Domain: give\n * Domain Path: /languages\n */\n')

    assert.deepEqual(readPluginHeader(dir), { file: 'give.php', textDomain: 'give', domainPath: 'languages' })
  })

  it('drops the leading and trailing slashes of the Domain Path', () => {
    write('learndash.php', '<?php\n/*\nPlugin Name: LearnDash\nText Domain: learndash\nDomain Path: /languages/\n*/\n')

    assert.equal(readPluginHeader(dir).domainPath, 'languages')
  })

  it('reads a header that closes the comment on its line, in any case, after # or @', () => {
    write('plugin.php', '<?php\n# plugin name: Plugin\n@ Text Domain:  my-plugin  */\n/* Domain Path: lang */\n')

    assert.deepEqual(readPluginHeader(dir), { file: 'plugin.php', textDomain: 'my-plugin', domainPath: 'lang' })
  })

  it('reports a missing Text Domain or Domain Path as null', () => {
    write('plugin.php', '<?php\n/*\n * Plugin Name: Plugin\n * Text Domain:\n */\n')

    assert.deepEqual(readPluginHeader(dir), { file: 'plugin.php', textDomain: null, domainPath: null })
  })

  it('takes the first plugin file in name order', () => {
    write('b.php', '<?php\n// Plugin Name: B\n// Text Domain: b\n')
    write('a.php', '<?php\n// Plugin Name: A\n// Text Domain: a\n')

    assert.equal(readPluginHeader(dir).file, 'a.php')
  })

  it('reads only the first 8 KiB of a file, like make-pot', () => {
    write('plugin.php', `<?php\n/*${' '.repeat(8192)}\nPlugin Name: Plugin\n*/\n`)

    assert.equal(readPluginHeader(dir), null)
  })

  it('returns null when no top-level PHP file has a Plugin Name header', () => {
    write('plugin.php', '<?php\n')
    write('readme.txt', 'Plugin Name: Plugin\n')
    write('src/plugin.php', '<?php\n// Plugin Name: Nested\n')

    assert.equal(readPluginHeader(dir), null)
  })

  it('returns null for a directory that is not there', () => {
    assert.equal(readPluginHeader(path.join(dir, 'nowhere')), null)
  })
})
