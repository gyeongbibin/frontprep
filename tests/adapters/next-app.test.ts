import { mkdir, rename, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { detectNextApp } from '../../src/adapters/next-app.js'
import { createProject } from '../helpers/project.js'

describe('Next App Router adapter', () => {
  it.each([
    ['app', null],
    ['src/app', 'src'],
  ] as const)(
    'detects an application under %s',
    async (appDirectory, sourceDirectory) => {
      const project = await createProject({ appDirectory })

      await expect(detectNextApp(project.root)).resolves.toEqual({
        appDirectory,
        layoutPath: `${appDirectory}/layout.tsx`,
        sourceDirectory,
        stylesheet: {
          importKind: 'relative',
          importSpecifier: './globals.css',
          path: `${appDirectory}/globals.css`,
          source: 'detected',
        },
        stylesheetNeedsImport: false,
        stylesheetPath: `${appDirectory}/globals.css`,
      })
    },
  )

  it('selects a sibling globals.css when the layout has no CSS import', async () => {
    const project = await createProject({
      layout: 'export default function Layout() { return null }\n',
    })

    await expect(detectNextApp(project.root)).resolves.toMatchObject({
      stylesheet: {
        importKind: 'planned',
        importSpecifier: './globals.css',
        path: 'src/app/globals.css',
        source: 'default',
      },
      stylesheetNeedsImport: true,
      stylesheetPath: 'src/app/globals.css',
    })
  })

  it('resolves a static stylesheet alias from JSONC TypeScript paths', async () => {
    const project = await createProject({
      layout: "import '@/styles/global.css'\n",
    })
    await writeFile(
      join(project.root, 'tsconfig.json'),
      '{\n  "compilerOptions": {\n    "baseUrl": ".",\n    "paths": { "@/*": ["./src/*"] },\n  },\n}\n',
      'utf8',
    )
    await mkdir(join(project.root, 'src/styles'), { recursive: true })
    await writeFile(join(project.root, 'src/styles/global.css'), 'body {}\n')

    await expect(detectNextApp(project.root)).resolves.toMatchObject({
      stylesheet: {
        importKind: 'alias',
        importSpecifier: '@/styles/global.css',
        path: 'src/styles/global.css',
        source: 'detected',
      },
    })
  })

  it('uses an explicit stylesheet when the layout needs an import', async () => {
    const project = await createProject({ layout: 'export default null\n' })

    await expect(
      detectNextApp(project.root, { stylesheet: 'src/styles/global.css' }),
    ).resolves.toMatchObject({
      stylesheet: {
        importKind: 'planned',
        importSpecifier: '../styles/global.css',
        path: 'src/styles/global.css',
        source: 'option',
      },
    })
  })

  it('rejects a stylesheet option that disagrees with the layout import', async () => {
    const project = await createProject()

    await expect(
      detectNextApp(project.root, { stylesheet: 'src/styles/global.css' }),
    ).rejects.toThrow('--stylesheet')
  })

  it('rejects an imported stylesheet through an internal symbolic link', async () => {
    const project = await createProject()
    await rename(
      join(project.root, 'src/app/globals.css'),
      join(project.root, 'src/app/actual.css'),
    )
    await symlink('actual.css', join(project.root, 'src/app/globals.css'))

    await expect(detectNextApp(project.root)).rejects.toThrow('symbolic link')
  })

  it('rejects multiple local CSS imports', async () => {
    const project = await createProject()
    await writeFile(
      join(project.root, 'src/app/layout.tsx'),
      "import './globals.css'\nimport './theme.css'\n",
      'utf8',
    )

    await expect(detectNextApp(project.root)).rejects.toThrow(
      'Multiple global stylesheets',
    )
  })

  it('rejects two App Router roots', async () => {
    const project = await createProject({ secondAppRoot: true })

    await expect(detectNextApp(project.root)).rejects.toThrow(
      'Exactly one App Router root is required',
    )
  })
})
