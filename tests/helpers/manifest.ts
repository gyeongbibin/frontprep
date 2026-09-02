import type {
  FrontprepManifestV1,
  FrontprepManifestV2,
} from '../../src/core/types.js'

type ManifestV1Overrides = Omit<
  Partial<FrontprepManifestV1>,
  'files' | 'managedScripts' | 'modules' | 'paths'
> & {
  files?: FrontprepManifestV1['files']
  managedScripts?: FrontprepManifestV1['managedScripts']
  modules?: Partial<FrontprepManifestV1['modules']>
  paths?: Partial<FrontprepManifestV1['paths']>
}

type ManifestV2Overrides = Omit<
  Partial<FrontprepManifestV2>,
  'files' | 'managedScripts' | 'modules' | 'paths' | 'roots'
> & {
  files?: Partial<FrontprepManifestV2['files']>
  managedScripts?: FrontprepManifestV2['managedScripts']
  modules?: Partial<FrontprepManifestV2['modules']>
  paths?: Partial<FrontprepManifestV2['paths']>
  roots?: Partial<FrontprepManifestV2['roots']>
}

const modules = {
  ci: '1.0.0',
  test: '1.0.0',
  quality: '1.0.0',
  tailwind: '1.0.0',
  'git-hooks': '1.0.0',
} as const

const packageJsonRecord = {
  hash: `sha256:${'a'.repeat(64)}`,
  mode: '0644',
  ownership: 'patched',
} as const

const stylesheetRecord = {
  hash: `sha256:${'b'.repeat(64)}`,
  mode: '0644',
  ownership: 'patched',
} as const

const managedScripts = {
  'frontprep:typecheck': 'tsc --noEmit',
  'frontprep:lint': 'eslint .',
}

export function manifestV1(
  overrides: ManifestV1Overrides = {},
): FrontprepManifestV1 {
  const defaults: FrontprepManifestV1 = {
    $schema:
      'https://unpkg.com/@mingyeongbin/frontprep/schema/manifest-v1.json',
    schemaVersion: 1,
    frontprepVersion: '0.1.0-beta.0',
    adapter: 'next-app',
    packageManager: 'pnpm@10.22.0',
    paths: { app: 'src/app', stylesheet: 'src/app/globals.css' },
    modules: { ...modules },
    files: {
      'src/app/globals.css': { ...stylesheetRecord },
      'package.json': { ...packageJsonRecord },
    },
    managedScripts: { ...managedScripts },
  }

  return {
    ...defaults,
    ...overrides,
    paths: { ...defaults.paths, ...overrides.paths },
    modules: { ...defaults.modules, ...overrides.modules },
    files: { ...defaults.files, ...overrides.files },
    managedScripts: {
      ...defaults.managedScripts,
      ...overrides.managedScripts,
    },
  }
}

export function manifestV2(
  overrides: ManifestV2Overrides = {},
): FrontprepManifestV2 {
  const defaults: FrontprepManifestV2 = {
    $schema:
      'https://unpkg.com/@mingyeongbin/frontprep/schema/manifest-v2.json',
    schemaVersion: 2,
    frontprepVersion: '0.1.0-beta.1',
    adapter: 'next-app',
    packageManager: 'pnpm@10.22.0',
    roots: { package: '.', workspace: '.' },
    paths: {
      app: 'src/app',
      layout: 'src/app/layout.tsx',
      stylesheet: 'src/app/globals.css',
      utilities: 'src/shared/lib',
      test: 'src/test',
      testSetup: 'src/test/setup.ts',
    },
    modules: { ...modules },
    files: {
      package: {
        'src/app/globals.css': { ...stylesheetRecord },
        'package.json': { ...packageJsonRecord },
      },
      repository: {},
    },
    managedScripts: { ...managedScripts },
  }

  return {
    ...defaults,
    ...overrides,
    roots: { ...defaults.roots, ...overrides.roots },
    paths: { ...defaults.paths, ...overrides.paths },
    modules: { ...defaults.modules, ...overrides.modules },
    files: {
      package: {
        ...defaults.files.package,
        ...overrides.files?.package,
      },
      repository: {
        ...defaults.files.repository,
        ...overrides.files?.repository,
      },
    },
    managedScripts: {
      ...defaults.managedScripts,
      ...overrides.managedScripts,
    },
  }
}
