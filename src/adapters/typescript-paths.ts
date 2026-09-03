import { lstat, realpath } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'

import { parse as parseJsonc, type ParseError } from 'jsonc-parser'

import { UnsupportedProjectError } from '../core/errors.js'
import {
  resolveProjectPath,
  toProjectPath,
  type ProjectPath,
} from '../core/paths.js'

export interface TypeScriptPathMapping {
  readonly pattern: string
  readonly targets: readonly string[]
}

export interface TypeScriptPaths {
  readonly baseUrl: string | null
  readonly mappings: readonly TypeScriptPathMapping[]
}

const configDirectories = new WeakMap<TypeScriptPaths, string>()

function invalidTsConfig(message: string): UnsupportedProjectError {
  return new UnsupportedProjectError(`Invalid tsconfig paths: ${message}`)
}

function objectValue(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function starCount(value: string): number {
  return [...value].filter((character) => character === '*').length
}

function assertPortablePath(value: string, label: string): void {
  if (value.length === 0 || value.includes('\\') || value.includes('\0')) {
    throw invalidTsConfig(`${label} must be a non-empty POSIX path`)
  }
}

export function parseTypeScriptPaths(
  contents: string,
  tsconfigPath: string,
): TypeScriptPaths {
  const errors: ParseError[] = []
  const parsed = parseJsonc(contents, errors, { allowTrailingComma: true })
  if (errors.length > 0 || !objectValue(parsed)) {
    throw invalidTsConfig('the file is not valid JSONC')
  }
  if (parsed.extends !== undefined) {
    throw invalidTsConfig('tsconfig extends is not supported')
  }

  const compilerOptions = parsed.compilerOptions ?? {}
  if (!objectValue(compilerOptions)) {
    throw invalidTsConfig('compilerOptions must be an object')
  }

  const rawBaseUrl = compilerOptions.baseUrl
  if (rawBaseUrl !== undefined && typeof rawBaseUrl !== 'string') {
    throw invalidTsConfig('baseUrl must be a string')
  }
  if (typeof rawBaseUrl === 'string') {
    assertPortablePath(rawBaseUrl, 'baseUrl')
  }

  const rawPaths = compilerOptions.paths
  if (rawPaths !== undefined && !objectValue(rawPaths)) {
    throw invalidTsConfig('paths must be an object')
  }

  const mappings: TypeScriptPathMapping[] = []
  for (const [pattern, rawTargets] of Object.entries(rawPaths ?? {})) {
    if (pattern.length === 0 || starCount(pattern) > 1) {
      throw invalidTsConfig(
        `path pattern must contain at most one *: ${pattern}`,
      )
    }
    if (!Array.isArray(rawTargets) || rawTargets.length === 0) {
      throw invalidTsConfig(
        `path targets must be a non-empty array: ${pattern}`,
      )
    }

    const targets: string[] = []
    for (const rawTarget of rawTargets) {
      if (typeof rawTarget !== 'string') {
        throw invalidTsConfig(`path target must be a string: ${pattern}`)
      }
      assertPortablePath(rawTarget, `path target for ${pattern}`)
      if (starCount(rawTarget) > 1) {
        throw invalidTsConfig(
          `path target must contain at most one *: ${rawTarget}`,
        )
      }
      targets.push(rawTarget)
    }
    mappings.push(Object.freeze({ pattern, targets: Object.freeze(targets) }))
  }

  const config = Object.freeze({
    baseUrl: rawBaseUrl ?? null,
    mappings: Object.freeze(mappings),
  })
  configDirectories.set(config, dirname(resolve(tsconfigPath)))
  return config
}

function mappingCapture(pattern: string, specifier: string): string | null {
  const star = pattern.indexOf('*')
  if (star === -1) return pattern === specifier ? '' : null

  const prefix = pattern.slice(0, star)
  const suffix = pattern.slice(star + 1)
  if (
    !specifier.startsWith(prefix) ||
    !specifier.endsWith(suffix) ||
    specifier.length < prefix.length + suffix.length
  ) {
    return null
  }
  return specifier.slice(prefix.length, specifier.length - suffix.length)
}

function selectedMapping(
  mappings: readonly TypeScriptPathMapping[],
  specifier: string,
): { capture: string; mapping: TypeScriptPathMapping } | null {
  const exact = mappings.find(
    ({ pattern }) => !pattern.includes('*') && pattern === specifier,
  )
  if (exact !== undefined) return { capture: '', mapping: exact }

  return (
    mappings
      .flatMap((mapping) => {
        const capture = mappingCapture(mapping.pattern, specifier)
        return capture === null ? [] : [{ capture, mapping }]
      })
      .sort(
        (left, right) =>
          right.mapping.pattern.indexOf('*') -
            left.mapping.pattern.indexOf('*') ||
          right.mapping.pattern.length - left.mapping.pattern.length,
      )[0] ?? null
  )
}

function toPosixPath(value: string): string {
  return value.split(sep).join('/')
}

async function existingProjectFile(
  packageRoot: string,
  absoluteCandidate: string,
): Promise<ProjectPath | null> {
  const root = await realpath(packageRoot)
  const relativeCandidate = relative(root, absoluteCandidate)
  if (isAbsolute(relativeCandidate) || relativeCandidate.startsWith('..')) {
    return null
  }

  try {
    const projectPath = toProjectPath(toPosixPath(relativeCandidate))
    const safePath = await resolveProjectPath(root, projectPath)
    const stats = await lstat(safePath)
    return stats.isFile() ? projectPath : null
  } catch {
    return null
  }
}

export async function resolveTypeScriptImport(
  packageRoot: string,
  config: TypeScriptPaths,
  specifier: string,
): Promise<readonly ProjectPath[]> {
  const cleanSpecifier = specifier.replace(/[?#].*$/u, '')
  const storedConfigDirectory = configDirectories.get(config) ?? packageRoot
  const configDirectory = await realpath(storedConfigDirectory)
  const baseDirectory =
    config.baseUrl === null
      ? configDirectory
      : resolve(configDirectory, config.baseUrl)
  const selected = selectedMapping(config.mappings, cleanSpecifier)

  let targets: readonly string[]
  let capture = ''
  if (selected !== null) {
    targets = selected.mapping.targets
    capture = selected.capture
  } else if (
    config.baseUrl !== null &&
    !cleanSpecifier.startsWith('.') &&
    !isAbsolute(cleanSpecifier)
  ) {
    targets = [cleanSpecifier]
  } else {
    return Object.freeze([])
  }

  const candidates = new Set<ProjectPath>()
  for (const target of targets) {
    const substituted = target.includes('*')
      ? target.replace('*', capture)
      : target
    const candidate = await existingProjectFile(
      packageRoot,
      resolve(baseDirectory, substituted),
    )
    if (candidate !== null) candidates.add(candidate)
  }

  return Object.freeze(
    [...candidates].sort((left, right) => left.localeCompare(right)),
  )
}
