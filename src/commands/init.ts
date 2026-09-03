import { FrontprepError, VerificationError } from '../core/errors.js'
import {
  GitHooksManager,
  type GitHooksActivation,
  type GitHooksService,
} from '../core/git-hooks.js'
import { assertSafeGitState } from '../core/git-guard.js'
import { buildPlan } from '../core/plan-builder.js'
import type { ChangeIntent } from '../core/intents.js'
import type { ChangePlan } from '../core/plan.js'
import { detectProject } from '../core/project-detector.js'
import { Reporter } from '../core/reporter.js'
import type { ScopedProjectPath } from '../core/scoped-paths.js'
import {
  applyPlan,
  type TransactionResult,
  type TransactionServices,
} from '../core/transaction.js'
import type {
  ModuleId,
  ProjectContext,
  ProjectDetectionOptions,
} from '../core/types.js'
import {
  runProjectCheck,
  verifyModules,
  verifyStructure,
} from '../core/verifier.js'
import { createModuleRegistry, DEFAULT_MODULES } from '../modules/registry.js'
import type { SetupModule, VerificationResult } from '../modules/types.js'
import { FRONTPREP_VERSION } from '../version.js'

export interface InitOptions extends ProjectDetectionOptions {
  cwd: string
  signal?: AbortSignal
}

export interface CommandReporter {
  alreadyApplied(): void
  detected(context: ProjectContext): void
  filesChanged(paths: readonly ScopedProjectPath[]): void
  header(version: string): void
  modulePassed(id: ModuleId): void
  noFilesChanged(): void
  projectPassed(): void
}

export interface CommandServices {
  applyPlan(
    context: ProjectContext,
    plan: ChangePlan,
    services: TransactionServices,
  ): Promise<TransactionResult>
  assertSafeGitState(context: ProjectContext): Promise<void>
  buildPlan(
    context: ProjectContext,
    intents: readonly ChangeIntent[],
  ): Promise<ChangePlan>
  detectProject(
    cwd: string,
    options?: ProjectDetectionOptions,
  ): Promise<ProjectContext>
  frontprepVersion: string
  gitHooks: GitHooksService
  modules: readonly SetupModule[]
  reporter: CommandReporter
  runProjectCheck(root: string, signal?: AbortSignal): Promise<void>
  verifyModules(
    context: ProjectContext,
    modules: readonly SetupModule[],
  ): Promise<VerificationResult>
  verifyStructure(
    context: ProjectContext,
    modules: readonly SetupModule[],
  ): Promise<VerificationResult>
}

export function createCommandServices(
  reporter: CommandReporter = new Reporter(),
  modules: readonly SetupModule[] = DEFAULT_MODULES,
): CommandServices {
  return {
    applyPlan,
    assertSafeGitState,
    buildPlan,
    detectProject,
    frontprepVersion: FRONTPREP_VERSION,
    gitHooks: new GitHooksManager(),
    modules: createModuleRegistry(modules),
    reporter,
    runProjectCheck,
    verifyModules,
    verifyStructure,
  }
}

function assertValid(result: VerificationResult): void {
  if (result.valid) return
  const first = result.issues[0]
  throw new VerificationError(
    result.issues.map(({ message }) => message).join('\n'),
    first?.moduleId,
    first?.path,
  )
}

function moduleVersions(
  modules: readonly SetupModule[],
): Readonly<Record<ModuleId, string>> {
  return Object.fromEntries(
    modules.map((setupModule) => [setupModule.id, setupModule.version]),
  ) as Record<ModuleId, string>
}

function includesGitHooks(modules: readonly SetupModule[]): boolean {
  return modules.some(({ id }) => id === 'git-hooks')
}

function activationRollbackFailure(
  original: unknown,
  restoration: unknown,
): FrontprepError {
  return new FrontprepError(
    'Frontprep could not restore Git hook configuration after verification failed.',
    {
      cause: { original, restoration },
      code: 'ROLLBACK_FAILED',
      exitCode: 1,
      phase: 'application',
      recovery: 'Restore core.hooksPath with git config --local and retry.',
    },
  )
}

async function verifyEmptyPlan(
  context: ProjectContext,
  services: CommandServices,
  signal?: AbortSignal,
): Promise<void> {
  let activation: GitHooksActivation | null = null
  try {
    signal?.throwIfAborted()
    if (includesGitHooks(services.modules)) {
      activation = await services.gitHooks.activate(context.root, signal)
    }
    signal?.throwIfAborted()
    assertValid(await services.verifyStructure(context, services.modules))
    signal?.throwIfAborted()
    await services.runProjectCheck(context.root, signal)
    signal?.throwIfAborted()
  } catch (error) {
    if (activation !== null) {
      try {
        await services.gitHooks.restore(context.root, activation)
      } catch (restoration) {
        throw activationRollbackFailure(error, restoration)
      }
    }
    throw error
  }
}

export async function runInit(
  options: InitOptions,
  services: CommandServices = createCommandServices(),
): Promise<TransactionResult> {
  services.reporter.header(services.frontprepVersion)
  const detectionOptions: ProjectDetectionOptions = {
    ...(options.stylesheet === undefined
      ? {}
      : { stylesheet: options.stylesheet }),
    ...(options.testDirectory === undefined
      ? {}
      : { testDirectory: options.testDirectory }),
    ...(options.utilityDirectory === undefined
      ? {}
      : { utilityDirectory: options.utilityDirectory }),
  }
  const context = await services.detectProject(options.cwd, detectionOptions)
  await services.assertSafeGitState(context)
  services.reporter.detected(context)

  const intents: ChangeIntent[] = []
  for (const setupModule of services.modules) {
    const analysis = await setupModule.analyze(context)
    intents.push(...(await setupModule.plan(context, analysis)))
  }
  const plan = await services.buildPlan(context, intents)

  let transaction: TransactionResult
  if (plan.operations.length === 0) {
    await verifyEmptyPlan(context, services, options.signal)
    transaction = {
      changed: false,
      changedFiles: [],
      manifest: context.manifest,
    }
  } else {
    transaction = await services.applyPlan(context, plan, {
      frontprepVersion: services.frontprepVersion,
      activateGitHooks: includesGitHooks(services.modules),
      gitHooks: services.gitHooks,
      moduleVersions: moduleVersions(services.modules),
      signal: options.signal,
      verify: async (root, signal) => {
        const refreshed = await services.detectProject(root, detectionOptions)
        assertValid(await services.verifyModules(refreshed, services.modules))
        await services.runProjectCheck(root, signal)
      },
    })
  }

  for (const setupModule of services.modules) {
    services.reporter.modulePassed(setupModule.id)
  }
  if (transaction.changed) {
    services.reporter.projectPassed()
    services.reporter.filesChanged(transaction.changedFiles)
  } else {
    services.reporter.alreadyApplied()
    services.reporter.noFilesChanged()
    services.reporter.projectPassed()
  }
  return transaction
}
