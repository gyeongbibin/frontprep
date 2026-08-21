import { describe, expect, it } from 'vitest'

import { dependencyIntent, managedFileIntent } from '../../src/core/intents.js'

describe('change intents', () => {
  it('creates an immutable dependency intent', () => {
    const intent = dependencyIntent(
      'quality',
      'devDependencies',
      'eslint',
      '^10.9.0',
      'lint source files',
    )

    expect(intent).toEqual({
      kind: 'dependency',
      moduleId: 'quality',
      section: 'devDependencies',
      name: 'eslint',
      range: '^10.9.0',
      reason: 'lint source files',
    })
    expect(Object.isFrozen(intent)).toBe(true)
  })

  it('validates paths used by file intents', () => {
    expect(() =>
      managedFileIntent(
        'quality',
        '../eslint.config.mjs',
        'content',
        0o644,
        'lint',
      ),
    ).toThrow('Unsafe project path')
  })
})
