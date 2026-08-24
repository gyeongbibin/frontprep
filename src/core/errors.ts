import type { ModuleId } from './types.js'

export type ErrorPhase =
  | 'usage'
  | 'detection'
  | 'git'
  | 'analysis'
  | 'planning'
  | 'application'
  | 'installation'
  | 'verification'

export interface FrontprepErrorOptions {
  cause?: unknown
  code: string
  exitCode: 1 | 2
  moduleId?: ModuleId
  path?: string
  phase: ErrorPhase
  recovery?: string
}

export class FrontprepError extends Error {
  readonly code: string
  readonly exitCode: 1 | 2
  readonly moduleId?: ModuleId
  readonly path?: string
  readonly phase: ErrorPhase
  readonly recovery?: string

  constructor(message: string, options: FrontprepErrorOptions) {
    super(message, { cause: options.cause })
    this.name = new.target.name
    this.code = options.code
    this.exitCode = options.exitCode
    this.moduleId = options.moduleId
    this.path = options.path
    this.phase = options.phase
    this.recovery = options.recovery
  }
}

export class UnsafePathError extends FrontprepError {
  constructor(path: string, cause?: unknown) {
    super(`Unsafe project path: ${JSON.stringify(path)}`, {
      cause,
      code: 'UNSAFE_PATH',
      exitCode: 2,
      path,
      phase: 'planning',
      recovery: 'Use a root-relative POSIX path inside the project.',
    })
  }
}

export class UnsupportedProjectError extends FrontprepError {
  constructor(message: string, recovery?: string, cause?: unknown) {
    super(message, {
      cause,
      code: 'UNSUPPORTED_PROJECT',
      exitCode: 2,
      phase: 'detection',
      recovery,
    })
  }
}

export class ConflictError extends FrontprepError {
  constructor(message: string, path?: string, moduleId?: ModuleId) {
    super(message, {
      code: 'CONFIGURATION_CONFLICT',
      exitCode: 2,
      moduleId,
      path,
      phase: 'planning',
      recovery: 'Resolve the reported conflict and run frontprep again.',
    })
  }
}

export class VerificationError extends FrontprepError {
  constructor(message: string, moduleId?: ModuleId, path?: string) {
    super(message, {
      code: 'VERIFICATION_FAILED',
      exitCode: 1,
      moduleId,
      path,
      phase: 'verification',
      recovery: 'Fix the reported project error and run frontprep again.',
    })
  }
}
