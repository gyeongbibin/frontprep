import { describe, expect, it } from 'vitest'

describe('scoped project paths', () => {
  it('keys equal relative paths independently by scope', async () => {
    const { scopedPathKey, scopedProjectPath } =
      await import('../../src/core/scoped-paths.js')

    expect(scopedPathKey(scopedProjectPath('same.txt'))).toBe(
      'package:same.txt',
    )
    expect(scopedPathKey(scopedProjectPath('same.txt', 'repository'))).toBe(
      'repository:same.txt',
    )
  })

  it('rejects paths that escape their selected root', async () => {
    const { scopedProjectPath } = await import('../../src/core/scoped-paths.js')

    expect(() => scopedProjectPath('../outside.txt')).toThrow(
      'Unsafe project path',
    )
  })

  it('returns an immutable target', async () => {
    const { scopedProjectPath } = await import('../../src/core/scoped-paths.js')

    expect(Object.isFrozen(scopedProjectPath('package.json'))).toBe(true)
  })
})
