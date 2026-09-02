import { toProjectPath } from './paths.js'
import type { ProjectPath } from './paths.js'

export type FileScope = 'package' | 'repository'

export interface ScopedProjectPath {
  readonly path: ProjectPath
  readonly scope: FileScope
}

export function scopedProjectPath(
  path: string,
  scope: FileScope = 'package',
): ScopedProjectPath {
  return Object.freeze({ path: toProjectPath(path), scope })
}

export function scopedPathKey(target: ScopedProjectPath): string {
  return `${target.scope}:${target.path}`
}
