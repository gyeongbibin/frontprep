import { describe, expect, it } from 'vitest'

import { writeManifest } from '../../src/core/manifest.js'
import { detectProject } from '../../src/core/project-detector.js'
import { manifestV2 } from '../helpers/manifest.js'
import { createProject, createWorkspaceProject } from '../helpers/project.js'

describe('project detector', () => {
  it('builds an immutable context for a supported project', async () => {
    const project = await createProject()

    const context = await detectProject(project.root)

    expect(context).toMatchObject({
      adapter: 'next-app',
      appDirectory: 'src/app',
      layout: {
        tests: { path: 'src/test', source: 'default' },
        utilities: { path: 'src/shared/lib', source: 'default' },
      },
      manifest: null,
      manifestNeedsMigration: false,
      packageRoot: context.root,
      packageManager: { name: 'pnpm', version: '10.22.0' },
      repositoryRoot: context.root,
      sourceDirectory: 'src',
      stylesheetPath: 'src/app/globals.css',
      workspaceRoot: context.root,
    })
    expect(Object.isFrozen(context)).toBe(true)
    expect(Object.isFrozen(context.layout)).toBe(true)
    expect(Object.isFrozen(context.layout.stylesheet)).toBe(true)
  })

  it('selects explicit utility and test directories', async () => {
    const project = await createProject()

    await expect(
      detectProject(project.root, {
        testDirectory: 'src/spec',
        utilityDirectory: 'src/shared/lib',
      }),
    ).resolves.toMatchObject({
      layout: {
        tests: { path: 'src/spec', source: 'option' },
        testSetupPath: 'src/spec/setup.ts',
        utilities: { path: 'src/shared/lib', source: 'option' },
      },
    })
  })

  it.each([
    ['npm@11.0.0', 'pnpm 10'],
    ['pnpm@9.15.0', 'pnpm 10'],
  ])('rejects package manager %s', async (packageManager, message) => {
    const project = await createProject({ packageManager })
    await expect(detectProject(project.root)).rejects.toThrow(message)
  })

  it('rejects Next.js 15', async () => {
    const project = await createProject({ nextVersion: '^15.5.0' })
    await expect(detectProject(project.root)).rejects.toThrow('Next.js 16')
  })

  it.each([
    [{ nextVersion: '>=16.0.0' }, 'Next.js 16'],
    [{ typescriptVersion: '>=5.0.0' }, 'TypeScript 5'],
  ])(
    'rejects ranges that can resolve to a future unsupported major',
    async (options, message) => {
      const project = await createProject(options)
      await expect(detectProject(project.root)).rejects.toThrow(message)
    },
  )

  it('rejects a project without TypeScript 5', async () => {
    const project = await createProject({ typescriptVersion: null })
    await expect(detectProject(project.root)).rejects.toThrow('TypeScript 5')
  })

  it('rejects package.json workspaces', async () => {
    const project = await createProject({ packageWorkspaces: ['packages/*'] })
    await expect(detectProject(project.root)).rejects.toThrow(
      'cannot contain nested workspaces',
    )
  })

  it('allows a settings-only pnpm-workspace.yaml', async () => {
    const project = await createProject({
      pnpmWorkspace: 'onlyBuiltDependencies:\n  - esbuild\n',
    })
    await expect(detectProject(project.root)).resolves.toBeDefined()
  })

  it('loads a valid frontprep manifest into the context', async () => {
    const project = await createProject()
    const manifest = manifestV2({
      frontprepVersion: '0.1.0-beta.0',
      files: { package: {}, repository: {} },
      managedScripts: {},
    })
    await writeManifest(project.root, manifest)

    await expect(detectProject(project.root)).resolves.toMatchObject({
      manifest,
      layout: {
        tests: { path: manifest.paths.test, source: 'manifest' },
        utilities: { path: manifest.paths.utilities, source: 'manifest' },
      },
    })
  })

  it('rejects an option that disagrees with the manifest path', async () => {
    const project = await createProject()
    await writeManifest(
      project.root,
      manifestV2({ frontprepVersion: '0.1.0-beta.0' }),
    )

    await expect(
      detectProject(project.root, { utilityDirectory: 'src/lib' }),
    ).rejects.toThrow('--utility-dir')
  })

  it('rejects pnpm workspace package globs', async () => {
    const project = await createProject({
      pnpmWorkspace: "packages:\n  - 'packages/*'\n",
    })
    await expect(detectProject(project.root)).rejects.toThrow(
      'single application repository',
    )
  })

  it('detects one explicitly selected pnpm workspace package', async () => {
    const project = await createWorkspaceProject()

    await expect(detectProject(project.packageRoot)).resolves.toMatchObject({
      packageDirectory: 'apps/web',
      packageRoot: expect.stringContaining('/apps/web'),
      repositoryRoot: expect.not.stringContaining('/apps/web'),
      root: expect.stringContaining('/apps/web'),
      workspaceRoot: expect.not.stringContaining('/apps/web'),
    })
  })
})
