import type { ChangeIntent } from '../core/intents.js'
import type { ModuleId, ProjectContext } from '../core/types.js'

export interface VerificationIssue {
  message: string
  moduleId?: ModuleId
  path?: string
}

export interface VerificationResult {
  issues: readonly VerificationIssue[]
  valid: boolean
}

export interface SetupModule<TAnalysis = unknown> {
  readonly id: ModuleId
  readonly version: string
  analyze(context: ProjectContext): Promise<TAnalysis>
  plan(
    context: ProjectContext,
    analysis: TAnalysis,
  ): Promise<readonly ChangeIntent[]>
  verify(context: ProjectContext): Promise<VerificationResult>
}
