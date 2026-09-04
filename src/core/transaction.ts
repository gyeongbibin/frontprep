import { chmod, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { FrontprepError } from './errors.js'
import { FileSystem, type FileSnapshot } from './filesystem.js'
import {
  GitHooksManager,
  type GitHooksActivation,
  type GitHooksService,
} from './git-hooks.js'
import { assertSafeGitState } from './git-guard.js'
import { MANIFEST_PATH, writeManifest } from './manifest.js'
import { PnpmPackageManager } from './package-manager.js'
import type { ChangePlan } from './plan.js'
import {
  displayScopedPath,
  rootForScope,
  scopedPathKey,
  scopedProjectPath,
  type ScopedProjectPath,
} from './scoped-paths.js'
import {
  MODULE_ORDER,
  type FrontprepManifest,
  type ManifestFile,
  type ModuleId,
  type ProjectContext,
} from './types.js'

const LOCKFILE_TARGET = scopedProjectPath('pnpm-lock.yaml', 'repository')
const FRONTPREP_MANIFEST_TARGET = scopedProjectPath(MANIFEST_PATH)

export interface PackageManagerService {
  assertSupported(root: string, signal?: AbortSignal): Promise<void>
  install(
    root: string,
    signal?: AbortSignal,
    options?: { readonly packageDirectory: string },
  ): Promise<void>
}

export interface TransactionServices {
  activateGitHooks?: boolean
  assertGitState?: (context: ProjectContext) => Promise<void>
  frontprepVersion: string
  gitHooks?: GitHooksService
  moduleVersions: Readonly<Record<ModuleId, string>>
  packageManager?: PackageManagerService
  signal?: AbortSignal
  verify(root: string, signal?: AbortSignal): Promise<void>
  writeManifestWhenUnchanged?: boolean
}

export interface TransactionResult {
  changed: boolean
  changedFiles: readonly ScopedProjectPath[]
  manifest: FrontprepManifest | null
}

interface BackupEntry {
  backupPath: string | null
  snapshot: FileSnapshot
}

function stalePlan(target: ScopedProjectPath): FrontprepError {
  return new FrontprepError(
    `Project file changed after planning: ${displayScopedPath(target)}`,
    {
      code: 'STALE_PLAN',
      exitCode: 2,
      path: displayScopedPath(target),
      phase: 'application',
      recovery: 'Review the concurrent change and run frontprep again.',
    },
  )
}

function rollbackFailure(
  original: unknown,
  failures: readonly unknown[],
): Error {
  return new FrontprepError(
    `Frontprep could not completely restore the project after a failure (${failures.length} restoration errors).`,
    {
      cause: { failures, original },
      code: 'ROLLBACK_FAILED',
      exitCode: 1,
      phase: 'application',
      recovery: 'Restore the affected files from version control and retry.',
    },
  )
}

function modeString(mode: number): string {
  return `0${mode.toString(8).padStart(3, '0')}`
}

function uniqueTargets(plan: ChangePlan): readonly ScopedProjectPath[] {
  const targets = new Map<string, ScopedProjectPath>()
  for (const operation of plan.operations) {
    const target = scopedProjectPath(operation.path, operation.scope)
    targets.set(scopedPathKey(target), target)
  }
  targets.set(scopedPathKey(LOCKFILE_TARGET), LOCKFILE_TARGET)
  targets.set(
    scopedPathKey(FRONTPREP_MANIFEST_TARGET),
    FRONTPREP_MANIFEST_TARGET,
  )
  return Object.freeze([...targets.values()])
}

async function assertCurrentPlan(
  context: ProjectContext,
  plan: ChangePlan,
): Promise<void> {
  for (const operation of plan.operations) {
    const target = scopedProjectPath(operation.path, operation.scope)
    const fileSystem = new FileSystem(rootForScope(context, target.scope))
    const current = await fileSystem.snapshot(target.path)
    if (current.hash !== operation.beforeHash) {
      throw stalePlan(target)
    }
  }
}

async function createBackup(
  context: ProjectContext,
  targets: readonly ScopedProjectPath[],
): Promise<{ directory: string; entries: Map<string, BackupEntry> }> {
  const directory = await mkdtemp(join(tmpdir(), 'frontprep-backup-'))
  await chmod(directory, 0o700)
  const entries = new Map<string, BackupEntry>()
  try {
    for (const target of targets) {
      const fileSystem = new FileSystem(rootForScope(context, target.scope))
      const snapshot = await fileSystem.snapshot(target.path)
      const backupPath = snapshot.exists
        ? join(directory, target.scope, target.path)
        : null
      if (backupPath !== null) await fileSystem.copy(target.path, backupPath)
      entries.set(scopedPathKey(target), { backupPath, snapshot })
    }
    return { directory, entries }
  } catch (error) {
    await rm(directory, { force: true, recursive: true }).catch(() => undefined)
    throw error
  }
}

async function restoreBackup(
  context: ProjectContext,
  targets: readonly ScopedProjectPath[],
  entries: ReadonlyMap<string, BackupEntry>,
  createdDirectories: readonly ScopedProjectPath[],
): Promise<readonly unknown[]> {
  const failures: unknown[] = []
  for (const target of [...targets].reverse()) {
    try {
      const fileSystem = new FileSystem(rootForScope(context, target.scope))
      const entry = entries.get(scopedPathKey(target))!
      if (!entry.snapshot.exists) {
        await fileSystem.remove(target.path)
      } else {
        await fileSystem.writeAtomic(
          target.path,
          await readFile(entry.backupPath!),
          entry.snapshot.mode!,
        )
      }
    } catch (error) {
      failures.push(error)
    }
  }
  for (const target of createdDirectories) {
    try {
      const fileSystem = new FileSystem(rootForScope(context, target.scope))
      await fileSystem.removeDirectoryIfEmpty(target.path)
    } catch (error) {
      failures.push(error)
    }
  }
  return failures
}

async function missingTargetDirectories(
  context: ProjectContext,
  plan: ChangePlan,
): Promise<readonly ScopedProjectPath[]> {
  const missing = new Map<string, ScopedProjectPath>()
  for (const operation of plan.operations) {
    const fileSystem = new FileSystem(rootForScope(context, operation.scope))
    for (const path of await fileSystem.missingParentDirectories(
      operation.path,
    )) {
      const target = scopedProjectPath(path, operation.scope)
      missing.set(scopedPathKey(target), target)
    }
  }
  return Object.freeze(
    [...missing.values()].sort(
      (left, right) =>
        right.path.split('/').length - left.path.split('/').length ||
        scopedPathKey(right).localeCompare(scopedPathKey(left)),
    ),
  )
}

async function fingerprint(
  context: ProjectContext,
  target: ScopedProjectPath,
  ownership: ManifestFile['ownership'],
): Promise<ManifestFile> {
  const fileSystem = new FileSystem(rootForScope(context, target.scope))
  const snapshot = await fileSystem.snapshot(target.path)
  if (!snapshot.exists || snapshot.hash === null || snapshot.mode === null) {
    throw new FrontprepError(
      `Expected generated file is missing: ${displayScopedPath(target)}`,
      {
        code: 'GENERATED_FILE_MISSING',
        exitCode: 1,
        path: displayScopedPath(target),
        phase: 'verification',
      },
    )
  }
  return {
    hash: snapshot.hash,
    mode: modeString(snapshot.mode),
    ownership,
  }
}

function createManifest(
  context: ProjectContext,
  services: TransactionServices,
  files: FrontprepManifest['files'],
  managedScripts: FrontprepManifest['managedScripts'],
): FrontprepManifest {
  const modules = Object.fromEntries(
    MODULE_ORDER.map((moduleId) => [
      moduleId,
      services.moduleVersions[moduleId],
    ]),
  ) as Record<ModuleId, string>
  const utilities = context.layout.utilities.path
  const testSetup = context.layout.testSetupPath

  return {
    $schema:
      'https://unpkg.com/@mingyeongbin/frontprep/schema/manifest-v2.json',
    schemaVersion: 2,
    frontprepVersion: services.frontprepVersion,
    adapter: context.adapter,
    packageManager: `${context.packageManager.name}@${context.packageManager.version}`,
    paths: {
      app: context.appDirectory,
      layout: context.layoutPath,
      stylesheet: context.stylesheetPath,
      utilities,
      test: context.layout.tests.path,
      testSetup,
    },
    roots: { package: context.packageDirectory, workspace: '.' },
    modules,
    files,
    managedScripts,
  }
}

export async function applyPlan(
  context: ProjectContext,
  plan: ChangePlan,
  services: TransactionServices,
): Promise<TransactionResult> {
  if (
    plan.operations.length === 0 &&
    services.writeManifestWhenUnchanged !== true
  ) {
    return Object.freeze({
      changed: false,
      changedFiles: Object.freeze([]),
      manifest: context.manifest,
    })
  }

  await (services.assertGitState ?? assertSafeGitState)(context)
  services.signal?.throwIfAborted()
  await assertCurrentPlan(context, plan)
  const createdDirectories = await missingTargetDirectories(context, plan)

  const targets =
    plan.operations.length === 0
      ? Object.freeze([FRONTPREP_MANIFEST_TARGET])
      : uniqueTargets(plan)
  const backup = await createBackup(context, targets)
  const packageManager = services.packageManager ?? new PnpmPackageManager()
  const gitHooks = services.gitHooks ?? new GitHooksManager()
  let gitHooksActivation: GitHooksActivation | null = null

  try {
    for (const operation of plan.operations) {
      services.signal?.throwIfAborted()
      const fileSystem = new FileSystem(rootForScope(context, operation.scope))
      await fileSystem.writeAtomic(
        operation.path,
        operation.afterBytes,
        operation.mode,
      )
    }

    if (plan.dependenciesChanged) {
      await packageManager.assertSupported(
        context.workspaceRoot,
        services.signal,
      )
      await packageManager.install(
        context.workspaceRoot,
        services.signal,
        context.packageDirectory === '.'
          ? undefined
          : { packageDirectory: context.packageDirectory },
      )
    }
    if (services.activateGitHooks === true && plan.operations.length > 0) {
      gitHooksActivation = await gitHooks.activate(
        context.repositoryRoot,
        services.signal,
        context.packageDirectory === '.'
          ? undefined
          : {
              packageDirectory: context.packageDirectory,
              packageRoot: context.packageRoot,
            },
      )
    }
    services.signal?.throwIfAborted()
    await services.verify(context.root, services.signal)
    services.signal?.throwIfAborted()

    const changedFiles = plan.operations.map((operation) =>
      scopedProjectPath(operation.path, operation.scope),
    )
    if (plan.operations.length > 0) {
      const originalLock = backup.entries.get(
        scopedPathKey(LOCKFILE_TARGET),
      )!.snapshot
      const lockFileSystem = new FileSystem(
        rootForScope(context, LOCKFILE_TARGET.scope),
      )
      const currentLock = await lockFileSystem.snapshot(LOCKFILE_TARGET.path)
      if (
        currentLock.hash !== originalLock.hash &&
        !changedFiles.some(
          (target) => scopedPathKey(target) === scopedPathKey(LOCKFILE_TARGET),
        )
      ) {
        changedFiles.push(LOCKFILE_TARGET)
      }
    }

    const files: FrontprepManifest['files'] = {
      package: { ...(context.manifest?.files.package ?? {}) },
      repository: { ...(context.manifest?.files.repository ?? {}) },
    }
    for (const operation of plan.operations) {
      const target = scopedProjectPath(operation.path, operation.scope)
      files[target.scope][target.path] = await fingerprint(
        context,
        target,
        operation.ownership,
      )
    }
    if (
      changedFiles.some(
        (target) => scopedPathKey(target) === scopedPathKey(LOCKFILE_TARGET),
      )
    ) {
      files.repository[LOCKFILE_TARGET.path] = await fingerprint(
        context,
        LOCKFILE_TARGET,
        'patched',
      )
    }

    const manifest = createManifest(context, services, files, {
      ...(context.manifest?.managedScripts ?? {}),
      ...plan.managedScripts,
    })
    await writeManifest(context.root, manifest)

    const originalManifest = backup.entries.get(
      scopedPathKey(FRONTPREP_MANIFEST_TARGET),
    )!.snapshot
    const currentManifest = await new FileSystem(context.root).snapshot(
      FRONTPREP_MANIFEST_TARGET.path,
    )
    if (currentManifest.hash !== originalManifest.hash) {
      changedFiles.push(FRONTPREP_MANIFEST_TARGET)
    }

    return Object.freeze({
      changed: changedFiles.length > 0,
      changedFiles: Object.freeze(changedFiles),
      manifest: Object.freeze(manifest),
    })
  } catch (error) {
    const failures: unknown[] = []
    if (gitHooksActivation !== null) {
      try {
        await gitHooks.restore(context.repositoryRoot, gitHooksActivation)
      } catch (restoration) {
        failures.push(restoration)
      }
    }
    failures.push(
      ...(await restoreBackup(
        context,
        targets,
        backup.entries,
        createdDirectories,
      )),
    )
    if (failures.length > 0) throw rollbackFailure(error, failures)
    throw error
  } finally {
    await rm(backup.directory, { force: true, recursive: true }).catch(
      () => undefined,
    )
  }
}
