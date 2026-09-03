import type { FileScope } from './scoped-paths.js'
import type { ProjectPath } from './paths.js'

export const MODULE_ORDER = [
  'quality',
  'tailwind',
  'test',
  'git-hooks',
  'ci',
] as const

export type ModuleId = (typeof MODULE_ORDER)[number]

export interface PackageJson {
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  engines?: Record<string, string>
  name?: string
  packageManager?: string
  private?: boolean
  scripts?: Record<string, string>
  type?: string
  version?: string
  workspaces?: string[] | { packages?: string[] }
  [key: string]: unknown
}

export interface ManifestFile {
  hash: string
  mode: string
  ownership: 'managed' | 'patched'
}

export interface FrontprepManifestV1 {
  $schema: string
  adapter: 'next-app'
  files: Record<string, ManifestFile>
  frontprepVersion: string
  managedScripts: Record<string, string>
  modules: Record<ModuleId, string>
  packageManager: string
  paths: {
    app: string
    stylesheet: string
  }
  schemaVersion: 1
}

export type FrontprepManifest = FrontprepManifestV2

export type PathSelectionSource = 'default' | 'detected' | 'manifest' | 'option'

export interface ProjectDetectionOptions {
  readonly stylesheet?: string
  readonly testDirectory?: string
  readonly utilityDirectory?: string
}

export interface ProjectLayout {
  readonly appDirectory: ProjectPath
  readonly layoutPath: ProjectPath
  readonly sourceDirectory: ProjectPath | null
  readonly stylesheet: {
    readonly path: ProjectPath
    readonly source: PathSelectionSource
    readonly importKind: 'alias' | 'relative' | 'planned'
    readonly importSpecifier: string
  }
  readonly utilities: {
    readonly path: ProjectPath
    readonly source: PathSelectionSource
  }
  readonly tests: {
    readonly path: ProjectPath
    readonly source: PathSelectionSource
  }
  readonly testSetupPath: ProjectPath
}

export interface FrontprepManifestV2 {
  $schema: 'https://unpkg.com/@mingyeongbin/frontprep/schema/manifest-v2.json'
  adapter: 'next-app'
  files: Record<FileScope, Record<string, ManifestFile>>
  frontprepVersion: string
  managedScripts: Record<string, string>
  modules: Record<ModuleId, string>
  packageManager: string
  paths: {
    app: string
    layout: string
    stylesheet: string
    utilities: string
    test: string
    testSetup: string
  }
  roots: {
    package: string
    workspace: '.'
  }
  schemaVersion: 2
}

export interface ProjectContext {
  adapter: 'next-app'
  appDirectory: ProjectPath
  layout: ProjectLayout
  layoutPath: ProjectPath
  manifest: FrontprepManifest | null
  manifestNeedsMigration: boolean
  packageRoot: string
  packageJson: PackageJson
  packageJsonPath: string
  packageManager: {
    name: 'pnpm'
    version: string
  }
  root: string
  repositoryRoot: string
  sourceDirectory: ProjectPath | null
  stylesheetNeedsImport: boolean
  stylesheetPath: ProjectPath
  workspaceRoot: string
}
