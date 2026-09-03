import { toProjectPath } from './paths.js'
import type { ProjectPath } from './paths.js'
import type {
  FrontprepManifest,
  ManifestFile,
  ProjectContext,
} from './types.js'

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

export function rootForScope(
  context: ProjectContext,
  _scope: FileScope,
): string {
  void _scope
  return context.root
}

export function manifestFile(
  manifest: FrontprepManifest | null,
  target: ScopedProjectPath,
): ManifestFile | undefined {
  return manifest?.files[target.scope][target.path]
}

export function displayScopedPath(target: ScopedProjectPath): string {
  return target.scope === 'package'
    ? target.path
    : `[repository] ${target.path}`
}
