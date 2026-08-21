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

export interface FrontprepManifest {
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
  stylesheetPath: string
}
