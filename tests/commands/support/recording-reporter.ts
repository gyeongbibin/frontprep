import type { CommandReporter } from '../../../src/commands/init.js'
import type { ModuleId } from '../../../src/core/types.js'
import {
  displayScopedPath,
  type ScopedProjectPath,
} from '../../../src/core/scoped-paths.js'

export class RecordingReporter implements CommandReporter {
  readonly events: string[] = []
  alreadyApplied(): void {
    this.events.push('already')
  }
  detected(): void {
    this.events.push('detected')
  }
  filesChanged(paths: readonly ScopedProjectPath[]): void {
    this.events.push(`changed:${paths.map(displayScopedPath).join(',')}`)
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
