import { execFile } from 'node:child_process'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { describe, expect, it } from 'vitest'

import {
  createCommandServices,
  runInit,
  type CommandReporter,
} from '../../src/commands/init.js'
import type {
  GitHooksActivation,
  GitHooksService,
} from '../../src/core/git-hooks.js'
import {
  applyPlan,
  type PackageManagerService,
} from '../../src/core/transaction.js'
import { createWorkspaceProject } from '../helpers/project.js'

const execFileAsync = promisify(execFile)

const SILENT_REPORTER: CommandReporter = {
  alreadyApplied() {},
  detected() {},
  filesChanged() {},
  header() {},
  modulePassed() {},
  noFilesChanged() {},
  projectPassed() {},
}

class WorkspacePackageManager implements PackageManagerService {
  installs = 0

  async assertSupported(): Promise<void> {}

  async install(root: string): Promise<void> {
    this.installs += 1
    await writeFile(join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\n')
  }
}

class WorkspaceGitHooks implements GitHooksService {
  constructor(
    private readonly packageRoot: string,
    private readonly repositoryRoot: string,
  ) {}

  async activate(): Promise<GitHooksActivation | null> {
    const path = 'apps/web/.husky/_'
    const current = await execFileAsync(
      'git',
      ['config', '--local', '--get', 'core.hooksPath'],
      { cwd: this.repositoryRoot, encoding: 'utf8' },
    ).catch(() => null)
    if (current?.stdout.trim() === path) return null
    await mkdir(join(this.packageRoot, '.husky/_'), { recursive: true })
    await writeFile(join(this.packageRoot, '.husky/_/h'), '# dispatcher\n')
    await execFileAsync('git', ['config', '--local', 'core.hooksPath', path], {
      cwd: this.repositoryRoot,
    })
    return { previousHooksPath: current?.stdout.trim() || null }
  }

  async restore(_root: string, activation: GitHooksActivation): Promise<void> {
    const args =
      activation.previousHooksPath === null
        ? ['config', '--local', '--unset-all', 'core.hooksPath']
        : ['config', '--local', 'core.hooksPath', activation.previousHooksPath]
    await execFileAsync('git', args, { cwd: this.repositoryRoot }).catch(
      () => undefined,
    )
  }
}

describe('workspace target acceptance', () => {
  it('applies all modules across roots and reruns idempotently', async () => {
    const project = await createWorkspaceProject()
    const packageManager = new WorkspacePackageManager()
    const gitHooks = new WorkspaceGitHooks(
      project.packageRoot,
      project.repositoryRoot,
    )
    const base = createCommandServices(SILENT_REPORTER)
    const services = {
      ...base,
      applyPlan: (context, plan, transactionServices) =>
        applyPlan(context, plan, {
          ...transactionServices,
          assertGitState: async () => undefined,
          gitHooks,
          packageManager,
        }),
      assertSafeGitState: async () => undefined,
      gitHooks,
      runProjectCheck: async () => undefined,
    } satisfies typeof base

    const first = await runInit({ cwd: project.packageRoot }, services)
    const second = await runInit({ cwd: project.packageRoot }, services)

    expect(first.changed).toBe(true)
    expect(second.changed).toBe(false)
    expect(packageManager.installs).toBe(1)
    const manifest = JSON.parse(
      await readFile(join(project.packageRoot, '.frontprep.json'), 'utf8'),
    ) as { roots: { package: string; workspace: string } }
    expect(manifest.roots).toEqual({ package: 'apps/web', workspace: '.' })
    const workflows = await readdir(
      join(project.repositoryRoot, '.github/workflows'),
    )
    expect(workflows).toEqual([
      expect.stringMatching(/^frontprep-apps-web-[a-f0-9]{8}\.yml$/u),
    ])
  }, 30_000)
})
