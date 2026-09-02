import type { ProjectPath } from './paths.js'
import type { FileScope } from './scoped-paths.js'
import type { ModuleId } from './types.js'

export interface FileOperation {
  afterBytes: Buffer
  beforeHash: string | null
  mode: number
  moduleIds: readonly ModuleId[]
  ownership: 'managed' | 'patched'
  path: ProjectPath
  scope: FileScope
}

export interface ChangePlan {
  dependenciesChanged: boolean
  managedScripts: Readonly<Record<string, string>>
  operations: readonly FileOperation[]
  snapshot: Readonly<Record<string, string | null>>
  summary: Readonly<Record<ModuleId, number>>
}
