import { readFile } from 'node:fs/promises'
import { join, posix } from 'node:path'

import { FrontprepError, UnsafePathError } from './errors.js'
import { toProjectPath } from './paths.js'
import type { ProjectPath } from './paths.js'
import type {
  FrontprepManifestV1,
  FrontprepManifestV2,
  ManifestFile,
} from './types.js'

export interface DetectedManifestPaths {
  readonly app: ProjectPath
  readonly layout: ProjectPath
  readonly stylesheet: ProjectPath
}

export interface NormalizedManifest {
  readonly manifest: FrontprepManifestV2 | null
  readonly needsMigration: boolean
}

function invalidMigration(details: string, cause?: unknown): FrontprepError {
  return new FrontprepError(`Invalid .frontprep.json: ${details}`, {
    cause,
    code: 'INVALID_MANIFEST',
    exitCode: 2,
    path: '.frontprep.json',
    phase: 'detection',
    recovery:
      'Restore or remove the invalid manifest before running frontprep.',
  })
}

function deriveUtilities(manifest: FrontprepManifestV1): ProjectPath {
  const candidates = Object.entries(manifest.files)
    .filter(([path, record]) => {
      if (record.ownership !== 'managed' || !path.endsWith('/cn.ts')) {
        return false
      }
      const directory = posix.dirname(path)
      return manifest.files[`${directory}/index.ts`] !== undefined
    })
    .map(([path]) => posix.dirname(path))

  if (candidates.length !== 1) {
    throw invalidMigration(
      `expected exactly one managed utility directory, found ${candidates.length}`,
    )
  }
  return toProjectPath(candidates[0]!)
}

function setupLiteral(config: string): string {
  const arrays = [...config.matchAll(/\bsetupFiles\s*:\s*\[([\s\S]*?)\]/gu)]
  if (arrays.length !== 1) {
    throw invalidMigration(
      `expected exactly one setupFiles array in vitest.config.mts, found ${arrays.length}`,
    )
  }

  const body = arrays[0]?.[1] ?? ''
  const literal = /^\s*(['"])(\.\/[^'"\r\n]+)\1\s*,?\s*$/u.exec(body)
  if (literal?.[2] === undefined) {
    throw invalidMigration(
      'expected setupFiles to contain exactly one package-relative string literal',
    )
  }
  return literal[2].slice(2)
}

async function deriveTestPaths(
  root: string,
  manifest: FrontprepManifestV1,
): Promise<{ test: ProjectPath; testSetup: ProjectPath }> {
  const configRecord = manifest.files['vitest.config.mts']
  if (configRecord?.ownership !== 'managed') {
    throw invalidMigration('expected a managed vitest.config.mts file record')
  }

  let config: string
  try {
    config = await readFile(join(root, 'vitest.config.mts'), 'utf8')
  } catch (error) {
    throw invalidMigration('could not read managed vitest.config.mts', error)
  }

  let testSetup: ProjectPath
  try {
    testSetup = toProjectPath(setupLiteral(config))
  } catch (error) {
    if (error instanceof UnsafePathError) {
      throw invalidMigration('Vitest setup path is unsafe', error)
    }
    throw error
  }

  if (posix.basename(testSetup) !== 'setup.ts') {
    throw invalidMigration('Vitest setup path must end in setup.ts')
  }
  if (manifest.files[testSetup]?.ownership !== 'managed') {
    throw invalidMigration(
      `Vitest setup path is not a managed file record: ${testSetup}`,
    )
  }

  return { test: toProjectPath(posix.dirname(testSetup)), testSetup }
}

function scopedFiles(files: Record<string, ManifestFile>): {
  package: Record<string, ManifestFile>
  repository: Record<string, ManifestFile>
} {
  const packageFiles: Record<string, ManifestFile> = {}
  const repositoryFiles: Record<string, ManifestFile> = {}

  for (const [path, record] of Object.entries(files)) {
    if (path === 'pnpm-lock.yaml' || path.startsWith('.github/workflows/')) {
      repositoryFiles[path] = record
    } else {
      packageFiles[path] = record
    }
  }

  return { package: packageFiles, repository: repositoryFiles }
}

export async function normalizeManifest(
  root: string,
  persisted: FrontprepManifestV1 | FrontprepManifestV2 | null,
  detected: DetectedManifestPaths,
): Promise<NormalizedManifest> {
  if (persisted === null) {
    return { manifest: null, needsMigration: false }
  }
  if (persisted.schemaVersion === 2) {
    return { manifest: persisted, needsMigration: false }
  }

  if (
    persisted.paths.app !== detected.app ||
    persisted.paths.stylesheet !== detected.stylesheet
  ) {
    throw invalidMigration(
      'the persisted App Router paths do not match the detected project',
    )
  }

  const utilities = deriveUtilities(persisted)
  const { test, testSetup } = await deriveTestPaths(root, persisted)

  return {
    manifest: {
      $schema:
        'https://unpkg.com/@mingyeongbin/frontprep/schema/manifest-v2.json',
      schemaVersion: 2,
      frontprepVersion: persisted.frontprepVersion,
      adapter: persisted.adapter,
      packageManager: persisted.packageManager,
      roots: { package: '.', workspace: '.' },
      paths: {
        app: persisted.paths.app,
        layout: detected.layout,
        stylesheet: persisted.paths.stylesheet,
        utilities,
        test,
        testSetup,
      },
      modules: { ...persisted.modules },
      files: scopedFiles(persisted.files),
      managedScripts: { ...persisted.managedScripts },
    },
    needsMigration: true,
  }
}
