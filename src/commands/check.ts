import { VerificationError } from '../core/errors.js'
import type { ProjectContext } from '../core/types.js'
import type { SetupModule, VerificationResult } from '../modules/types.js'
import {
  createCommandServices,
  type CommandReporter,
  type InitOptions,
} from './init.js'

export interface CheckServices {
  assertSafeGitState(context: ProjectContext): Promise<void>
  detectProject(cwd: string): Promise<ProjectContext>
  frontprepVersion: string
  modules: readonly SetupModule[]
  reporter: CommandReporter
  runProjectCheck(root: string, signal?: AbortSignal): Promise<void>
  verifyStructure(
    context: ProjectContext,
    modules: readonly SetupModule[],
  ): Promise<VerificationResult>
}

export async function runCheck(
  options: InitOptions,
  services: CheckServices = createCommandServices(),
): Promise<void> {
  services.reporter.header(services.frontprepVersion)
  const context = await services.detectProject(options.cwd)
  await services.assertSafeGitState(context)
  services.reporter.detected(context)
  if (context.manifestNeedsMigration) {
    services.reporter.migrationAvailable?.()
  }

  const verification = await services.verifyStructure(context, services.modules)
  if (!verification.valid) {
    const first = verification.issues[0]
    throw new VerificationError(
      verification.issues.map(({ message }) => message).join('\n'),
      first?.moduleId,
      first?.path,
    )
  }

  for (const setupModule of services.modules) {
    services.reporter.modulePassed(setupModule.id)
  }
  await services.runProjectCheck(context.root, options.signal)
  services.reporter.projectPassed()
}
