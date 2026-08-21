import { VerificationError } from '../core/errors.js'
import { assertSafeGitState } from '../core/git-guard.js'
import { buildPlan } from '../core/plan-builder.js'
import type { ChangeIntent } from '../core/intents.js'
import type { ChangePlan } from '../core/plan.js'
import { detectProject } from '../core/project-detector.js'
import { Reporter } from '../core/reporter.js'
import {
  applyPlan,
  type TransactionResult,
  type TransactionServices,
} from '../core/transaction.js'
import type { ModuleId, ProjectContext } from '../core/types.js'
import {
  runProjectCheck,
  verifyModules,
  verifyStructure,
} from '../core/verifier.js'
import type { SetupModule, VerificationResult } from '../modules/types.js'

export interface InitOptions {
  cwd: string
  signal?: AbortSignal
}

export interface CommandReporter {
  alreadyApplied(): void
  detected(): void
  filesChanged(paths: readonly string[]): void
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
  detectProject(cwd: string): Promise<ProjectContext>
  frontprepVersion: string
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

export const FRONTPREP_VERSION = '0.1.0-beta.0'

export function createCommandServices(
  reporter: CommandReporter = new Reporter(),
  modules: readonly SetupModule[] = [],
): CommandServices {
  return {
    applyPlan,
    assertSafeGitState,
    buildPlan,
    detectProject,
    frontprepVersion: FRONTPREP_VERSION,
    modules,
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

export async function runInit(
  options: InitOptions,
  services: CommandServices = createCommandServices(),
): Promise<TransactionResult> {
  services.reporter.header(services.frontprepVersion)
  const context = await services.detectProject(options.cwd)
  await services.assertSafeGitState(context)
  services.reporter.detected()

  const intents: ChangeIntent[] = []
  for (const setupModule of services.modules) {
    const analysis = await setupModule.analyze(context)
    intents.push(...(await setupModule.plan(context, analysis)))
  }
  const plan = await services.buildPlan(context, intents)

  let transaction: TransactionResult
  if (plan.operations.length === 0) {
    assertValid(await services.verifyStructure(context, services.modules))
    await services.runProjectCheck(context.root, options.signal)
    transaction = {
      changed: false,
      changedFiles: [],
      manifest: context.manifest,
    }
  } else {
    transaction = await services.applyPlan(context, plan, {
      frontprepVersion: services.frontprepVersion,
      moduleVersions: moduleVersions(services.modules),
      signal: options.signal,
      verify: async (root, signal) => {
        const refreshed = await services.detectProject(root)
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
