import { execFile } from 'node:child_process'
import { lstat, readFile, realpath } from 'node:fs/promises'
import { isAbsolute, join, posix, relative, sep } from 'node:path'
import { promisify } from 'node:util'

import { parse as parseJsonc, type ParseError } from 'jsonc-parser'
import { minVersion, subset, validRange } from 'semver'
import { parse as parseYaml } from 'yaml'

import { detectNextApp } from '../adapters/next-app.js'
import { freezeProjectContext } from './context.js'
import { UnsupportedProjectError } from './errors.js'
import { loadPersistedManifest } from './manifest.js'
import { normalizeManifest } from './manifest-migration.js'
import { toProjectPath, type ProjectPath } from './paths.js'
import type {
  PackageJson,
  PathSelectionSource,
  ProjectContext,
  ProjectDetectionOptions,
} from './types.js'

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
  const supportedRange = `>=${major}.0.0 <${major + 1}.0.0-0`
  if (
    range === undefined ||
    validRange(range) === null ||
    !subset(range, supportedRange)
  ) {
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

interface ListedWorkspacePackage {
  readonly path?: string
}

function toPosixPath(value: string): string {
  return value.split(sep).join('/')
}

async function listedPackages(
  repositoryRoot: string,
  args: readonly string[],
): Promise<readonly ListedWorkspacePackage[]> {
  try {
    const result = await execFileAsync(
      'pnpm',
      [
        '--dir',
        repositoryRoot,
        ...args,
        'list',
        '--recursive',
        '--depth',
        '-1',
        '--json',
      ],
      { cwd: repositoryRoot, encoding: 'utf8' },
    )
    const value = JSON.parse(result.stdout) as unknown
    if (!Array.isArray(value)) throw new Error('expected an array')
    return value as ListedWorkspacePackage[]
  } catch (error) {
    throw new UnsupportedProjectError(
      'The selected --cwd is not a resolvable pnpm workspace package.',
      'Add the package to pnpm-workspace.yaml or select its exact directory with --cwd.',
      error,
    )
  }
}

async function workspacePackageManager(
  repositoryRoot: string,
  packageRoot: string,
  packageDirectory: ProjectPath,
): Promise<PackageJson> {
  let workspace: { packages?: unknown } | null
  let rootPackageJson: PackageJson
  try {
    workspace = parseYaml(
      await readFile(join(repositoryRoot, 'pnpm-workspace.yaml'), 'utf8'),
    ) as { packages?: unknown } | null
    rootPackageJson = parseJson<PackageJson>(
      await readFile(join(repositoryRoot, 'package.json'), 'utf8'),
      'workspace package.json',
    )
  } catch (error) {
    if (error instanceof UnsupportedProjectError) throw error
    throw new UnsupportedProjectError(
      'A nested --cwd requires repository-root package.json and pnpm-workspace.yaml.',
      'Create the pnpm workspace files or select a standalone Git root.',
      error,
    )
  }
  if (!Array.isArray(workspace?.packages) || workspace.packages.length === 0) {
    throw new UnsupportedProjectError(
      'pnpm-workspace.yaml must declare the selected workspace package.',
      'Add the package directory to pnpm-workspace.yaml.',
    )
  }

  const selected = await listedPackages(repositoryRoot, [
    '--filter',
    `./${packageDirectory}`,
    '--fail-if-no-match',
  ])
  const selectedRoots = await Promise.all(
    selected.flatMap(({ path }) =>
      typeof path === 'string' ? [realpath(path)] : [],
    ),
  )
  if (selectedRoots.length !== 1 || selectedRoots[0] !== packageRoot) {
    throw new UnsupportedProjectError(
      `pnpm did not resolve --cwd ${packageDirectory} to exactly one package.`,
      'Select the exact package directory and check pnpm-workspace.yaml.',
    )
  }

  const allPackages = await listedPackages(repositoryRoot, [])
  for (const listed of allPackages) {
    if (typeof listed.path !== 'string') continue
    const listedRoot = await realpath(listed.path)
    if (listedRoot === packageRoot) continue
    try {
      const metadata = await lstat(join(listedRoot, '.frontprep.json'))
      if (metadata.isFile() || metadata.isSymbolicLink()) {
        throw new UnsupportedProjectError(
          `Another workspace package is already managed by Frontprep: ${toPosixPath(relative(repositoryRoot, listedRoot))}.`,
          'Frontprep beta supports one managed workspace package per repository.',
        )
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
      throw error
    }
  }
  return rootPackageJson
}

function selectedPath(
  option: string | undefined,
  manifest: string | undefined,
  fallback: string,
  flag: '--test-dir' | '--utility-dir',
): { path: ProjectPath; source: PathSelectionSource } {
  let optionPath: ProjectPath | undefined
  let manifestPath: ProjectPath | undefined
  try {
    optionPath = option === undefined ? undefined : toProjectPath(option)
    manifestPath = manifest === undefined ? undefined : toProjectPath(manifest)
  } catch (error) {
    throw new UnsupportedProjectError(
      `${flag} and manifest paths must be safe project-relative POSIX paths.`,
      `Provide a valid ${flag} value or repair .frontprep.json.`,
      error,
    )
  }
  if (
    optionPath !== undefined &&
    manifestPath !== undefined &&
    optionPath !== manifestPath
  ) {
    throw new UnsupportedProjectError(
      `${flag} selects ${optionPath}, but .frontprep.json selects ${manifestPath}.`,
      'Use the manifest path or remove the stale manifest before overriding it.',
    )
  }
  return {
    path: optionPath ?? manifestPath ?? toProjectPath(fallback),
    source:
      optionPath !== undefined
        ? 'option'
        : manifestPath !== undefined
          ? 'manifest'
          : 'default',
  }
}

async function assertDirectoryOrMissing(
  root: string,
  path: ProjectPath,
  flag: '--test-dir' | '--utility-dir',
): Promise<void> {
  let current = root
  const segments = path.split('/')
  for (const [index, segment] of segments.entries()) {
    current = join(current, segment)
    try {
      const metadata = await lstat(current)
      if (metadata.isSymbolicLink()) {
        throw new UnsupportedProjectError(
          `${flag} contains a symbolic link: ${path}.`,
          `Choose a real directory with ${flag}.`,
        )
      }
      if (index < segments.length - 1 && !metadata.isDirectory()) {
        throw new UnsupportedProjectError(
          `${flag} contains a non-directory path component: ${path}.`,
          `Choose a valid directory with ${flag}.`,
        )
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
  }
  if (!(await lstat(join(root, path))).isDirectory()) {
    throw new UnsupportedProjectError(
      `${flag} must be a real directory or a missing directory: ${path}.`,
      `Choose a valid directory with ${flag}.`,
    )
  }
}

export async function detectProject(
  cwd: string,
  options: ProjectDetectionOptions = {},
): Promise<ProjectContext> {
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
  const rawPackageDirectory = toPosixPath(relative(gitRoot, root))
  if (isAbsolute(rawPackageDirectory) || rawPackageDirectory.startsWith('..')) {
    throw new UnsupportedProjectError(
      'The selected package must be inside the Git worktree root.',
    )
  }
  const packageDirectory =
    rawPackageDirectory === '' ? '.' : toProjectPath(rawPackageDirectory)
  const packageManagerOwner =
    packageDirectory === '.'
      ? packageJson
      : await workspacePackageManager(gitRoot, root, packageDirectory)

  const packageManagerMatch =
    /^pnpm@(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/u.exec(
      packageManagerOwner.packageManager ?? '',
    )
  if (
    packageManagerMatch?.[1] === undefined ||
    minVersion(packageManagerMatch[1])?.major !== 10
  ) {
    throw new UnsupportedProjectError('Frontprep requires pnpm 10.')
  }

  assertMajorVersion(directDependency(packageJson, 'next'), 16, 'Next.js 16')
  assertMajorVersion(
    directDependency(packageJson, 'typescript'),
    5,
    'TypeScript 5',
  )
  if (hasPackageWorkspaces(packageJson)) {
    throw new UnsupportedProjectError(
      'The selected application package cannot contain nested workspaces.',
    )
  }
  if (packageDirectory === '.') await assertSinglePackageWorkspace(root)

  const persisted = await loadPersistedManifest(root)
  const app = await detectNextApp(root, {
    manifestStylesheet: persisted?.paths.stylesheet,
    stylesheet: options.stylesheet,
  })
  const normalized = await normalizeManifest(root, persisted, {
    app: app.appDirectory,
    layout: app.layoutPath,
    stylesheet: app.stylesheetPath,
  })
  const manifest = normalized.manifest
  if (
    manifest !== null &&
    (manifest.paths.app !== app.appDirectory ||
      manifest.paths.layout !== app.layoutPath)
  ) {
    throw new UnsupportedProjectError(
      'The App Router root does not match .frontprep.json.',
      'Restore the recorded layout or remove the stale manifest before continuing.',
    )
  }
  if (
    manifest !== null &&
    (manifest.roots.package !== packageDirectory ||
      manifest.roots.workspace !== '.')
  ) {
    throw new UnsupportedProjectError(
      'The selected package root does not match .frontprep.json.',
      'Run with the recorded --cwd or remove the stale manifest.',
    )
  }

  const sourcePrefix = app.sourceDirectory === null ? '' : 'src/'
  const utilities = selectedPath(
    options.utilityDirectory,
    manifest?.paths.utilities,
    `${sourcePrefix}shared/lib`,
    '--utility-dir',
  )
  const tests = selectedPath(
    options.testDirectory,
    manifest?.paths.test,
    `${sourcePrefix}test`,
    '--test-dir',
  )
  await assertDirectoryOrMissing(root, utilities.path, '--utility-dir')
  await assertDirectoryOrMissing(root, tests.path, '--test-dir')

  const testSetupPath =
    tests.source === 'manifest'
      ? toProjectPath(manifest!.paths.testSetup)
      : toProjectPath(posix.join(tests.path, 'setup.ts'))
  if (posix.dirname(testSetupPath) !== tests.path) {
    throw new UnsupportedProjectError(
      '.frontprep.json testSetup must be inside the selected test directory.',
      'Repair or remove the stale manifest before continuing.',
    )
  }
  const layout = {
    appDirectory: app.appDirectory,
    layoutPath: app.layoutPath,
    sourceDirectory: app.sourceDirectory,
    stylesheet: app.stylesheet,
    utilities,
    tests,
    testSetupPath,
  }
  return freezeProjectContext({
    ...app,
    adapter: 'next-app',
    layout,
    manifest,
    manifestNeedsMigration: normalized.needsMigration,
    packageDirectory,
    packageJson,
    packageJsonPath,
    packageManager: { name: 'pnpm', version: packageManagerMatch[1] },
    packageRoot: root,
    repositoryRoot: gitRoot,
    root,
    workspaceRoot: gitRoot,
  })
}
