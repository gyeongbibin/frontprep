import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { Ajv2020 } from 'ajv/dist/2020.js'
import { gt, valid } from 'semver'

import manifestV1Schema from '../../schema/manifest-v1.json' with { type: 'json' }
import manifestV2Schema from '../../schema/manifest-v2.json' with { type: 'json' }
import { FRONTPREP_VERSION } from '../version.js'
import { FrontprepError } from './errors.js'
import { FileSystem } from './filesystem.js'
import { toProjectPath } from './paths.js'
import type {
  FrontprepManifest,
  FrontprepManifestV1,
  FrontprepManifestV2,
} from './types.js'

export const MANIFEST_PATH = '.frontprep.json'

const ajv = new Ajv2020({ allErrors: true, strict: true })
const validateManifestV1 = ajv.compile<FrontprepManifestV1>(manifestV1Schema)
const validateManifestV2 = ajv.compile<FrontprepManifestV2>(manifestV2Schema)

function sortedRecord<T>(record: Record<string, T>): Record<string, T> {
  return Object.fromEntries(
    Object.entries(record).sort(([left], [right]) => left.localeCompare(right)),
  )
}

export function serializeManifestV1(manifest: FrontprepManifestV1): string {
  const ordered: FrontprepManifestV1 = {
    $schema: manifest.$schema,
    schemaVersion: manifest.schemaVersion,
    frontprepVersion: manifest.frontprepVersion,
    adapter: manifest.adapter,
    packageManager: manifest.packageManager,
    paths: {
      app: manifest.paths.app,
      stylesheet: manifest.paths.stylesheet,
    },
    modules: sortedRecord(manifest.modules) as FrontprepManifestV1['modules'],
    files: sortedRecord(manifest.files),
    managedScripts: sortedRecord(manifest.managedScripts),
  }
  return `${JSON.stringify(ordered, null, 2)}\n`
}

export function serializeManifestV2(manifest: FrontprepManifestV2): string {
  const ordered: FrontprepManifestV2 = {
    $schema: manifest.$schema,
    schemaVersion: manifest.schemaVersion,
    frontprepVersion: manifest.frontprepVersion,
    adapter: manifest.adapter,
    packageManager: manifest.packageManager,
    roots: {
      package: manifest.roots.package,
      workspace: manifest.roots.workspace,
    },
    paths: {
      app: manifest.paths.app,
      layout: manifest.paths.layout,
      stylesheet: manifest.paths.stylesheet,
      utilities: manifest.paths.utilities,
      test: manifest.paths.test,
      testSetup: manifest.paths.testSetup,
    },
    modules: sortedRecord(manifest.modules) as FrontprepManifestV2['modules'],
    files: {
      package: sortedRecord(manifest.files.package),
      repository: sortedRecord(manifest.files.repository),
    },
    managedScripts: sortedRecord(manifest.managedScripts),
  }
  return `${JSON.stringify(ordered, null, 2)}\n`
}

export function serializeManifest(manifest: FrontprepManifest): string {
  return serializeManifestV2(manifest)
}

function invalidManifest(details: string, cause?: unknown): FrontprepError {
  return new FrontprepError(`Invalid .frontprep.json: ${details}`, {
    cause,
    code: 'INVALID_MANIFEST',
    exitCode: 2,
    path: MANIFEST_PATH,
    phase: 'detection',
    recovery:
      'Restore or remove the invalid manifest before running frontprep.',
  })
}

export async function loadManifest(
  root: string,
): Promise<FrontprepManifest | null> {
  const value = await loadPersistedManifest(root)
  if (value === null) return null
  if (value.schemaVersion !== 2) {
    throw invalidManifest(
      'schema v1 must be normalized before entering the v2 runtime',
    )
  }
  return value
}

function validationDetails(errors: typeof validateManifestV1.errors): string {
  return (
    errors
      ?.map(
        (error) =>
          `${error.instancePath || '/'} ${error.message ?? 'is invalid'}`,
      )
      .join('; ') ?? 'schema validation failed'
  )
}

function assertCompatibleVersion(manifest: { frontprepVersion: string }): void {
  if (valid(manifest.frontprepVersion) === null) {
    throw invalidManifest('frontprepVersion must be a valid semantic version')
  }
  if (gt(manifest.frontprepVersion, FRONTPREP_VERSION)) {
    throw invalidManifest(
      `the manifest was created by newer frontprep ${manifest.frontprepVersion}; upgrade this CLI before continuing`,
    )
  }
}

export async function loadPersistedManifest(
  root: string,
): Promise<FrontprepManifestV1 | FrontprepManifestV2 | null> {
  let value: unknown
  try {
    value = JSON.parse(await readFile(join(root, MANIFEST_PATH), 'utf8'))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null
    }
    throw invalidManifest('the file is not valid JSON', error)
  }

  if (
    typeof value !== 'object' ||
    value === null ||
    !('schemaVersion' in value)
  ) {
    throw invalidManifest('/schemaVersion is required')
  }

  if (value.schemaVersion === 1) {
    if (!validateManifestV1(value)) {
      throw invalidManifest(validationDetails(validateManifestV1.errors))
    }
    assertCompatibleVersion(value)
    return value
  }
  if (value.schemaVersion === 2) {
    if (!validateManifestV2(value)) {
      throw invalidManifest(validationDetails(validateManifestV2.errors))
    }
    assertCompatibleVersion(value)
    return value
  }

  throw invalidManifest(
    `/schemaVersion must be equal to one of the supported versions: 1 or 2`,
  )
}

export async function writeManifestV1(
  root: string,
  manifest: FrontprepManifestV1,
): Promise<void> {
  if (!validateManifestV1(manifest)) {
    throw invalidManifest('refused to write data that does not match schema')
  }
  const fileSystem = new FileSystem(root)
  await fileSystem.writeAtomic(
    toProjectPath(MANIFEST_PATH),
    Buffer.from(serializeManifestV1(manifest)),
    0o644,
  )
}

export async function writeManifestV2(
  root: string,
  manifest: FrontprepManifestV2,
): Promise<void> {
  if (!validateManifestV2(manifest)) {
    throw invalidManifest('refused to write data that does not match schema')
  }
  const fileSystem = new FileSystem(root)
  await fileSystem.writeAtomic(
    toProjectPath(MANIFEST_PATH),
    Buffer.from(serializeManifestV2(manifest)),
    0o644,
  )
}

export async function writeManifest(
  root: string,
  manifest: FrontprepManifest,
): Promise<void> {
  await writeManifestV2(root, manifest)
}
