import { lstat, readdir } from 'node:fs/promises'
import { join, posix } from 'node:path'

import { intersects, validRange } from 'semver'

import {
  configFragmentIntent,
  cssImportIntent,
  dependencyIntent,
  lineSetIntent,
  managedFileIntent,
  staticImportIntent,
  type ChangeIntent,
} from '../core/intents.js'
import { ConflictError } from '../core/errors.js'
import { FileSystem, type FileSnapshot } from '../core/filesystem.js'
import { toProjectPath } from '../core/paths.js'
import { detectProject } from '../core/project-detector.js'
import type { ProjectContext } from '../core/types.js'
import type {
  SetupModule,
  VerificationIssue,
  VerificationResult,
} from './types.js'

const MODULE_ID = 'tailwind' as const
const CANONICAL_CSS_IMPORT = "@import 'tailwindcss';"

const POSTCSS_CONFIG = `const config = {
  plugins: {
    '@tailwindcss/postcss': {},
  },
}

export default config
`

const CN_UTILITY = `import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs))
}
`

const BARREL_EXPORTS = Object.freeze([
  "export { cva, type VariantProps } from 'class-variance-authority'",
  "export { cn } from './cn'",
])

const RUNTIME_DEPENDENCIES = Object.freeze([
  ['class-variance-authority', '^0.7.0'],
  ['clsx', '^2.0.0'],
  ['tailwind-merge', '^3.0.0'],
] as const)

const DEVELOPMENT_DEPENDENCIES = Object.freeze([
  ['@tailwindcss/postcss', '^4.0.0'],
  ['postcss', '^8.0.0'],
  ['prettier-plugin-tailwindcss', '^0.8.0'],
  ['tailwindcss', '^4.0.0'],
] as const)

const ALTERNATE_POSTCSS_CONFIGS = Object.freeze([
  'postcss.config.js',
  'postcss.config.cjs',
  'postcss.config.ts',
  'postcss.config.mts',
  'postcss.config.cts',
  '.postcssrc',
  '.postcssrc.json',
  '.postcssrc.yaml',
  '.postcssrc.yml',
  '.postcssrc.js',
  '.postcssrc.cjs',
  '.postcssrc.mjs',
  '.postcssrc.ts',
  '.postcssrc.mts',
  '.postcssrc.cts',
])

const LEGACY_TAILWIND_CONFIGS = Object.freeze([
  'tailwind.config.js',
  'tailwind.config.cjs',
  'tailwind.config.mjs',
  'tailwind.config.ts',
  'tailwind.config.mts',
  'tailwind.config.cts',
])

export interface TailwindAnalysis {
  readonly layoutImportValue: string | null
  readonly missingBarrelExports: readonly string[]
  readonly stylesheetPath: string
  readonly utilsDirectory: string
}

function verificationResult(
  issues: readonly VerificationIssue[],
): VerificationResult {
  return Object.freeze({
    issues: Object.freeze([...issues]),
    valid: issues.length === 0,
  })
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
  label: string,
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
        `${label} could not be inspected: ${inspectedPath}.`,
        inspectedPath,
        MODULE_ID,
      )
    }
  }
  return null
}

async function assertNoSymbolicLinkComponents(
  root: string,
  path: string,
  label: string,
): Promise<void> {
  const linkedComponent = await symbolicLinkComponent(root, path, label)
  if (linkedComponent !== null) {
    throw new ConflictError(
      `${label} contains a symbolic link: ${linkedComponent}.`,
      linkedComponent,
      MODULE_ID,
    )
  }
}

async function selectUtilityDirectory(
  context: ProjectContext,
): Promise<string> {
  const path = context.layout.utilities.path
  await assertNoSymbolicLinkComponents(context.root, path, 'Utility path')
  if ((await pathMetadata(context.root, path)) === 'other') {
    throw new ConflictError(
      `Utility path must be a real directory: ${path}.`,
      path,
      MODULE_ID,
    )
  }
  return path
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

async function configurationConflicts(
  context: ProjectContext,
): Promise<readonly VerificationIssue[]> {
  const issues: VerificationIssue[] = []
  const postcssPaths = new Set<string>(ALTERNATE_POSTCSS_CONFIGS)
  try {
    for (const entry of await readdir(context.root)) {
      if (entry.startsWith('.postcssrc')) postcssPaths.add(entry)
    }
  } catch {
    issues.push({
      message: 'PostCSS configuration directory could not be inspected.',
      path: '.',
    })
  }
  for (const path of [...postcssPaths].sort()) {
    if ((await pathMetadata(context.root, path)) !== 'missing') {
      issues.push({
        message: `PostCSS configuration conflicts at ${path}.`,
        path,
      })
    }
  }
  for (const path of LEGACY_TAILWIND_CONFIGS) {
    if ((await pathMetadata(context.root, path)) !== 'missing') {
      issues.push({
        message: `Legacy Tailwind configuration conflicts at ${path}.`,
        path,
      })
    }
  }
  if (Object.hasOwn(context.packageJson, 'postcss')) {
    issues.push({
      message: 'PostCSS configuration conflicts at package.json#postcss.',
      path: 'package.json',
    })
  }
  return Object.freeze(issues)
}

function decodeCssEscapes(contents: string): string {
  return contents.replace(
    /\\([0-9a-fA-F]{1,6})(?:\r\n|[ \t\n\r\f])?|\\(\r\n|[\n\r\f])|\\(.)/gu,
    (
      _match,
      hexadecimal: string | undefined,
      newline: string | undefined,
      escaped: string | undefined,
    ) => {
      if (hexadecimal !== undefined) {
        const codePoint = Number.parseInt(hexadecimal, 16)
        return codePoint === 0 || codePoint > 0x10ffff
          ? '\uFFFD'
          : String.fromCodePoint(codePoint)
      }
      if (newline !== undefined) return ''
      return escaped ?? ''
    },
  )
}

function stylesheetConflict(contents: string): string | null {
  const lines = contents.split(/\r?\n/u)
  const withoutComments = contents.replace(/\/\*[\s\S]*?\*\//gu, (comment) =>
    comment.replace(/[^\r\n]/gu, ' '),
  )
  const normalized = decodeCssEscapes(withoutComments)
  if (
    normalized
      .split(/\r?\n/u)
      .some((line) =>
        /^\s*@tailwind\s+(?:base|components|utilities)\s*;/iu.test(line),
      )
  ) {
    return 'Legacy Tailwind directives are not supported.'
  }

  const canonicalIndexes = lines.flatMap((line, index) =>
    line === CANONICAL_CSS_IMPORT ? [index] : [],
  )
  const tailwindImports = [
    ...normalized.matchAll(
      /(?:^|[;}])\s*@import\s+(?:["']tailwindcss["']|url\(\s*(?:["']tailwindcss["']|tailwindcss)\s*\))/giu,
    ),
  ]

  if (canonicalIndexes.length > 1) {
    return 'Tailwind stylesheet import is duplicated.'
  }
  if (tailwindImports.length > canonicalIndexes.length) {
    return 'Tailwind stylesheet import is not canonical.'
  }
  if (canonicalIndexes.length === 1 && canonicalIndexes[0] !== 0) {
    return 'Tailwind stylesheet import must be the first line.'
  }
  return null
}

function stripTypeScriptComments(contents: string): string {
  let result = ''
  let index = 0
  let state: 'block' | 'code' | 'double' | 'line' | 'single' | 'template' =
    'code'
  while (index < contents.length) {
    const character = contents[index]!
    const next = contents[index + 1]
    if (state === 'line') {
      if (character === '\n' || character === '\r') {
        result += character
        state = 'code'
      } else {
        result += ' '
      }
      index += 1
      continue
    }
    if (state === 'block') {
      if (character === '*' && next === '/') {
        result += '  '
        index += 2
        state = 'code'
      } else {
        result += character === '\n' || character === '\r' ? character : ' '
        index += 1
      }
      continue
    }
    if (state === 'template') {
      if (character === '\\' && next !== undefined) {
        result += '  '
        index += 2
      } else if (character === '`') {
        result += ' '
        index += 1
        state = 'code'
      } else {
        result += character === '\n' || character === '\r' ? character : ' '
        index += 1
      }
      continue
    }
    if (state === 'single' || state === 'double') {
      result += character
      if (character === '\\' && next !== undefined) {
        result += next
        index += 2
      } else {
        if (
          (state === 'single' && character === "'") ||
          (state === 'double' && character === '"')
        ) {
          state = 'code'
        }
        index += 1
      }
      continue
    }

    if (character === '/' && next === '/') {
      result += '  '
      index += 2
      state = 'line'
    } else if (character === '/' && next === '*') {
      result += '  '
      index += 2
      state = 'block'
    } else if (character === "'") {
      result += character
      index += 1
      state = 'single'
    } else if (character === '"') {
      result += character
      index += 1
      state = 'double'
    } else if (character === '`') {
      result += ' '
      index += 1
      state = 'template'
    } else {
      result += character
      index += 1
    }
  }
  return result
}

function analyzeBarrel(contents: string): {
  conflict: boolean
  missing: readonly string[]
} {
  const rawLines = contents.split(/\r?\n/u)
  const activeLines = stripTypeScriptComments(contents).split(/\r?\n/u)
  let conflict = false
  const missing: string[] = []
  for (const requiredLine of BARREL_EXPORTS) {
    const activeCount = activeLines.filter(
      (line) => line === requiredLine,
    ).length
    const rawCount = rawLines.filter((line) => line === requiredLine).length
    if (activeCount === 0) missing.push(requiredLine)
    if (activeCount > 1 || rawCount > activeCount) conflict = true
  }

  const remaining = activeLines
    .filter((line) => !BARREL_EXPORTS.includes(line))
    .join('\n')
    .replace(/'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"/gu, '')
  if (/\b(?:cn|cva|VariantProps)\b/u.test(remaining)) conflict = true
  return { conflict, missing: Object.freeze(missing) }
}

async function assertManagedFileCompatible(
  fileSystem: FileSystem,
  path: string,
  contents: string,
  label: string,
): Promise<void> {
  const snapshot = await safeSnapshot(fileSystem, path)
  if (snapshot === null) {
    throw new ConflictError(`${label} conflicts at ${path}.`, path, MODULE_ID)
  }
  if (
    snapshot.exists &&
    (!snapshot.bytes?.equals(Buffer.from(contents)) || snapshot.mode !== 0o644)
  ) {
    throw new ConflictError(`${label} conflicts at ${path}.`, path, MODULE_ID)
  }
}

function propertyArray(
  contents: string,
  property: string,
): readonly string[] | null {
  const escapedProperty = property.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
  const declarations = [
    ...contents.matchAll(
      new RegExp(`^\\s*${escapedProperty}:\\s*(.+),\\s*$`, 'gmu'),
    ),
  ]
  if (declarations.length !== 1 || declarations[0]?.[1] === undefined) {
    return null
  }
  const array = declarations[0][1].match(/^\[(.*)\]$/u)
  if (array?.[1] === undefined) return null
  return Object.freeze(
    [...array[1].matchAll(/['"]([^'"]+)['"]/gu)].flatMap((item) =>
      item[1] === undefined ? [] : [item[1]],
    ),
  )
}

function hasTailwindPrettierConfiguration(
  contents: string,
  stylesheetPath: string,
): boolean {
  const lines = contents.trimEnd().split('\n')
  if (
    lines[0] !== "/** @type {import('prettier').Config} */" ||
    lines[1] !== 'const config = {' ||
    lines.at(-3) !== '}' ||
    lines.at(-2) !== '' ||
    lines.at(-1) !== 'export default config' ||
    lines
      .slice(2, -3)
      .some((line) => !/^ {2}[A-Za-z_$][\w$]*: .+,$/u.test(line))
  ) {
    return false
  }
  const plugins = propertyArray(contents, 'plugins')
  const functions = propertyArray(contents, 'tailwindFunctions')
  const stylesheetLines = contents
    .split('\n')
    .filter((line) => /^\s*tailwindStylesheet:/u.test(line))
  return (
    plugins !== null &&
    functions !== null &&
    plugins.includes('prettier-plugin-tailwindcss') &&
    ['clsx', 'cn', 'cva'].every((name) => functions.includes(name)) &&
    stylesheetLines.length === 1 &&
    stylesheetLines[0]?.trim() === `tailwindStylesheet: './${stylesheetPath}',`
  )
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

export const tailwindModule: SetupModule<TailwindAnalysis> = Object.freeze({
  id: MODULE_ID,
  version: '2.0.0',

  async analyze(context: ProjectContext): Promise<TailwindAnalysis> {
    const conflicts = await configurationConflicts(context)
    if (conflicts.length > 0) {
      throw new ConflictError(
        conflicts.map(({ message }) => message).join('\n'),
        conflicts[0]?.path,
        MODULE_ID,
      )
    }

    const utilsDirectory = await selectUtilityDirectory(context)
    const fileSystem = new FileSystem(context.root)
    await assertNoSymbolicLinkComponents(
      context.root,
      context.layoutPath,
      'Root layout path',
    )
    await assertNoSymbolicLinkComponents(
      context.root,
      context.stylesheetPath,
      'Stylesheet path',
    )
    await assertManagedFileCompatible(
      fileSystem,
      'postcss.config.mjs',
      POSTCSS_CONFIG,
      'PostCSS configuration',
    )
    await assertManagedFileCompatible(
      fileSystem,
      posix.join(utilsDirectory, 'cn.ts'),
      CN_UTILITY,
      'Class utility',
    )

    const layoutSnapshot = await safeSnapshot(fileSystem, context.layoutPath)
    if (layoutSnapshot === null || !layoutSnapshot.exists) {
      throw new ConflictError(
        `Root layout must be a regular file: ${context.layoutPath}.`,
        context.layoutPath,
        MODULE_ID,
      )
    }

    const stylesheetSnapshot = await safeSnapshot(
      fileSystem,
      context.stylesheetPath,
    )
    if (stylesheetSnapshot === null) {
      throw new ConflictError(
        `Stylesheet must be a regular file: ${context.stylesheetPath}.`,
        context.stylesheetPath,
        MODULE_ID,
      )
    }
    const stylesheetIssue = stylesheetConflict(
      stylesheetSnapshot.bytes?.toString('utf8') ?? '',
    )
    if (stylesheetIssue !== null) {
      throw new ConflictError(
        stylesheetIssue,
        context.stylesheetPath,
        MODULE_ID,
      )
    }

    const barrelPath = posix.join(utilsDirectory, 'index.ts')
    const barrelSnapshot = await safeSnapshot(fileSystem, barrelPath)
    if (barrelSnapshot === null) {
      throw new ConflictError(
        `Utility barrel must be a regular file: ${barrelPath}.`,
        barrelPath,
        MODULE_ID,
      )
    }
    const barrelContents = barrelSnapshot.bytes?.toString('utf8') ?? ''
    const barrelAnalysis = analyzeBarrel(barrelContents)
    if (barrelAnalysis.conflict) {
      throw new ConflictError(
        'Utility barrel has a conflicting required symbol.',
        barrelPath,
        MODULE_ID,
      )
    }

    return Object.freeze({
      layoutImportValue: context.stylesheetNeedsImport
        ? context.layout.stylesheet.importSpecifier
        : null,
      missingBarrelExports: barrelAnalysis.missing,
      stylesheetPath: context.stylesheetPath,
      utilsDirectory,
    })
  },

  async plan(
    context: ProjectContext,
    analysis: TailwindAnalysis,
  ): Promise<readonly ChangeIntent[]> {
    const intents: ChangeIntent[] = []
    for (const [name, range] of RUNTIME_DEPENDENCIES) {
      intents.push(
        dependencyIntent(
          MODULE_ID,
          'dependencies',
          name,
          range,
          'Tailwind class utilities are used by application code.',
        ),
      )
    }
    for (const [name, range] of DEVELOPMENT_DEPENDENCIES) {
      intents.push(
        dependencyIntent(
          MODULE_ID,
          'devDependencies',
          name,
          range,
          'Tailwind CSS is compiled and formatted by project tooling.',
        ),
      )
    }
    intents.push(
      managedFileIntent(
        MODULE_ID,
        'postcss.config.mjs',
        POSTCSS_CONFIG,
        0o644,
        'Tailwind v4 runs through the official PostCSS plugin.',
      ),
      cssImportIntent(
        MODULE_ID,
        analysis.stylesheetPath,
        'tailwindcss',
        'The detected global stylesheet loads Tailwind CSS.',
      ),
    )
    if (analysis.layoutImportValue !== null) {
      intents.push(
        staticImportIntent(
          MODULE_ID,
          context.layoutPath,
          analysis.layoutImportValue,
          'The detected root layout loads the global stylesheet.',
        ),
      )
    }
    intents.push(
      managedFileIntent(
        MODULE_ID,
        posix.join(analysis.utilsDirectory, 'cn.ts'),
        CN_UTILITY,
        0o644,
        'Applications need one deterministic Tailwind class merger.',
      ),
      lineSetIntent(
        MODULE_ID,
        posix.join(analysis.utilsDirectory, 'index.ts'),
        analysis.missingBarrelExports,
        'The shared utility barrel exposes class and variant helpers.',
      ),
      configFragmentIntent(
        MODULE_ID,
        'prettier',
        {
          plugins: ['prettier-plugin-tailwindcss'],
          tailwindFunctions: ['clsx', 'cn', 'cva'],
          tailwindStylesheet: `./${analysis.stylesheetPath}`,
        },
        'Prettier sorts Tailwind classes in the detected stylesheet context.',
      ),
    )
    return Object.freeze(intents)
  },

  async verify(context: ProjectContext): Promise<VerificationResult> {
    const issues: VerificationIssue[] = [
      ...(await configurationConflicts(context)),
    ]
    for (const [path, label] of [
      [context.layoutPath, 'Root layout path'],
      [context.stylesheetPath, 'Stylesheet path'],
    ] as const) {
      try {
        await assertNoSymbolicLinkComponents(context.root, path, label)
      } catch (error) {
        issues.push({
          message:
            error instanceof Error
              ? error.message
              : `${label} could not be verified.`,
          path,
        })
      }
    }
    for (const [name, range] of [
      ...RUNTIME_DEPENDENCIES,
      ...DEVELOPMENT_DEPENDENCIES,
    ]) {
      const actual = declaredDependency(context, name)
      if (
        actual === undefined ||
        validRange(actual) === null ||
        !intersects(actual, range)
      ) {
        issues.push({
          message: `Dependency ${name} must satisfy ${range}.`,
          path: 'package.json',
        })
      }
    }

    const fileSystem = new FileSystem(context.root)
    const postcssSnapshot = await safeSnapshot(fileSystem, 'postcss.config.mjs')
    if (
      postcssSnapshot === null ||
      !postcssSnapshot.exists ||
      !postcssSnapshot.bytes?.equals(Buffer.from(POSTCSS_CONFIG)) ||
      postcssSnapshot.mode !== 0o644
    ) {
      issues.push({
        message: 'Managed Tailwind configuration is missing or changed.',
        path: 'postcss.config.mjs',
      })
    }

    const stylesheetSnapshot = await safeSnapshot(
      fileSystem,
      context.stylesheetPath,
    )
    const stylesheetContents = stylesheetSnapshot?.bytes?.toString('utf8') ?? ''
    const stylesheetLines = stylesheetContents.split(/\r?\n/u)
    if (
      stylesheetSnapshot === null ||
      !stylesheetSnapshot.exists ||
      stylesheetConflict(stylesheetContents) !== null ||
      stylesheetLines[0] !== CANONICAL_CSS_IMPORT ||
      stylesheetLines.filter((line) => line === CANONICAL_CSS_IMPORT).length !==
        1
    ) {
      issues.push({
        message: 'Tailwind stylesheet import is missing or changed.',
        path: context.stylesheetPath,
      })
    }

    const layoutSnapshot = await safeSnapshot(fileSystem, context.layoutPath)
    try {
      const refreshed = await detectProject(context.root, {
        stylesheet: context.layout.stylesheet.path,
        testDirectory: context.layout.tests.path,
        utilityDirectory: context.layout.utilities.path,
      })
      if (
        layoutSnapshot === null ||
        !layoutSnapshot.exists ||
        refreshed.stylesheetNeedsImport ||
        refreshed.stylesheetPath !== context.stylesheetPath
      ) {
        issues.push({
          message:
            'The root layout is not connected to the detected stylesheet.',
          path: context.layoutPath,
        })
      }
    } catch {
      issues.push({
        message:
          'The root layout and stylesheet connection could not be verified.',
        path: context.layoutPath,
      })
    }

    let utilsDirectory: string
    try {
      utilsDirectory = await selectUtilityDirectory(context)
    } catch (error) {
      issues.push({
        message:
          error instanceof Error
            ? error.message
            : 'Utility directory could not be verified.',
        path: context.layout.utilities.path,
      })
      utilsDirectory = context.layout.utilities.path
    }

    const cnPath = posix.join(utilsDirectory, 'cn.ts')
    const cnSnapshot = await safeSnapshot(fileSystem, cnPath)
    if (
      cnSnapshot === null ||
      !cnSnapshot.exists ||
      !cnSnapshot.bytes?.equals(Buffer.from(CN_UTILITY)) ||
      cnSnapshot.mode !== 0o644
    ) {
      issues.push({
        message: 'Managed class utility is missing or changed.',
        path: cnPath,
      })
    }

    const barrelPath = posix.join(utilsDirectory, 'index.ts')
    const barrelSnapshot = await safeSnapshot(fileSystem, barrelPath)
    const barrelContents = barrelSnapshot?.bytes?.toString('utf8') ?? ''
    const barrelAnalysis = analyzeBarrel(barrelContents)
    if (
      barrelSnapshot === null ||
      !barrelSnapshot.exists ||
      barrelAnalysis.missing.length > 0 ||
      barrelAnalysis.conflict
    ) {
      issues.push({
        message: 'Required utility barrel exports are missing or changed.',
        path: barrelPath,
      })
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
      !hasTailwindPrettierConfiguration(
        prettierSnapshot.bytes.toString('utf8'),
        context.stylesheetPath,
      )
    ) {
      issues.push({
        message: 'Tailwind Prettier configuration is missing or changed.',
        path: 'prettier.config.mjs',
      })
    }

    return verificationResult(issues)
  },
})
