import { chmod, mkdir, readFile, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'

import { FileSystem, hashBytes } from '../../src/core/filesystem.js'
import { buildPlan } from '../../src/core/plan-builder.js'
import { detectProject } from '../../src/core/project-detector.js'
import type { FrontprepManifest, ProjectContext } from '../../src/core/types.js'
import { ciModule } from '../../src/modules/ci.js'
import { manifestV2 } from '../helpers/manifest.js'
import { createProject, createWorkspaceProject } from '../helpers/project.js'

interface WorkflowStep {
  name: string
  run?: string
  uses?: string
  with?: Record<string, unknown>
}

interface WorkflowDocument {
  concurrency: { 'cancel-in-progress': boolean; group: string }
  env: { HUSKY: string }
  jobs: {
    check: {
      name: string
      'runs-on': string
      steps: WorkflowStep[]
      'timeout-minutes': number
    }
  }
  name: string
  on: {
    pull_request: { branches: string[] }
    push: { branches: string[] }
  }
  permissions: { contents: string }
}

async function plannedIntents() {
  const project = await createProject()
  const context = await detectProject(project.root)
  const analysis = await ciModule.analyze(context)
  return ciModule.plan(context, analysis)
}

async function canonicalWorkflow(): Promise<string> {
  const workflow = (await plannedIntents()).find(
    (intent) => intent.kind === 'managed-file',
  )
  if (workflow?.kind !== 'managed-file') {
    throw new Error('CI workflow intent is missing')
  }
  return workflow.content
}

async function contextWithCheck(
  root: string,
  check = 'pnpm run frontprep:quality && pnpm run frontprep:test',
): Promise<ProjectContext> {
  const packagePath = join(root, 'package.json')
  const packageJson = JSON.parse(await readFile(packagePath, 'utf8')) as {
    scripts?: Record<string, string>
  }
  packageJson.scripts = {
    ...packageJson.scripts,
    'frontprep:check': check,
    'frontprep:quality': 'echo quality',
    'frontprep:test': 'echo test',
  }
  await writeFile(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`)
  return detectProject(root)
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

function withManagedWorkflow(
  context: ProjectContext,
  bytes: Buffer,
): ProjectContext {
  const manifest: FrontprepManifest = manifestV2({
    frontprepVersion: '0.1.0-beta.0',
    files: {
      package: {},
      repository: {
        '.github/workflows/ci.yml': {
          hash: hashBytes(bytes),
          mode: '0644',
          ownership: 'managed',
        },
      },
    },
    managedScripts: {},
  })
  return Object.freeze({ ...context, manifest: Object.freeze(manifest) })
}

describe('CI module plan', () => {
  it('emits the deterministic build, aggregate check, and workflow intents', async () => {
    const intents = await plannedIntents()

    expect(intents).toEqual([
      {
        command: 'next build',
        kind: 'script',
        moduleId: 'ci',
        name: 'frontprep:build',
        policy: 'owned',
        reason: 'CI provides the deterministic production build.',
      },
      {
        command: 'pnpm run frontprep:build',
        kind: 'script',
        moduleId: 'ci',
        name: 'frontprep:check',
        policy: 'append-once',
        reason: 'CI adds the production build to the full check.',
      },
      expect.objectContaining({
        kind: 'managed-file',
        mode: 0o644,
        moduleId: 'ci',
        path: '.github/workflows/ci.yml',
        reason: 'CI owns the GitHub Actions workflow.',
        scope: 'repository',
      }),
    ])
  })

  it('renders a repository workflow for one workspace package', async () => {
    const project = await createWorkspaceProject()
    const context = await detectProject(project.packageRoot)
    await ciModule.analyze(context)
    const workflow = (await ciModule.plan(context, undefined)).find(
      (intent) => intent.kind === 'managed-file',
    )

    expect(workflow).toMatchObject({
      path: expect.stringMatching(
        /^\.github\/workflows\/frontprep-apps-web-[a-f0-9]{8}\.yml$/u,
      ),
      scope: 'repository',
    })
    expect(workflow?.kind).toBe('managed-file')
    if (workflow?.kind !== 'managed-file') return
    expect(workflow.content).toContain("- 'apps/web/**'")
    expect(workflow.content).toContain(
      'pnpm --filter ./apps/web --fail-if-no-match run frontprep:check',
    )
  }, 30_000)

  it('renders the complete pinned and least-privilege workflow policy', async () => {
    const workflowIntent = (await plannedIntents()).find(
      (intent) => intent.kind === 'managed-file',
    )
    expect(workflowIntent?.kind).toBe('managed-file')
    if (workflowIntent?.kind !== 'managed-file') return

    const workflow = parse(workflowIntent.content) as WorkflowDocument
    expect(workflow).toMatchObject({
      concurrency: {
        'cancel-in-progress': true,
        group:
          'ci-${{ github.workflow }}-${{ github.event.pull_request.number || github.ref }}',
      },
      env: { HUSKY: '0' },
      jobs: {
        check: {
          name: 'Frontprep check',
          'runs-on': 'ubuntu-latest',
          'timeout-minutes': 20,
        },
      },
      name: 'CI',
      on: {
        pull_request: { branches: ['develop', 'main'] },
        push: { branches: ['develop', 'main'] },
      },
      permissions: { contents: 'read' },
    })

    expect(workflow.jobs.check.steps).toEqual([
      {
        name: 'Checkout',
        uses: 'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1',
        with: { 'persist-credentials': false },
      },
      {
        name: 'Set up pnpm',
        uses: 'pnpm/action-setup@0e279bb959325dab635dd2c09392533439d90093',
      },
      {
        name: 'Set up Node.js',
        uses: 'actions/setup-node@820762786026740c76f36085b0efc47a31fe5020',
        with: {
          cache: 'pnpm',
          'cache-dependency-path': 'pnpm-lock.yaml',
          'node-version': '22.22.1',
        },
      },
      {
        name: 'Install dependencies',
        run: 'pnpm install --frozen-lockfile',
      },
      { name: 'Run Frontprep checks', run: 'pnpm run frontprep:check' },
    ])
    expect(
      workflow.jobs.check.steps
        .flatMap(({ uses }) => (uses === undefined ? [] : [uses]))
        .every((uses) => /@[0-9a-f]{40}$/u.test(uses)),
    ).toBe(true)
  })

  it('produces an empty plan after the canonical result is applied', async () => {
    const project = await createProject()
    const context = await contextWithCheck(project.root)
    const analysis = await ciModule.analyze(context)
    const first = await buildPlan(
      context,
      await ciModule.plan(context, analysis),
    )
    await applyOperations(project.root, first.operations)

    const updated = await detectProject(project.root)
    const secondAnalysis = await ciModule.analyze(updated)
    const second = await buildPlan(
      updated,
      await ciModule.plan(updated, secondAnalysis),
    )

    expect(second.operations).toEqual([])
  })
})

describe('CI module ownership', () => {
  it('accepts an exact pre-existing canonical workflow', async () => {
    const project = await createProject()
    const path = join(project.root, '.github/workflows/ci.yml')
    await mkdir(join(project.root, '.github/workflows'), { recursive: true })
    await writeFile(path, await canonicalWorkflow(), { mode: 0o644 })

    await expect(
      ciModule.analyze(await detectProject(project.root)),
    ).resolves.toBeUndefined()
  })

  it('accepts an unchanged Frontprep-managed workflow for upgrades', async () => {
    const project = await createProject()
    const path = join(project.root, '.github/workflows/ci.yml')
    await mkdir(join(project.root, '.github/workflows'), { recursive: true })
    const previous = Buffer.from('name: Previous Frontprep CI\n')
    await writeFile(path, previous, { mode: 0o644 })
    const context = withManagedWorkflow(
      await detectProject(project.root),
      previous,
    )

    await expect(ciModule.analyze(context)).resolves.toBeUndefined()
  })

  it.each([
    [
      'unowned content',
      async (root: string) => {
        await mkdir(join(root, '.github/workflows'), { recursive: true })
        await writeFile(
          join(root, '.github/workflows/ci.yml'),
          'name: User CI\n',
        )
      },
    ],
    [
      'symbolic link',
      async (root: string) => {
        await mkdir(join(root, '.github/workflows'), { recursive: true })
        await writeFile(
          join(root, '.github/workflows/user.yml'),
          'name: User\n',
        )
        await symlink('user.yml', join(root, '.github/workflows/ci.yml'))
      },
    ],
    [
      'directory',
      async (root: string) => {
        await mkdir(join(root, '.github/workflows/ci.yml'), { recursive: true })
      },
    ],
    [
      'wrong mode',
      async (root: string) => {
        await mkdir(join(root, '.github/workflows'), { recursive: true })
        const path = join(root, '.github/workflows/ci.yml')
        await writeFile(path, await canonicalWorkflow())
        await chmod(path, 0o600)
      },
    ],
  ])('rejects a conflicting canonical path: %s', async (_label, arrange) => {
    const project = await createProject()
    await arrange(project.root)

    await expect(
      ciModule.analyze(await detectProject(project.root)),
    ).rejects.toMatchObject({
      code: 'CONFIGURATION_CONFLICT',
      moduleId: 'ci',
      path: '.github/workflows/ci.yml',
    })
  })

  it('rejects a user-modified managed workflow', async () => {
    const project = await createProject()
    const path = join(project.root, '.github/workflows/ci.yml')
    await mkdir(join(project.root, '.github/workflows'), { recursive: true })
    const original = Buffer.from(await canonicalWorkflow())
    await writeFile(path, original)
    const context = withManagedWorkflow(
      await detectProject(project.root),
      original,
    )
    await writeFile(path, 'name: Modified\n')

    await expect(ciModule.analyze(context)).rejects.toMatchObject({
      code: 'CONFIGURATION_CONFLICT',
      moduleId: 'ci',
      path: '.github/workflows/ci.yml',
    })
  })

  it('preserves unrelated workflow files', async () => {
    const project = await createProject()
    const deployPath = join(project.root, '.github/workflows/deploy.yml')
    await mkdir(join(project.root, '.github/workflows'), { recursive: true })
    await writeFile(deployPath, 'name: Deploy\n')
    const context = await contextWithCheck(project.root)
    const analysis = await ciModule.analyze(context)
    const plan = await buildPlan(
      context,
      await ciModule.plan(context, analysis),
    )

    expect(plan.operations.map(({ path }) => path)).not.toContain(
      '.github/workflows/deploy.yml',
    )
    expect(await readFile(deployPath, 'utf8')).toBe('name: Deploy\n')
  })
})

describe('CI module verification', () => {
  it('accepts the canonical installed state', async () => {
    const project = await createProject()
    const context = await contextWithCheck(project.root)
    const analysis = await ciModule.analyze(context)
    const plan = await buildPlan(
      context,
      await ciModule.plan(context, analysis),
    )
    await applyOperations(project.root, plan.operations)

    await expect(
      ciModule.verify(await detectProject(project.root)),
    ).resolves.toEqual({ issues: [], valid: true })
  })

  it.each([
    'pnpm run frontprep:quality && pnpm run frontprep:build && pnpm run frontprep:test',
    'pnpm run frontprep:quality && pnpm run frontprep:test && pnpm run frontprep:build && pnpm run frontprep:build',
    'pnpm run frontprep:quality && pnpm run frontprep:test && echo extra && pnpm run frontprep:build',
  ])('rejects a noncanonical full-check pipeline: %s', async (check) => {
    const project = await createProject()
    const context = await contextWithCheck(project.root)
    const analysis = await ciModule.analyze(context)
    const plan = await buildPlan(
      context,
      await ciModule.plan(context, analysis),
    )
    await applyOperations(project.root, plan.operations)
    await contextWithCheck(project.root, check)

    const result = await ciModule.verify(await detectProject(project.root))

    expect(result.issues).toContainEqual({
      message: 'Frontprep-owned script frontprep:check is missing or changed.',
      path: 'package.json',
    })
  })

  it('aggregates independent script, workflow content, and mode drift', async () => {
    const project = await createProject()
    const context = await contextWithCheck(project.root)
    const analysis = await ciModule.analyze(context)
    const plan = await buildPlan(
      context,
      await ciModule.plan(context, analysis),
    )
    await applyOperations(project.root, plan.operations)
    const packagePath = join(project.root, 'package.json')
    const packageJson = JSON.parse(await readFile(packagePath, 'utf8')) as {
      scripts: Record<string, string>
    }
    packageJson.scripts['frontprep:build'] = 'next dev'
    packageJson.scripts['frontprep:check'] = 'echo changed'
    await writeFile(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`)
    const workflowPath = join(project.root, '.github/workflows/ci.yml')
    await writeFile(workflowPath, 'name: Changed\n')
    await chmod(workflowPath, 0o600)

    const result = await ciModule.verify(await detectProject(project.root))

    expect(result.valid).toBe(false)
    expect(result.issues).toEqual([
      {
        message: 'Managed GitHub Actions workflow is missing or changed.',
        path: '.github/workflows/ci.yml',
      },
      {
        message:
          'Frontprep-owned script frontprep:build is missing or changed.',
        path: 'package.json',
      },
      {
        message:
          'Frontprep-owned script frontprep:check is missing or changed.',
        path: 'package.json',
      },
    ])
  })
})
