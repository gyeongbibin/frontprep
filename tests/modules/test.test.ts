import {
  access,
  chmod,
  mkdir,
  readFile,
  rename,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  createCommandServices,
  runInit,
  type CommandReporter,
} from '../../src/commands/init.js'
import { FileSystem, hashBytes } from '../../src/core/filesystem.js'
import type { GitHooksService } from '../../src/core/git-hooks.js'
import { buildPlan } from '../../src/core/plan-builder.js'
import { detectProject } from '../../src/core/project-detector.js'
import {
  applyPlan,
  type PackageManagerService,
} from '../../src/core/transaction.js'
import type { FrontprepManifest, ProjectContext } from '../../src/core/types.js'
import type { ModuleId } from '../../src/core/types.js'
import { qualityModule } from '../../src/modules/quality.js'
import { testModule } from '../../src/modules/test.js'
import type { SetupModule } from '../../src/modules/types.js'
import { manifestV2 } from '../helpers/manifest.js'
import { createProject } from '../helpers/project.js'

class SilentReporter implements CommandReporter {
  alreadyApplied(): void {}
  detected(): void {}
  filesChanged(): void {}
  header(): void {}
  modulePassed(): void {}
  noFilesChanged(): void {}
  projectPassed(): void {}
}

class RecordingPackageManager implements PackageManagerService {
  installs = 0
  supportedChecks = 0

  async assertSupported(): Promise<void> {
    this.supportedChecks += 1
  }

  async install(): Promise<void> {
    this.installs += 1
  }
}

const PASSIVE_GIT_HOOKS: GitHooksService = {
  async activate() {
    return null
  },
  async restore() {},
}

function passiveModule(id: ModuleId): SetupModule<null> {
  return {
    id,
    version: '1.0.0',
    async analyze() {
      return null
    },
    async plan() {
      return []
    },
    async verify() {
      return { issues: [], valid: true }
    },
  }
}

function testCommandServices(
  packageManager: PackageManagerService,
  runProjectCheck: () => Promise<void> = async () => undefined,
) {
  const base = createCommandServices(new SilentReporter(), [
    qualityModule,
    passiveModule('tailwind'),
    testModule,
    passiveModule('git-hooks'),
    passiveModule('ci'),
  ])
  return {
    ...base,
    applyPlan: (context, plan, services) =>
      applyPlan(context, plan, {
        ...services,
        assertGitState: async () => undefined,
        packageManager,
      }),
    assertSafeGitState: async () => undefined,
    gitHooks: PASSIVE_GIT_HOOKS,
    runProjectCheck,
  } satisfies typeof base
}

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

async function qualityAndTestPlan(root: string) {
  const context = await detectProject(root)
  const qualityAnalysis = await qualityModule.analyze(context)
  const testAnalysis = await testModule.analyze(context)
  return buildPlan(context, [
    ...(await qualityModule.plan(context, qualityAnalysis)),
    ...(await testModule.plan(context, testAnalysis)),
  ])
}

function withManagedFile(
  context: ProjectContext,
  path: string,
  bytes: Buffer,
): ProjectContext {
  const manifest: FrontprepManifest = manifestV2({
    frontprepVersion: '0.1.0-beta.0',
    files: {
      package: {
        [path]: {
          hash: hashBytes(bytes),
          mode: '0644',
          ownership: 'managed',
        },
      },
      repository: {},
    },
    managedScripts: {},
  })
  return Object.freeze({ ...context, manifest: Object.freeze(manifest) })
}

describe('test module', () => {
  it('plans the Vitest foundation from a src/app project context', async () => {
    const project = await createProject()
    const context = await detectProject(project.root)

    const analysis = await testModule.analyze(context)
    const intents = await testModule.plan(context, analysis)

    expect(testModule.id).toBe('test')
    expect(testModule.version).toBe('3.0.0')
    expect(analysis).toEqual({
      setupDirectory: 'src/test',
      setupPath: 'src/test/setup.ts',
    })
    expect(
      intents
        .filter((intent) => intent.kind === 'dependency')
        .map(({ name, range, section }) => ({ name, range, section })),
    ).toEqual([
      {
        name: '@testing-library/dom',
        range: '^10.0.0',
        section: 'devDependencies',
      },
      {
        name: '@testing-library/jest-dom',
        range: '>=6.0.0 <6.10.0',
        section: 'devDependencies',
      },
      {
        name: '@testing-library/react',
        range: '^16.0.0',
        section: 'devDependencies',
      },
      {
        name: '@vitejs/plugin-react',
        range: '^4.7.0',
        section: 'devDependencies',
      },
      { name: 'jsdom', range: '^26.0.0', section: 'devDependencies' },
      { name: 'vite', range: '^6.0.0', section: 'devDependencies' },
      {
        name: 'vite-tsconfig-paths',
        range: '^6.0.0',
        section: 'devDependencies',
      },
      { name: 'vitest', range: '^4.0.0', section: 'devDependencies' },
    ])
    expect(
      intents
        .filter((intent) => intent.kind === 'script')
        .map(({ command, name, policy }) => ({ command, name, policy })),
    ).toEqual([
      {
        command: 'vitest run',
        name: 'frontprep:test',
        policy: 'owned',
      },
      {
        command: 'pnpm run frontprep:test',
        name: 'frontprep:check',
        policy: 'append-once',
      },
      {
        command: 'vitest',
        name: 'test',
        policy: 'preserve-existing',
      },
      {
        command: 'vitest run',
        name: 'test:run',
        policy: 'preserve-existing',
      },
    ])
    expect(
      intents
        .filter((intent) => intent.kind === 'managed-file')
        .map(({ content, mode, path }) => ({ content, mode, path })),
    ).toEqual([
      {
        content: `import react from '@vitejs/plugin-react'
import { configDefaults, defineConfig } from 'vitest/config'
import tsconfigPaths from 'vite-tsconfig-paths'

export default defineConfig({
  plugins: [tsconfigPaths(), react()],
  test: {
    environment: 'jsdom',
    exclude: [...configDefaults.exclude, '**/{__fixtures__,fixtures}/**'],
    include: ['src/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}'],
    passWithNoTests: true,
    setupFiles: ['./src/test/setup.ts'],
  },
})
`,
        mode: 0o644,
        path: 'vitest.config.mts',
      },
      {
        content: `import '@testing-library/jest-dom/vitest'
import { cleanup } from '@testing-library/react'
import { afterEach } from 'vitest'

afterEach(() => {
  cleanup()
})
`,
        mode: 0o644,
        path: 'src/test/setup.ts',
      },
    ])
  })

  it('uses root-relative test paths for an app project', async () => {
    const project = await createProject({ appDirectory: 'app' })
    const context = await detectProject(project.root)

    const analysis = await testModule.analyze(context)
    const intents = await testModule.plan(context, analysis)

    expect(analysis).toEqual({
      setupDirectory: 'test',
      setupPath: 'test/setup.ts',
    })
    expect(
      intents
        .filter((intent) => intent.kind === 'managed-file')
        .map(({ content, path }) => ({ content, path })),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          content: expect.stringMatching(
            /include: \[\s+'app\/\*\*\/\*\.\{test,spec\}\.\{js,mjs,cjs,ts,mts,cts,jsx,tsx\}',\s+'test\/\*\*\/\*\.\{test,spec\}\.\{js,mjs,cjs,ts,mts,cts,jsx,tsx\}',\s+\]/u,
          ),
          path: 'vitest.config.mts',
        }),
        expect.objectContaining({ path: 'test/setup.ts' }),
      ]),
    )
  })

  it.each([
    ['src/test', 'src/test/setup.ts'],
    ['tests/unit', 'tests/unit/setup.ts'],
  ])(
    'uses the explicitly selected test directory %s',
    async (path, expected) => {
      const project = await createProject()
      await mkdir(join(project.root, path), { recursive: true })
      const context = await detectProject(project.root, { testDirectory: path })

      const analysis = await testModule.analyze(context)
      const intents = await testModule.plan(context, analysis)
      const config = intents.find(
        (intent) =>
          intent.kind === 'managed-file' && intent.path === 'vitest.config.mts',
      )

      expect(analysis.setupPath).toBe(expected)
      expect(config?.kind).toBe('managed-file')
      if (config?.kind !== 'managed-file') return
      expect(config.content).toContain(
        "'src/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}'",
      )
      if (path === 'tests/unit') {
        expect(config.content).toContain(
          "'tests/unit/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}'",
        )
      } else {
        expect(config.content.match(/src\/\*\*\//gu)).toHaveLength(1)
      }
    },
  )

  it('does not let a conventional directory override the resolved default', async () => {
    const project = await createProject()
    await mkdir(join(project.root, 'src/tests'), { recursive: true })
    const context = await detectProject(project.root)

    await expect(testModule.analyze(context)).resolves.toMatchObject({
      setupPath: 'src/test/setup.ts',
    })
  })

  it('rejects a test candidate that is not a directory', async () => {
    const project = await createProject()
    await writeFile(join(project.root, 'src/tests'), 'not a directory\n')
    await expect(
      detectProject(project.root, { testDirectory: 'src/tests' }),
    ).rejects.toThrow(
      '--test-dir must be a real directory or a missing directory: src/tests.',
    )
  })

  it('rejects a symbolic-link test directory instead of following it', async () => {
    const project = await createProject()
    await mkdir(join(project.root, 'src/test-target'), { recursive: true })
    await symlink('test-target', join(project.root, 'src/test'))
    await expect(detectProject(project.root)).rejects.toThrow(
      '--test-dir contains a symbolic link: src/test.',
    )
  })

  it('rejects a symbolic-link source directory before selecting a test path', async () => {
    const project = await createProject()
    await rename(join(project.root, 'src'), join(project.root, 'source'))
    await symlink('source', join(project.root, 'src'), 'dir')
    await expect(detectProject(project.root)).rejects.toThrow('symbolic link')
  })

  it.each([
    'vitest.config.js',
    'vitest.config.cjs',
    'vitest.config.mjs',
    'vitest.config.ts',
    'vitest.config.cts',
  ])('rejects alternate Vitest configuration at %s', async (path) => {
    const project = await createProject()
    await writeFile(join(project.root, path), 'export default {}\n')
    const context = await detectProject(project.root)

    await expect(testModule.analyze(context)).rejects.toThrow(
      `Vitest configuration conflicts at ${path}.`,
    )
  })

  it.each(['vitest.workspace.ts', 'vitest.workspace.mts'])(
    'rejects a Vitest workspace at %s',
    async (path) => {
      const project = await createProject()
      await writeFile(join(project.root, path), 'export default []\n')
      const context = await detectProject(project.root)

      await expect(testModule.analyze(context)).rejects.toThrow(
        `Vitest workspace configuration conflicts at ${path}.`,
      )
    },
  )

  it.each(['jest.config.js', 'jest.config.cjs', 'jest.config.ts'])(
    'rejects Jest configuration at %s',
    async (path) => {
      const project = await createProject()
      await writeFile(join(project.root, path), 'export default {}\n')
      const context = await detectProject(project.root)

      await expect(testModule.analyze(context)).rejects.toThrow(
        `Jest configuration conflicts at ${path}.`,
      )
    },
  )

  it('rejects package.json#jest configuration', async () => {
    const project = await createProject()
    const packagePath = join(project.root, 'package.json')
    const packageJson = JSON.parse(
      await readFile(packagePath, 'utf8'),
    ) as Record<string, unknown>
    packageJson.jest = { testEnvironment: 'jsdom' }
    await writeFile(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`)
    const context = await detectProject(project.root)

    await expect(testModule.analyze(context)).rejects.toThrow(
      'Jest configuration conflicts at package.json#jest.',
    )
  })

  it.each([
    'jest',
    '@jest/core',
    '@swc/jest',
    '@types/jest',
    'babel-jest',
    'jest-environment-jsdom',
    'ts-jest',
  ])('rejects the direct Jest tool %s', async (name) => {
    const project = await createProject()
    const packagePath = join(project.root, 'package.json')
    const packageJson = JSON.parse(await readFile(packagePath, 'utf8')) as {
      devDependencies?: Record<string, string>
    }
    packageJson.devDependencies = { [name]: '^1.0.0' }
    await writeFile(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`)
    const context = await detectProject(project.root)

    await expect(testModule.analyze(context)).rejects.toThrow(
      `Jest dependency conflicts at package.json#devDependencies.${name}.`,
    )
  })

  it('allows an unrelated root Vite configuration', async () => {
    const project = await createProject()
    await writeFile(
      join(project.root, 'vite.config.ts'),
      'export default { custom: true }\n',
    )
    const context = await detectProject(project.root)

    await expect(testModule.analyze(context)).resolves.toEqual({
      setupDirectory: 'src/test',
      setupPath: 'src/test/setup.ts',
    })
  })

  it('accepts exact canonical config and setup files', async () => {
    const project = await createProject()
    const context = await detectProject(project.root)
    const analysis = await testModule.analyze(context)
    const intents = await testModule.plan(context, analysis)
    for (const intent of intents.filter(
      (intent) => intent.kind === 'managed-file',
    )) {
      await mkdir(join(project.root, intent.path, '..'), { recursive: true })
      await writeFile(join(project.root, intent.path), intent.content)
    }

    const updatedContext = await detectProject(project.root)

    await expect(testModule.analyze(updatedContext)).resolves.toEqual(analysis)
  })

  it.each([
    ['vitest.config.mts', 'Vitest configuration'],
    ['src/test/setup.ts', 'Test setup'],
  ])('rejects differing user-owned %s', async (path, label) => {
    const project = await createProject()
    await mkdir(join(project.root, path, '..'), { recursive: true })
    await writeFile(join(project.root, path), 'user-owned configuration\n')
    const context = await detectProject(project.root)

    await expect(testModule.analyze(context)).rejects.toThrow(
      `${label} conflicts at ${path}.`,
    )
  })

  it('allows an unchanged manifest-owned config to be rewritten', async () => {
    const project = await createProject()
    const configPath = join(project.root, 'vitest.config.mts')
    const bytes = Buffer.from('frontprep-owned previous version\n')
    await writeFile(configPath, bytes)
    const context = withManagedFile(
      await detectProject(project.root),
      'vitest.config.mts',
      bytes,
    )

    await expect(testModule.analyze(context)).resolves.toEqual({
      setupDirectory: 'src/test',
      setupPath: 'src/test/setup.ts',
    })
  })

  it.each(['vitest.config.mts', 'src/test/setup.ts'])(
    'rejects a symbolic-link managed file at %s',
    async (path) => {
      const project = await createProject()
      const target = join(project.root, 'managed-target.ts')
      await writeFile(target, 'export default {}\n')
      await mkdir(join(project.root, path, '..'), { recursive: true })
      await symlink(target, join(project.root, path))
      const context = await detectProject(project.root)

      await expect(testModule.analyze(context)).rejects.toThrow(
        path === 'vitest.config.mts'
          ? 'Vitest configuration conflicts at vitest.config.mts.'
          : 'Test setup path contains a symbolic link: src/test/setup.ts.',
      )
    },
  )

  it('preserves a compatible existing dependency in its original section', async () => {
    const project = await createProject()
    const packagePath = join(project.root, 'package.json')
    const packageJson = JSON.parse(await readFile(packagePath, 'utf8')) as {
      dependencies?: Record<string, string>
    }
    packageJson.dependencies = {
      ...packageJson.dependencies,
      vitest: '^4.1.0',
    }
    await writeFile(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`)
    const context = await detectProject(project.root)
    const analysis = await testModule.analyze(context)
    const plan = await buildPlan(
      context,
      await testModule.plan(context, analysis),
    )
    const packageOperation = plan.operations.find(
      ({ path }) => path === 'package.json',
    )
    const updatedPackage = JSON.parse(
      packageOperation?.afterBytes.toString('utf8') ?? '{}',
    ) as {
      dependencies?: Record<string, string>
      devDependencies?: Record<string, string>
    }

    expect(updatedPackage.dependencies?.vitest).toBe('^4.1.0')
    expect(updatedPackage.devDependencies?.vitest).toBeUndefined()
  })

  it('rejects an incompatible existing Test dependency before writing', async () => {
    const project = await createProject()
    const packagePath = join(project.root, 'package.json')
    const packageJson = JSON.parse(await readFile(packagePath, 'utf8')) as {
      devDependencies?: Record<string, string>
    }
    packageJson.devDependencies = { vite: '^8.0.0' }
    await writeFile(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`)
    const context = await detectProject(project.root)
    const analysis = await testModule.analyze(context)

    await expect(
      buildPlan(context, await testModule.plan(context, analysis)),
    ).rejects.toThrow(
      'Existing dependency vite@^8.0.0 is incompatible with ^6.0.0.',
    )
  })

  it('applies and verifies the Test contract while preserving user aliases', async () => {
    const project = await createProject()
    const packagePath = join(project.root, 'package.json')
    const packageJson = JSON.parse(await readFile(packagePath, 'utf8')) as {
      scripts?: Record<string, string>
    }
    packageJson.scripts = {
      test: 'custom-test-runner',
      'test:run': 'custom-test-runner --once',
    }
    await writeFile(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`)

    const plan = await qualityAndTestPlan(project.root)
    await applyOperations(project.root, plan.operations)

    const updatedContext = await detectProject(project.root)
    const result = await testModule.verify(updatedContext)

    expect(result).toEqual({ issues: [], valid: true })
    expect(updatedContext.packageJson.devDependencies).toMatchObject({
      '@testing-library/dom': '^10.0.0',
      '@testing-library/jest-dom': '>=6.0.0 <6.10.0',
      '@testing-library/react': '^16.0.0',
      '@vitejs/plugin-react': '^4.7.0',
      jsdom: '^26.0.0',
      vite: '^6.0.0',
      'vite-tsconfig-paths': '^6.0.0',
      vitest: '^4.0.0',
    })
    expect(updatedContext.packageJson.scripts).toMatchObject({
      test: 'custom-test-runner',
      'test:run': 'custom-test-runner --once',
      'frontprep:test': 'vitest run',
      'frontprep:check':
        'pnpm run frontprep:quality && pnpm run frontprep:test',
    })
  })

  it('aggregates missing dependencies, scripts, and managed files', async () => {
    const project = await createProject()
    const context = await detectProject(project.root)

    const result = await testModule.verify(context)

    expect(result.valid).toBe(false)
    expect(result.issues).toEqual(
      expect.arrayContaining([
        {
          message: 'Dependency vitest must satisfy ^4.0.0.',
          path: 'package.json',
        },
        {
          message:
            'Frontprep-owned script frontprep:test is missing or changed.',
          path: 'package.json',
        },
        {
          message: 'Conventional script test is missing.',
          path: 'package.json',
        },
        {
          message:
            'Frontprep-owned script frontprep:check is missing or changed.',
          path: 'package.json',
        },
        {
          message: 'Managed Vitest configuration is missing or changed.',
          path: 'vitest.config.mts',
        },
        {
          message: 'Managed Test setup is missing or changed.',
          path: 'src/test/setup.ts',
        },
      ]),
    )
  })

  it('accepts a later build stage in the full check pipeline', async () => {
    const project = await createProject()
    const plan = await qualityAndTestPlan(project.root)
    await applyOperations(project.root, plan.operations)
    const packagePath = join(project.root, 'package.json')
    const packageJson = JSON.parse(await readFile(packagePath, 'utf8')) as {
      scripts: Record<string, string>
    }
    packageJson.scripts['frontprep:check'] += ' && pnpm run frontprep:build'
    await writeFile(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`)

    const updatedContext = await detectProject(project.root)

    await expect(testModule.verify(updatedContext)).resolves.toEqual({
      issues: [],
      valid: true,
    })
  })

  it.each([
    ['pnpm run frontprep:test'],
    ['pnpm run frontprep:test && pnpm run frontprep:quality'],
    [
      'pnpm run frontprep:quality && pnpm run frontprep:test && pnpm run frontprep:test',
    ],
    [
      'pnpm run frontprep:quality && pnpm run frontprep:test && pnpm run frontprep:quality',
    ],
  ])('rejects the invalid full check pipeline %s', async (command) => {
    const project = await createProject()
    const plan = await qualityAndTestPlan(project.root)
    await applyOperations(project.root, plan.operations)
    const packagePath = join(project.root, 'package.json')
    const packageJson = JSON.parse(await readFile(packagePath, 'utf8')) as {
      scripts: Record<string, string>
    }
    packageJson.scripts['frontprep:check'] = command
    await writeFile(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`)

    const updatedContext = await detectProject(project.root)
    const result = await testModule.verify(updatedContext)

    expect(result.issues).toContainEqual({
      message: 'Frontprep-owned script frontprep:check is missing or changed.',
      path: 'package.json',
    })
  })

  it('reports changed managed files and post-install conflicts together', async () => {
    const project = await createProject()
    const plan = await qualityAndTestPlan(project.root)
    await applyOperations(project.root, plan.operations)
    await chmod(join(project.root, 'vitest.config.mts'), 0o600)
    await writeFile(join(project.root, 'src/test/setup.ts'), 'changed setup\n')
    await writeFile(join(project.root, 'jest.config.js'), 'export default {}\n')

    const updatedContext = await detectProject(project.root)
    const result = await testModule.verify(updatedContext)

    expect(result.valid).toBe(false)
    expect(result.issues).toEqual(
      expect.arrayContaining([
        {
          message: 'Jest configuration conflicts at jest.config.js.',
          path: 'jest.config.js',
        },
        {
          message: 'Managed Vitest configuration is missing or changed.',
          path: 'vitest.config.mts',
        },
        {
          message: 'Managed Test setup is missing or changed.',
          path: 'src/test/setup.ts',
        },
      ]),
    )
  })

  it('keeps the resolved test directory when another convention appears', async () => {
    const project = await createProject()
    const plan = await qualityAndTestPlan(project.root)
    await applyOperations(project.root, plan.operations)
    await mkdir(join(project.root, 'src/tests'), { recursive: true })

    const updatedContext = await detectProject(project.root)
    const result = await testModule.verify(updatedContext)

    expect(result.valid).toBe(true)
  })

  it('runs init twice with one install and a manifest-backed no-change rerun', async () => {
    const project = await createProject()
    const packagePath = join(project.root, 'package.json')
    const packageJson = JSON.parse(await readFile(packagePath, 'utf8')) as {
      scripts?: Record<string, string>
    }
    packageJson.scripts = { test: 'custom-test-runner' }
    await writeFile(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`)
    const packageManager = new RecordingPackageManager()
    let checks = 0
    const services = testCommandServices(packageManager, async () => {
      checks += 1
    })

    const first = await runInit({ cwd: project.root }, services)
    const second = await runInit({ cwd: project.root }, services)

    expect(first.changed).toBe(true)
    expect(first.changedFiles).toEqual(
      expect.arrayContaining([
        { path: 'package.json', scope: 'package' },
        { path: 'vitest.config.mts', scope: 'package' },
        { path: 'src/test/setup.ts', scope: 'package' },
      ]),
    )
    expect(first.manifest?.files.package).toMatchObject({
      'vitest.config.mts': { mode: '0644', ownership: 'managed' },
      'src/test/setup.ts': { mode: '0644', ownership: 'managed' },
    })
    expect(second).toMatchObject({ changed: false, changedFiles: [] })
    expect(packageManager.supportedChecks).toBe(1)
    expect(packageManager.installs).toBe(1)
    expect(checks).toBe(2)
    const updated = await detectProject(project.root)
    expect(updated.packageJson.scripts?.test).toBe('custom-test-runner')
    expect(updated.packageJson.scripts?.['frontprep:check']).toBe(
      'pnpm run frontprep:quality && pnpm run frontprep:test',
    )
  })

  it('rolls back Test files and package changes when project checking fails', async () => {
    const project = await createProject()
    const originalPackage = await readFile(
      join(project.root, 'package.json'),
      'utf8',
    )
    const packageManager = new RecordingPackageManager()
    const services = testCommandServices(packageManager, async () => {
      throw new Error('project check failed')
    })

    await expect(runInit({ cwd: project.root }, services)).rejects.toThrow(
      'project check failed',
    )

    expect(await readFile(join(project.root, 'package.json'), 'utf8')).toBe(
      originalPackage,
    )
    await expect(
      access(join(project.root, 'vitest.config.mts')),
    ).rejects.toThrow()
    await expect(
      access(join(project.root, 'src/test/setup.ts')),
    ).rejects.toThrow()
    await expect(access(join(project.root, 'src/test'))).rejects.toThrow()
    await expect(
      access(join(project.root, '.frontprep.json')),
    ).rejects.toThrow()
    expect(packageManager.installs).toBe(1)
  })
})
