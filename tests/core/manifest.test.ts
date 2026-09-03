import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Ajv2020 } from 'ajv/dist/2020.js'
import { describe, expect, it } from 'vitest'

import {
  loadManifest,
  loadPersistedManifest,
  MANIFEST_PATH,
  serializeManifest,
  serializeManifestV1,
  writeManifest,
  writeManifestV1,
} from '../../src/core/manifest.js'
import type {
  FrontprepManifestV1,
  FrontprepManifestV2,
} from '../../src/core/types.js'
import { manifestV1, manifestV2 } from '../helpers/manifest.js'

describe('frontprep manifest', () => {
  it('serializes keys deterministically with LF and a final newline', () => {
    const serialized = serializeManifestV1(manifestV1())
    const parsed = JSON.parse(serialized) as FrontprepManifestV1

    expect(serialized.endsWith('\n')).toBe(true)
    expect(serialized).not.toContain('\r')
    expect(Object.keys(parsed.files)).toEqual([
      'package.json',
      'src/app/globals.css',
    ])
    expect(Object.keys(parsed.modules)).toEqual([
      'ci',
      'git-hooks',
      'quality',
      'tailwind',
      'test',
    ])
    expect(Object.keys(parsed.managedScripts)).toEqual([
      'frontprep:lint',
      'frontprep:typecheck',
    ])
  })

  it('writes and loads a valid manifest', async () => {
    const root = await mkdtemp(join(tmpdir(), 'frontprep-manifest-'))
    await writeManifestV1(root, manifestV1())

    await expect(loadPersistedManifest(root)).resolves.toEqual(manifestV1())
  })

  it('returns null when the manifest is absent', async () => {
    const root = await mkdtemp(join(tmpdir(), 'frontprep-manifest-'))
    await expect(loadManifest(root)).resolves.toBeNull()
  })

  it('rejects an unknown schema version', async () => {
    const root = await mkdtemp(join(tmpdir(), 'frontprep-manifest-'))
    await writeFile(
      join(root, MANIFEST_PATH),
      `${JSON.stringify({ ...manifestV1(), schemaVersion: 2 })}\n`,
      'utf8',
    )

    await expect(loadManifest(root)).rejects.toThrow('Invalid .frontprep.json')
  })

  it.each([
    ['0.2.0', 'newer frontprep'],
    ['not-a-version', 'valid semantic version'],
  ])('rejects incompatible frontprepVersion %s', async (version, message) => {
    const root = await mkdtemp(join(tmpdir(), 'frontprep-manifest-'))
    await writeFile(
      join(root, MANIFEST_PATH),
      `${JSON.stringify({ ...manifestV1(), frontprepVersion: version })}\n`,
      'utf8',
    )

    await expect(loadManifest(root)).rejects.toThrow(message)
  })

  it('defines a closed schema for complete v2 manifests', async () => {
    const schemaPath = new URL('../../schema/manifest-v2.json', import.meta.url)
    const schema = JSON.parse(await readFile(schemaPath, 'utf8')) as object
    const ajv = new Ajv2020({ allErrors: true, strict: true })
    const validate = ajv.compile<FrontprepManifestV2>(schema)

    expect(validate(manifestV2()), validate.errors?.[0]?.message).toBe(true)
    expect(
      validate(manifestV2({ paths: { utilities: '../shared/lib' } })),
    ).toBe(false)
    expect(validate({ ...manifestV2(), unexpected: true })).toBe(false)
  })

  it('loads a persisted v2 manifest with the matching schema', async () => {
    const root = await mkdtemp(join(tmpdir(), 'frontprep-manifest-'))
    const persisted = manifestV2({ frontprepVersion: '0.1.0-beta.0' })
    await writeFile(
      join(root, MANIFEST_PATH),
      `${JSON.stringify(persisted)}\n`,
      'utf8',
    )

    await expect(loadPersistedManifest(root)).resolves.toEqual(persisted)
  })

  it('serializes v2 manifests with stable nested file ordering', async () => {
    const serialized = serializeManifest(
      manifestV2({
        files: {
          package: {
            'z.txt': {
              hash: `sha256:${'c'.repeat(64)}`,
              mode: '0644',
              ownership: 'managed',
            },
            'a.txt': {
              hash: `sha256:${'d'.repeat(64)}`,
              mode: '0644',
              ownership: 'managed',
            },
          },
          repository: {
            'z.txt': {
              hash: `sha256:${'e'.repeat(64)}`,
              mode: '0644',
              ownership: 'managed',
            },
            'a.txt': {
              hash: `sha256:${'f'.repeat(64)}`,
              mode: '0644',
              ownership: 'managed',
            },
          },
        },
      }),
    )
    const parsed = JSON.parse(serialized) as FrontprepManifestV2

    expect(serialized.endsWith('\n')).toBe(true)
    expect(Object.keys(parsed.files.package)).toEqual(['a.txt', 'z.txt'])
    expect(Object.keys(parsed.files.repository)).toEqual(['a.txt', 'z.txt'])
  })

  it('refuses to write an invalid v2 manifest', async () => {
    const root = await mkdtemp(join(tmpdir(), 'frontprep-manifest-'))
    const invalid = manifestV2({ paths: { utilities: '../outside' } })

    await expect(writeManifest(root, invalid)).rejects.toMatchObject({
      code: 'INVALID_MANIFEST',
    })
  })
})
