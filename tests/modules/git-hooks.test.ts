import { chmod, mkdir, readFile, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { FileSystem } from '../../src/core/filesystem.js'
import { buildPlan } from '../../src/core/plan-builder.js'
import { detectProject } from '../../src/core/project-detector.js'
import type { PackageJson, ProjectContext } from '../../src/core/types.js'
import { gitHooksModule } from '../../src/modules/git-hooks.js'
import { createModuleRegistry } from '../../src/modules/registry.js'
import { qualityModule } from '../../src/modules/quality.js'
import { tailwindModule } from '../../src/modules/tailwind.js'
import { testModule } from '../../src/modules/test.js'
import { manifestV2 } from '../helpers/manifest.js'
import { createProject } from '../helpers/project.js'

const EXPECTED_DEPENDENCIES = {
  '@commitlint/cli': '^21.2.0',
  '@commitlint/config-conventional': '^21.2.0',
  husky: '^9.1.0',
  'lint-staged': '^17.3.0',
}

const EXPECTED_FILES = {
  '.husky/commit-msg': 'pnpm exec commitlint --edit "$1"\n',
  '.husky/pre-commit': 'pnpm exec lint-staged\n',
  'commitlint.config.mjs': `export default {
  extends: ['@commitlint/config-conventional'],
}
`,
  'lint-staged.config.mjs': `export default {
  '*.{cjs,cts,js,jsx,mjs,mts,ts,tsx}': ['eslint --fix', 'prettier --write'],
  '*.{css,json,jsonc,md,mdx,yaml,yml}': 'prettier --write',
}
`,
}

async function updatePackage(
  root: string,
  mutate: (packageJson: PackageJson) => void,
): Promise<void> {
  const path = join(root, 'package.json')
  const packageJson = JSON.parse(await readFile(path, 'utf8')) as PackageJson
  mutate(packageJson)
  await writeFile(path, `${JSON.stringify(packageJson, null, 2)}\n`)
}

async function contextWithPrepare(
  prepare?: string,
): Promise<{ context: ProjectContext; root: string }> {
  const project = await createProject()
  if (prepare !== undefined) {
    await updatePackage(project.root, (packageJson) => {
      packageJson.scripts = { prepare }
    })
  }
  return { context: await detectProject(project.root), root: project.root }
}

async function writeCanonicalFiles(root: string): Promise<void> {
  const fileSystem = new FileSystem(root)
  for (const [path, contents] of Object.entries(EXPECTED_FILES)) {
    await fileSystem.writeAtomic(
      path as never,
      Buffer.from(contents),
      path.startsWith('.husky/') ? 0o755 : 0o644,
    )
  }
}

async function applyGitHooksPlan(root: string): Promise<void> {
  const context = await detectProject(root)
  const analysis = await gitHooksModule.analyze(context)
  const plan = await buildPlan(
    context,
    await gitHooksModule.plan(context, analysis),
  )
  const fileSystem = new FileSystem(root)
  for (const operation of plan.operations) {
    await fileSystem.writeAtomic(
      operation.path,
      operation.afterBytes,
      operation.mode,
    )
  }
}

describe('git hooks module plan', () => {
  it('emits the complete dependency, script, config, hook, and mode contract', async () => {
    const { context } = await contextWithPrepare()
    const analysis = await gitHooksModule.analyze(context)
    const intents = await gitHooksModule.plan(context, analysis)

    expect(analysis).toEqual({ integratePrepare: true })
    expect(
      intents
        .filter((intent) => intent.kind === 'dependency')
        .map(({ name, range, section }) => ({ name, range, section })),
    ).toEqual(
      Object.entries(EXPECTED_DEPENDENCIES).map(([name, range]) => ({
        name,
        range,
        section: 'devDependencies',
      })),
    )
    expect(
      intents
        .filter((intent) => intent.kind === 'script')
        .map(({ command, name, policy }) => ({ command, name, policy })),
    ).toEqual([
      {
        command: 'husky',
        name: 'frontprep:prepare',
        policy: 'owned',
      },
      {
        command: 'pnpm run frontprep:prepare',
        name: 'prepare',
        policy: 'append-once',
      },
    ])
    expect(
      intents
        .filter(
          (intent) =>
            intent.kind === 'managed-file' || intent.kind === 'executable-file',
        )
        .map((intent) => ({
          content: intent.content,
          kind: intent.kind,
          mode: intent.kind === 'managed-file' ? intent.mode : 0o755,
          path: intent.path,
        })),
    ).toEqual([
      {
        content: EXPECTED_FILES['.husky/pre-commit'],
        kind: 'executable-file',
        mode: 0o755,
        path: '.husky/pre-commit',
      },
      {
        content: EXPECTED_FILES['.husky/commit-msg'],
        kind: 'executable-file',
        mode: 0o755,
        path: '.husky/commit-msg',
      },
      {
        content: EXPECTED_FILES['lint-staged.config.mjs'],
        kind: 'managed-file',
        mode: 0o644,
        path: 'lint-staged.config.mjs',
      },
      {
        content: EXPECTED_FILES['commitlint.config.mjs'],
        kind: 'managed-file',
        mode: 0o644,
        path: 'commitlint.config.mjs',
      },
    ])
  })

  it.each([
    'husky',
    'pnpm husky',
    'pnpm exec husky',
    'pnpm run frontprep:prepare',
    'generate&&husky',
    'pnpm exec husky&&generate',
  ])('preserves the recognized prepare stage %s', async (prepare) => {
    const { context } = await contextWithPrepare(prepare)
    const analysis = await gitHooksModule.analyze(context)
    const intents = await gitHooksModule.plan(context, analysis)

    expect(analysis.integratePrepare).toBe(false)
    expect(
      intents.filter(
        (intent) => intent.kind === 'script' && intent.name === 'prepare',
      ),
    ).toEqual([])
  })

  it('appends after custom and false-substring prepare stages', async () => {
    for (const prepare of ['generate', 'echo husky']) {
      const { context } = await contextWithPrepare(prepare)
      const analysis = await gitHooksModule.analyze(context)
      expect(analysis.integratePrepare).toBe(true)
    }
  })

  it('rejects duplicate recognized prepare stages', async () => {
    const { context } = await contextWithPrepare(
      'husky && pnpm run frontprep:prepare',
    )

    await expect(gitHooksModule.analyze(context)).rejects.toMatchObject({
      code: 'CONFIGURATION_CONFLICT',
      moduleId: 'git-hooks',
      path: 'package.json',
    })
  })

  it('rejects compact duplicate prepare stages', async () => {
    const { context } = await contextWithPrepare(
      'husky&&pnpm run frontprep:prepare',
    )

    await expect(gitHooksModule.analyze(context)).rejects.toMatchObject({
      code: 'CONFIGURATION_CONFLICT',
      moduleId: 'git-hooks',
      path: 'package.json',
    })
  })
})

describe('git hooks module conflicts', () => {
  it('accepts canonical files, Git samples, and unrelated user hooks', async () => {
    const project = await createProject()
    await writeCanonicalFiles(project.root)
    await writeFile(join(project.root, '.husky/post-commit'), 'echo user\n')

    await expect(
      gitHooksModule.analyze(await detectProject(project.root)),
    ).resolves.toEqual({ integratePrepare: true })
  })

  it.each([
    ['lint-staged.config.js', 'export default {}\n'],
    ['lint-staged.config.json', '{}\n'],
    ['.lintstagedrc.json', '{}\n'],
    ['commitlint.config.js', 'export default {}\n'],
    ['commitlint.config.json', '{}\n'],
    ['.commitlintrc.yml', 'rules: {}\n'],
    ['lefthook.yml', 'pre-commit: {}\n'],
    ['.pre-commit-config.yaml', 'repos: []\n'],
  ])('rejects conflicting root configuration %s', async (path, contents) => {
    const project = await createProject()
    await writeFile(join(project.root, path), contents)

    await expect(
      gitHooksModule.analyze(await detectProject(project.root)),
    ).rejects.toMatchObject({
      code: 'CONFIGURATION_CONFLICT',
      moduleId: 'git-hooks',
      path,
    })
  })

  it('rejects nested lint-staged files and package configuration', async () => {
    for (const path of [
      'src/feature/lint-staged.config.mjs',
      'src/feature/package.json',
    ]) {
      const project = await createProject()
      await mkdir(join(project.root, 'src/feature'), { recursive: true })
      await writeFile(
        join(project.root, path),
        path.endsWith('package.json')
          ? '{"lint-staged":{"*.ts":"prettier --write"}}\n'
          : 'export default {}\n',
      )
      await expect(
        gitHooksModule.analyze(await detectProject(project.root)),
      ).rejects.toMatchObject({ code: 'CONFIGURATION_CONFLICT' })
    }
  })

  it.each([
    'simple-git-hooks',
    'lefthook',
    '@evilmartians/lefthook',
    'pre-commit',
  ])('rejects the competing hook manager dependency %s', async (name) => {
    const project = await createProject()
    await updatePackage(project.root, (packageJson) => {
      packageJson.devDependencies = { [name]: '^1.0.0' }
    })

    await expect(
      gitHooksModule.analyze(await detectProject(project.root)),
    ).rejects.toMatchObject({
      code: 'CONFIGURATION_CONFLICT',
      moduleId: 'git-hooks',
      path: `package.json#${name}`,
    })
  })

  it('rejects package-level lint-staged, commitlint, and hook-manager keys', async () => {
    for (const key of ['lint-staged', 'commitlint', 'simple-git-hooks']) {
      const project = await createProject()
      await updatePackage(project.root, (packageJson) => {
        packageJson[key] = {}
      })
      await expect(
        gitHooksModule.analyze(await detectProject(project.root)),
      ).rejects.toMatchObject({ code: 'CONFIGURATION_CONFLICT' })
    }
  })

  it('rejects a changed unowned canonical file and symbolic Husky path', async () => {
    const changed = await createProject()
    await writeFile(
      join(changed.root, 'lint-staged.config.mjs'),
      'export default {}\n',
    )
    await expect(
      gitHooksModule.analyze(await detectProject(changed.root)),
    ).rejects.toMatchObject({ path: 'lint-staged.config.mjs' })

    const linked = await createProject()
    await mkdir(join(linked.root, 'outside'))
    await symlink('outside', join(linked.root, '.husky'))
    await expect(
      gitHooksModule.analyze(await detectProject(linked.root)),
    ).rejects.toMatchObject({ path: '.husky/commit-msg' })
  })

  it('rejects another active hooks path and non-sample default hooks', async () => {
    const configured = await createProject()
    const { execFile } = await import('node:child_process')
    const { promisify } = await import('node:util')
    await promisify(execFile)(
      'git',
      ['config', '--local', 'core.hooksPath', '.custom-hooks'],
      { cwd: configured.root },
    )
    await expect(
      gitHooksModule.analyze(await detectProject(configured.root)),
    ).rejects.toMatchObject({ path: '.git/config' })

    const defaultHook = await createProject()
    await writeFile(join(defaultHook.root, '.git/hooks/pre-commit'), 'exit 0\n')
    await expect(
      gitHooksModule.analyze(await detectProject(defaultHook.root)),
    ).rejects.toMatchObject({ path: '.git/hooks/pre-commit' })
  })

  it('allows manifest-owned canonical rewrites', async () => {
    const project = await createProject()
    await applyGitHooksPlan(project.root)
    const manifestPath = join(project.root, '.frontprep.json')
    const fileSystem = new FileSystem(project.root)
    await writeFile(
      join(project.root, 'lint-staged.config.mjs'),
      `${EXPECTED_FILES['lint-staged.config.mjs']}// v1\n`,
    )
    const snapshot = await fileSystem.snapshot(
      'lint-staged.config.mjs' as never,
    )
    const manifest = manifestV2({
      frontprepVersion: '0.1.0-beta.0',
      files: {
        package: {
          'lint-staged.config.mjs': {
            hash: snapshot.hash!,
            mode: '0644',
            ownership: 'managed',
          },
        },
        repository: {},
      },
      managedScripts: {},
    })
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
    await expect(
      gitHooksModule.analyze(await detectProject(project.root)),
    ).resolves.toEqual({ integratePrepare: false })
  })
})

describe('git hooks module verification', () => {
  it('accepts a canonical activated setup', async () => {
    const project = await createProject()
    await applyGitHooksPlan(project.root)
    await mkdir(join(project.root, '.husky/_'), { recursive: true })
    await writeFile(join(project.root, '.husky/_/h'), '# dispatcher\n')
    const { execFile } = await import('node:child_process')
    const { promisify } = await import('node:util')
    await promisify(execFile)(
      'git',
      ['config', '--local', 'core.hooksPath', '.husky/_'],
      { cwd: project.root },
    )

    await expect(
      gitHooksModule.verify(await detectProject(project.root)),
    ).resolves.toEqual({ issues: [], valid: true })
  })

  it('aggregates dependency, script, file, config, path, and dispatcher drift', async () => {
    const project = await createProject()
    await applyGitHooksPlan(project.root)
    await updatePackage(project.root, (packageJson) => {
      packageJson.devDependencies!['lint-staged'] = '^16.0.0'
      packageJson.scripts!['frontprep:prepare'] = 'echo changed'
      packageJson.scripts!.prepare = 'husky && pnpm run frontprep:prepare'
    })
    await chmod(join(project.root, '.husky/pre-commit'), 0o644)
    await writeFile(
      join(project.root, 'commitlint.config.js'),
      'module.exports = {}\n',
    )

    const result = await gitHooksModule.verify(
      await detectProject(project.root),
    )
    const messages = result.issues.map(({ message }) => message)

    expect(result.valid).toBe(false)
    expect(messages).toContain('Dependency lint-staged must satisfy ^17.3.0.')
    expect(messages).toContain(
      'Frontprep-owned script frontprep:prepare is missing or changed.',
    )
    expect(messages).toContain(
      'Prepare script must contain exactly one recognized Husky stage.',
    )
    expect(messages).toContain('Managed pre-commit hook is missing or changed.')
    expect(messages).toContain(
      'commitlint configuration conflicts at commitlint.config.js.',
    )
    expect(messages).toContain('Git core.hooksPath must be .husky/_.')
    expect(messages).toContain('Husky dispatcher is missing or unsafe.')
  })
})

describe('git hooks module composition', () => {
  it('composes after Quality, Tailwind, and Test without default registration', async () => {
    const project = await createProject()
    const context = await detectProject(project.root)
    const modules = [
      qualityModule,
      tailwindModule,
      testModule,
      gitHooksModule,
    ] as const
    const intents = []
    for (const module of modules) {
      const analysis = await module.analyze(context)
      intents.push(...(await module.plan(context, analysis as never)))
    }

    const plan = await buildPlan(context, intents)
    const packageOperation = plan.operations.find(
      ({ path }) => path === 'package.json',
    )!
    const packageJson = JSON.parse(
      packageOperation.afterBytes.toString('utf8'),
    ) as PackageJson

    expect(createModuleRegistry()).toEqual([])
    expect(plan.operations.map(({ path }) => path)).toEqual(
      expect.arrayContaining([
        '.husky/commit-msg',
        '.husky/pre-commit',
        'commitlint.config.mjs',
        'lint-staged.config.mjs',
        'vitest.config.mts',
      ]),
    )
    expect(packageJson.scripts).toMatchObject({
      'frontprep:check':
        'pnpm run frontprep:quality && pnpm run frontprep:test',
      'frontprep:prepare': 'husky',
      prepare: 'pnpm run frontprep:prepare',
    })
    expect(packageJson.devDependencies).toMatchObject(EXPECTED_DEPENDENCIES)
  })
})
