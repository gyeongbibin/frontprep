import { access } from 'node:fs/promises'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { ProcessFailure, ProcessRunner } from '../../src/core/process.js'
import { createProject } from '../helpers/project.js'

describe('ProcessRunner', () => {
  it('captures stdout and stderr from a successful process', async () => {
    const project = await createProject()
    const runner = new ProcessRunner()

    const result = await runner.run(
      process.execPath,
      ['-e', "console.log('out'); console.error('err')"],
      { cwd: project.root },
    )

    expect(result).toEqual({
      exitCode: 0,
      signal: null,
      stderr: 'err\n',
      stdout: 'out\n',
    })
  })

  it('reports the complete failure without losing process output', async () => {
    const project = await createProject()
    const runner = new ProcessRunner()

    const failure = await runner
      .run(
        process.execPath,
        [
          '-e',
          "console.log('before exit'); console.error('failure'); process.exit(3)",
        ],
        { cwd: project.root },
      )
      .catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(ProcessFailure)
    expect(failure).toMatchObject({
      args: expect.any(Array),
      command: process.execPath,
      exitCode: 3,
      signal: null,
      stderr: 'failure\n',
      stdout: 'before exit\n',
    })
  })

  it('passes consumer values literally without shell expansion', async () => {
    const project = await createProject()
    const runner = new ProcessRunner()
    const marker = join(project.root, 'shell-expanded')
    const literal = `$(touch ${marker})`

    const result = await runner.run(
      process.execPath,
      ['-e', 'process.stdout.write(process.argv[1])', literal],
      { cwd: project.root },
    )

    expect(result.stdout).toBe(literal)
    await expect(access(marker)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('terminates an in-flight process when its signal is aborted', async () => {
    const project = await createProject()
    const runner = new ProcessRunner()
    const controller = new AbortController()

    const pending = runner.run(
      process.execPath,
      ['-e', 'setInterval(() => undefined, 1_000)'],
      { cwd: project.root, signal: controller.signal },
    )
    controller.abort()

    await expect(pending).rejects.toMatchObject({
      exitCode: null,
      signal: 'SIGTERM',
    })
  })
})
