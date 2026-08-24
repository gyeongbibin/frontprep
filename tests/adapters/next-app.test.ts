import { writeFile } from 'node:fs/promises'
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
      stylesheetNeedsImport: true,
      stylesheetPath: 'src/app/globals.css',
    })
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
