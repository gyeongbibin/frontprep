import { chmod, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { hashBytes } from '../../src/core/filesystem.js'
import type { ChangePlan, FileOperation } from '../../src/core/plan.js'
import { toProjectPath } from '../../src/core/paths.js'
import { detectProject } from '../../src/core/project-detector.js'
import {
  applyPlan,
  type PackageManagerService,
  type TransactionServices,
} from '../../src/core/transaction.js'
import type { ModuleId } from '../../src/core/types.js'
import { createProject } from '../helpers/project.js'

const MODULE_VERSIONS: Readonly<Record<ModuleId, string>> = {
  quality: '1.0.0',
  tailwind: '1.0.0',
  test: '1.0.0',
  'git-hooks': '1.0.0',
  ci: '1.0.0',
}

function plan(
  operations: readonly FileOperation[],
  dependenciesChanged = false,
): ChangePlan {
  return {
    dependenciesChanged,
    managedScripts: {},
    operations,
    snapshot: Object.fromEntries(
      operations.map(({ beforeHash, path }) => [path, beforeHash]),
    ),
    summary: { quality: 0, tailwind: 0, test: 0, 'git-hooks': 0, ci: 0 },
  }
}

function operation(
  path: string,
  contents: string,
  beforeHash: string | null,
  mode = 0o644,
): FileOperation {
  return {
    afterBytes: Buffer.from(contents),
    beforeHash,
    mode,
    moduleIds: ['quality'],
    ownership: 'managed',
    path: toProjectPath(path),
  }
}

class TestPackageManager implements PackageManagerService {
  installs = 0
  supportedChecks = 0

  constructor(
    private readonly installEffect: (
      root: string,
    ) => Promise<void> = async () => undefined,
  ) {}

  async assertSupported(): Promise<void> {
    this.supportedChecks += 1
  }

  async install(root: string): Promise<void> {
    this.installs += 1
    await this.installEffect(root)
  }
}

function services(
  packageManager: PackageManagerService,
  verify: TransactionServices['verify'] = async () => undefined,
  signal?: AbortSignal,
): TransactionServices {
  return {
    assertGitState: async () => undefined,
    frontprepVersion: '0.1.0-beta.0',
    moduleVersions: MODULE_VERSIONS,
    packageManager,
    signal,
    verify,
  }
}

describe('applyPlan', () => {
  it('does not install, verify, or write a manifest for an empty plan', async () => {
    const project = await createProject()
    const context = await detectProject(project.root)
    const packageManager = new TestPackageManager()
    let verifications = 0

    const result = await applyPlan(
      context,
      plan([]),
      services(packageManager, async () => {
        verifications += 1
      }),
    )

    expect(result).toEqual({
      changed: false,
      changedFiles: [],
      manifest: null,
    })
    expect(packageManager.installs).toBe(0)
    expect(verifications).toBe(0)
    await expect(
      readFile(join(project.root, '.frontprep.json')),
    ).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('installs once, verifies written files, and writes the manifest last', async () => {
    const project = await createProject()
    const context = await detectProject(project.root)
    const packageManager = new TestPackageManager(async (root) => {
      await writeFile(join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\n')
    })
    const target = '.editorconfig'
    let manifestExistedDuringVerification = false

    const result = await applyPlan(
      context,
      plan([operation(target, 'root = true\n', null)], true),
      services(packageManager, async (root) => {
        expect(await readFile(join(root, target), 'utf8')).toBe('root = true\n')
        try {
          await readFile(join(root, '.frontprep.json'))
          manifestExistedDuringVerification = true
        } catch {
          manifestExistedDuringVerification = false
        }
      }),
    )

    expect(packageManager.supportedChecks).toBe(1)
    expect(packageManager.installs).toBe(1)
    expect(manifestExistedDuringVerification).toBe(false)
    expect(result.changedFiles).toEqual(['.editorconfig', 'pnpm-lock.yaml'])
    expect(result.manifest?.files['.editorconfig']).toMatchObject({
      hash: hashBytes(Buffer.from('root = true\n')),
      mode: '0644',
      ownership: 'managed',
    })
    expect(result.manifest?.files['pnpm-lock.yaml']).toMatchObject({
      ownership: 'patched',
    })
    expect(
      JSON.parse(await readFile(join(project.root, '.frontprep.json'), 'utf8')),
    ).toEqual(result.manifest)
  })

  it('rejects a stale source hash before changing any file', async () => {
    const project = await createProject()
    const context = await detectProject(project.root)
    const target = 'src/app/globals.css'
    const original = await readFile(join(project.root, target))
    const change = operation(target, 'planned\n', hashBytes(original))
    await writeFile(join(project.root, target), 'changed after planning\n')

    await expect(
      applyPlan(context, plan([change]), services(new TestPackageManager())),
    ).rejects.toMatchObject({ code: 'STALE_PLAN', path: target })
    expect(await readFile(join(project.root, target), 'utf8')).toBe(
      'changed after planning\n',
    )
  })

  it('restores bytes, modes, lockfile, and newly created files after verification fails', async () => {
    const project = await createProject()
    const context = await detectProject(project.root)
    const existingPath = 'src/app/globals.css'
    const createdPath = '.editorconfig'
    const lockPath = join(project.root, 'pnpm-lock.yaml')
    const original = await readFile(join(project.root, existingPath))
    await chmod(join(project.root, existingPath), 0o600)
    await writeFile(lockPath, 'original lock\n')
    const packageManager = new TestPackageManager(async (root) => {
      await writeFile(join(root, 'pnpm-lock.yaml'), 'changed lock\n')
    })

    await expect(
      applyPlan(
        context,
        plan(
          [
            operation(existingPath, 'changed\n', hashBytes(original), 0o755),
            operation(createdPath, 'root = true\n', null),
          ],
          true,
        ),
        services(packageManager, async () => {
          throw new Error('verification failed')
        }),
      ),
    ).rejects.toThrow('verification failed')

    expect(await readFile(join(project.root, existingPath))).toEqual(original)
    expect((await stat(join(project.root, existingPath))).mode & 0o777).toBe(
      0o600,
    )
    await expect(
      readFile(join(project.root, createdPath)),
    ).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(lockPath, 'utf8')).toBe('original lock\n')
    await expect(
      readFile(join(project.root, '.frontprep.json')),
    ).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rolls back when the abort signal fires during verification', async () => {
    const project = await createProject()
    const context = await detectProject(project.root)
    const controller = new AbortController()
    const target = '.editorconfig'

    await expect(
      applyPlan(
        context,
        plan([operation(target, 'root = true\n', null)]),
        services(
          new TestPackageManager(),
          async () => controller.abort(),
          controller.signal,
        ),
      ),
    ).rejects.toMatchObject({ name: 'AbortError' })
    await expect(readFile(join(project.root, target))).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })
})
