import { intersects, validRange } from 'semver'

import { ConflictError } from './errors.js'
import type {
  ChangeIntent,
  DependencyIntent,
  ExecutableFileIntent,
  ManagedFileIntent,
} from './intents.js'

export function assertCompatibleDependencies(
  intents: readonly DependencyIntent[],
): void {
  const byName = new Map<string, DependencyIntent[]>()
  for (const intent of intents) {
    const group = byName.get(intent.name) ?? []
    group.push(intent)
    byName.set(intent.name, group)
  }

  for (const [name, group] of byName) {
    for (let left = 0; left < group.length; left += 1) {
      for (let right = left + 1; right < group.length; right += 1) {
        const leftRange = group[left]!.range
        const rightRange = group[right]!.range
        if (
          validRange(leftRange) === null ||
          validRange(rightRange) === null ||
          !intersects(leftRange, rightRange)
        ) {
          throw new ConflictError(
            `Incompatible dependency requirements for ${name}: ${leftRange} and ${rightRange}.`,
          )
        }
      }
    }
  }
}

function isCompleteIntent(
  intent: ChangeIntent,
): intent is ExecutableFileIntent | ManagedFileIntent {
  return intent.kind === 'managed-file' || intent.kind === 'executable-file'
}

function isPartialIntent(intent: ChangeIntent): boolean {
  return (
    intent.kind === 'line-set' ||
    intent.kind === 'css-import' ||
    intent.kind === 'static-import'
  )
}

export function assertCompatiblePathIntents(
  intents: readonly ChangeIntent[],
): void {
  const byPath = new Map<string, ChangeIntent[]>()
  for (const intent of intents) {
    if (!('path' in intent)) {
      continue
    }
    const group = byPath.get(intent.path) ?? []
    group.push(intent)
    byPath.set(intent.path, group)
  }

  for (const [path, group] of byPath) {
    if (group.some(isCompleteIntent) && group.some(isPartialIntent)) {
      throw new ConflictError(
        `Conflicting complete and partial changes for ${path}.`,
        path,
      )
    }
  }
}
