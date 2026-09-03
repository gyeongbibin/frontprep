import { lstat, readFile, realpath } from 'node:fs/promises'
import { dirname, join, posix, relative, resolve, sep } from 'node:path'

import { UnsupportedProjectError } from '../core/errors.js'
import {
  resolveProjectPath,
  toProjectPath,
  type ProjectPath,
} from '../core/paths.js'
import type { PathSelectionSource, ProjectLayout } from '../core/types.js'
import { extractStaticCssImports } from './static-imports.js'
import {
  parseTypeScriptPaths,
  resolveTypeScriptImport,
} from './typescript-paths.js'

export interface NextAppDetectionOptions {
  readonly manifestStylesheet?: string
  readonly stylesheet?: string
}

export interface NextAppPaths {
  readonly appDirectory: ProjectPath
  readonly layoutPath: ProjectPath
  readonly sourceDirectory: ProjectPath | null
  readonly stylesheet: ProjectLayout['stylesheet']
  readonly stylesheetNeedsImport: boolean
  readonly stylesheetPath: ProjectPath
}

async function regularFile(path: string): Promise<boolean> {
  try {
    const metadata = await lstat(path)
    return metadata.isFile() && !metadata.isSymbolicLink()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

function toPosixPath(path: string): string {
  return path.split(sep).join('/')
}

function projectPath(value: string, flag?: string): ProjectPath {
  try {
    return toProjectPath(value)
  } catch (error) {
    throw new UnsupportedProjectError(
      `${flag ?? 'Configured path'} must be a safe project-relative POSIX path: ${value}.`,
      flag === undefined ? undefined : `Provide a valid ${flag} value.`,
      error,
    )
  }
}

async function assertSafeRegularOrMissing(
  root: string,
  path: ProjectPath,
  flag: string,
): Promise<void> {
  let current = root
  const segments = path.split('/')
  for (const [index, segment] of segments.entries()) {
    current = join(current, segment)
    try {
      const metadata = await lstat(current)
      if (metadata.isSymbolicLink()) {
        throw new UnsupportedProjectError(
          `Configured stylesheet contains a symbolic link: ${path}.`,
          `Choose a regular project file with ${flag}.`,
        )
      }
      if (index < segments.length - 1 && !metadata.isDirectory()) {
        throw new UnsupportedProjectError(
          `Configured stylesheet has a non-directory path component: ${path}.`,
          `Choose a regular project file with ${flag}.`,
        )
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
  }
  if (!(await lstat(join(root, path))).isFile()) {
    throw new UnsupportedProjectError(
      `Configured stylesheet must be a regular file or a missing file: ${path}.`,
      `Choose a valid path with ${flag}.`,
    )
  }
}

function relativeImport(fromPath: ProjectPath, toPath: ProjectPath): string {
  const value = posix.relative(posix.dirname(fromPath), toPath)
  return value.startsWith('.') ? value : `./${value}`
}

async function resolveRelativeStylesheet(
  root: string,
  layoutPath: ProjectPath,
  specifier: string,
): Promise<ProjectPath> {
  const clean = specifier.replace(/[?#].*$/u, '')
  const candidate = resolve(root, dirname(layoutPath), clean)
  const path = projectPath(toPosixPath(relative(root, candidate)))
  const resolved = await resolveProjectPath(root, path)
  await assertSafeRegularOrMissing(root, path, '--stylesheet')
  if (!(await regularFile(resolved))) {
    throw new UnsupportedProjectError(
      `The root layout stylesheet import is not a regular project file: ${specifier}.`,
      'Fix the import or select the intended file with --stylesheet.',
    )
  }
  return path
}

async function resolveAliasedStylesheet(
  root: string,
  specifier: string,
): Promise<ProjectPath> {
  let tsconfig: string
  try {
    tsconfig = await readFile(join(root, 'tsconfig.json'), 'utf8')
  } catch (error) {
    throw new UnsupportedProjectError(
      'tsconfig.json is required to resolve the stylesheet alias.',
      'Fix tsconfig.json or select the intended file with --stylesheet.',
      error,
    )
  }
  const config = parseTypeScriptPaths(tsconfig, join(root, 'tsconfig.json'))
  const matches = await resolveTypeScriptImport(root, config, specifier)
  if (matches.length !== 1) {
    throw new UnsupportedProjectError(
      `The stylesheet alias must resolve to exactly one file; found ${matches.length}: ${specifier}.`,
      'Make the alias unambiguous or select the intended file with --stylesheet.',
    )
  }
  await assertSafeRegularOrMissing(root, matches[0]!, '--stylesheet')
  return matches[0]!
}

function assertAgreement(
  selected: ProjectPath | undefined,
  actual: ProjectPath,
  flag: string,
): void {
  if (selected !== undefined && selected !== actual) {
    throw new UnsupportedProjectError(
      `${flag} selects ${selected}, but the root layout imports ${actual}.`,
      `Use ${flag} ${actual} or update the root layout import.`,
    )
  }
}

export async function detectNextApp(
  root: string,
  options: NextAppDetectionOptions = {},
): Promise<NextAppPaths> {
  const rootRealPath = await realpath(root)
  const candidates = [
    { appDirectory: 'app', sourceDirectory: null },
    { appDirectory: 'src/app', sourceDirectory: 'src' },
  ] as const
  const layouts: Array<{
    appDirectory: ProjectPath
    layoutPath: ProjectPath
    sourceDirectory: ProjectPath | null
  }> = []

  for (const candidate of candidates) {
    for (const extension of ['ts', 'tsx']) {
      const layoutPath = projectPath(
        `${candidate.appDirectory}/layout.${extension}`,
      )
      if (await regularFile(join(rootRealPath, layoutPath))) {
        layouts.push({
          appDirectory: projectPath(candidate.appDirectory),
          layoutPath,
          sourceDirectory:
            candidate.sourceDirectory === null
              ? null
              : projectPath(candidate.sourceDirectory),
        })
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
  const imports = extractStaticCssImports(layout)
  if (imports.length > 1) {
    throw new UnsupportedProjectError(
      `Multiple global stylesheets are imported by ${app.layoutPath}.`,
      'Keep one static global CSS import or select and reconcile it with --stylesheet.',
    )
  }

  const optionPath =
    options.stylesheet === undefined
      ? undefined
      : projectPath(options.stylesheet, '--stylesheet')
  const manifestPath =
    options.manifestStylesheet === undefined
      ? undefined
      : projectPath(
          options.manifestStylesheet,
          '.frontprep.json paths.stylesheet',
        )

  if (
    optionPath !== undefined &&
    manifestPath !== undefined &&
    optionPath !== manifestPath
  ) {
    throw new UnsupportedProjectError(
      `--stylesheet selects ${optionPath}, but .frontprep.json selects ${manifestPath}.`,
      'Use the manifest path or remove the stale manifest before overriding it.',
    )
  }

  const imported = imports[0]
  if (imported !== undefined) {
    const importKind = imported.startsWith('.') ? 'relative' : 'alias'
    const path =
      importKind === 'relative'
        ? await resolveRelativeStylesheet(
            rootRealPath,
            app.layoutPath,
            imported,
          )
        : await resolveAliasedStylesheet(rootRealPath, imported)
    assertAgreement(optionPath, path, '--stylesheet')
    assertAgreement(manifestPath, path, '.frontprep.json paths.stylesheet')
    const source: PathSelectionSource =
      optionPath !== undefined
        ? 'option'
        : manifestPath !== undefined
          ? 'manifest'
          : 'detected'
    const stylesheet = Object.freeze({
      importKind,
      importSpecifier: imported,
      path,
      source,
    })
    return Object.freeze({
      ...app,
      stylesheet,
      stylesheetNeedsImport: false,
      stylesheetPath: path,
    })
  }

  const path =
    optionPath ?? manifestPath ?? projectPath(`${app.appDirectory}/globals.css`)
  const source: PathSelectionSource =
    optionPath !== undefined
      ? 'option'
      : manifestPath !== undefined
        ? 'manifest'
        : 'default'
  await assertSafeRegularOrMissing(rootRealPath, path, '--stylesheet')
  const stylesheet = Object.freeze({
    importKind: 'planned' as const,
    importSpecifier: relativeImport(app.layoutPath, path),
    path,
    source,
  })
  return Object.freeze({
    ...app,
    stylesheet,
    stylesheetNeedsImport: true,
    stylesheetPath: path,
  })
}
