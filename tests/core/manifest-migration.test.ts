import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { toProjectPath } from '../../src/core/paths.js'
import type { ManifestFile } from '../../src/core/types.js'
import { manifestV1, manifestV2 } from '../helpers/manifest.js'
import { writeProjectFile } from '../helpers/project.js'

const managedFile: ManifestFile = {
  hash: `sha256:${'c'.repeat(64)}`,
  mode: '0644',
  ownership: 'managed',
}

const patchedFile: ManifestFile = {
  hash: `sha256:${'d'.repeat(64)}`,
  mode: '0644',
  ownership: 'patched',
}

const detected = {
  app: toProjectPath('src/app'),
  layout: toProjectPath('src/app/layout.tsx'),
  stylesheet: toProjectPath('src/app/globals.css'),
}

async function migrationRoot(setupFiles: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'frontprep-migration-'))
  await writeProjectFile(
    root,
    'vitest.config.mts',
    `export default { test: { setupFiles: [${setupFiles}] } }\n`,
  )
  return root
}

describe('manifest migration', () => {
  it('derives v2 layout paths and separates repository file records', async () => {
    const { normalizeManifest } =
      await import('../../src/core/manifest-migration.js')
    const root = await migrationRoot("'./src/test/setup.ts'")
    const persisted = manifestV1({
      files: {
        'src/shared/utils/cn.ts': { ...managedFile },
        'src/shared/utils/index.ts': { ...patchedFile },
        'vitest.config.mts': { ...managedFile },
        'src/test/setup.ts': { ...managedFile },
        'pnpm-lock.yaml': { ...patchedFile },
        '.github/workflows/ci.yml': { ...managedFile },
      },
    })

    const result = await normalizeManifest(root, persisted, detected)

    expect(result).toMatchObject({
      needsMigration: true,
      manifest: {
        schemaVersion: 2,
        roots: { package: '.', workspace: '.' },
        paths: {
          app: 'src/app',
          layout: 'src/app/layout.tsx',
          stylesheet: 'src/app/globals.css',
          utilities: 'src/shared/utils',
          test: 'src/test',
          testSetup: 'src/test/setup.ts',
        },
      },
    })
    expect(Object.keys(result.manifest?.files.repository ?? {}).sort()).toEqual(
      ['.github/workflows/ci.yml', 'pnpm-lock.yaml'],
    )
    expect(Object.keys(result.manifest?.files.package ?? {}).sort()).toEqual([
      'src/shared/utils/cn.ts',
      'src/shared/utils/index.ts',
      'src/test/setup.ts',
      'vitest.config.mts',
    ])
  })

  it('returns an existing v2 manifest without migration', async () => {
    const { normalizeManifest } =
      await import('../../src/core/manifest-migration.js')
    const persisted = manifestV2()

    await expect(
      normalizeManifest('/unused', persisted, detected),
    ).resolves.toEqual({ manifest: persisted, needsMigration: false })
  })

  it('rejects ambiguous managed utility directories', async () => {
    const { normalizeManifest } =
      await import('../../src/core/manifest-migration.js')
    const root = await migrationRoot("'./src/test/setup.ts'")
    const persisted = manifestV1({
      files: {
        'src/shared/utils/cn.ts': { ...managedFile },
        'src/shared/utils/index.ts': { ...patchedFile },
        'src/lib/utils/cn.ts': { ...managedFile },
        'src/lib/utils/index.ts': { ...patchedFile },
        'vitest.config.mts': { ...managedFile },
        'src/test/setup.ts': { ...managedFile },
      },
    })

    await expect(
      normalizeManifest(root, persisted, detected),
    ).rejects.toMatchObject({ code: 'INVALID_MANIFEST' })
  })

  it('rejects ambiguous Vitest setup paths', async () => {
    const { normalizeManifest } =
      await import('../../src/core/manifest-migration.js')
    const root = await migrationRoot("'./src/test/setup.ts', './test/setup.ts'")
    const persisted = manifestV1({
      files: {
        'src/shared/utils/cn.ts': { ...managedFile },
        'src/shared/utils/index.ts': { ...patchedFile },
        'vitest.config.mts': { ...managedFile },
        'src/test/setup.ts': { ...managedFile },
        'test/setup.ts': { ...managedFile },
      },
    })

    await expect(
      normalizeManifest(root, persisted, detected),
    ).rejects.toMatchObject({ code: 'INVALID_MANIFEST' })
  })

  it('rejects migration when no managed utility directory can be derived', async () => {
    const { normalizeManifest } =
      await import('../../src/core/manifest-migration.js')
    const root = await migrationRoot("'./src/test/setup.ts'")
    const persisted = manifestV1({
      files: {
        'vitest.config.mts': { ...managedFile },
        'src/test/setup.ts': { ...managedFile },
      },
    })

    await expect(
      normalizeManifest(root, persisted, detected),
    ).rejects.toMatchObject({ code: 'INVALID_MANIFEST' })
  })

  it.each([
    ["'./../outside/setup.ts'", 'an unsafe setup path'],
    ["'./src/other/setup.ts'", 'a setup path without a managed record'],
  ])('rejects %s (%s)', async (setupFiles) => {
    const { normalizeManifest } =
      await import('../../src/core/manifest-migration.js')
    const root = await migrationRoot(setupFiles)
    const persisted = manifestV1({
      files: {
        'src/shared/utils/cn.ts': { ...managedFile },
        'src/shared/utils/index.ts': { ...patchedFile },
        'vitest.config.mts': { ...managedFile },
        'src/test/setup.ts': { ...managedFile },
      },
    })

    await expect(
      normalizeManifest(root, persisted, detected),
    ).rejects.toMatchObject({ code: 'INVALID_MANIFEST' })
  })
})
