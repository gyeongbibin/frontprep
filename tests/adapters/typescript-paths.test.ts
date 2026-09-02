import { mkdtemp, mkdir, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { writeProjectFile } from '../helpers/project.js'

async function projectRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'frontprep-ts-paths-'))
}

describe('TypeScript path aliases', () => {
  it('parses JSONC and resolves a wildcard path from baseUrl', async () => {
    const { parseTypeScriptPaths, resolveTypeScriptImport } =
      await import('../../src/adapters/typescript-paths.js')
    const root = await projectRoot()
    await writeProjectFile(root, 'src/styles/global.css', 'body {}\n')
    const config = parseTypeScriptPaths(
      `{
        // TypeScript aliases
        "compilerOptions": {
          "baseUrl": ".",
          "paths": { "@/*": ["./src/*"], },
        },
      }`,
      join(root, 'tsconfig.json'),
    )

    expect(config).toEqual({
      baseUrl: '.',
      mappings: [{ pattern: '@/*', targets: ['./src/*'] }],
    })
    await expect(
      resolveTypeScriptImport(root, config, '@/styles/global.css'),
    ).resolves.toEqual(['src/styles/global.css'])
    await expect(
      resolveTypeScriptImport(root, config, '@/styles/global.css?inline'),
    ).resolves.toEqual(['src/styles/global.css'])
  })

  it('prefers an exact mapping over a matching wildcard', async () => {
    const { parseTypeScriptPaths, resolveTypeScriptImport } =
      await import('../../src/adapters/typescript-paths.js')
    const root = await projectRoot()
    await writeProjectFile(root, 'src/exact.css', 'exact\n')
    await writeProjectFile(root, 'src/fallback/global.css', 'fallback\n')
    const config = parseTypeScriptPaths(
      JSON.stringify({
        compilerOptions: {
          paths: {
            'styles/global.css': ['src/exact.css'],
            'styles/*': ['src/fallback/*'],
          },
        },
      }),
      join(root, 'tsconfig.json'),
    )

    await expect(
      resolveTypeScriptImport(root, config, 'styles/global.css'),
    ).resolves.toEqual(['src/exact.css'])
  })

  it('uses baseUrl for unmatched bare specifiers', async () => {
    const { parseTypeScriptPaths, resolveTypeScriptImport } =
      await import('../../src/adapters/typescript-paths.js')
    const root = await projectRoot()
    await writeProjectFile(root, 'src/styles/global.css', 'body {}\n')
    const config = parseTypeScriptPaths(
      JSON.stringify({ compilerOptions: { baseUrl: 'src' } }),
      join(root, 'tsconfig.json'),
    )

    await expect(
      resolveTypeScriptImport(root, config, 'styles/global.css'),
    ).resolves.toEqual(['src/styles/global.css'])
  })

  it('returns every existing target in sorted unique order', async () => {
    const { parseTypeScriptPaths, resolveTypeScriptImport } =
      await import('../../src/adapters/typescript-paths.js')
    const root = await projectRoot()
    await writeProjectFile(root, 'src/global.css', 'src\n')
    await writeProjectFile(root, 'generated/global.css', 'generated\n')
    const config = parseTypeScriptPaths(
      JSON.stringify({
        compilerOptions: {
          paths: {
            '@/*': ['src/*', 'generated/*', 'src/*', 'missing/*'],
          },
        },
      }),
      join(root, 'tsconfig.json'),
    )

    await expect(
      resolveTypeScriptImport(root, config, '@/global.css'),
    ).resolves.toEqual(['generated/global.css', 'src/global.css'])
  })

  it('returns no candidate for an unmatched package-like import without baseUrl', async () => {
    const { parseTypeScriptPaths, resolveTypeScriptImport } =
      await import('../../src/adapters/typescript-paths.js')
    const root = await projectRoot()
    const config = parseTypeScriptPaths(
      JSON.stringify({ compilerOptions: {} }),
      join(root, 'tsconfig.json'),
    )

    await expect(
      resolveTypeScriptImport(root, config, 'package/global.css'),
    ).resolves.toEqual([])
  })

  it('filters targets outside the package and escaping symlinks', async () => {
    const { parseTypeScriptPaths, resolveTypeScriptImport } =
      await import('../../src/adapters/typescript-paths.js')
    const parent = await projectRoot()
    const root = join(parent, 'project')
    const outside = join(parent, 'outside')
    await mkdir(root)
    await mkdir(outside)
    await writeProjectFile(outside, 'global.css', 'outside\n')
    await symlink(outside, join(root, 'linked'))
    const config = parseTypeScriptPaths(
      JSON.stringify({
        compilerOptions: {
          paths: { 'outside/*': ['../outside/*'], 'linked/*': ['linked/*'] },
        },
      }),
      join(root, 'tsconfig.json'),
    )

    await expect(
      resolveTypeScriptImport(root, config, 'outside/global.css'),
    ).resolves.toEqual([])
    await expect(
      resolveTypeScriptImport(root, config, 'linked/global.css'),
    ).resolves.toEqual([])
  })

  it.each([
    ['{ invalid', 'invalid JSONC'],
    [
      JSON.stringify({ compilerOptions: { baseUrl: 42 } }),
      'non-string baseUrl',
    ],
    [
      JSON.stringify({ compilerOptions: { paths: { '@/**': ['src/*'] } } }),
      'multi-star pattern',
    ],
    [
      JSON.stringify({ compilerOptions: { paths: { '@/*': [42] } } }),
      'non-string target',
    ],
    [
      JSON.stringify({ compilerOptions: { paths: { '@/*': 'src/*' } } }),
      'non-array targets',
    ],
  ])('rejects %s (%s)', async (contents) => {
    const { parseTypeScriptPaths } =
      await import('../../src/adapters/typescript-paths.js')

    expect(() =>
      parseTypeScriptPaths(contents, '/project/tsconfig.json'),
    ).toThrow()
  })
})
