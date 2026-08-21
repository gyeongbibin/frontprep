import { chmod, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { hashBytes } from '../../src/core/filesystem.js'
import { detectProject } from '../../src/core/project-detector.js'
import type { FrontprepManifest, ModuleId } from '../../src/core/types.js'
import { verifyModules, verifyStructure } from '../../src/core/verifier.js'
import type { SetupModule } from '../../src/modules/types.js'
import { createProject } from '../helpers/project.js'

function manifest(files: FrontprepManifest['files'] = {}): FrontprepManifest {
  return {
    $schema:
      'https://unpkg.com/@mingyeongbin/frontprep/schema/manifest-v1.json',
    schemaVersion: 1,
    frontprepVersion: '0.1.0-beta.0',
    adapter: 'next-app',
    packageManager: 'pnpm@10.22.0',
    paths: { app: 'src/app', stylesheet: 'src/app/globals.css' },
    modules: {
      quality: '1.0.0',
      tailwind: '1.0.0',
      test: '1.0.0',
      'git-hooks': '1.0.0',
      ci: '1.0.0',
    },
    files,
    managedScripts: { 'frontprep:check': 'pnpm run frontprep:lint' },
  }
}

function setupModule(
  id: ModuleId,
  calls: ModuleId[],
  issues: readonly { message: string; path?: string }[] = [],
): SetupModule {
  return {
    id,
    version: '1.0.0',
    async analyze() {
      return undefined
    },
    async plan() {
      return []
    },
    async verify() {
      calls.push(id)
      return { issues, valid: issues.length === 0 }
    },
  }
}

describe('verification', () => {
  it('aggregates structural and module failures in registry order', async () => {
    const project = await createProject()
    const editorPath = join(project.root, '.editorconfig')
    await writeFile(editorPath, 'changed\n')
    await chmod(editorPath, 0o644)
    const base = await detectProject(project.root)
    const context = {
      ...base,
      manifest: manifest({
        '.editorconfig': {
          hash: hashBytes(Buffer.from('expected\n')),
          mode: '0644',
          ownership: 'managed',
        },
      }),
    }
    const calls: ModuleId[] = []
    const modules = [
      setupModule('quality', calls),
      setupModule('tailwind', calls),
      setupModule('test', calls),
      setupModule('git-hooks', calls),
      setupModule('ci', calls, [
        { message: 'workflow drift', path: '.github/workflows/ci.yml' },
      ]),
    ]

    const result = await verifyStructure(context, modules)

    expect(calls).toEqual(['quality', 'tailwind', 'test', 'git-hooks', 'ci'])
    expect(result.valid).toBe(false)
    expect(result.issues.map(({ message }) => message)).toEqual([
      'Managed file fingerprint does not match.',
      'Managed package script is missing or changed.',
      'workflow drift',
    ])
    expect(result.issues.map(({ path }) => path)).toEqual([
      '.editorconfig',
      'package.json',
      '.github/workflows/ci.yml',
    ])
  })

  it('reports every missing registered module and manifest', async () => {
    const project = await createProject()
    const context = await detectProject(project.root)

    const result = await verifyStructure(context, [])

    expect(result.valid).toBe(false)
    expect(result.issues).toHaveLength(6)
    expect(result.issues[0]?.message).toBe('Frontprep manifest is missing.')
    expect(result.issues.slice(1).map(({ moduleId }) => moduleId)).toEqual([
      'quality',
      'tailwind',
      'test',
      'git-hooks',
      'ci',
    ])
  })

  it('returns all module verifier issues without requiring a manifest', async () => {
    const project = await createProject()
    const context = await detectProject(project.root)
    const calls: ModuleId[] = []
    const modules = [
      setupModule('quality', calls, [{ message: 'lint invalid' }]),
      setupModule('tailwind', calls, [{ message: 'styles invalid' }]),
    ]

    const result = await verifyModules(context, modules)

    expect(result).toMatchObject({ valid: false })
    expect(result.issues.map(({ moduleId }) => moduleId)).toEqual([
      'quality',
      'tailwind',
    ])
  })

  it('accepts an exact managed file, script, paths, versions, and module state', async () => {
    const project = await createProject()
    const editorBytes = Buffer.from('root = true\n')
    await writeFile(join(project.root, '.editorconfig'), editorBytes)
    const base = await detectProject(project.root)
    const context = {
      ...base,
      packageJson: {
        ...base.packageJson,
        scripts: { 'frontprep:check': 'pnpm run frontprep:lint' },
      },
      manifest: manifest({
        '.editorconfig': {
          hash: hashBytes(editorBytes),
          mode: '0644',
          ownership: 'managed',
        },
      }),
    }
    const calls: ModuleId[] = []
    const modules = (
      ['quality', 'tailwind', 'test', 'git-hooks', 'ci'] as const
    ).map((id) => setupModule(id, calls))

    await expect(verifyStructure(context, modules)).resolves.toEqual({
      issues: [],
      valid: true,
    })
    expect(await readFile(join(project.root, '.editorconfig'))).toEqual(
      editorBytes,
    )
  })
})
