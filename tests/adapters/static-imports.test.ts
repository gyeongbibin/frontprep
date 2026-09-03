import { describe, expect, it } from 'vitest'

describe('static CSS imports', () => {
  it('extracts side-effect CSS imports in source order and removes duplicates', async () => {
    const { extractStaticCssImports } =
      await import('../../src/adapters/static-imports.js')

    expect(
      extractStaticCssImports(`
        import '@/styles/global.css'
        import   "./theme.css"  ;
        import './print.css?inline'
        import './theme.css'
        import './tokens.css#layer'
      `),
    ).toEqual([
      '@/styles/global.css',
      './theme.css',
      './print.css?inline',
      './tokens.css#layer',
    ])
  })

  it('ignores comments, strings, templates, dynamic imports, and require calls', async () => {
    const { extractStaticCssImports } =
      await import('../../src/adapters/static-imports.js')

    expect(
      extractStaticCssImports(`
        // import './line-comment.css'
        /* import './block-comment.css' */
        const single = "import './double-string.css'"
        const double = 'import "./single-string.css"'
        const template = \`import './template.css'\`
        void import('./dynamic.css')
        require('./required.css')
        import styles from './default.css'
        import { tokens } from './named.css'
        import './real.css'
      `),
    ).toEqual(['./real.css'])
  })

  it('does not treat import-like identifier text or non-CSS imports as stylesheets', async () => {
    const { extractStaticCssImports } =
      await import('../../src/adapters/static-imports.js')

    expect(
      extractStaticCssImports(`
        important './not-import.css'
        importValue './also-not-import.css'
        import './module.ts'
        import.meta.url
      `),
    ).toEqual([])
  })
})
