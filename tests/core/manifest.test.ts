import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  loadManifest,
  MANIFEST_PATH,
  serializeManifest,
  writeManifest,
} from '../../src/core/manifest.js'
import type { FrontprepManifest } from '../../src/core/types.js'

function manifest(): FrontprepManifest {
  return {
    $schema:
      'https://unpkg.com/@mingyeongbin/frontprep/schema/manifest-v1.json',
    schemaVersion: 1,
    frontprepVersion: '0.1.0-beta.0',
    adapter: 'next-app',
    packageManager: 'pnpm@10.22.0',
    paths: { app: 'src/app', stylesheet: 'src/app/globals.css' },
    modules: {
      ci: '1.0.0',
      test: '1.0.0',
      quality: '1.0.0',
      tailwind: '1.0.0',
      'git-hooks': '1.0.0',
    },
    files: {
      'src/app/globals.css': {
        hash: `sha256:${'b'.repeat(64)}`,
        mode: '0644',
        ownership: 'patched',
      },
      'package.json': {
        hash: `sha256:${'a'.repeat(64)}`,
        mode: '0644',
        ownership: 'patched',
      },
    },
    managedScripts: {
      'frontprep:typecheck': 'tsc --noEmit',
      'frontprep:lint': 'eslint .',
    },
  }
}

describe('frontprep manifest', () => {
  it('serializes keys deterministically with LF and a final newline', () => {
    const serialized = serializeManifest(manifest())
    const parsed = JSON.parse(serialized) as FrontprepManifest

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
    await writeManifest(root, manifest())

    await expect(loadManifest(root)).resolves.toEqual(manifest())
  })

  it('returns null when the manifest is absent', async () => {
    const root = await mkdtemp(join(tmpdir(), 'frontprep-manifest-'))
    await expect(loadManifest(root)).resolves.toBeNull()
  })

  it('rejects an unknown schema version', async () => {
    const root = await mkdtemp(join(tmpdir(), 'frontprep-manifest-'))
    await writeFile(
      join(root, MANIFEST_PATH),
      `${JSON.stringify({ ...manifest(), schemaVersion: 2 })}\n`,
      'utf8',
    )

    await expect(loadManifest(root)).rejects.toThrow('Invalid .frontprep.json')
  })
})
