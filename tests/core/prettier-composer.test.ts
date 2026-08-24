import { describe, expect, it } from 'vitest'

import { composePrettierConfig } from '../../src/core/composers/prettier.js'
import { configFragmentIntent } from '../../src/core/intents.js'

describe('Prettier config composer', () => {
  it('merges fragments and keeps the Tailwind plugin last', () => {
    const contents = composePrettierConfig([
      configFragmentIntent(
        'tailwind',
        'prettier',
        {
          plugins: ['prettier-plugin-tailwindcss'],
          tailwindFunctions: ['cn', 'cva', 'clsx'],
          tailwindStylesheet: './src/app/globals.css',
        },
        'sort Tailwind classes',
      ),
      configFragmentIntent(
        'quality',
        'prettier',
        {
          plugins: ['prettier-plugin-organize-imports'],
          semi: false,
          singleQuote: true,
        },
        'format source files',
      ),
    ])

    expect(contents).toContain('semi: false')
    expect(contents).toContain('singleQuote: true')
    expect(contents).toContain(
      "plugins: ['prettier-plugin-organize-imports', 'prettier-plugin-tailwindcss']",
    )
    expect(contents).toContain("tailwindFunctions: ['clsx', 'cn', 'cva']")
    expect(contents.endsWith('\n')).toBe(true)
  })
})
