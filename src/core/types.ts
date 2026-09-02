import type { FileScope } from './scoped-paths.js'

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

export type FrontprepManifest = FrontprepManifestV1

export type PathSelectionSource = 'default' | 'detected' | 'manifest' | 'option'

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
  appDirectory: string
  layoutPath: string
  manifest: FrontprepManifest | null
  packageJson: PackageJson
  packageJsonPath: string
  packageManager: {
    name: 'pnpm'
    version: string
  }
  root: string
  sourceDirectory: string | null
  stylesheetNeedsImport: boolean
  stylesheetPath: string
}
