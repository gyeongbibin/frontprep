import { access, readFile, realpath } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

import { UnsupportedProjectError } from '../core/errors.js'
import { toProjectPath } from '../core/paths.js'

export interface NextAppPaths {
  appDirectory: string
  layoutPath: string
  sourceDirectory: string | null
  stylesheetNeedsImport: boolean
  stylesheetPath: string
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

function toPosixPath(path: string): string {
  return path.split(sep).join('/')
}

function importedStylesheets(layout: string): string[] {
  const imports: string[] = []
  const pattern = /^\s*import\s+['"]([^'"]+\.css)['"]\s*;?\s*$/gmu
  for (const match of layout.matchAll(pattern)) {
    const value = match[1]
    if (value?.startsWith('.')) {
      imports.push(value)
    }
  }
  return imports
}

export async function detectNextApp(root: string): Promise<NextAppPaths> {
  const rootRealPath = await realpath(root)
  const candidates = [
    { appDirectory: 'app', sourceDirectory: null },
    { appDirectory: 'src/app', sourceDirectory: 'src' },
  ] as const
  const layouts: Array<{
    appDirectory: 'app' | 'src/app'
    layoutPath: string
    sourceDirectory: 'src' | null
  }> = []

  for (const candidate of candidates) {
    for (const extension of ['ts', 'tsx']) {
      const layoutPath = `${candidate.appDirectory}/layout.${extension}`
      if (await fileExists(join(rootRealPath, layoutPath))) {
        layouts.push({ ...candidate, layoutPath })
      }
    }
  }

  if (layouts.length !== 1) {
    throw new UnsupportedProjectError(
      'Exactly one App Router root is required under app/ or src/app/.',
    )
  }

  const app = layouts[0]!
  const layout = await readFile(join(rootRealPath, app.layoutPath), 'utf8')
  const stylesheets = importedStylesheets(layout)
  if (stylesheets.length > 1) {
    throw new UnsupportedProjectError(
      `Multiple global stylesheets are imported by ${app.layoutPath}.`,
      'Keep one relative global CSS import in the root layout.',
    )
  }

  if (stylesheets.length === 0) {
    return Object.freeze({
      ...app,
      stylesheetNeedsImport: true,
      stylesheetPath: `${app.appDirectory}/globals.css`,
    })
  }

  const stylesheetAbsolutePath = resolve(
    dirname(join(rootRealPath, app.layoutPath)),
    stylesheets[0]!,
  )
  const stylesheetRealParent = await realpath(dirname(stylesheetAbsolutePath))
  const rootRelativeParent = relative(rootRealPath, stylesheetRealParent)
  if (rootRelativeParent.startsWith('..') || isAbsolute(rootRelativeParent)) {
    throw new UnsupportedProjectError(
      'The global stylesheet resolves outside the project root.',
    )
  }
  const stylesheetPath = toProjectPath(
    toPosixPath(relative(rootRealPath, stylesheetAbsolutePath)),
  )

  return Object.freeze({
    ...app,
    stylesheetNeedsImport: false,
    stylesheetPath,
  })
}
