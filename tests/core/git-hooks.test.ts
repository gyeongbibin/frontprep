import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  GitHooksManager,
  hasHuskyDispatcher,
  readLocalHooksPath,
  resolveDefaultHooksDirectory,
} from '../../src/core/git-hooks.js'
import {
  ProcessFailure,
  type ProcessResult,
  type ProcessRunner,
} from '../../src/core/process.js'

const temporaryRoots: string[] = []

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'frontprep-git-hooks-'))
  temporaryRoots.push(root)
  return root
}

function success(stdout = ''): ProcessResult {
  return { exitCode: 0, signal: null, stderr: '', stdout }
}

function failure(
  command: string,
  args: readonly string[],
  exitCode: number,
): ProcessFailure {
  return new ProcessFailure(command, args, {
    exitCode,
    signal: null,
    stderr: '',
    stdout: '',
  })
}

class StaticRunner implements Pick<ProcessRunner, 'run'> {
  readonly calls: { args: readonly string[]; command: string }[] = []

  constructor(
    private readonly result: ProcessResult | Error,
    private readonly expectedCommand = 'git',
  ) {}

  async run(command: string, args: readonly string[]): Promise<ProcessResult> {
    this.calls.push({ args: [...args], command })
    expect(command).toBe(this.expectedCommand)
    if (this.result instanceof Error) throw this.result
    return this.result
  }
}

class StatefulRunner implements Pick<ProcessRunner, 'run'> {
  readonly calls: { args: readonly string[]; command: string }[] = []
  failActivation = false
  failRestore = false
  installDispatcher = true
  hooksPath: string | null

  constructor(
    private readonly root: string,
    hooksPath: string | null = null,
  ) {
    this.hooksPath = hooksPath
  }

  async run(command: string, args: readonly string[]): Promise<ProcessResult> {
    this.calls.push({ command, args: [...args] })
    if (
      command === 'git' &&
      args.join(' ') === 'config --local --get core.hooksPath'
    ) {
      if (this.hooksPath === null) throw failure(command, args, 1)
      return success(`${this.hooksPath}\n`)
    }
    if (command === 'pnpm') {
      this.hooksPath = '.husky/_'
      if (this.failActivation) throw failure(command, args, 7)
      if (this.installDispatcher) {
        await mkdir(join(this.root, '.husky/_'), { recursive: true })
        await writeFile(join(this.root, '.husky/_/h'), '# dispatcher\n')
      }
      return success()
    }
    if (
      command === 'git' &&
      args.join(' ') === 'config --local --unset-all core.hooksPath'
    ) {
      if (this.failRestore) throw failure(command, args, 9)
      this.hooksPath = null
      return success()
    }
    if (
      command === 'git' &&
      args.slice(0, 3).join(' ') === 'config --local core.hooksPath'
    ) {
      if (this.failRestore) throw failure(command, args, 9)
      this.hooksPath = args[3] ?? null
      return success()
    }
    throw new Error(`Unexpected command: ${command} ${args.join(' ')}`)
  }
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((root) => rm(root, { force: true, recursive: true })),
  )
})

describe('Git Hooks inspection', () => {
  it('reads and trims the repository-local hooks path', async () => {
    const runner = new StaticRunner(success('.husky/_\n'))

    await expect(readLocalHooksPath('/project', runner)).resolves.toBe(
      '.husky/_',
    )
    expect(runner.calls).toEqual([
      {
        command: 'git',
        args: ['config', '--local', '--get', 'core.hooksPath'],
      },
    ])
  })

  it('treats only git-config exit 1 as an unset hooks path', async () => {
    const args = ['config', '--local', '--get', 'core.hooksPath']
    await expect(
      readLocalHooksPath('/project', new StaticRunner(failure('git', args, 1))),
    ).resolves.toBeNull()
    await expect(
      readLocalHooksPath('/project', new StaticRunner(failure('git', args, 2))),
    ).rejects.toMatchObject({ exitCode: 2 })
  })

  it('resolves the absolute default Git hooks directory', async () => {
    const runner = new StaticRunner(success('/repo/.git/hooks\n'))

    await expect(
      resolveDefaultHooksDirectory('/project', runner),
    ).resolves.toBe('/repo/.git/hooks')
    expect(runner.calls[0]).toEqual({
      command: 'git',
      args: ['rev-parse', '--path-format=absolute', '--git-path', 'hooks'],
    })
  })

  it('accepts only a regular non-symbolic Husky dispatcher', async () => {
    const root = await temporaryRoot()
    await mkdir(join(root, '.husky/_'), { recursive: true })
    await expect(hasHuskyDispatcher(root)).resolves.toBe(false)

    await writeFile(join(root, '.husky/_/h'), '# dispatcher\n')
    await expect(hasHuskyDispatcher(root)).resolves.toBe(true)

    await rm(join(root, '.husky/_/h'))
    await mkdir(join(root, '.husky/_/target'))
    await symlink('target', join(root, '.husky/_/h'))
    await expect(hasHuskyDispatcher(root)).resolves.toBe(false)
  })
})

describe('GitHooksManager', () => {
  it('activates Husky and returns the previous path', async () => {
    const root = await temporaryRoot()
    const runner = new StatefulRunner(root)
    const manager = new GitHooksManager(runner)

    await expect(manager.activate(root)).resolves.toEqual({
      previousHooksPath: null,
    })
    expect(runner.hooksPath).toBe('.husky/_')
    expect(runner.calls).toContainEqual({
      command: 'pnpm',
      args: ['run', 'frontprep:prepare'],
    })
  })

  it('does nothing when Husky is already active and installed', async () => {
    const root = await temporaryRoot()
    await mkdir(join(root, '.husky/_'), { recursive: true })
    await writeFile(join(root, '.husky/_/h'), '# dispatcher\n')
    const runner = new StatefulRunner(root, '.husky/_')

    await expect(new GitHooksManager(runner).activate(root)).resolves.toBeNull()
    expect(runner.calls.some(({ command }) => command === 'pnpm')).toBe(false)
  })

  it('restores an unset or custom previous path', async () => {
    const root = await temporaryRoot()
    const runner = new StatefulRunner(root, '.custom-hooks')
    const manager = new GitHooksManager(runner)

    await manager.restore(root, { previousHooksPath: '.custom-hooks' })
    expect(runner.hooksPath).toBe('.custom-hooks')
    runner.hooksPath = '.husky/_'
    await manager.restore(root, { previousHooksPath: null })
    expect(runner.hooksPath).toBeNull()
  })

  it('restores Git configuration when activation leaves no dispatcher', async () => {
    const root = await temporaryRoot()
    const runner = new StatefulRunner(root, '.custom-hooks')
    runner.installDispatcher = false

    await expect(new GitHooksManager(runner).activate(root)).rejects.toThrow(
      'Husky activation did not install its dispatcher',
    )
    expect(runner.hooksPath).toBe('.custom-hooks')
  })

  it('reports a restoration failure after activation fails', async () => {
    const root = await temporaryRoot()
    const runner = new StatefulRunner(root)
    runner.failActivation = true
    runner.failRestore = true

    await expect(
      new GitHooksManager(runner).activate(root),
    ).rejects.toMatchObject({ code: 'ROLLBACK_FAILED' })
  })
})
