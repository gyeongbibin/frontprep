import { describe, expect, it } from 'vitest'

import {
  assertCompatibleDependencies,
  assertCompatiblePathIntents,
} from '../../src/core/conflict-detector.js'
import {
  dependencyIntent,
  lineSetIntent,
  managedFileIntent,
} from '../../src/core/intents.js'

describe('conflict detector', () => {
  it('rejects incompatible dependency requirements', () => {
    expect(() =>
      assertCompatibleDependencies([
        dependencyIntent(
          'quality',
          'devDependencies',
          'eslint',
          '^9.0.0',
          'lint',
        ),
        dependencyIntent(
          'ci',
          'devDependencies',
          'eslint',
          '^10.0.0',
          'CI lint',
        ),
      ]),
    ).toThrow('Incompatible dependency requirements for eslint')
  })

  it('allows compatible dependency requirements', () => {
    expect(() =>
      assertCompatibleDependencies([
        dependencyIntent(
          'quality',
          'devDependencies',
          'eslint',
          '^10.0.0',
          'lint',
        ),
        dependencyIntent(
          'ci',
          'devDependencies',
          'eslint',
          '>=10.5.0 <11',
          'CI lint',
        ),
      ]),
    ).not.toThrow()
  })

  it('rejects complete and partial intents for the same path', () => {
    expect(() =>
      assertCompatiblePathIntents([
        managedFileIntent(
          'quality',
          '.editorconfig',
          'root = true\n',
          0o644,
          'editor',
        ),
        lineSetIntent('ci', '.editorconfig', ['[*]'], 'CI editor defaults'),
      ]),
    ).toThrow('Conflicting complete and partial changes for .editorconfig')
  })
})
