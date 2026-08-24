import { describe, expect, it } from 'vitest'

import {
  createModuleRegistry,
  DEFAULT_MODULES,
} from '../../src/modules/registry.js'
import type { SetupModule } from '../../src/modules/types.js'

function moduleWithId(id: SetupModule['id']): SetupModule {
  return {
    id,
    version: '1.0.0',
    analyze: async () => undefined,
    plan: async () => [],
    verify: async () => ({ issues: [], valid: true }),
  }
}

describe('module registry', () => {
  it('exports the frozen five-module production registry', () => {
    expect(DEFAULT_MODULES.map(({ id }) => id)).toEqual([
      'quality',
      'tailwind',
      'test',
      'git-hooks',
      'ci',
    ])
    expect(Object.isFrozen(DEFAULT_MODULES)).toBe(true)
  })

  it('returns modules in the fixed v1 order', () => {
    const modules = createModuleRegistry([
      moduleWithId('ci'),
      moduleWithId('quality'),
      moduleWithId('test'),
    ])

    expect(modules.map(({ id }) => id)).toEqual(['quality', 'test', 'ci'])
  })

  it('rejects duplicate module IDs', () => {
    expect(() =>
      createModuleRegistry([moduleWithId('quality'), moduleWithId('quality')]),
    ).toThrow('Duplicate module: quality')
  })
})
