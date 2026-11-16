'use strict'

/**
 * Shell-style globs, shared by the toolbox actions. Loaded by a path relative to each action's
 * directory, like exec.js.
 */

/**
 * Turns a shell-style glob into a RegExp. `*` matches anything, `/` included, `?` one character and
 * `[...]` a set, which is what bash's `[[ $file == $glob ]]` does.
 *
 * @param {string} glob The glob.
 *
 * @returns {RegExp} A RegExp that matches the whole path.
 */
function globToRegExp(glob) {
  let source = ''

  for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index]

    if (char === '*') {
      source += '.*'
    } else if (char === '?') {
      source += '.'
    } else if (char === '[') {
      const close = glob.indexOf(']', index + 2)

      if (close === -1) {
        source += '\\['
      } else {
        const set = glob.slice(index + 1, close).replace(/^!/, '^').replace(/\\/g, '\\\\')
        source += `[${set}]`
        index = close
      }
    } else {
      source += char.replace(/[.+^${}()|\\\]]/g, '\\$&')
    }
  }

  return new RegExp(`^${source}$`, 's')
}

module.exports = { globToRegExp }
