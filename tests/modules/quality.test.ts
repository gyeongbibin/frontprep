import { chmod, readFile, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { FileSystem } from '../../src/core/filesystem.js'
import { configFragmentIntent, scriptIntent } from '../../src/core/intents.js'
import { buildPlan } from '../../src/core/plan-builder.js'
import { detectProject } from '../../src/core/project-detector.js'
import { qualityModule } from '../../src/modules/quality.js'
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

describe('quality module', () => {
  it('plans the deterministic quality foundation for a clean project', async () => {
    const project = await createProject()
    const context = await detectProject(project.root)
    const imported = await import('../../src/modules/quality.js')

    const analysis = await imported.qualityModule.analyze(context)
    const intents = await imported.qualityModule.plan(context, analysis)

    expect(imported.qualityModule.id).toBe('quality')
    expect(imported.qualityModule.version).toBe('2.0.0')
    expect(
      intents
        .filter((intent) => intent.kind === 'dependency')
        .map(({ name, range, section }) => ({ name, range, section })),
    ).toEqual([
      { name: 'eslint', range: '^9.39.0', section: 'devDependencies' },
      {
        name: 'eslint-config-next',
        range: '^16.0.0',
        section: 'devDependencies',
      },
      { name: 'prettier', range: '^3.0.0', section: 'devDependencies' },
    ])
    expect(
      intents
        .filter((intent) => intent.kind === 'script')
        .map(({ command, name, policy }) => ({ command, name, policy })),
    ).toEqual([
      {
        command: 'eslint . --max-warnings=0',
        name: 'frontprep:lint',
        policy: 'owned',
      },
      {
        command: 'eslint . --fix --max-warnings=0',
        name: 'frontprep:lint:fix',
        policy: 'owned',
      },
      {
        command: 'prettier --write .',
        name: 'frontprep:format',
        policy: 'owned',
      },
      {
        command: 'prettier --check .',
        name: 'frontprep:format:check',
        policy: 'owned',
      },
      {
        command: 'tsc --noEmit',
        name: 'frontprep:typecheck',
        policy: 'owned',
      },
      {
        command:
          'pnpm run frontprep:lint && pnpm run frontprep:format:check && pnpm run frontprep:typecheck',
        name: 'frontprep:quality',
        policy: 'owned',
      },
      {
        command: 'pnpm run frontprep:quality',
        name: 'frontprep:check',
        policy: 'owned',
      },
      {
        command: 'pnpm run frontprep:lint',
        name: 'lint',
        policy: 'preserve-existing',
      },
      {
        command: 'pnpm run frontprep:lint:fix',
        name: 'lint:fix',
        policy: 'preserve-existing',
      },
      {
        command: 'pnpm run frontprep:format',
        name: 'format',
        policy: 'preserve-existing',
      },
      {
        command: 'pnpm run frontprep:format:check',
        name: 'format:check',
        policy: 'preserve-existing',
      },
      {
        command: 'pnpm run frontprep:typecheck',
        name: 'typecheck',
        policy: 'preserve-existing',
      },
      {
        command: 'pnpm run frontprep:quality',
        name: 'quality',
        policy: 'preserve-existing',
      },
      {
        command: 'pnpm run frontprep:check',
        name: 'check',
        policy: 'preserve-existing',
      },
    ])
    expect(
      intents
        .filter((intent) => intent.kind === 'managed-file')
        .map(({ mode, path }) => ({ mode, path })),
    ).toEqual([
      { mode: 0o644, path: 'eslint.config.mjs' },
      { mode: 0o644, path: '.editorconfig' },
    ])
    expect(
      intents.find((intent) => intent.kind === 'config-fragment'),
    ).toMatchObject({
      composer: 'prettier',
      values: {
        arrowParens: 'always',
        bracketSameLine: false,
        bracketSpacing: true,
        endOfLine: 'lf',
        printWidth: 100,
        proseWrap: 'preserve',
        semi: false,
        singleQuote: true,
        tabWidth: 2,
        trailingComma: 'all',
        useTabs: false,
      },
    })
    expect(intents.find((intent) => intent.kind === 'line-set')).toMatchObject({
      lines: ['.next', 'coverage', 'dist', 'node_modules', 'pnpm-lock.yaml'],
      path: '.prettierignore',
    })
  })

  it.each([
    ['eslint.config.js', 'ESLint'],
    ['eslint.config.cjs', 'ESLint'],
    ['eslint.config.ts', 'ESLint'],
    ['eslint.config.mts', 'ESLint'],
    ['eslint.config.cts', 'ESLint'],
    ['.eslintrc', 'ESLint'],
    ['.eslintrc.js', 'ESLint'],
    ['.eslintrc.cjs', 'ESLint'],
    ['.eslintrc.json', 'ESLint'],
    ['.eslintrc.yaml', 'ESLint'],
    ['.eslintrc.yml', 'ESLint'],
    ['.prettierrc', 'Prettier'],
    ['.prettierrc.json', 'Prettier'],
    ['.prettierrc.yml', 'Prettier'],
    ['.prettierrc.yaml', 'Prettier'],
    ['.prettierrc.json5', 'Prettier'],
    ['.prettierrc.js', 'Prettier'],
    ['.prettierrc.cjs', 'Prettier'],
    ['.prettierrc.mjs', 'Prettier'],
    ['.prettierrc.ts', 'Prettier'],
    ['.prettierrc.mts', 'Prettier'],
    ['.prettierrc.cts', 'Prettier'],
    ['.prettierrc.toml', 'Prettier'],
    ['prettier.config.js', 'Prettier'],
    ['prettier.config.cjs', 'Prettier'],
    ['prettier.config.ts', 'Prettier'],
    ['prettier.config.mts', 'Prettier'],
    ['prettier.config.cts', 'Prettier'],
  ])(
    'rejects the alternate %s configuration instead of creating an ambiguous setup',
    async (path, tool) => {
      const project = await createProject()
      await writeFile(join(project.root, path), 'export default {}\n')
      const context = await detectProject(project.root)

      await expect(qualityModule.analyze(context)).rejects.toThrow(
        `${tool} configuration conflicts at ${path}.`,
      )
    },
  )

  it.each([
    ['src/eslint.config.js', 'ESLint'],
    ['src/.prettierrc', 'Prettier'],
    ['src/.editorconfig', 'EditorConfig'],
  ])('rejects nested configuration at %s', async (path, tool) => {
    const project = await createProject()
    await writeFile(join(project.root, path), 'export default {}\n')
    const context = await detectProject(project.root)

    await expect(qualityModule.analyze(context)).rejects.toThrow(
      `${tool} configuration conflicts at ${path}.`,
    )
  })

  it.each([
    ['eslintConfig', 'ESLint'],
    ['prettier', 'Prettier'],
  ])('rejects nested package.json#%s configuration', async (key, tool) => {
    const project = await createProject()
    await writeFile(
      join(project.root, 'src/package.json'),
      `${JSON.stringify({ [key]: {} }, null, 2)}\n`,
    )
    const context = await detectProject(project.root)

    await expect(qualityModule.analyze(context)).rejects.toThrow(
      `${tool} configuration conflicts at src/package.json#${key}.`,
    )
  })

  it.each([
    ['eslintConfig', 'ESLint'],
    ['prettier', 'Prettier'],
  ])(
    'rejects package.json#%s instead of creating an ambiguous %s setup',
    async (key, tool) => {
      const project = await createProject()
      const packagePath = join(project.root, 'package.json')
      const packageJson = JSON.parse(
        await readFile(packagePath, 'utf8'),
      ) as Record<string, unknown>
      packageJson[key] = {}
      await writeFile(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`)
      const context = await detectProject(project.root)

      await expect(qualityModule.analyze(context)).rejects.toThrow(
        `${tool} configuration conflicts at package.json#${key}.`,
      )
    },
  )

  it.each([
    ['eslint.config.mjs', 'ESLint'],
    ['prettier.config.mjs', 'Prettier'],
    ['.editorconfig', 'EditorConfig'],
  ])(
    'rejects differing user-owned canonical config at %s',
    async (path, tool) => {
      const project = await createProject()
      await writeFile(join(project.root, path), 'user-owned configuration\n')
      const context = await detectProject(project.root)

      await expect(qualityModule.analyze(context)).rejects.toThrow(
        `${tool} configuration conflicts at ${path}.`,
      )
    },
  )

  it('aggregates missing dependencies, scripts, and configuration files', async () => {
    const project = await createProject()
    const context = await detectProject(project.root)

    const result = await qualityModule.verify(context)

    expect(result.valid).toBe(false)
    expect(result.issues).toEqual(
      expect.arrayContaining([
        {
          message: 'Dependency eslint must satisfy ^9.39.0.',
          path: 'package.json',
        },
        {
          message:
            'Frontprep-owned script frontprep:lint is missing or changed.',
          path: 'package.json',
        },
        {
          message: 'Conventional script lint is missing.',
          path: 'package.json',
        },
        {
          message: 'Managed Quality configuration is missing or changed.',
          path: 'eslint.config.mjs',
        },
        {
          message: 'Managed Quality configuration is missing or changed.',
          path: '.editorconfig',
        },
        {
          message: 'Prettier base configuration is missing or changed.',
          path: 'prettier.config.mjs',
        },
        {
          message:
            'Required Prettier ignore entries are missing: .next, coverage, dist, node_modules, pnpm-lock.yaml.',
          path: '.prettierignore',
        },
      ]),
    )
  })

  it('applies, verifies, and replans without replacing user-owned aliases', async () => {
    const project = await createProject()
    const packagePath = join(project.root, 'package.json')
    const packageJson = JSON.parse(await readFile(packagePath, 'utf8')) as {
      scripts?: Record<string, string>
    }
    packageJson.scripts = { lint: 'custom-lint .' }
    await writeFile(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`)
    await writeFile(join(project.root, '.prettierignore'), 'storybook-static\n')

    const context = await detectProject(project.root)
    const analysis = await qualityModule.analyze(context)
    const plan = await buildPlan(
      context,
      await qualityModule.plan(context, analysis),
    )
    await applyOperations(project.root, plan.operations)

    const updatedContext = await detectProject(project.root)
    const verification = await qualityModule.verify(updatedContext)
    const updatedPackage = updatedContext.packageJson
    expect(verification).toEqual({ issues: [], valid: true })
    expect(updatedPackage.devDependencies).toMatchObject({
      eslint: '^9.39.0',
      'eslint-config-next': '^16.0.0',
      prettier: '^3.0.0',
    })
    expect(updatedPackage.scripts).toMatchObject({
      lint: 'custom-lint .',
      format: 'pnpm run frontprep:format',
      quality: 'pnpm run frontprep:quality',
      check: 'pnpm run frontprep:check',
      'frontprep:lint': 'eslint . --max-warnings=0',
      'frontprep:quality':
        'pnpm run frontprep:lint && pnpm run frontprep:format:check && pnpm run frontprep:typecheck',
      'frontprep:check': 'pnpm run frontprep:quality',
    })
    expect(await readFile(join(project.root, '.prettierignore'), 'utf8')).toBe(
      'storybook-static\n.next\ncoverage\ndist\nnode_modules\npnpm-lock.yaml\n',
    )

    const secondAnalysis = await qualityModule.analyze(updatedContext)
    const secondPlan = await buildPlan(
      updatedContext,
      await qualityModule.plan(updatedContext, secondAnalysis),
    )
    expect(secondPlan.operations).toEqual([])
  })

  it('reports changed managed modes and required Prettier values together', async () => {
    const project = await createProject()
    const context = await detectProject(project.root)
    const analysis = await qualityModule.analyze(context)
    const plan = await buildPlan(
      context,
      await qualityModule.plan(context, analysis),
    )
    await applyOperations(project.root, plan.operations)
    await chmod(join(project.root, '.editorconfig'), 0o600)
    const prettierPath = join(project.root, 'prettier.config.mjs')
    const prettierConfig = await readFile(prettierPath, 'utf8')
    await writeFile(
      prettierPath,
      prettierConfig.replace('semi: false', 'semi: true'),
    )

    const changedContext = await detectProject(project.root)
    const result = await qualityModule.verify(changedContext)

    expect(result.valid).toBe(false)
    expect(result.issues).toEqual(
      expect.arrayContaining([
        {
          message: 'Managed Quality configuration is missing or changed.',
          path: '.editorconfig',
        },
        {
          message: 'Prettier base configuration is missing or changed.',
          path: 'prettier.config.mjs',
        },
      ]),
    )
  })

  it('accepts a frontprep check pipeline extended once by a later module', async () => {
    const project = await createProject()
    const context = await detectProject(project.root)
    const analysis = await qualityModule.analyze(context)
    const qualityIntents = await qualityModule.plan(context, analysis)
    const plan = await buildPlan(context, [
      ...qualityIntents,
      scriptIntent(
        'test',
        'frontprep:check',
        'pnpm run frontprep:test',
        'append-once',
        'Test extends the full check pipeline.',
      ),
    ])
    await applyOperations(project.root, plan.operations)

    const updatedContext = await detectProject(project.root)
    const result = await qualityModule.verify(updatedContext)

    expect(updatedContext.packageJson.scripts?.['frontprep:check']).toBe(
      'pnpm run frontprep:quality && pnpm run frontprep:test',
    )
    expect(result).toEqual({ issues: [], valid: true })
  })

  it('rejects a frontprep check pipeline with a duplicated Quality stage', async () => {
    const project = await createProject()
    const context = await detectProject(project.root)
    const analysis = await qualityModule.analyze(context)
    const plan = await buildPlan(
      context,
      await qualityModule.plan(context, analysis),
    )
    await applyOperations(project.root, plan.operations)
    const packagePath = join(project.root, 'package.json')
    const packageJson = JSON.parse(await readFile(packagePath, 'utf8')) as {
      scripts: Record<string, string>
    }
    packageJson.scripts['frontprep:check'] =
      'pnpm run frontprep:quality && pnpm run frontprep:test && pnpm run frontprep:quality'
    await writeFile(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`)

    const changedContext = await detectProject(project.root)
    const result = await qualityModule.verify(changedContext)

    expect(result.issues).toContainEqual({
      message: 'Frontprep-owned script frontprep:check is missing or changed.',
      path: 'package.json',
    })
  })

  it('aggregates alternate configuration added after Quality setup', async () => {
    const project = await createProject()
    const context = await detectProject(project.root)
    const analysis = await qualityModule.analyze(context)
    const plan = await buildPlan(
      context,
      await qualityModule.plan(context, analysis),
    )
    await applyOperations(project.root, plan.operations)
    await writeFile(
      join(project.root, 'eslint.config.js'),
      'export default []\n',
    )
    await writeFile(join(project.root, 'src/.prettierrc'), '{}\n')
    const packagePath = join(project.root, 'package.json')
    const packageJson = JSON.parse(
      await readFile(packagePath, 'utf8'),
    ) as Record<string, unknown>
    packageJson.prettier = {}
    await writeFile(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`)

    const changedContext = await detectProject(project.root)
    const result = await qualityModule.verify(changedContext)

    expect(result.valid).toBe(false)
    expect(result.issues).toEqual(
      expect.arrayContaining([
        {
          message: 'ESLint configuration conflicts at eslint.config.js.',
          path: 'eslint.config.js',
        },
        {
          message: 'Prettier configuration conflicts at package.json#prettier.',
          path: 'package.json',
        },
        {
          message: 'Prettier configuration conflicts at src/.prettierrc.',
          path: 'src/.prettierrc',
        },
      ]),
    )
  })

  it('continues verification when a configuration path is not a regular file', async () => {
    const project = await createProject()
    await symlink('src/app/layout.tsx', join(project.root, 'eslint.config.mjs'))
    const context = await detectProject(project.root)

    const result = await qualityModule.verify(context)

    expect(result.valid).toBe(false)
    expect(result.issues).toEqual(
      expect.arrayContaining([
        {
          message: 'Managed Quality configuration is missing or changed.',
          path: 'eslint.config.mjs',
        },
        {
          message: 'Dependency eslint must satisfy ^9.39.0.',
          path: 'package.json',
        },
      ]),
    )
  })

  it('accepts a first-run Prettier config composed with Tailwind', async () => {
    const project = await createProject()
    const context = await detectProject(project.root)
    const analysis = await qualityModule.analyze(context)
    const qualityIntents = await qualityModule.plan(context, analysis)
    const plan = await buildPlan(context, [
      ...qualityIntents,
      configFragmentIntent(
        'tailwind',
        'prettier',
        { plugins: ['prettier-plugin-tailwindcss'] },
        'Tailwind sorts utility classes.',
      ),
    ])
    await applyOperations(project.root, plan.operations)

    const updatedContext = await detectProject(project.root)
    const result = await qualityModule.verify(updatedContext)

    expect(result).toEqual({ issues: [], valid: true })
  })

  it('rejects a symlinked nested package configuration without following it', async () => {
    const project = await createProject()
    await writeFile(
      join(project.root, 'shared-package.json'),
      '{"prettier":{"semi":true}}\n',
    )
    await symlink(
      '../shared-package.json',
      join(project.root, 'src/package.json'),
    )
    const context = await detectProject(project.root)

    await expect(qualityModule.analyze(context)).rejects.toThrow(
      'Nested package configuration could not be inspected.',
    )
  })
})
