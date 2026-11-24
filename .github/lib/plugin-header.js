'use strict'

/**
 * The header of a plugin's main file, shared by the toolbox actions. Loaded by a path relative to
 * each action's directory, like workspace.js.
 *
 * The main file is found the way `wp i18n make-pot` finds it: the PHP files at the top of the
 * directory, read up to their first 8 KiB, and the first with a `Plugin Name` header wins. The
 * files are read in name order.
 */

const fs = require('node:fs')
const path = require('node:path')

/** How much of a file make-pot reads for its header, and so how much this reads. */
const HEADER_BYTES = 8192

/**
 * Reads one header field the way WordPress does: the line may start with spaces, tabs, `/`, `*`,
 * `#` or `@`, the name matches in any case, and the value ends before a `*\/` or `?>`.
 *
 * @param {string} text The start of the file.
 * @param {string} name The header name, e.g. `Text Domain`.
 *
 * @returns {string|null} The value, or null when the header is missing or empty.
 */
function readField(text, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = text.match(new RegExp(`^[ \\t/*#@]*${escaped}:(.*)$`, 'mi'))
  const value = match ? match[1].replace(/\s*(?:\*\/|\?>).*/, '').trim() : ''

  return value === '' ? null : value
}

/**
 * Reads the start of a file, with CR-only line endings made LF.
 *
 * @param {string} file The file.
 *
 * @returns {string} Its first 8 KiB.
 */
function readStart(file) {
  const fd = fs.openSync(file, 'r')
  try {
    const buffer = Buffer.alloc(HEADER_BYTES)
    const bytes = fs.readSync(fd, buffer, 0, HEADER_BYTES, 0)

    return buffer.toString('utf8', 0, bytes).replace(/\r/g, '\n')
  } finally {
    fs.closeSync(fd)
  }
}

/**
 * Finds the plugin's main file in a directory and reads its `Text Domain` and `Domain Path`.
 *
 * @param {string} dir The plugin directory.
 *
 * @throws {Error} When the directory or a file exists but cannot be read.
 *
 * @returns {{file: string, textDomain: string|null, domainPath: string|null}|null} The main file's
 *          name, its text domain, and its domain path without leading and trailing slashes, a
 *          missing header as null; or null when no top-level PHP file has a `Plugin Name` header,
 *          or the directory does not exist.
 */
function readPluginHeader(dir) {
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') {
      return null
    }

    throw error
  }

  const files = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.php'))
    .map((entry) => entry.name)
    .sort()

  for (const file of files) {
    const text = readStart(path.join(dir, file))

    if (readField(text, 'Plugin Name') !== null) {
      const domainPath = readField(text, 'Domain Path')

      return {
        file,
        textDomain: readField(text, 'Text Domain'),
        domainPath: domainPath === null ? null : domainPath.replace(/^\/+|\/+$/g, ''),
      }
    }
  }

  return null
}

module.exports = { readPluginHeader }
