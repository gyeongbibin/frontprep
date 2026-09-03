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

  it('defaults file intents to package scope and accepts repository scope', () => {
    expect(
      managedFileIntent(
        'quality',
        '.editorconfig',
        'root = true\n',
        0o644,
        'editor defaults',
      ),
    ).toMatchObject({ path: '.editorconfig', scope: 'package' })
    expect(
      managedFileIntent(
        'ci',
        '.github/workflows/ci.yml',
        'name: CI\n',
        0o644,
        'CI workflow',
        'repository',
      ),
    ).toMatchObject({
      path: '.github/workflows/ci.yml',
      scope: 'repository',
    })
  })
})
