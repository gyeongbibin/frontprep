import { FrontprepError } from './errors.js'
import { ProcessFailure } from './process.js'
import { displayScopedPath, type ScopedProjectPath } from './scoped-paths.js'
import type { ModuleId } from './types.js'

export interface OutputWriter {
  readonly isTTY?: boolean
  write(chunk: string): unknown
}

function green(value: string, enabled: boolean): string {
  return enabled ? `\u001B[32m${value}\u001B[39m` : value
}

export class Reporter {
  private readonly color: boolean

  constructor(
    private readonly stdout: OutputWriter = process.stdout,
    private readonly stderr: OutputWriter = process.stderr,
    env: NodeJS.ProcessEnv = process.env,
  ) {
    this.color = stdout.isTTY === true && !('NO_COLOR' in env)
  }

  private status(message: string): void {
    this.stdout.write(`${green('✓', this.color)} ${message}\n`)
  }

  header(version: string): void {
    this.stdout.write(`frontprep ${version}\n`)
  }

  detected(): void {
    this.status('Detected Next.js App Router with pnpm')
  }

  modulePassed(moduleId: ModuleId): void {
    this.status(moduleId)
  }

  alreadyApplied(): void {
    this.status('All modules are already applied')
  }

  noFilesChanged(): void {
    this.status('No files changed')
  }

  filesChanged(paths: readonly ScopedProjectPath[]): void {
    this.status(`Changed ${paths.length} file${paths.length === 1 ? '' : 's'}`)
    for (const path of paths) {
      this.stdout.write(`  ${displayScopedPath(path)}\n`)
    }
  }

  projectPassed(): void {
    this.status('Project verification passed')
  }

  error(error: unknown): void {
    if (error instanceof FrontprepError) {
      this.stderr.write(`[${error.phase}] ${error.message}\n`)
      if (error.moduleId !== undefined) {
        this.stderr.write(`Module: ${error.moduleId}\n`)
      }
      if (error.path !== undefined) this.stderr.write(`Path: ${error.path}\n`)
      if (error.recovery !== undefined) {
        this.stderr.write(`Recovery: ${error.recovery}\n`)
      }
      return
    }

    if (error instanceof ProcessFailure) {
      this.stderr.write(`[process] ${error.message}\n`)
      if (error.stdout.length > 0) this.stderr.write(error.stdout)
      if (error.stderr.length > 0) this.stderr.write(error.stderr)
      return
    }

    this.stderr.write(
      `[unexpected] ${error instanceof Error ? error.message : String(error)}\n`,
    )
  }

  unexpected(error: unknown, incidentId: string, debug: boolean): void {
    this.stderr.write(`Unexpected failure (${incidentId}).\n`)
    if (error instanceof Error) {
      this.stderr.write(
        `${debug ? (error.stack ?? error.message) : error.message}\n`,
      )
    } else {
      this.stderr.write(`${String(error)}\n`)
    }
  }
}
