import { toProjectPath, type ProjectPath } from './paths.js'
import type { FileScope } from './scoped-paths.js'
import type { ModuleId } from './types.js'

export type DependencySection = 'dependencies' | 'devDependencies'
export type ScriptPolicy = 'append-once' | 'owned' | 'preserve-existing'
export type ConfigValue = boolean | number | string | readonly string[]

interface BaseIntent {
  moduleId: ModuleId
  reason: string
}

export interface DependencyIntent extends BaseIntent {
  kind: 'dependency'
  name: string
  range: string
  section: DependencySection
}

export interface ScriptIntent extends BaseIntent {
  command: string
  kind: 'script'
  name: string
  policy: ScriptPolicy
}

export interface ManagedFileIntent extends BaseIntent {
  content: string
  kind: 'managed-file'
  mode: number
  path: ProjectPath
  scope: FileScope
}

export interface ConfigFragmentIntent extends BaseIntent {
  composer: 'prettier'
  kind: 'config-fragment'
  values: Readonly<Record<string, ConfigValue>>
}

export interface LineSetIntent extends BaseIntent {
  kind: 'line-set'
  lines: readonly string[]
  path: ProjectPath
  scope: FileScope
}

export interface CssImportIntent extends BaseIntent {
  importValue: string
  kind: 'css-import'
  path: ProjectPath
  scope: FileScope
}

export interface StaticImportIntent extends BaseIntent {
  importValue: string
  kind: 'static-import'
  path: ProjectPath
  scope: FileScope
}

export interface ExecutableFileIntent extends BaseIntent {
  content: string
  kind: 'executable-file'
  path: ProjectPath
  scope: FileScope
}

export type ChangeIntent =
  | ConfigFragmentIntent
  | CssImportIntent
  | DependencyIntent
  | ExecutableFileIntent
  | LineSetIntent
  | ManagedFileIntent
  | ScriptIntent
  | StaticImportIntent

export function dependencyIntent(
  moduleId: ModuleId,
  section: DependencySection,
  name: string,
  range: string,
  reason: string,
): DependencyIntent {
  return Object.freeze({
    kind: 'dependency',
    moduleId,
    section,
    name,
    range,
    reason,
  })
}

export function scriptIntent(
  moduleId: ModuleId,
  name: string,
  command: string,
  policy: ScriptPolicy,
  reason: string,
): ScriptIntent {
  return Object.freeze({
    kind: 'script',
    moduleId,
    name,
    command,
    policy,
    reason,
  })
}

export function managedFileIntent(
  moduleId: ModuleId,
  path: string,
  content: string,
  mode: number,
  reason: string,
  scope: FileScope = 'package',
): ManagedFileIntent {
  return Object.freeze({
    kind: 'managed-file',
    moduleId,
    path: toProjectPath(path),
    content,
    mode,
    reason,
    scope,
  })
}

export function configFragmentIntent(
  moduleId: ModuleId,
  composer: 'prettier',
  values: Readonly<Record<string, ConfigValue>>,
  reason: string,
): ConfigFragmentIntent {
  const frozenValues = Object.fromEntries(
    Object.entries(values).map(([key, value]) => [
      key,
      Array.isArray(value) ? Object.freeze([...value]) : value,
    ]),
  )
  return Object.freeze({
    kind: 'config-fragment',
    moduleId,
    composer,
    values: Object.freeze(frozenValues),
    reason,
  })
}

export function lineSetIntent(
  moduleId: ModuleId,
  path: string,
  lines: readonly string[],
  reason: string,
  scope: FileScope = 'package',
): LineSetIntent {
  return Object.freeze({
    kind: 'line-set',
    moduleId,
    path: toProjectPath(path),
    lines: Object.freeze([...lines]),
    reason,
    scope,
  })
}

export function cssImportIntent(
  moduleId: ModuleId,
  path: string,
  importValue: string,
  reason: string,
  scope: FileScope = 'package',
): CssImportIntent {
  return Object.freeze({
    kind: 'css-import',
    moduleId,
    path: toProjectPath(path),
    importValue,
    reason,
    scope,
  })
}

export function staticImportIntent(
  moduleId: ModuleId,
  path: string,
  importValue: string,
  reason: string,
  scope: FileScope = 'package',
): StaticImportIntent {
  return Object.freeze({
    kind: 'static-import',
    moduleId,
    path: toProjectPath(path),
    importValue,
    reason,
    scope,
  })
}

export function executableFileIntent(
  moduleId: ModuleId,
  path: string,
  content: string,
  reason: string,
  scope: FileScope = 'package',
): ExecutableFileIntent {
  return Object.freeze({
    kind: 'executable-file',
    moduleId,
    path: toProjectPath(path),
    content,
    reason,
    scope,
  })
}
