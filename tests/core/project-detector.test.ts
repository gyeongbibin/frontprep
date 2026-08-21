import { describe, expect, it } from 'vitest'

import { detectProject } from '../../src/core/project-detector.js'
import { createProject } from '../helpers/project.js'

describe('project detector', () => {
  it('builds an immutable context for a supported project', async () => {
    const project = await createProject()

    const context = await detectProject(project.root)

    expect(context).toMatchObject({
      adapter: 'next-app',
      appDirectory: 'src/app',
      manifest: null,
      packageManager: { name: 'pnpm', version: '10.22.0' },
      sourceDirectory: 'src',
      stylesheetPath: 'src/app/globals.css',
    })
    expect(Object.isFrozen(context)).toBe(true)
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

  it('rejects a project without TypeScript 5', async () => {
    const project = await createProject({ typescriptVersion: null })
    await expect(detectProject(project.root)).rejects.toThrow('TypeScript 5')
  })

  it('rejects package.json workspaces', async () => {
    const project = await createProject({ packageWorkspaces: ['packages/*'] })
    await expect(detectProject(project.root)).rejects.toThrow(
      'single application repository',
    )
  })

  it('allows a settings-only pnpm-workspace.yaml', async () => {
    const project = await createProject({
      pnpmWorkspace: 'onlyBuiltDependencies:\n  - esbuild\n',
    })
    await expect(detectProject(project.root)).resolves.toBeDefined()
  })

  it('rejects pnpm workspace package globs', async () => {
    const project = await createProject({
      pnpmWorkspace: "packages:\n  - 'packages/*'\n",
    })
    await expect(detectProject(project.root)).rejects.toThrow(
      'single application repository',
    )
  })
})
