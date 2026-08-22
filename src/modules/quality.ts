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
import { FileSystem } from '../core/filesystem.js'
import { toProjectPath } from '../core/paths.js'
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
  ['eslint', '^10.0.0'],
  ['eslint-config-next', '^16.0.0'],
  ['prettier', '^3.0.0'],
] as const)

const SCRIPTS = Object.freeze([
  ['frontprep:lint', 'eslint .', 'owned'],
  ['frontprep:lint:fix', 'eslint . --fix', 'owned'],
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

function declaredRange(context: ProjectContext, name: string): string | null {
  return (
    context.packageJson.dependencies?.[name] ??
    context.packageJson.devDependencies?.[name] ??
    null
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
  version: '1.0.0',
  async analyze(context: ProjectContext): Promise<QualityAnalysis> {
    const fileSystem = new FileSystem(context.root)
    for (const [path, tool] of ALTERNATE_CONFIGS) {
      if ((await fileSystem.snapshot(toProjectPath(path))).exists) {
        throw new ConflictError(
          `${tool} configuration conflicts at ${path}.`,
          path,
          MODULE_ID,
        )
      }
    }
    for (const [key, tool] of PACKAGE_CONFIGS) {
      if (Object.hasOwn(context.packageJson, key)) {
        throw new ConflictError(
          `${tool} configuration conflicts at package.json#${key}.`,
          'package.json',
          MODULE_ID,
        )
      }
    }
    for (const [path, tool, expected] of canonicalConfigs()) {
      const snapshot = await fileSystem.snapshot(toProjectPath(path))
      if (!snapshot.exists || snapshot.bytes?.equals(Buffer.from(expected))) {
        continue
      }

      const recorded = context.manifest?.files[path]
      if (
        recorded?.ownership === 'managed' &&
        recorded.hash === snapshot.hash
      ) {
        continue
      }

      throw new ConflictError(
        `${tool} configuration conflicts at ${path}.`,
        path,
        MODULE_ID,
      )
    }
    return Object.freeze({ eligible: true })
  },
  async plan(): Promise<readonly ChangeIntent[]> {
    return createIntents()
  },
  async verify(context: ProjectContext): Promise<VerificationResult> {
    const issues: VerificationIssue[] = []
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
      if (policy === 'owned' && actual !== command) {
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
      const snapshot = await fileSystem.snapshot(toProjectPath(path))
      if (
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

    const prettierSnapshot = await fileSystem.snapshot(
      toProjectPath('prettier.config.mjs'),
    )
    if (
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

    const ignoreSnapshot = await fileSystem.snapshot(
      toProjectPath('.prettierignore'),
    )
    const ignoreLines = new Set(
      ignoreSnapshot.bytes?.toString('utf8').split('\n') ?? [],
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
