import { describe, expect, it } from 'vitest'

import { PnpmPackageManager } from '../../src/core/package-manager.js'
import type { ProcessOptions, ProcessResult } from '../../src/core/process.js'

class RecordingRunner {
  readonly calls: Array<{
    args: readonly string[]
    command: string
    options: ProcessOptions
  }> = []

  constructor(private readonly stdout: string) {}

  async run(
    command: string,
    args: readonly string[],
    options: ProcessOptions,
  ): Promise<ProcessResult> {
    this.calls.push({ args, command, options })
    return { exitCode: 0, signal: null, stderr: '', stdout: this.stdout }
  }
}

describe('PnpmPackageManager', () => {
  it('accepts a pnpm 10 runtime', async () => {
    const runner = new RecordingRunner('10.22.0\n')
    const packageManager = new PnpmPackageManager(runner)

    await expect(
      packageManager.assertSupported('/project'),
    ).resolves.toBeUndefined()
    expect(runner.calls).toEqual([
      {
        args: ['--version'],
        command: 'pnpm',
        options: { cwd: '/project', signal: undefined },
      },
    ])
  })

  it.each(['9.15.0', 'not-a-version'])(
    'rejects unsupported version %s',
    async (version) => {
      const packageManager = new PnpmPackageManager(
        new RecordingRunner(`${version}\n`),
      )

      await expect(
        packageManager.assertSupported('/project'),
      ).rejects.toMatchObject({
        code: 'UNSUPPORTED_PNPM',
        phase: 'installation',
      })
    },
  )

  it('installs without running consumer lifecycle scripts', async () => {
    const runner = new RecordingRunner('')
    const packageManager = new PnpmPackageManager(runner)

    await packageManager.install('/project')

    expect(runner.calls).toEqual([
      {
        args: ['install', '--ignore-scripts'],
        command: 'pnpm',
        options: { cwd: '/project', signal: undefined },
      },
    ])
  })
})
