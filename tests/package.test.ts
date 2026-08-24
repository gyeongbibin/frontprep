import { execFile } from 'node:child_process'
import { readFile, stat } from 'node:fs/promises'
import { promisify } from 'node:util'

import { beforeAll, describe, expect, it } from 'vitest'

import tsupConfig from '../tsup.config.js'

const execFileAsync = promisify(execFile)
const root = new URL('..', import.meta.url)

interface PackageJson {
  bin: Record<string, string>
  bugs: { url: string }
  devDependencies: Record<string, string>
  engines: { node: string }
  files: string[]
  homepage: string
  keywords: string[]
  license: string
  name: string
  publishConfig: { access: string }
  repository: { type: string; url: string }
  scripts: Record<string, string>
}

interface PackedFile {
  mode: number
  path: string
}

interface PackResult {
  files: PackedFile[]
}

describe('package metadata', () => {
  beforeAll(async () => {
    await execFileAsync('pnpm', ['build'], { cwd: root })
  })

  it('publishes the frontprep executable and runtime assets', async () => {
    const contents = await readFile(
      new URL('../package.json', import.meta.url),
      'utf8',
    )
    const packageJson = JSON.parse(contents) as PackageJson

    expect(packageJson.name).toBe('@mingyeongbin/frontprep')
    expect(packageJson.bin).toEqual({ frontprep: 'dist/cli.js' })
    expect(packageJson.homepage).toBe(
      'https://github.com/gyeongbibin/frontprep#readme',
    )
    expect(packageJson.bugs).toEqual({
      url: 'https://github.com/gyeongbibin/frontprep/issues',
    })
    expect(packageJson.keywords).toEqual([
      'frontend',
      'nextjs',
      'pnpm',
      'setup',
      'tooling',
    ])
    expect(packageJson.license).toBe('MIT')
    expect(packageJson.publishConfig).toEqual({ access: 'public' })
    expect(packageJson.repository).toEqual({
      type: 'git',
      url: 'git+https://github.com/gyeongbibin/frontprep.git',
    })
    expect(packageJson.engines.node).toBe('>=22.22.1')
    expect(packageJson.devDependencies['@types/node']).toBe('^22.20.0')
    expect(packageJson.devDependencies.eslint).toBe('^9.39.0')
    expect(packageJson.devDependencies['@eslint/js']).toBe('^9.39.0')
    expect(packageJson.files).toEqual(['dist', 'schema'])
    expect(packageJson.scripts['verify:package']).toBe(
      'pnpm build && pnpm --silent dlx --package=node@22.22.1 node scripts/verify-package.mjs',
    )
    expect(packageJson.scripts['verify:quality-compatibility']).toBe(
      'vitest run --config tests/acceptance/vitest.config.ts tests/acceptance/quality-module.acceptance.ts',
    )
    expect(packageJson.scripts['verify:test-compatibility']).toBe(
      'vitest run --config tests/acceptance/vitest.config.ts tests/acceptance/test-module.acceptance.ts',
    )
    expect(packageJson.scripts['verify:git-hooks-compatibility']).toBe(
      'vitest run --config tests/acceptance/vitest.config.ts tests/acceptance/git-hooks-module.acceptance.ts',
    )
    expect(packageJson.scripts['verify:ci-compatibility']).toBe(
      'pnpm build && vitest run --config tests/acceptance/vitest.config.ts tests/acceptance/ci-module.acceptance.ts',
    )
  })

  it('packs only the executable, sourcemap, schema, and required metadata', async () => {
    const { stdout } = await execFileAsync(
      'npm',
      ['pack', '--json', '--dry-run'],
      { cwd: root, encoding: 'utf8' },
    )
    const packed = (JSON.parse(stdout) as PackResult[])[0]!

    expect(packed.files.map(({ path }) => path)).toEqual([
      'LICENSE',
      'README.md',
      'dist/cli.js',
      'dist/cli.js.map',
      'package.json',
      'schema/manifest-v1.json',
    ])
    expect(packed.files.find(({ path }) => path === 'dist/cli.js')?.mode).toBe(
      0o755,
    )
  })

  it('builds an executable with one Node shebang', async () => {
    const executable = new URL('../dist/cli.js', import.meta.url)
    const contents = await readFile(executable, 'utf8')
    const mode = (await stat(executable)).mode & 0o777

    expect(contents.startsWith('#!/usr/bin/env node\n')).toBe(true)
    expect(contents.match(/^#!\/usr\/bin\/env node$/gmu)).toHaveLength(1)
    expect(mode).toBe(0o755)
  })

  it('targets the supported Node.js major', () => {
    expect(tsupConfig).toMatchObject({ target: 'node22' })
  })

  it('passes the packaged CLI smoke verification', async () => {
    await expect(
      execFileAsync(process.execPath, ['scripts/verify-package.mjs'], {
        cwd: root,
      }),
    ).resolves.toMatchObject({ stdout: expect.stringContaining('verified') })
  }, 30_000)
})
