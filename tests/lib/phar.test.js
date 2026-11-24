'use strict'

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { downloadPhar } = require('../../.github/lib/phar.js')

const CONTENT = 'phar bytes'
const SHA512 = crypto.createHash('sha512').update(CONTENT).digest('hex')

/** An exec stand-in whose curl writes `content` to the `-o` path, or fails. */
function fakeExec({ content = CONTENT, exitCode = 0 } = {}) {
  const calls = []

  return {
    calls,
    async getExecOutput(command, args) {
      calls.push([command, ...args])
      if (exitCode === 0) {
        fs.writeFileSync(args[args.indexOf('-o') + 1], content)
      }

      return { exitCode, stdout: '', stderr: exitCode === 0 ? '' : 'curl: (22) 404' }
    },
  }
}

function tempPhar() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'phar-')), 'tool.phar')
}

describe('downloadPhar', () => {
  it('downloads once and reuses the file on the next call', async () => {
    const phar = tempPhar()
    const exec = fakeExec()
    const options = { exec, phar, url: 'https://example.com/tool.phar', label: 'tool 1.0.0', sha512: SHA512 }

    assert.equal(await downloadPhar(options), phar)
    assert.equal(await downloadPhar(options), phar)
    assert.equal(exec.calls.length, 1)
  })

  it('deletes a phar that does not match its sha512', async () => {
    const phar = tempPhar()

    await assert.rejects(
      downloadPhar({ exec: fakeExec({ content: 'other' }), phar, url: 'u', label: 'tool 1.0.0', sha512: SHA512, what: 'Nothing ran.' }),
      /The tool 1\.0\.0 phar does not match its sha512: .* Nothing ran\.$/
    )
    assert.equal(fs.existsSync(phar), false)
  })

  it('leaves no file behind when the download fails', async () => {
    const phar = tempPhar()

    await assert.rejects(downloadPhar({ exec: fakeExec({ exitCode: 22 }), phar, url: 'u', label: 'tool 1.0.0' }), /Downloading tool 1\.0\.0/)
    assert.equal(fs.existsSync(phar), false)
  })
})
