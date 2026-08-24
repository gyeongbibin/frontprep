import { lstat, readdir } from 'node:fs/promises'
import { join, posix } from 'node:path'

import { intersects, validRange } from 'semver'

import {
  dependencyIntent,
  managedFileIntent,
  scriptIntent,
  type ChangeIntent,
  type ScriptPolicy,
} from '../core/intents.js'
import { ConflictError } from '../core/errors.js'
import { FileSystem, type FileSnapshot } from '../core/filesystem.js'
import { toProjectPath } from '../core/paths.js'
import type { ProjectContext } from '../core/types.js'
import type {
  SetupModule,
  VerificationIssue,
  VerificationResult,
} from './types.js'

const MODULE_ID = 'test' as const

const DEVELOPMENT_DEPENDENCIES = Object.freeze([
  ['@testing-library/dom', '^10.0.0'],
  ['@testing-library/jest-dom', '>=6.0.0 <6.10.0'],
  ['@testing-library/react', '^16.0.0'],
  ['@vitejs/plugin-react', '^4.7.0'],
  ['jsdom', '^26.0.0'],
  ['vite', '^6.0.0'],
  ['vite-tsconfig-paths', '^6.0.0'],
  ['vitest', '^4.0.0'],
] as const)

const SCRIPTS = Object.freeze([
  ['frontprep:test', 'vitest run', 'owned'],
  ['frontprep:check', 'pnpm run frontprep:test', 'append-once'],
  ['test', 'vitest', 'preserve-existing'],
  ['test:run', 'vitest run', 'preserve-existing'],
] as const satisfies readonly (readonly [string, string, ScriptPolicy])[])

const JEST_DEPENDENCIES = Object.freeze([
  '@jest/core',
  '@swc/jest',
  '@types/jest',
  'babel-jest',
  'jest',
  'jest-environment-jsdom',
  'ts-jest',
])

const TEST_SETUP = `import '@testing-library/jest-dom/vitest'
import { cleanup } from '@testing-library/react'
import { afterEach } from 'vitest'

afterEach(() => {
  cleanup()
})
`

export interface TestAnalysis {
  readonly setupDirectory: string
  readonly setupPath: string
}

function renderVitestConfig(setupPath: string): string {
  return `import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'
import tsconfigPaths from 'vite-tsconfig-paths'

export default defineConfig({
  plugins: [tsconfigPaths(), react()],
  test: {
    environment: 'jsdom',
    passWithNoTests: true,
    setupFiles: ['./${setupPath}'],
  },
})
`
}

async function safeSnapshot(
  fileSystem: FileSystem,
  path: string,
): Promise<FileSnapshot | null> {
  try {
    return await fileSystem.snapshot(toProjectPath(path))
  } catch {
    return null
  }
}

function configurationIssue(
  label: string,
  displayPath: string,
  path: string = displayPath,
): VerificationIssue {
  return {
    message: `${label} conflicts at ${displayPath}.`,
    path,
  }
}

async function configurationConflicts(
  context: ProjectContext,
  analysis: TestAnalysis,
  includeCanonicalOwnershipConflicts: boolean,
): Promise<readonly VerificationIssue[]> {
  const issues: VerificationIssue[] = []
  try {
    const entries = await readdir(context.root, { withFileTypes: true })
    entries.sort((left, right) => left.name.localeCompare(right.name))
    for (const entry of entries) {
      if (
        entry.name.startsWith('vitest.config.') &&
        entry.name !== 'vitest.config.mts'
      ) {
        issues.push(configurationIssue('Vitest configuration', entry.name))
      } else if (entry.name.startsWith('vitest.workspace.')) {
        issues.push(
          configurationIssue('Vitest workspace configuration', entry.name),
        )
      } else if (entry.name.startsWith('jest.config.')) {
        issues.push(configurationIssue('Jest configuration', entry.name))
      }
    }
  } catch {
    issues.push({
      message: 'Test configuration directory could not be inspected.',
      path: '.',
    })
  }

  if (Object.hasOwn(context.packageJson, 'jest')) {
    issues.push(
      configurationIssue(
        'Jest configuration',
        'package.json#jest',
        'package.json',
      ),
    )
  }
  for (const name of JEST_DEPENDENCIES) {
    const section =
      context.packageJson.dependencies?.[name] !== undefined
        ? 'dependencies'
        : context.packageJson.devDependencies?.[name] !== undefined
          ? 'devDependencies'
          : null
    if (section !== null) {
      issues.push(
        configurationIssue(
          'Jest dependency',
          `package.json#${section}.${name}`,
          'package.json',
        ),
      )
    }
  }

  if (includeCanonicalOwnershipConflicts) {
    const fileSystem = new FileSystem(context.root)
    for (const [path, label, expected] of [
      [
        'vitest.config.mts',
        'Vitest configuration',
        renderVitestConfig(analysis.setupPath),
      ],
      [analysis.setupPath, 'Test setup', TEST_SETUP],
    ] as const) {
      const snapshot = await safeSnapshot(fileSystem, path)
      if (snapshot?.exists === false) continue
      if (
        snapshot !== null &&
        snapshot.bytes?.equals(Buffer.from(expected)) &&
        snapshot.mode === 0o644
      ) {
        continue
      }
      const recorded = context.manifest?.files[path]
      if (
        snapshot !== null &&
        recorded?.ownership === 'managed' &&
        recorded.hash === snapshot.hash
      ) {
        continue
      }
      issues.push(configurationIssue(label, path))
    }
  }
  return Object.freeze(issues)
}

function declaredDependency(
  context: ProjectContext,
  name: string,
): string | undefined {
  return (
    context.packageJson.dependencies?.[name] ??
    context.packageJson.devDependencies?.[name]
  )
}

function hasTestCheckStages(command: string | undefined): boolean {
  const qualityStage = 'pnpm run frontprep:quality'
  const testStage = 'pnpm run frontprep:test'
  const stages = command?.split(' && ') ?? []
  return (
    stages[0] === qualityStage &&
    stages[1] === testStage &&
    stages.filter((stage) => stage === qualityStage).length === 1 &&
    stages.filter((stage) => stage === testStage).length === 1
  )
}

function verificationResult(
  issues: readonly VerificationIssue[],
): VerificationResult {
  return Object.freeze({
    issues: Object.freeze([...issues]),
    valid: issues.length === 0,
  })
}

function setupCandidates(context: ProjectContext): readonly string[] {
  return Object.freeze(
    ['test', 'tests'].map((path) =>
      context.sourceDirectory === null
        ? path
        : posix.join(context.sourceDirectory, path),
    ),
  )
}

async function pathMetadata(
  root: string,
  path: string,
): Promise<'directory' | 'missing' | 'other'> {
  try {
    const metadata = await lstat(join(root, path))
    return metadata.isDirectory() && !metadata.isSymbolicLink()
      ? 'directory'
      : 'other'
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing'
    return 'other'
  }
}

async function symbolicLinkComponent(
  root: string,
  path: string,
): Promise<string | null> {
  let current = root
  const traversed: string[] = []
  for (const segment of path.split('/')) {
    traversed.push(segment)
    current = join(current, segment)
    try {
      if ((await lstat(current)).isSymbolicLink()) {
        return traversed.join('/')
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      const inspectedPath = traversed.join('/')
      throw new ConflictError(
        `Test path could not be inspected: ${inspectedPath}.`,
        inspectedPath,
        MODULE_ID,
      )
    }
  }
  return null
}

async function selectSetupDirectory(context: ProjectContext): Promise<string> {
  const existing: string[] = []
  for (const candidate of setupCandidates(context)) {
    const linkedComponent = await symbolicLinkComponent(context.root, candidate)
    if (linkedComponent !== null) {
      throw new ConflictError(
        `Test path contains a symbolic link: ${linkedComponent}.`,
        linkedComponent,
        MODULE_ID,
      )
    }
    const metadata = await pathMetadata(context.root, candidate)
    if (metadata === 'other') {
      throw new ConflictError(
        `Test path must be a real directory: ${candidate}.`,
        candidate,
        MODULE_ID,
      )
    }
    if (metadata === 'directory') existing.push(candidate)
  }
  if (existing.length > 1) {
    throw new ConflictError(
      `Multiple test directories were detected: ${existing.join(', ')}.`,
      existing[0],
      MODULE_ID,
    )
  }
  return existing[0] ?? setupCandidates(context)[0]!
}

function createAnalysis(setupDirectory: string): TestAnalysis {
  return Object.freeze({
    setupDirectory,
    setupPath: posix.join(setupDirectory, 'setup.ts'),
  })
}

function createIntents(analysis: TestAnalysis): readonly ChangeIntent[] {
  return Object.freeze([
    ...DEVELOPMENT_DEPENDENCIES.map(([name, range]) =>
      dependencyIntent(
        MODULE_ID,
        'devDependencies',
        name,
        range,
        `Test requires ${name}.`,
      ),
    ),
    ...SCRIPTS.map(([name, command, policy]) =>
      scriptIntent(
        MODULE_ID,
        name,
        command,
        policy,
        `Test provides the ${name} script.`,
      ),
    ),
    managedFileIntent(
      MODULE_ID,
      'vitest.config.mts',
      renderVitestConfig(analysis.setupPath),
      0o644,
      'Test owns the Vitest configuration.',
    ),
    managedFileIntent(
      MODULE_ID,
      analysis.setupPath,
      TEST_SETUP,
      0o644,
      'Test owns the React Testing Library setup.',
    ),
  ])
}

export const testModule: SetupModule<TestAnalysis> = Object.freeze({
  id: MODULE_ID,
  version: '1.0.0',
  async analyze(context: ProjectContext): Promise<TestAnalysis> {
    const analysis = createAnalysis(await selectSetupDirectory(context))
    const conflicts = await configurationConflicts(context, analysis, true)
    const first = conflicts[0]
    if (first !== undefined) {
      throw new ConflictError(first.message, first.path, MODULE_ID)
    }
    return analysis
  },
  async plan(
    _context: ProjectContext,
    analysis: TestAnalysis,
  ): Promise<readonly ChangeIntent[]> {
    return createIntents(analysis)
  },
  async verify(context: ProjectContext): Promise<VerificationResult> {
    const issues: VerificationIssue[] = []
    let analysis: TestAnalysis
    try {
      analysis = createAnalysis(await selectSetupDirectory(context))
    } catch (error) {
      issues.push({
        message:
          error instanceof Error
            ? error.message
            : 'Test setup path could not be verified.',
        path: context.sourceDirectory ?? '.',
      })
      analysis = createAnalysis(setupCandidates(context)[0]!)
    }
    issues.push(...(await configurationConflicts(context, analysis, false)))

    for (const [name, expected] of DEVELOPMENT_DEPENDENCIES) {
      const actual = declaredDependency(context, name)
      if (
        actual === undefined ||
        validRange(actual) === null ||
        !intersects(actual, expected)
      ) {
        issues.push({
          message: `Dependency ${name} must satisfy ${expected}.`,
          path: 'package.json',
        })
      }
    }

    for (const [name, command, policy] of SCRIPTS) {
      const actual = context.packageJson.scripts?.[name]
      if (name === 'frontprep:check') {
        if (!hasTestCheckStages(actual)) {
          issues.push({
            message:
              'Frontprep-owned script frontprep:check is missing or changed.',
            path: 'package.json',
          })
        }
      } else if (policy === 'owned' && actual !== command) {
        issues.push({
          message: `Frontprep-owned script ${name} is missing or changed.`,
          path: 'package.json',
        })
      } else if (policy === 'preserve-existing' && actual === undefined) {
        issues.push({
          message: `Conventional script ${name} is missing.`,
          path: 'package.json',
        })
      }
    }

    const fileSystem = new FileSystem(context.root)
    for (const [path, expected, message] of [
      [
        'vitest.config.mts',
        renderVitestConfig(analysis.setupPath),
        'Managed Vitest configuration is missing or changed.',
      ],
      [
        analysis.setupPath,
        TEST_SETUP,
        'Managed Test setup is missing or changed.',
      ],
    ] as const) {
      const snapshot = await safeSnapshot(fileSystem, path)
      if (
        snapshot === null ||
        !snapshot.exists ||
        !snapshot.bytes?.equals(Buffer.from(expected)) ||
        snapshot.mode !== 0o644
      ) {
        issues.push({ message, path })
      }
    }
    return verificationResult(issues)
  },
})
