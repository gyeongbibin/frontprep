import { describe, expect, it } from 'vitest'

import { managedFileIntent } from '../../src/core/intents.js'
import type {
  GitHooksActivation,
  GitHooksService,
} from '../../src/core/git-hooks.js'
import type { ChangePlan } from '../../src/core/plan.js'
import { detectProject } from '../../src/core/project-detector.js'
import type { TransactionResult } from '../../src/core/transaction.js'
import type { ModuleId } from '../../src/core/types.js'
import {
  createCommandServices,
  runInit,
  type CommandReporter,
  type CommandServices,
} from '../../src/commands/init.js'
import type { SetupModule } from '../../src/modules/types.js'
import { createProject } from '../helpers/project.js'

class RecordingReporter implements CommandReporter {
  readonly events: string[] = []
  alreadyApplied(): void {
    this.events.push('already')
  }
  detected(): void {
    this.events.push('detected')
  }
  filesChanged(paths: readonly string[]): void {
    this.events.push(`changed:${paths.join(',')}`)
  }
  header(version: string): void {
    this.events.push(`header:${version}`)
  }
  modulePassed(id: ModuleId): void {
    this.events.push(`module:${id}`)
  }
  noFilesChanged(): void {
    this.events.push('no-files')
  }
  projectPassed(): void {
    this.events.push('project')
  }
}

class RecordingGitHooks implements GitHooksService {
  readonly events: string[] = []

  async activate(): Promise<GitHooksActivation> {
    this.events.push('activate')
    return { previousHooksPath: null }
  }

  async restore(): Promise<void> {
    this.events.push('restore')
  }
}

const EMPTY_PLAN: ChangePlan = {
  dependenciesChanged: false,
  managedScripts: {},
  operations: [],
  snapshot: {},
  summary: { quality: 0, tailwind: 0, test: 0, 'git-hooks': 0, ci: 0 },
}

function setupModule(id: ModuleId, calls: string[]): SetupModule<string> {
  return {
    id,
    version: '1.0.0',
    async analyze() {
      calls.push(`analyze:${id}`)
      return id
    },
    async plan(_context, analysis) {
      calls.push(`plan:${analysis}`)
      return [managedFileIntent(id, `${id}.txt`, `${id}\n`, 0o644, 'fixture')]
    },
    async verify() {
      calls.push(`verify:${id}`)
      return { issues: [], valid: true }
    },
  }
}

describe('runInit', () => {
  it('normalizes module order and rejects duplicate IDs at the service boundary', () => {
    const calls: string[] = []
    const quality = setupModule('quality', calls)
    const ci = setupModule('ci', calls)

    expect(
      createCommandServices(new RecordingReporter(), [ci, quality]).modules.map(
        ({ id }) => id,
      ),
    ).toEqual(['quality', 'ci'])
    expect(() =>
      createCommandServices(new RecordingReporter(), [quality, quality]),
    ).toThrow('Duplicate module: quality')
  })

  it('analyzes and plans modules in order before building one aggregate plan', async () => {
    const project = await createProject()
    const context = await detectProject(project.root)
    const calls: string[] = []
    const reporter = new RecordingReporter()
    const modules = (
      ['quality', 'tailwind', 'test', 'git-hooks', 'ci'] as const
    ).map((id) => setupModule(id, calls))
    let aggregateSize = 0
    const transaction: TransactionResult = {
      changed: true,
      changedFiles: ['quality.txt' as never],
      manifest: null,
    }
    const services: CommandServices = {
      applyPlan: async (_context, _plan, transactionServices) => {
        await transactionServices.verify(project.root)
        return transaction
      },
      assertSafeGitState: async () => undefined,
      buildPlan: async (_context, intents) => {
        aggregateSize = intents.length
        calls.push('build')
        return { ...EMPTY_PLAN, operations: [{} as never] }
      },
      detectProject: async () => context,
      frontprepVersion: '0.1.0-beta.0',
      gitHooks: new RecordingGitHooks(),
      modules,
      reporter,
      runProjectCheck: async () => {
        calls.push('project-check')
      },
      verifyModules: async (verificationContext, verificationModules) => {
        for (const module of verificationModules) {
          await module.verify(verificationContext)
        }
        return { issues: [], valid: true }
      },
      verifyStructure: async () => ({ issues: [], valid: true }),
    }

    await expect(runInit({ cwd: project.root }, services)).resolves.toBe(
      transaction,
    )

    expect(aggregateSize).toBe(5)
    expect(calls).toEqual([
      'analyze:quality',
      'plan:quality',
      'analyze:tailwind',
      'plan:tailwind',
      'analyze:test',
      'plan:test',
      'analyze:git-hooks',
      'plan:git-hooks',
      'analyze:ci',
      'plan:ci',
      'build',
      'verify:quality',
      'verify:tailwind',
      'verify:test',
      'verify:git-hooks',
      'verify:ci',
      'project-check',
    ])
    expect(reporter.events).toEqual([
      'header:0.1.0-beta.0',
      'detected',
      'module:quality',
      'module:tailwind',
      'module:test',
      'module:git-hooks',
      'module:ci',
      'project',
      'changed:quality.txt',
    ])
  })

  it('verifies an empty plan without invoking the transaction', async () => {
    const project = await createProject()
    const context = await detectProject(project.root)
    const calls: string[] = []
    const reporter = new RecordingReporter()
    const modules = (
      ['quality', 'tailwind', 'test', 'git-hooks', 'ci'] as const
    ).map((id) => setupModule(id, calls))
    let applied = false
    const gitHooks = new RecordingGitHooks()
    const services: CommandServices = {
      applyPlan: async () => {
        applied = true
        throw new Error('must not apply')
      },
      assertSafeGitState: async () => undefined,
      buildPlan: async () => EMPTY_PLAN,
      detectProject: async () => context,
      frontprepVersion: '0.1.0-beta.0',
      gitHooks,
      modules,
      reporter,
      runProjectCheck: async () => undefined,
      verifyModules: async () => ({ issues: [], valid: true }),
      verifyStructure: async () => ({ issues: [], valid: true }),
    }

    const result = await runInit({ cwd: project.root }, services)

    expect(applied).toBe(false)
    expect(gitHooks.events).toEqual(['activate'])
    expect(result.changed).toBe(false)
    expect(reporter.events.slice(-3)).toEqual([
      'already',
      'no-files',
      'project',
    ])
  })

  it('restores empty-plan Git Hooks activation when verification fails', async () => {
    const project = await createProject()
    const context = await detectProject(project.root)
    const calls: string[] = []
    const gitHooks = new RecordingGitHooks()
    const services: CommandServices = {
      applyPlan: async () => {
        throw new Error('must not apply')
      },
      assertSafeGitState: async () => undefined,
      buildPlan: async () => EMPTY_PLAN,
      detectProject: async () => context,
      frontprepVersion: '0.1.0-beta.0',
      gitHooks,
      modules: [setupModule('git-hooks', calls)],
      reporter: new RecordingReporter(),
      runProjectCheck: async () => {
        throw new Error('project check failed')
      },
      verifyModules: async () => ({ issues: [], valid: true }),
      verifyStructure: async () => ({ issues: [], valid: true }),
    }

    await expect(runInit({ cwd: project.root }, services)).rejects.toThrow(
      'project check failed',
    )
    expect(gitHooks.events).toEqual(['activate', 'restore'])
  })

  it('does not activate an empty Git Hooks plan after cancellation', async () => {
    const project = await createProject()
    const context = await detectProject(project.root)
    const calls: string[] = []
    const gitHooks = new RecordingGitHooks()
    const controller = new AbortController()
    controller.abort()
    const services: CommandServices = {
      applyPlan: async () => {
        throw new Error('must not apply')
      },
      assertSafeGitState: async () => undefined,
      buildPlan: async () => EMPTY_PLAN,
      detectProject: async () => context,
      frontprepVersion: '0.1.0-beta.0',
      gitHooks,
      modules: [setupModule('git-hooks', calls)],
      reporter: new RecordingReporter(),
      runProjectCheck: async () => undefined,
      verifyModules: async () => ({ issues: [], valid: true }),
      verifyStructure: async () => ({ issues: [], valid: true }),
    }

    await expect(
      runInit({ cwd: project.root, signal: controller.signal }, services),
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(gitHooks.events).toEqual([])
  })
})
