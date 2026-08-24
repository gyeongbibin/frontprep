import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { Ajv2020 } from 'ajv/dist/2020.js'
import { gt, valid } from 'semver'

import manifestSchema from '../../schema/manifest-v1.json' with { type: 'json' }
import { FRONTPREP_VERSION } from '../version.js'
import { FrontprepError } from './errors.js'
import { FileSystem } from './filesystem.js'
import { toProjectPath } from './paths.js'
import type { FrontprepManifest } from './types.js'

export const MANIFEST_PATH = '.frontprep.json'

const ajv = new Ajv2020({ allErrors: true, strict: true })
const validateManifest = ajv.compile<FrontprepManifest>(manifestSchema)

function sortedRecord<T>(record: Record<string, T>): Record<string, T> {
  return Object.fromEntries(
    Object.entries(record).sort(([left], [right]) => left.localeCompare(right)),
  )
}

export function serializeManifest(manifest: FrontprepManifest): string {
  const ordered: FrontprepManifest = {
    $schema: manifest.$schema,
    schemaVersion: manifest.schemaVersion,
    frontprepVersion: manifest.frontprepVersion,
    adapter: manifest.adapter,
    packageManager: manifest.packageManager,
    paths: {
      app: manifest.paths.app,
      stylesheet: manifest.paths.stylesheet,
    },
    modules: sortedRecord(manifest.modules) as FrontprepManifest['modules'],
    files: sortedRecord(manifest.files),
    managedScripts: sortedRecord(manifest.managedScripts),
  }
  return `${JSON.stringify(ordered, null, 2)}\n`
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
  let value: unknown
  try {
    value = JSON.parse(await readFile(join(root, MANIFEST_PATH), 'utf8'))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null
    }
    throw invalidManifest('the file is not valid JSON', error)
  }

  if (!validateManifest(value)) {
    const details = validateManifest.errors
      ?.map(
        (error) =>
          `${error.instancePath || '/'} ${error.message ?? 'is invalid'}`,
      )
      .join('; ')
    throw invalidManifest(details ?? 'schema validation failed')
  }
  if (valid(value.frontprepVersion) === null) {
    throw invalidManifest('frontprepVersion must be a valid semantic version')
  }
  if (gt(value.frontprepVersion, FRONTPREP_VERSION)) {
    throw invalidManifest(
      `the manifest was created by newer frontprep ${value.frontprepVersion}; upgrade this CLI before continuing`,
    )
  }
  return value
}

export async function writeManifest(
  root: string,
  manifest: FrontprepManifest,
): Promise<void> {
  if (!validateManifest(manifest)) {
    throw invalidManifest('refused to write data that does not match schema')
  }
  const fileSystem = new FileSystem(root)
  await fileSystem.writeAtomic(
    toProjectPath(MANIFEST_PATH),
    Buffer.from(serializeManifest(manifest)),
    0o644,
  )
}
