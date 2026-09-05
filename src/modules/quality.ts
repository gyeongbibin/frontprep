import { readdir } from 'node:fs/promises'
import { join, posix } from 'node:path'

import { intersects, validRange } from 'semver'

import {
  configFragmentIntent,
  dependencyIntent,
  lineSetIntent,
  managedFileIntent,
  scriptIntent,
  type ChangeIntent,
  type ConfigValue,
  type ScriptPolicy,
} from '../core/intents.js'
import { composePrettierConfig } from '../core/composers/prettier.js'
import { ConflictError } from '../core/errors.js'
import { FileSystem, type FileSnapshot } from '../core/filesystem.js'
import { toProjectPath } from '../core/paths.js'
import { manifestFile, scopedProjectPath } from '../core/scoped-paths.js'
import type { ProjectContext } from '../core/types.js'
import type {
  SetupModule,
  VerificationIssue,
  VerificationResult,
} from './types.js'

const MODULE_ID = 'quality' as const

const ALTERNATE_CONFIGS = Object.freeze([
  ['eslint.config.js', 'ESLint'],
  ['eslint.config.cjs', 'ESLint'],
  ['eslint.config.ts', 'ESLint'],
  ['eslint.config.mts', 'ESLint'],
  ['eslint.config.cts', 'ESLint'],
  ['.eslintrc', 'ESLint'],
  ['.eslintrc.js', 'ESLint'],
  ['.eslintrc.cjs', 'ESLint'],
  ['.eslintrc.json', 'ESLint'],
  ['.eslintrc.yaml', 'ESLint'],
  ['.eslintrc.yml', 'ESLint'],
  ['.prettierrc', 'Prettier'],
  ['.prettierrc.json', 'Prettier'],
  ['.prettierrc.yml', 'Prettier'],
  ['.prettierrc.yaml', 'Prettier'],
  ['.prettierrc.json5', 'Prettier'],
  ['.prettierrc.js', 'Prettier'],
  ['.prettierrc.cjs', 'Prettier'],
  ['.prettierrc.mjs', 'Prettier'],
  ['.prettierrc.ts', 'Prettier'],
  ['.prettierrc.mts', 'Prettier'],
  ['.prettierrc.cts', 'Prettier'],
  ['.prettierrc.toml', 'Prettier'],
  ['prettier.config.js', 'Prettier'],
  ['prettier.config.cjs', 'Prettier'],
  ['prettier.config.ts', 'Prettier'],
  ['prettier.config.mts', 'Prettier'],
  ['prettier.config.cts', 'Prettier'],
] as const)

const PACKAGE_CONFIGS = Object.freeze([
  ['eslintConfig', 'ESLint'],
  ['prettier', 'Prettier'],
] as const)

const CONFIG_FILE_TO_TOOL = new Map<string, string>([
  ...ALTERNATE_CONFIGS.map(([path, tool]) => [path, tool] as const),
  ['eslint.config.mjs', 'ESLint'],
  ['prettier.config.mjs', 'Prettier'],
  ['.editorconfig', 'EditorConfig'],
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

const ESLINT_CONFIG = `import { defineConfig, globalIgnores } from 'eslint/config'
import nextVitals from 'eslint-config-next/core-web-vitals'
import nextTs from 'eslint-config-next/typescript'

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  globalIgnores(['.next/**', 'out/**', 'build/**', 'next-env.d.ts']),
])

export default eslintConfig
`

const EDITOR_CONFIG = `root = true

[*]
charset = utf-8
end_of_line = lf
insert_final_newline = true
indent_style = space
indent_size = 2
trim_trailing_whitespace = true

[*.md]
trim_trailing_whitespace = false
`

const PRETTIER_VALUES: Readonly<Record<string, ConfigValue>> = Object.freeze({
  arrowParens: 'always',
  bracketSameLine: false,
  bracketSpacing: true,
  endOfLine: 'lf',
  printWidth: 100,
  proseWrap: 'preserve',
  semi: false,
  singleQuote: true,
  tabWidth: 2,
  trailingComma: 'all',
  useTabs: false,
})

const PRETTIER_IGNORE_LINES = Object.freeze([
  '.next',
  'coverage',
  'dist',
  'node_modules',
  'pnpm-lock.yaml',
])

const DEPENDENCIES = Object.freeze([
  ['eslint', '^9.39.0'],
  ['eslint-config-next', '^16.0.0'],
  ['prettier', '^3.0.0'],
] as const)

const SCRIPTS = Object.freeze([
  ['frontprep:lint', 'eslint . --max-warnings=0', 'owned'],
  ['frontprep:lint:fix', 'eslint . --fix --max-warnings=0', 'owned'],
  ['frontprep:format', 'prettier --write .', 'owned'],
  ['frontprep:format:check', 'prettier --check .', 'owned'],
  ['frontprep:typecheck', 'tsc --noEmit', 'owned'],
  [
    'frontprep:quality',
    'pnpm run frontprep:lint && pnpm run frontprep:format:check && pnpm run frontprep:typecheck',
    'owned',
  ],
  ['frontprep:check', 'pnpm run frontprep:quality', 'owned'],
  ['lint', 'pnpm run frontprep:lint', 'preserve-existing'],
  ['lint:fix', 'pnpm run frontprep:lint:fix', 'preserve-existing'],
  ['format', 'pnpm run frontprep:format', 'preserve-existing'],
  ['format:check', 'pnpm run frontprep:format:check', 'preserve-existing'],
  ['typecheck', 'pnpm run frontprep:typecheck', 'preserve-existing'],
  ['quality', 'pnpm run frontprep:quality', 'preserve-existing'],
  ['check', 'pnpm run frontprep:check', 'preserve-existing'],
] as const satisfies readonly (readonly [string, string, ScriptPolicy])[])

interface QualityAnalysis {
  readonly eligible: true
}

function createPrettierFragment() {
  return configFragmentIntent(
    MODULE_ID,
    'prettier',
    PRETTIER_VALUES,
    'Quality provides the base Prettier policy.',
  )
}

function canonicalConfigs(): readonly (readonly [string, string, string])[] {
  return Object.freeze([
    ['eslint.config.mjs', 'ESLint', ESLINT_CONFIG],
    [
      'prettier.config.mjs',
      'Prettier',
      composePrettierConfig([createPrettierFragment()]),
    ],
    ['.editorconfig', 'EditorConfig', EDITOR_CONFIG],
  ])
}

async function findNestedConfigurations(
  context: ProjectContext,
): Promise<readonly VerificationIssue[]> {
  const configurations: VerificationIssue[] = []
  const fileSystem = new FileSystem(context.root)
  const directories = ['']
  while (directories.length > 0) {
    const directory = directories.shift()!
    let entries
    try {
      entries = await readdir(join(context.root, directory), {
        withFileTypes: true,
      })
    } catch {
      configurations.push({
        message: 'Quality configuration directory could not be inspected.',
        path: directory || '.',
      })
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
      const tool = CONFIG_FILE_TO_TOOL.get(entry.name)
      if (tool !== undefined && (entry.isFile() || entry.isSymbolicLink())) {
        configurations.push(configurationConflict(tool, projectPath))
      }
      if (entry.name === 'package.json' && entry.isSymbolicLink()) {
        configurations.push({
          message: 'Nested package configuration could not be inspected.',
          path: projectPath,
        })
        continue
      }
      if (entry.name === 'package.json' && entry.isFile()) {
        try {
          const bytes = await fileSystem.read(toProjectPath(projectPath))
          const packageJson = JSON.parse(
            bytes?.toString('utf8') ?? '{}',
          ) as Record<string, unknown>
          for (const [key, packageTool] of PACKAGE_CONFIGS) {
            if (Object.hasOwn(packageJson, key)) {
              configurations.push(
                configurationConflict(
                  packageTool,
                  `${projectPath}#${key}`,
                  projectPath,
                ),
              )
            }
          }
        } catch {
          configurations.push({
            message: 'Nested package configuration could not be inspected.',
            path: projectPath,
          })
        }
      }
    }
  }
  return Object.freeze(configurations)
}

function configurationConflict(
  tool: string,
  displayPath: string,
  path: string = displayPath,
): VerificationIssue {
  return {
    message: `${tool} configuration conflicts at ${displayPath}.`,
    path,
  }
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

async function findConfigurationConflicts(
  context: ProjectContext,
  includeCanonicalOwnershipConflicts: boolean,
): Promise<readonly VerificationIssue[]> {
  const issues: VerificationIssue[] = []
  const fileSystem = new FileSystem(context.root)
  for (const [path, tool] of ALTERNATE_CONFIGS) {
    const snapshot = await safeSnapshot(fileSystem, path)
    if (snapshot === null || snapshot.exists) {
      issues.push(configurationConflict(tool, path))
    }
  }
  for (const [key, tool] of PACKAGE_CONFIGS) {
    if (Object.hasOwn(context.packageJson, key)) {
      issues.push(
        configurationConflict(tool, `package.json#${key}`, 'package.json'),
      )
    }
  }
  if (includeCanonicalOwnershipConflicts) {
    for (const [path, tool, expected] of canonicalConfigs()) {
      const snapshot = await safeSnapshot(fileSystem, path)
      if (snapshot === null) {
        issues.push(configurationConflict(tool, path))
        continue
      }
      if (!snapshot.exists || snapshot.bytes?.equals(Buffer.from(expected))) {
        continue
      }

      const recorded = manifestFile(context.manifest, scopedProjectPath(path))
      if (
        recorded?.ownership === 'managed' &&
        recorded.hash === snapshot.hash
      ) {
        continue
      }

      issues.push(configurationConflict(tool, path))
    }
  }
  issues.push(...(await findNestedConfigurations(context)))
  return Object.freeze(issues)
}

function declaredRange(context: ProjectContext, name: string): string | null {
  return (
    context.packageJson.dependencies?.[name] ??
    context.packageJson.devDependencies?.[name] ??
    null
  )
}

function hasQualityCheckStage(actual: string | undefined): boolean {
  const qualityStage = 'pnpm run frontprep:quality'
  const stages = actual?.split(' && ') ?? []
  return (
    stages[0] === qualityStage &&
    stages.filter((stage) => stage === qualityStage).length === 1
  )
}

function hasPrettierBaseConfiguration(contents: string): boolean {
  const lines = contents.trimEnd().split('\n')
  if (
    lines[0] !== "/** @type {import('prettier').Config} */" ||
    lines[1] !== 'const config = {' ||
    lines.at(-3) !== '}' ||
    lines.at(-2) !== '' ||
    lines.at(-1) !== 'export default config'
  ) {
    return false
  }

  const propertyLines = lines.slice(2, -3)
  if (
    propertyLines.some((line) => !/^ {2}[A-Za-z_$][\w$]*: .+,$/u.test(line))
  ) {
    return false
  }

  const expectedLines = composePrettierConfig([createPrettierFragment()])
    .split('\n')
    .filter((line) => line.startsWith('  '))
  const actual = new Set(propertyLines)
  return expectedLines.every((line) => actual.has(line))
}

function verificationResult(
  issues: readonly VerificationIssue[],
): VerificationResult {
  return {
    issues: Object.freeze([...issues]),
    valid: issues.length === 0,
  }
}

function createIntents(): readonly ChangeIntent[] {
  return Object.freeze([
    ...DEPENDENCIES.map(([name, range]) =>
      dependencyIntent(
        MODULE_ID,
        'devDependencies',
        name,
        range,
        `Quality requires ${name}.`,
      ),
    ),
    ...SCRIPTS.map(([name, command, policy]) =>
      scriptIntent(
        MODULE_ID,
        name,
        command,
        policy,
        `Quality provides the ${name} script.`,
      ),
    ),
    managedFileIntent(
      MODULE_ID,
      'eslint.config.mjs',
      ESLINT_CONFIG,
      0o644,
      'Quality owns the ESLint flat config.',
    ),
    managedFileIntent(
      MODULE_ID,
      '.editorconfig',
      EDITOR_CONFIG,
      0o644,
      'Quality owns the editor defaults.',
    ),
    createPrettierFragment(),
    lineSetIntent(
      MODULE_ID,
      '.prettierignore',
      PRETTIER_IGNORE_LINES,
      'Quality excludes generated files from formatting.',
    ),
  ])
}

export const qualityModule: SetupModule<QualityAnalysis> = Object.freeze({
  id: MODULE_ID,
  version: '2.0.0',
  async analyze(context: ProjectContext): Promise<QualityAnalysis> {
    const conflicts = await findConfigurationConflicts(context, true)
    const first = conflicts[0]
    if (first !== undefined) {
      throw new ConflictError(first.message, first.path, MODULE_ID)
    }
    return Object.freeze({ eligible: true })
  },
  async plan(): Promise<readonly ChangeIntent[]> {
    return createIntents()
  },
  async verify(context: ProjectContext): Promise<VerificationResult> {
    const issues: VerificationIssue[] = [
      ...(await findConfigurationConflicts(context, false)),
    ]
    for (const [name, expected] of DEPENDENCIES) {
      const actual = declaredRange(context, name)
      if (
        actual === null ||
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
      const ownedScriptValid =
        name === 'frontprep:check'
          ? hasQualityCheckStage(actual)
          : actual === command
      if (policy === 'owned' && !ownedScriptValid) {
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
    for (const [path, , expected] of canonicalConfigs().filter(
      ([path]) => path !== 'prettier.config.mjs',
    )) {
      const snapshot = await safeSnapshot(fileSystem, path)
      if (
        snapshot === null ||
        !snapshot.exists ||
        !snapshot.bytes?.equals(Buffer.from(expected)) ||
        snapshot.mode !== 0o644
      ) {
        issues.push({
          message: 'Managed Quality configuration is missing or changed.',
          path,
        })
      }
    }

    const prettierSnapshot = await safeSnapshot(
      fileSystem,
      'prettier.config.mjs',
    )
    if (
      prettierSnapshot === null ||
      !prettierSnapshot.exists ||
      prettierSnapshot.mode !== 0o644 ||
      prettierSnapshot.bytes === null ||
      !hasPrettierBaseConfiguration(prettierSnapshot.bytes.toString('utf8'))
    ) {
      issues.push({
        message: 'Prettier base configuration is missing or changed.',
        path: 'prettier.config.mjs',
      })
    }

    const ignoreSnapshot = await safeSnapshot(fileSystem, '.prettierignore')
    const ignoreLines = new Set(
      ignoreSnapshot?.bytes?.toString('utf8').split('\n') ?? [],
    )
    const missingIgnoreLines = PRETTIER_IGNORE_LINES.filter(
      (line) => !ignoreLines.has(line),
    )
    if (missingIgnoreLines.length > 0) {
      issues.push({
        message: `Required Prettier ignore entries are missing: ${missingIgnoreLines.join(', ')}.`,
        path: '.prettierignore',
      })
    }

    return verificationResult(issues)
  },
})
