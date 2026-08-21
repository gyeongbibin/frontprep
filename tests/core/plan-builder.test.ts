import { chmod, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  configFragmentIntent,
  cssImportIntent,
  dependencyIntent,
  lineSetIntent,
  managedFileIntent,
  scriptIntent,
  staticImportIntent,
} from '../../src/core/intents.js'
import { hashBytes } from '../../src/core/filesystem.js'
import { buildPlan } from '../../src/core/plan-builder.js'
import { detectProject } from '../../src/core/project-detector.js'
import type { FrontprepManifest } from '../../src/core/types.js'
import { createProject } from '../helpers/project.js'

describe('plan builder', () => {
  it('aggregates package, config, CSS, and line changes deterministically', async () => {
    const project = await createProject()
    const context = await detectProject(project.root)

    const plan = await buildPlan(context, [
      cssImportIntent(
        'tailwind',
        'src/app/globals.css',
        'tailwindcss',
        'enable Tailwind',
      ),
      dependencyIntent(
        'quality',
        'devDependencies',
        'eslint',
        '^10.9.0',
        'lint',
      ),
      scriptIntent('quality', 'frontprep:lint', 'eslint .', 'owned', 'lint'),
      configFragmentIntent(
        'quality',
        'prettier',
        { semi: false, singleQuote: true },
        'format',
      ),
      configFragmentIntent(
        'tailwind',
        'prettier',
        { plugins: ['prettier-plugin-tailwindcss'] },
        'sort classes',
      ),
      lineSetIntent(
        'quality',
        '.prettierignore',
        ['node_modules', '.next'],
        'ignore generated files',
      ),
      lineSetIntent(
        'quality',
        '.prettierignore',
        ['.next'],
        'deduplicate generated files',
      ),
    ])

    expect(plan.operations.map(({ path }) => path)).toEqual([
      '.prettierignore',
      'package.json',
      'prettier.config.mjs',
      'src/app/globals.css',
    ])
    expect(plan.dependenciesChanged).toBe(true)
    expect(plan.managedScripts).toEqual({ 'frontprep:lint': 'eslint .' })
    const ignoreOperation = plan.operations[0]!
    expect(ignoreOperation.afterBytes.toString()).toBe('node_modules\n.next\n')
    expect(Object.isFrozen(plan.operations)).toBe(true)
  })

  it('preserves an existing compatible dependency range and script', async () => {
    const project = await createProject()
    const packagePath = join(project.root, 'package.json')
    const packageJson = JSON.parse(await readFile(packagePath, 'utf8')) as {
      devDependencies?: Record<string, string>
      scripts?: Record<string, string>
    }
    packageJson.devDependencies = { eslint: '^10.5.0' }
    packageJson.scripts = { lint: 'custom-lint' }
    await writeFile(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`)
    const context = await detectProject(project.root)

    const plan = await buildPlan(context, [
      dependencyIntent(
        'quality',
        'devDependencies',
        'eslint',
        '^10.9.0',
        'lint',
      ),
      scriptIntent(
        'quality',
        'lint',
        'eslint .',
        'preserve-existing',
        'conventional alias',
      ),
    ])

    expect(plan.operations).toEqual([])
    expect(plan.dependenciesChanged).toBe(false)
  })

  it('inserts a missing static import once', async () => {
    const project = await createProject({
      layout: 'export default function Layout() { return null }\n',
    })
    const context = await detectProject(project.root)

    const plan = await buildPlan(context, [
      staticImportIntent(
        'tailwind',
        'src/app/layout.tsx',
        './globals.css',
        'connect global styles',
      ),
    ])

    expect(plan.operations).toHaveLength(1)
    expect(plan.operations[0]?.afterBytes.toString()).toBe(
      "import './globals.css'\n\nexport default function Layout() { return null }\n",
    )
  })

  it('collapses equivalent managed file intents', async () => {
    const project = await createProject()
    const context = await detectProject(project.root)

    const plan = await buildPlan(context, [
      managedFileIntent(
        'quality',
        '.editorconfig',
        'root = true\n',
        0o644,
        'editor',
      ),
      managedFileIntent(
        'ci',
        '.editorconfig',
        'root = true\n',
        0o644,
        'editor',
      ),
    ])

    expect(plan.operations).toHaveLength(1)
    expect(plan.operations[0]?.moduleIds).toEqual(['quality', 'ci'])
  })

  it('rejects a user-modified managed file', async () => {
    const project = await createProject()
    const configPath = join(project.root, 'eslint.config.mjs')
    await writeFile(configPath, 'export default []\n')
    await chmod(configPath, 0o644)
    const context = await detectProject(project.root)
    const manifest: FrontprepManifest = {
      $schema:
        'https://unpkg.com/@mingyeongbin/frontprep/schema/manifest-v1.json',
      schemaVersion: 1,
      frontprepVersion: '0.1.0-beta.0',
      adapter: 'next-app',
      packageManager: 'pnpm@10.22.0',
      paths: { app: 'src/app', stylesheet: 'src/app/globals.css' },
      modules: {
        quality: '1.0.0',
        tailwind: '1.0.0',
        test: '1.0.0',
        'git-hooks': '1.0.0',
        ci: '1.0.0',
      },
      files: {
        'eslint.config.mjs': {
          hash: hashBytes(Buffer.from('original\n')),
          mode: '0644',
          ownership: 'managed',
        },
      },
      managedScripts: {},
    }

    await expect(
      buildPlan(Object.freeze({ ...context, manifest }), [
        managedFileIntent(
          'quality',
          'eslint.config.mjs',
          'export default [next]\n',
          0o644,
          'lint',
        ),
      ]),
    ).rejects.toThrow('User-modified managed file: eslint.config.mjs')
  })
})
