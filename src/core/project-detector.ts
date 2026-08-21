import { execFile } from 'node:child_process'
import { readFile, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { parse as parseJsonc, type ParseError } from 'jsonc-parser'
import { minVersion } from 'semver'
import { parse as parseYaml } from 'yaml'

import { detectNextApp } from '../adapters/next-app.js'
import { freezeProjectContext } from './context.js'
import { UnsupportedProjectError } from './errors.js'
import { loadManifest } from './manifest.js'
import type { PackageJson, ProjectContext } from './types.js'

const execFileAsync = promisify(execFile)

function parseJson<T>(contents: string, label: string): T {
  try {
    return JSON.parse(contents) as T
  } catch (error) {
    throw new UnsupportedProjectError(
      `${label} is not valid JSON.`,
      undefined,
      error,
    )
  }
}

function parseTsConfig(contents: string): void {
  const errors: ParseError[] = []
  parseJsonc(contents, errors, { allowTrailingComma: true })
  if (errors.length > 0) {
    throw new UnsupportedProjectError('tsconfig.json is not valid JSONC.')
  }
}

function directDependency(
  packageJson: PackageJson,
  name: string,
): string | undefined {
  return packageJson.dependencies?.[name] ?? packageJson.devDependencies?.[name]
}

function assertMajorVersion(
  range: string | undefined,
  major: number,
  label: string,
): void {
  const minimum = range === undefined ? null : minVersion(range)
  if (minimum?.major !== major) {
    throw new UnsupportedProjectError(
      `${label} is required. Expected major version ${major}.`,
    )
  }
}

function hasPackageWorkspaces(packageJson: PackageJson): boolean {
  if (Array.isArray(packageJson.workspaces)) {
    return packageJson.workspaces.length > 0
  }
  return (packageJson.workspaces?.packages?.length ?? 0) > 0
}

async function assertSinglePackageWorkspace(root: string): Promise<void> {
  try {
    const contents = await readFile(join(root, 'pnpm-workspace.yaml'), 'utf8')
    const workspace = parseYaml(contents) as { packages?: unknown } | null
    if (Array.isArray(workspace?.packages) && workspace.packages.length > 0) {
      throw new UnsupportedProjectError(
        'Frontprep v1 requires a single application repository.',
      )
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return
    }
    if (error instanceof UnsupportedProjectError) {
      throw error
    }
    throw new UnsupportedProjectError(
      'pnpm-workspace.yaml could not be parsed.',
      undefined,
      error,
    )
  }
}

export async function detectProject(cwd: string): Promise<ProjectContext> {
  let root: string
  try {
    root = await realpath(cwd)
  } catch (error) {
    throw new UnsupportedProjectError(
      `Project directory does not exist: ${cwd}`,
      undefined,
      error,
    )
  }

  const packageJsonPath = join(root, 'package.json')
  let packageJson: PackageJson
  try {
    packageJson = parseJson<PackageJson>(
      await readFile(packageJsonPath, 'utf8'),
      'package.json',
    )
    parseTsConfig(await readFile(join(root, 'tsconfig.json'), 'utf8'))
  } catch (error) {
    if (error instanceof UnsupportedProjectError) {
      throw error
    }
    throw new UnsupportedProjectError(
      'A package.json and tsconfig.json are required at the project root.',
      undefined,
      error,
    )
  }

  let gitRoot: string
  try {
    const result = await execFileAsync(
      'git',
      ['rev-parse', '--show-toplevel'],
      {
        cwd: root,
        encoding: 'utf8',
      },
    )
    gitRoot = await realpath(result.stdout.trim())
  } catch (error) {
    throw new UnsupportedProjectError(
      'The project root must be a Git worktree root.',
      undefined,
      error,
    )
  }
  if (gitRoot !== root) {
    throw new UnsupportedProjectError(
      'The package root must match the Git worktree root.',
    )
  }

  const packageManagerMatch =
    /^pnpm@(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/u.exec(
      packageJson.packageManager ?? '',
    )
  if (
    packageManagerMatch?.[1] === undefined ||
    minVersion(packageManagerMatch[1])?.major !== 10
  ) {
    throw new UnsupportedProjectError('Frontprep v1 requires pnpm 10.')
  }

  assertMajorVersion(directDependency(packageJson, 'next'), 16, 'Next.js 16')
  assertMajorVersion(
    directDependency(packageJson, 'typescript'),
    5,
    'TypeScript 5',
  )
  if (hasPackageWorkspaces(packageJson)) {
    throw new UnsupportedProjectError(
      'Frontprep v1 requires a single application repository.',
    )
  }
  await assertSinglePackageWorkspace(root)

  const app = await detectNextApp(root)
  const manifest = await loadManifest(root)
  return freezeProjectContext({
    ...app,
    adapter: 'next-app',
    manifest,
    packageJson,
    packageJsonPath,
    packageManager: { name: 'pnpm', version: packageManagerMatch[1] },
    root,
  })
}
