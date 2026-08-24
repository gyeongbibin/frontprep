import { lstat, readdir } from 'node:fs/promises'
import { join, posix } from 'node:path'

import { intersects, validRange } from 'semver'

import { ConflictError } from '../core/errors.js'
import { FileSystem, type FileSnapshot } from '../core/filesystem.js'
import {
  hasHuskyDispatcher,
  readLocalHooksPath,
  resolveDefaultHooksDirectory,
} from '../core/git-hooks.js'
import {
  dependencyIntent,
  executableFileIntent,
  managedFileIntent,
  scriptIntent,
  type ChangeIntent,
} from '../core/intents.js'
import { toProjectPath } from '../core/paths.js'
import type { ProjectContext } from '../core/types.js'
import type {
  SetupModule,
  VerificationIssue,
  VerificationResult,
} from './types.js'

const MODULE_ID = 'git-hooks' as const

const DEVELOPMENT_DEPENDENCIES = Object.freeze([
  ['@commitlint/cli', '^21.2.0'],
  ['@commitlint/config-conventional', '^21.2.0'],
  ['husky', '^9.1.0'],
  ['lint-staged', '^17.3.0'],
] as const)

const PRE_COMMIT = 'pnpm exec lint-staged\n'
const COMMIT_MSG = 'pnpm exec commitlint --edit "$1"\n'
const LINT_STAGED_CONFIG = `export default {
  '*.{cjs,cts,js,jsx,mjs,mts,ts,tsx}': ['eslint --fix', 'prettier --write'],
  '*.{css,json,jsonc,md,mdx,yaml,yml}': 'prettier --write',
}
`
const COMMITLINT_CONFIG = `export default {
  extends: ['@commitlint/config-conventional'],
}
`

const CANONICAL_FILES = Object.freeze([
  ['.husky/pre-commit', PRE_COMMIT, 0o755, 'pre-commit hook'],
  ['.husky/commit-msg', COMMIT_MSG, 0o755, 'commit-msg hook'],
  [
    'lint-staged.config.mjs',
    LINT_STAGED_CONFIG,
    0o644,
    'lint-staged configuration',
  ],
  [
    'commitlint.config.mjs',
    COMMITLINT_CONFIG,
    0o644,
    'commitlint configuration',
  ],
] as const)

const ALTERNATE_ROOT_CONFIGS = Object.freeze([
  ['.commitlintrc', 'commitlint configuration'],
  ['.commitlintrc.cjs', 'commitlint configuration'],
  ['.commitlintrc.js', 'commitlint configuration'],
  ['.commitlintrc.json', 'commitlint configuration'],
  ['.commitlintrc.mjs', 'commitlint configuration'],
  ['.commitlintrc.yaml', 'commitlint configuration'],
  ['.commitlintrc.yml', 'commitlint configuration'],
  ['.lintstagedrc', 'lint-staged configuration'],
  ['.lintstagedrc.cjs', 'lint-staged configuration'],
  ['.lintstagedrc.js', 'lint-staged configuration'],
  ['.lintstagedrc.json', 'lint-staged configuration'],
  ['.lintstagedrc.mjs', 'lint-staged configuration'],
  ['.lintstagedrc.yaml', 'lint-staged configuration'],
  ['.lintstagedrc.yml', 'lint-staged configuration'],
  ['commitlint.config.cjs', 'commitlint configuration'],
  ['commitlint.config.cts', 'commitlint configuration'],
  ['commitlint.config.js', 'commitlint configuration'],
  ['commitlint.config.mts', 'commitlint configuration'],
  ['commitlint.config.ts', 'commitlint configuration'],
  ['lint-staged.config.cjs', 'lint-staged configuration'],
  ['lint-staged.config.cts', 'lint-staged configuration'],
  ['lint-staged.config.js', 'lint-staged configuration'],
  ['lint-staged.config.mts', 'lint-staged configuration'],
  ['lint-staged.config.ts', 'lint-staged configuration'],
] as const)

const COMPETING_DEPENDENCIES = Object.freeze([
  '@evilmartians/lefthook',
  'lefthook',
  'pre-commit',
  'simple-git-hooks',
])

const COMPETING_ROOT_CONFIGS = Object.freeze([
  '.lefthook.yaml',
  '.lefthook.yml',
  '.pre-commit-config.yaml',
  '.pre-commit-config.yml',
  'lefthook.yaml',
  'lefthook.yml',
])

const PACKAGE_CONFIG_KEYS = Object.freeze([
  'commitlint',
  'lint-staged',
  ...COMPETING_DEPENDENCIES,
])

const IGNORED_SCAN_DIRECTORIES = new Set([
  '.git',
  '.next',
  '.turbo',
  '.worktrees',
  'build',
  'coverage',
  'dist',
  'node_modules',
  'out',
])

const RECOGNIZED_PREPARE_STAGES = new Set([
  'husky',
  'pnpm husky',
  'pnpm exec husky',
  'pnpm run frontprep:prepare',
])

export interface GitHooksAnalysis {
  readonly integratePrepare: boolean
}

function issue(message: string, path: string): VerificationIssue {
  return { message, moduleId: MODULE_ID, path }
}

function conflictIssue(label: string, path: string): VerificationIssue {
  return issue(`${label} conflicts at ${path}.`, path)
}

function sortedIssues(
  issues: readonly VerificationIssue[],
): readonly VerificationIssue[] {
  return Object.freeze(
    [...issues].sort(
      (left, right) =>
        (left.path ?? '').localeCompare(right.path ?? '') ||
        left.message.localeCompare(right.message),
    ),
  )
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

function declaredDependency(
  context: ProjectContext,
  name: string,
): string | undefined {
  return (
    context.packageJson.dependencies?.[name] ??
    context.packageJson.devDependencies?.[name]
  )
}

function recognizedPrepareStages(command: string | undefined): string[] {
  return (command?.split(' && ') ?? []).filter((stage) =>
    RECOGNIZED_PREPARE_STAGES.has(stage),
  )
}

function isLintStagedConfig(name: string): boolean {
  return (
    name.startsWith('lint-staged.config.') ||
    name === '.lintstagedrc' ||
    name.startsWith('.lintstagedrc.')
  )
}

async function canonicalOwnershipIssues(
  context: ProjectContext,
): Promise<readonly VerificationIssue[]> {
  const issues: VerificationIssue[] = []
  const fileSystem = new FileSystem(context.root)
  for (const [path, contents, mode, label] of CANONICAL_FILES) {
    if (path.includes('/')) {
      const parent = path.slice(0, path.lastIndexOf('/'))
      try {
        const metadata = await lstat(join(context.root, parent))
        if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
          issues.push(conflictIssue(label, path))
          continue
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          issues.push(conflictIssue(label, path))
          continue
        }
      }
    }
    const snapshot = await safeSnapshot(fileSystem, path)
    if (snapshot?.exists === false) continue
    if (
      snapshot !== null &&
      snapshot.bytes?.equals(Buffer.from(contents)) &&
      snapshot.mode === mode
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
    issues.push(conflictIssue(label, path))
  }
  return sortedIssues(issues)
}

async function rootConfigurationIssues(
  context: ProjectContext,
): Promise<readonly VerificationIssue[]> {
  const issues: VerificationIssue[] = []
  const fileSystem = new FileSystem(context.root)
  for (const [path, label] of ALTERNATE_ROOT_CONFIGS) {
    const snapshot = await safeSnapshot(fileSystem, path)
    if (snapshot === null || snapshot.exists) {
      issues.push(conflictIssue(label, path))
    }
  }
  for (const path of COMPETING_ROOT_CONFIGS) {
    const snapshot = await safeSnapshot(fileSystem, path)
    if (snapshot === null || snapshot.exists) {
      issues.push(conflictIssue('hook manager configuration', path))
    }
  }
  for (const key of PACKAGE_CONFIG_KEYS) {
    if (Object.hasOwn(context.packageJson, key)) {
      issues.push(
        conflictIssue(
          key === 'lint-staged' || key === 'commitlint'
            ? `${key} configuration`
            : 'hook manager configuration',
          `package.json#${key}`,
        ),
      )
    }
  }
  for (const name of COMPETING_DEPENDENCIES) {
    if (declaredDependency(context, name) !== undefined) {
      issues.push(
        conflictIssue('hook manager dependency', `package.json#${name}`),
      )
    }
  }
  return sortedIssues(issues)
}

async function nestedLintStagedIssues(
  context: ProjectContext,
): Promise<readonly VerificationIssue[]> {
  const issues: VerificationIssue[] = []
  const directories = ['']
  const fileSystem = new FileSystem(context.root)
  while (directories.length > 0) {
    const directory = directories.shift()!
    let entries
    try {
      entries = await readdir(join(context.root, directory), {
        withFileTypes: true,
      })
    } catch {
      issues.push(
        issue(
          'Git Hooks configuration directory could not be inspected.',
          directory || '.',
        ),
      )
      continue
    }
    entries.sort((left, right) => left.name.localeCompare(right.name))
    for (const entry of entries) {
      const projectPath = posix.join(directory, entry.name)
      if (entry.isDirectory()) {
        if (!IGNORED_SCAN_DIRECTORIES.has(entry.name)) {
          directories.push(projectPath)
        }
        continue
      }
      if (directory === '') continue
      if (isLintStagedConfig(entry.name)) {
        issues.push(conflictIssue('lint-staged configuration', projectPath))
        continue
      }
      if (entry.name !== 'package.json') continue
      if (entry.isSymbolicLink()) {
        issues.push(
          issue(
            'Nested package configuration could not be inspected.',
            projectPath,
          ),
        )
        continue
      }
      if (!entry.isFile()) continue
      try {
        const bytes = await fileSystem.read(toProjectPath(projectPath))
        const packageJson = JSON.parse(
          bytes?.toString('utf8') ?? '{}',
        ) as Record<string, unknown>
        if (Object.hasOwn(packageJson, 'lint-staged')) {
          issues.push(
            conflictIssue(
              'lint-staged configuration',
              `${projectPath}#lint-staged`,
            ),
          )
        }
      } catch {
        issues.push(
          issue(
            'Nested package configuration could not be inspected.',
            projectPath,
          ),
        )
      }
    }
  }
  return sortedIssues(issues)
}

async function gitConfigurationIssues(
  context: ProjectContext,
  requireActive: boolean,
): Promise<readonly VerificationIssue[]> {
  const issues: VerificationIssue[] = []
  let hooksPath: string | null
  try {
    hooksPath = await readLocalHooksPath(context.root)
  } catch {
    return Object.freeze([
      issue('Git core.hooksPath could not be inspected.', '.git/config'),
    ])
  }
  if (hooksPath !== null && hooksPath !== '.husky/_') {
    issues.push(issue('Git core.hooksPath must be .husky/_.', '.git/config'))
    return sortedIssues(issues)
  }
  if (hooksPath === '.husky/_') return Object.freeze([])
  if (requireActive) {
    issues.push(issue('Git core.hooksPath must be .husky/_.', '.git/config'))
  }

  let directory: string
  try {
    directory = await resolveDefaultHooksDirectory(context.root)
  } catch {
    return Object.freeze([
      issue('Git default hooks directory could not be resolved.', '.git/hooks'),
    ])
  }
  try {
    const entries = await readdir(directory, { withFileTypes: true })
    entries.sort((left, right) => left.name.localeCompare(right.name))
    for (const entry of entries) {
      if (entry.name.endsWith('.sample')) continue
      if (entry.isFile() || entry.isSymbolicLink()) {
        issues.push(
          conflictIssue('Git default hook', `.git/hooks/${entry.name}`),
        )
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      issues.push(
        issue(
          'Git default hooks directory could not be inspected.',
          '.git/hooks',
        ),
      )
    }
  }
  return sortedIssues(issues)
}

async function configurationIssues(
  context: ProjectContext,
  includeCanonicalOwnership: boolean,
  requireActive: boolean,
): Promise<readonly VerificationIssue[]> {
  const groups = await Promise.all([
    rootConfigurationIssues(context),
    nestedLintStagedIssues(context),
    gitConfigurationIssues(context, requireActive),
    includeCanonicalOwnership
      ? canonicalOwnershipIssues(context)
      : Promise.resolve([]),
  ])
  return sortedIssues(groups.flat())
}

function createIntents(analysis: GitHooksAnalysis): readonly ChangeIntent[] {
  const intents: ChangeIntent[] = [
    ...DEVELOPMENT_DEPENDENCIES.map(([name, range]) =>
      dependencyIntent(
        MODULE_ID,
        'devDependencies',
        name,
        range,
        `Git Hooks requires ${name}.`,
      ),
    ),
    scriptIntent(
      MODULE_ID,
      'frontprep:prepare',
      'husky',
      'owned',
      'Git Hooks owns deterministic Husky activation.',
    ),
  ]
  if (analysis.integratePrepare) {
    intents.push(
      scriptIntent(
        MODULE_ID,
        'prepare',
        'pnpm run frontprep:prepare',
        'append-once',
        'Git Hooks activates Husky after normal dependency installation.',
      ),
    )
  }
  intents.push(
    executableFileIntent(
      MODULE_ID,
      '.husky/pre-commit',
      PRE_COMMIT,
      'Git Hooks runs lint-staged before commits.',
    ),
    executableFileIntent(
      MODULE_ID,
      '.husky/commit-msg',
      COMMIT_MSG,
      'Git Hooks validates commit messages.',
    ),
    managedFileIntent(
      MODULE_ID,
      'lint-staged.config.mjs',
      LINT_STAGED_CONFIG,
      0o644,
      'Git Hooks owns staged-file tasks.',
    ),
    managedFileIntent(
      MODULE_ID,
      'commitlint.config.mjs',
      COMMITLINT_CONFIG,
      0o644,
      'Git Hooks owns the Conventional Commits policy.',
    ),
  )
  return Object.freeze(intents)
}

function verificationResult(
  issues: readonly VerificationIssue[],
): VerificationResult {
  return Object.freeze({
    issues: sortedIssues(issues),
    valid: issues.length === 0,
  })
}

export const gitHooksModule: SetupModule<GitHooksAnalysis> = Object.freeze({
  id: MODULE_ID,
  version: '1.0.0',
  async analyze(context: ProjectContext): Promise<GitHooksAnalysis> {
    const stages = recognizedPrepareStages(context.packageJson.scripts?.prepare)
    if (stages.length > 1) {
      throw new ConflictError(
        'Prepare script contains multiple Husky activation stages.',
        'package.json',
        MODULE_ID,
      )
    }
    const conflicts = await configurationIssues(context, true, false)
    const first = conflicts[0]
    if (first !== undefined) {
      throw new ConflictError(first.message, first.path, MODULE_ID)
    }
    return Object.freeze({ integratePrepare: stages.length === 0 })
  },
  async plan(
    _context: ProjectContext,
    analysis: GitHooksAnalysis,
  ): Promise<readonly ChangeIntent[]> {
    return createIntents(analysis)
  },
  async verify(context: ProjectContext): Promise<VerificationResult> {
    const issues: VerificationIssue[] = [
      ...(await configurationIssues(context, false, true)),
    ]
    for (const [name, expected] of DEVELOPMENT_DEPENDENCIES) {
      const actual = declaredDependency(context, name)
      if (
        actual === undefined ||
        validRange(actual) === null ||
        !intersects(actual, expected)
      ) {
        issues.push(
          issue(`Dependency ${name} must satisfy ${expected}.`, 'package.json'),
        )
      }
    }

    if (context.packageJson.scripts?.['frontprep:prepare'] !== 'husky') {
      issues.push(
        issue(
          'Frontprep-owned script frontprep:prepare is missing or changed.',
          'package.json',
        ),
      )
    }
    if (
      recognizedPrepareStages(context.packageJson.scripts?.prepare).length !== 1
    ) {
      issues.push(
        issue(
          'Prepare script must contain exactly one recognized Husky stage.',
          'package.json',
        ),
      )
    }

    const fileSystem = new FileSystem(context.root)
    for (const [path, contents, mode, label] of CANONICAL_FILES) {
      const snapshot = await safeSnapshot(fileSystem, path)
      if (
        snapshot === null ||
        !snapshot.exists ||
        !snapshot.bytes?.equals(Buffer.from(contents)) ||
        snapshot.mode !== mode
      ) {
        issues.push(issue(`Managed ${label} is missing or changed.`, path))
      }
    }
    if (!(await hasHuskyDispatcher(context.root))) {
      issues.push(issue('Husky dispatcher is missing or unsafe.', '.husky/_/h'))
    }
    return verificationResult(issues)
  },
})
