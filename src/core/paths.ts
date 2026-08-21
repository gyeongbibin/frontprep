import { lstat, realpath } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { posix } from 'node:path'

import { UnsafePathError } from './errors.js'

declare const projectPathBrand: unique symbol
export type ProjectPath = string & { readonly [projectPathBrand]: true }

export function toProjectPath(value: string): ProjectPath {
  if (
    value.length === 0 ||
    value.includes('\0') ||
    value.includes('\\') ||
    isAbsolute(value) ||
    value.split('/').includes('..')
  ) {
    throw new UnsafePathError(value)
  }

  const normalized = posix.normalize(value.replace(/^\.\//u, ''))
  if (
    normalized === '.' ||
    normalized.startsWith('../') ||
    normalized.includes('/../')
  ) {
    throw new UnsafePathError(value)
  }

  return normalized as ProjectPath
}

function isInside(root: string, candidate: string): boolean {
  const pathFromRoot = relative(root, candidate)
  return (
    pathFromRoot === '' ||
    (!pathFromRoot.startsWith('..') && !isAbsolute(pathFromRoot))
  )
}

export async function resolveProjectPath(
  root: string,
  projectPath: ProjectPath,
): Promise<string> {
  const rootRealPath = await realpath(root)
  const candidate = resolve(rootRealPath, projectPath)
  if (!isInside(rootRealPath, candidate)) {
    throw new UnsafePathError(projectPath)
  }

  const segments = projectPath.split('/')
  let current = rootRealPath
  for (const segment of segments) {
    current = join(current, segment)
    try {
      const stats = await lstat(current)
      if (stats.isSymbolicLink()) {
        const linkedPath = await realpath(current)
        if (!isInside(rootRealPath, linkedPath)) {
          throw new UnsafePathError(projectPath)
        }
      }
    } catch (error) {
      if (error instanceof UnsafePathError) {
        throw error
      }
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        break
      }
      throw new UnsafePathError(projectPath, error)
    }
  }

  const parent = dirname(candidate)
  if (!isInside(rootRealPath, parent)) {
    throw new UnsafePathError(projectPath)
  }
  return candidate
}
