import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { runCli, type CliIo } from '../src/cli.js'

function io(): CliIo & { stderrText: string; stdoutText: string } {
  return {
    stderrText: '',
    stdoutText: '',
    writeErr(value) {
      this.stderrText += value
    },
    writeOut(value) {
      this.stdoutText += value
    },
  }
}

describe('frontprep CLI', () => {
  it('lists init and check in help', async () => {
    const output = io()

    await expect(
      runCli(['node', 'frontprep', '--help'], undefined, output),
    ).resolves.toBe(0)
    expect(output.stdoutText).toContain('init')
    expect(output.stdoutText).toContain('check')
  })

  it('prints the package version', async () => {
    const output = io()

    await expect(
      runCli(['node', 'frontprep', '--version'], undefined, output),
    ).resolves.toBe(0)
    expect(output.stdoutText).toBe('0.1.0-beta.0\n')
  })

  it('maps an unknown command to exit code 2', async () => {
    const output = io()

    await expect(
      runCli(['node', 'frontprep', 'unknown'], undefined, output),
    ).resolves.toBe(2)
    expect(output.stderrText).toContain('unknown command')
  })

  it('maps an unsupported project to exit code 2', async () => {
    const output = io()
    const root = await mkdtemp(join(tmpdir(), 'frontprep-unsupported-'))

    await expect(
      runCli(['node', 'frontprep', 'init', '--cwd', root], undefined, output),
    ).resolves.toBe(2)
    expect(output.stderrText).toContain('package.json')
  })
})
