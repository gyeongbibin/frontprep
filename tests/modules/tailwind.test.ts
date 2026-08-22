import {
  chmod,
  mkdir,
  readFile,
  rename,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { FileSystem } from '../../src/core/filesystem.js'
import { buildPlan } from '../../src/core/plan-builder.js'
import { detectProject } from '../../src/core/project-detector.js'
import { qualityModule } from '../../src/modules/quality.js'
import { tailwindModule } from '../../src/modules/tailwind.js'
import { createProject } from '../helpers/project.js'

async function applyOperations(
  root: string,
  operations: Awaited<ReturnType<typeof buildPlan>>['operations'],
): Promise<void> {
  const fileSystem = new FileSystem(root)
  for (const operation of operations) {
    await fileSystem.writeAtomic(
      operation.path,
      operation.afterBytes,
      operation.mode,
    )
  }
}

async function tailwindIntents(root: string) {
  const context = await detectProject(root)
  const analysis = await tailwindModule.analyze(context)
  return {
    analysis,
    context,
    intents: await tailwindModule.plan(context, analysis),
  }
}

describe('tailwind module', () => {
  it('plans the Tailwind v4 foundation from a src/app project context', async () => {
    const project = await createProject()
    const { analysis, context, intents } = await tailwindIntents(project.root)

    expect(tailwindModule.id).toBe('tailwind')
    expect(tailwindModule.version).toBe('1.0.0')
    expect(analysis).toMatchObject({
      stylesheetPath: 'src/app/globals.css',
      utilsDirectory: 'src/shared/utils',
    })
    expect(
      intents
        .filter((intent) => intent.kind === 'dependency')
        .map(({ name, range, section }) => ({ name, range, section })),
    ).toEqual([
      {
        name: 'class-variance-authority',
        range: '^0.7.0',
        section: 'dependencies',
      },
      { name: 'clsx', range: '^2.0.0', section: 'dependencies' },
      { name: 'tailwind-merge', range: '^3.0.0', section: 'dependencies' },
      {
        name: '@tailwindcss/postcss',
        range: '^4.0.0',
        section: 'devDependencies',
      },
      { name: 'postcss', range: '^8.0.0', section: 'devDependencies' },
      {
        name: 'prettier-plugin-tailwindcss',
        range: '^0.8.0',
        section: 'devDependencies',
      },
      { name: 'tailwindcss', range: '^4.0.0', section: 'devDependencies' },
    ])
    expect(
      intents
        .filter((intent) => intent.kind === 'managed-file')
        .map(({ mode, path }) => ({ mode, path })),
    ).toEqual([
      { mode: 0o644, path: 'postcss.config.mjs' },
      { mode: 0o644, path: 'src/shared/utils/cn.ts' },
    ])
    expect(
      intents.find((intent) => intent.kind === 'css-import'),
    ).toMatchObject({
      importValue: 'tailwindcss',
      path: 'src/app/globals.css',
    })
    expect(intents.some((intent) => intent.kind === 'static-import')).toBe(
      false,
    )
    expect(intents.find((intent) => intent.kind === 'line-set')).toMatchObject({
      lines: [
        "export { cva, type VariantProps } from 'class-variance-authority'",
        "export { cn } from './cn'",
      ],
      path: 'src/shared/utils/index.ts',
    })
    expect(
      intents.find((intent) => intent.kind === 'config-fragment'),
    ).toMatchObject({
      composer: 'prettier',
      values: {
        plugins: ['prettier-plugin-tailwindcss'],
        tailwindFunctions: ['clsx', 'cn', 'cva'],
        tailwindStylesheet: './src/app/globals.css',
      },
    })

    const qualityAnalysis = await qualityModule.analyze(context)
    const plan = await buildPlan(context, [
      ...(await qualityModule.plan(context, qualityAnalysis)),
      ...intents,
    ])
    expect(plan.operations.map(({ path }) => path)).toEqual(
      expect.arrayContaining([
        'package.json',
        'postcss.config.mjs',
        'prettier.config.mjs',
        'src/app/globals.css',
        'src/shared/utils/cn.ts',
        'src/shared/utils/index.ts',
      ]),
    )
  })

  it('uses root-relative app paths and adds a missing layout import', async () => {
    const project = await createProject({
      appDirectory: 'app',
      layout: 'export default function Layout() { return null }\n',
    })

    const { intents } = await tailwindIntents(project.root)

    expect(
      intents.find((intent) => intent.kind === 'static-import'),
    ).toMatchObject({
      importValue: './globals.css',
      path: 'app/layout.tsx',
    })
    expect(intents.find((intent) => intent.kind === 'line-set')).toMatchObject({
      path: 'shared/utils/index.ts',
    })
    expect(
      intents
        .filter((intent) => intent.kind === 'managed-file')
        .map(({ path }) => path),
    ).toContain('shared/utils/cn.ts')
  })

  it('targets the stylesheet actually imported by the detected layout', async () => {
    const project = await createProject()
    await mkdir(join(project.root, 'src/styles'), { recursive: true })
    await writeFile(
      join(project.root, 'src/styles/theme.css'),
      '@theme { --color-brand: red; }\n',
    )
    await writeFile(
      join(project.root, 'src/app/layout.tsx'),
      "import '../styles/theme.css'\n\nexport default function Layout() { return null }\n",
    )

    const { analysis, intents } = await tailwindIntents(project.root)

    expect(analysis.stylesheetPath).toBe('src/styles/theme.css')
    expect(
      intents.find((intent) => intent.kind === 'css-import'),
    ).toMatchObject({ path: 'src/styles/theme.css' })
    expect(
      intents.find((intent) => intent.kind === 'config-fragment'),
    ).toMatchObject({
      values: { tailwindStylesheet: './src/styles/theme.css' },
    })
  })

  it('rejects a symbolic-link root layout instead of following it', async () => {
    const project = await createProject()
    const layoutPath = join(project.root, 'src/app/layout.tsx')
    await rename(layoutPath, join(project.root, 'src/app/layout.actual.tsx'))
    await symlink('layout.actual.tsx', layoutPath)
    const context = await detectProject(project.root)

    await expect(tailwindModule.analyze(context)).rejects.toThrow(
      'Root layout must be a regular file: src/app/layout.tsx.',
    )
  })

  it.each([
    ['src/shared/utils', 'src/shared/utils'],
    ['src/lib/utils', 'src/lib/utils'],
    ['src/utils', 'src/utils'],
  ])(
    'reuses the single existing utility directory %s',
    async (path, expected) => {
      const project = await createProject()
      await mkdir(join(project.root, path), { recursive: true })

      const { analysis } = await tailwindIntents(project.root)

      expect(analysis.utilsDirectory).toBe(expected)
    },
  )

  it('rejects multiple existing utility directories instead of guessing', async () => {
    const project = await createProject()
    await mkdir(join(project.root, 'src/lib/utils'), { recursive: true })
    await mkdir(join(project.root, 'src/utils'), { recursive: true })
    const context = await detectProject(project.root)

    await expect(tailwindModule.analyze(context)).rejects.toThrow(
      'Multiple utility directories were detected: src/lib/utils, src/utils.',
    )
  })

  it.each(['symbolic link', 'non-directory'])(
    'rejects a %s utility candidate',
    async (kind) => {
      const project = await createProject()
      const candidate = join(project.root, 'src/utils')
      if (kind === 'symbolic link') {
        await symlink('app', candidate)
      } else {
        await writeFile(candidate, 'not a directory\n')
      }
      const context = await detectProject(project.root)

      await expect(tailwindModule.analyze(context)).rejects.toThrow(
        'Utility path must be a real directory: src/utils.',
      )
    },
  )

  it.each([
    ['postcss.config.js', 'PostCSS'],
    ['.postcssrc', 'PostCSS'],
    ['tailwind.config.ts', 'Legacy Tailwind'],
  ])('rejects conflicting %s configuration', async (path, tool) => {
    const project = await createProject()
    await writeFile(join(project.root, path), 'export default {}\n')
    const context = await detectProject(project.root)

    await expect(tailwindModule.analyze(context)).rejects.toThrow(
      `${tool} configuration conflicts at ${path}.`,
    )
  })

  it('rejects package.json#postcss', async () => {
    const project = await createProject()
    const packagePath = join(project.root, 'package.json')
    const packageJson = JSON.parse(
      await readFile(packagePath, 'utf8'),
    ) as Record<string, unknown>
    packageJson.postcss = {}
    await writeFile(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`)
    const context = await detectProject(project.root)

    await expect(tailwindModule.analyze(context)).rejects.toThrow(
      'PostCSS configuration conflicts at package.json#postcss.',
    )
  })

  it.each([
    [
      '@import "tailwindcss";\n@import "tailwindcss";\nbody {}\n',
      'Tailwind stylesheet import is duplicated.',
    ],
    [
      "@import 'tailwindcss';\nbody {}\n",
      'Tailwind stylesheet import is not canonical.',
    ],
    [
      '@tailwind base;\nbody {}\n',
      'Legacy Tailwind directives are not supported.',
    ],
    [
      'body {}\n@import "tailwindcss";\n',
      'Tailwind stylesheet import must be the first line.',
    ],
  ])('rejects an incompatible stylesheet', async (contents, message) => {
    const project = await createProject()
    await writeFile(join(project.root, 'src/app/globals.css'), contents)
    const context = await detectProject(project.root)

    await expect(tailwindModule.analyze(context)).rejects.toThrow(message)
  })

  it('preserves unrelated barrel exports and appends only missing exports', async () => {
    const project = await createProject()
    await mkdir(join(project.root, 'src/lib/utils'), { recursive: true })
    await writeFile(
      join(project.root, 'src/lib/utils/index.ts'),
      "export { formatDate } from './date'\nexport { cn } from './cn'\n",
    )

    const { intents } = await tailwindIntents(project.root)
    const lineSet = intents.find((intent) => intent.kind === 'line-set')

    expect(lineSet).toMatchObject({
      lines: [
        "export { cva, type VariantProps } from 'class-variance-authority'",
      ],
      path: 'src/lib/utils/index.ts',
    })
  })

  it.each([
    "export { cn as mergeClasses } from './cn'\n",
    "export { cva } from 'class-variance-authority'\n",
    'export type VariantProps = string\n',
  ])('rejects a conflicting utility barrel symbol', async (contents) => {
    const project = await createProject()
    await mkdir(join(project.root, 'src/shared/utils'), { recursive: true })
    await writeFile(join(project.root, 'src/shared/utils/index.ts'), contents)
    const context = await detectProject(project.root)

    await expect(tailwindModule.analyze(context)).rejects.toThrow(
      'Utility barrel has a conflicting required symbol.',
    )
  })

  it('applies, verifies, and replans idempotently with Quality', async () => {
    const project = await createProject()
    await writeFile(
      join(project.root, 'src/app/globals.css'),
      '@theme { --color-brand: red; }\nbody {}\n',
    )
    const context = await detectProject(project.root)
    const qualityAnalysis = await qualityModule.analyze(context)
    const tailwindAnalysis = await tailwindModule.analyze(context)
    const plan = await buildPlan(context, [
      ...(await qualityModule.plan(context, qualityAnalysis)),
      ...(await tailwindModule.plan(context, tailwindAnalysis)),
    ])
    await applyOperations(project.root, plan.operations)

    const updatedContext = await detectProject(project.root)
    const verification = await tailwindModule.verify(updatedContext)
    expect(verification).toEqual({ issues: [], valid: true })
    expect(
      await readFile(join(project.root, 'src/app/globals.css'), 'utf8'),
    ).toBe(
      '@import "tailwindcss";\n\n@theme { --color-brand: red; }\nbody {}\n',
    )
    expect(
      await readFile(join(project.root, 'prettier.config.mjs'), 'utf8'),
    ).toContain("tailwindStylesheet: './src/app/globals.css'")

    const secondAnalysis = await tailwindModule.analyze(updatedContext)
    const secondPlan = await buildPlan(updatedContext, [
      ...(await qualityModule.plan(updatedContext, qualityAnalysis)),
      ...(await tailwindModule.plan(updatedContext, secondAnalysis)),
    ])
    expect(secondPlan.operations).toEqual([])
  })

  it('accepts a canonical first-line import in an existing CRLF stylesheet', async () => {
    const project = await createProject()
    await writeFile(
      join(project.root, 'src/app/globals.css'),
      '@import "tailwindcss";\r\nbody {}\r\n',
    )
    const context = await detectProject(project.root)
    const qualityAnalysis = await qualityModule.analyze(context)
    const tailwindAnalysis = await tailwindModule.analyze(context)
    const plan = await buildPlan(context, [
      ...(await qualityModule.plan(context, qualityAnalysis)),
      ...(await tailwindModule.plan(context, tailwindAnalysis)),
    ])
    await applyOperations(project.root, plan.operations)

    const updatedContext = await detectProject(project.root)
    const result = await tailwindModule.verify(updatedContext)

    expect(result).toEqual({ issues: [], valid: true })
  })

  it('aggregates independent verification failures', async () => {
    const project = await createProject()
    const context = await detectProject(project.root)

    const result = await tailwindModule.verify(context)

    expect(result.valid).toBe(false)
    expect(result.issues).toEqual(
      expect.arrayContaining([
        {
          message: 'Dependency tailwindcss must satisfy ^4.0.0.',
          path: 'package.json',
        },
        {
          message: 'Managed Tailwind configuration is missing or changed.',
          path: 'postcss.config.mjs',
        },
        {
          message: 'Tailwind stylesheet import is missing or changed.',
          path: 'src/app/globals.css',
        },
        {
          message: 'Managed class utility is missing or changed.',
          path: 'src/shared/utils/cn.ts',
        },
        {
          message: 'Required utility barrel exports are missing or changed.',
          path: 'src/shared/utils/index.ts',
        },
        {
          message: 'Tailwind Prettier configuration is missing or changed.',
          path: 'prettier.config.mjs',
        },
      ]),
    )
  })

  it('does not accept Tailwind-shaped values outside the managed Prettier ESM shape', async () => {
    const project = await createProject()
    const context = await detectProject(project.root)
    const qualityAnalysis = await qualityModule.analyze(context)
    const tailwindAnalysis = await tailwindModule.analyze(context)
    const plan = await buildPlan(context, [
      ...(await qualityModule.plan(context, qualityAnalysis)),
      ...(await tailwindModule.plan(context, tailwindAnalysis)),
    ])
    await applyOperations(project.root, plan.operations)
    await writeFile(
      join(project.root, 'prettier.config.mjs'),
      `const unrelated = {
  plugins: ['prettier-plugin-tailwindcss'],
  tailwindFunctions: ['clsx', 'cn', 'cva'],
  tailwindStylesheet: './src/app/globals.css',
}

export default unrelated
`,
    )

    const updatedContext = await detectProject(project.root)
    const result = await tailwindModule.verify(updatedContext)

    expect(result.issues).toContainEqual({
      message: 'Tailwind Prettier configuration is missing or changed.',
      path: 'prettier.config.mjs',
    })
  })

  it('reports changed managed modes and post-install conflicts together', async () => {
    const project = await createProject()
    const context = await detectProject(project.root)
    const qualityAnalysis = await qualityModule.analyze(context)
    const tailwindAnalysis = await tailwindModule.analyze(context)
    const plan = await buildPlan(context, [
      ...(await qualityModule.plan(context, qualityAnalysis)),
      ...(await tailwindModule.plan(context, tailwindAnalysis)),
    ])
    await applyOperations(project.root, plan.operations)
    await chmod(join(project.root, 'postcss.config.mjs'), 0o600)
    await writeFile(
      join(project.root, 'tailwind.config.js'),
      'export default {}\n',
    )

    const updatedContext = await detectProject(project.root)
    const result = await tailwindModule.verify(updatedContext)

    expect(result.issues).toEqual(
      expect.arrayContaining([
        {
          message: 'Managed Tailwind configuration is missing or changed.',
          path: 'postcss.config.mjs',
        },
        {
          message:
            'Legacy Tailwind configuration conflicts at tailwind.config.js.',
          path: 'tailwind.config.js',
        },
      ]),
    )
  })
})
