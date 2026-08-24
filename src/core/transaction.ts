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
import { toProjectPath, type ProjectPath } from './paths.js'
import {
  MODULE_ORDER,
  type FrontprepManifest,
  type ManifestFile,
  type ModuleId,
  type ProjectContext,
} from './types.js'

const LOCKFILE_PATH = toProjectPath('pnpm-lock.yaml')
const FRONTPREP_MANIFEST_PATH = toProjectPath(MANIFEST_PATH)

export interface PackageManagerService {
  assertSupported(root: string, signal?: AbortSignal): Promise<void>
  install(root: string, signal?: AbortSignal): Promise<void>
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
}

export interface TransactionResult {
  changed: boolean
  changedFiles: readonly ProjectPath[]
  manifest: FrontprepManifest | null
}

interface BackupEntry {
  backupPath: string | null
  snapshot: FileSnapshot
}

function stalePlan(path: ProjectPath): FrontprepError {
  return new FrontprepError(`Project file changed after planning: ${path}`, {
    code: 'STALE_PLAN',
    exitCode: 2,
    path,
    phase: 'application',
    recovery: 'Review the concurrent change and run frontprep again.',
  })
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

function uniqueTargets(plan: ChangePlan): readonly ProjectPath[] {
  const paths = new Set<ProjectPath>(
    plan.operations.map((operation) => operation.path),
  )
  paths.add(LOCKFILE_PATH)
  paths.add(FRONTPREP_MANIFEST_PATH)
  return Object.freeze([...paths])
}

async function assertCurrentPlan(
  fileSystem: FileSystem,
  plan: ChangePlan,
): Promise<void> {
  for (const operation of plan.operations) {
    const current = await fileSystem.snapshot(operation.path)
    if (current.hash !== operation.beforeHash) {
      throw stalePlan(operation.path)
    }
  }
}

async function createBackup(
  fileSystem: FileSystem,
  paths: readonly ProjectPath[],
): Promise<{ directory: string; entries: Map<ProjectPath, BackupEntry> }> {
  const directory = await mkdtemp(join(tmpdir(), 'frontprep-backup-'))
  await chmod(directory, 0o700)
  const entries = new Map<ProjectPath, BackupEntry>()
  try {
    for (const path of paths) {
      const snapshot = await fileSystem.snapshot(path)
      const backupPath = snapshot.exists ? join(directory, path) : null
      if (backupPath !== null) await fileSystem.copy(path, backupPath)
      entries.set(path, { backupPath, snapshot })
    }
    return { directory, entries }
  } catch (error) {
    await rm(directory, { force: true, recursive: true }).catch(() => undefined)
    throw error
  }
}

async function restoreBackup(
  fileSystem: FileSystem,
  paths: readonly ProjectPath[],
  entries: ReadonlyMap<ProjectPath, BackupEntry>,
  createdDirectories: readonly ProjectPath[],
): Promise<readonly unknown[]> {
  const failures: unknown[] = []
  for (const path of [...paths].reverse()) {
    try {
      const entry = entries.get(path)!
      if (!entry.snapshot.exists) {
        await fileSystem.remove(path)
      } else {
        await fileSystem.writeAtomic(
          path,
          await readFile(entry.backupPath!),
          entry.snapshot.mode!,
        )
      }
    } catch (error) {
      failures.push(error)
    }
  }
  for (const path of createdDirectories) {
    try {
      await fileSystem.removeDirectoryIfEmpty(path)
    } catch (error) {
      failures.push(error)
    }
  }
  return failures
}

async function missingTargetDirectories(
  fileSystem: FileSystem,
  plan: ChangePlan,
): Promise<readonly ProjectPath[]> {
  const missing = new Set<ProjectPath>()
  for (const operation of plan.operations) {
    for (const path of await fileSystem.missingParentDirectories(
      operation.path,
    )) {
      missing.add(path)
    }
  }
  return Object.freeze(
    [...missing].sort(
      (left, right) =>
        right.split('/').length - left.split('/').length ||
        right.localeCompare(left),
    ),
  )
}

async function fingerprint(
  fileSystem: FileSystem,
  path: ProjectPath,
  ownership: ManifestFile['ownership'],
): Promise<ManifestFile> {
  const snapshot = await fileSystem.snapshot(path)
  if (!snapshot.exists || snapshot.hash === null || snapshot.mode === null) {
    throw new FrontprepError(`Expected generated file is missing: ${path}`, {
      code: 'GENERATED_FILE_MISSING',
      exitCode: 1,
      path,
      phase: 'verification',
    })
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
  return {
    $schema:
      'https://unpkg.com/@mingyeongbin/frontprep/schema/manifest-v1.json',
    schemaVersion: 1,
    frontprepVersion: services.frontprepVersion,
    adapter: context.adapter,
    packageManager: `${context.packageManager.name}@${context.packageManager.version}`,
    paths: {
      app: context.appDirectory,
      stylesheet: context.stylesheetPath,
    },
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
  if (plan.operations.length === 0) {
    return Object.freeze({
      changed: false,
      changedFiles: Object.freeze([]),
      manifest: context.manifest,
    })
  }

  const fileSystem = new FileSystem(context.root)
  await (services.assertGitState ?? assertSafeGitState)(context)
  services.signal?.throwIfAborted()
  await assertCurrentPlan(fileSystem, plan)
  const createdDirectories = await missingTargetDirectories(fileSystem, plan)

  const targets = uniqueTargets(plan)
  const backup = await createBackup(fileSystem, targets)
  const packageManager = services.packageManager ?? new PnpmPackageManager()
  const gitHooks = services.gitHooks ?? new GitHooksManager()
  let gitHooksActivation: GitHooksActivation | null = null

  try {
    for (const operation of plan.operations) {
      services.signal?.throwIfAborted()
      await fileSystem.writeAtomic(
        operation.path,
        operation.afterBytes,
        operation.mode,
      )
    }

    if (plan.dependenciesChanged) {
      await packageManager.assertSupported(context.root, services.signal)
      await packageManager.install(context.root, services.signal)
    }
    if (services.activateGitHooks === true) {
      gitHooksActivation = await gitHooks.activate(
        context.root,
        services.signal,
      )
    }
    services.signal?.throwIfAborted()
    await services.verify(context.root, services.signal)
    services.signal?.throwIfAborted()

    const changedFiles = plan.operations.map((operation) => operation.path)
    const originalLock = backup.entries.get(LOCKFILE_PATH)!.snapshot
    const currentLock = await fileSystem.snapshot(LOCKFILE_PATH)
    if (currentLock.hash !== originalLock.hash) changedFiles.push(LOCKFILE_PATH)

    const files: FrontprepManifest['files'] = {
      ...(context.manifest?.files ?? {}),
    }
    for (const operation of plan.operations) {
      files[operation.path] = await fingerprint(
        fileSystem,
        operation.path,
        operation.ownership,
      )
    }
    if (changedFiles.includes(LOCKFILE_PATH)) {
      files[LOCKFILE_PATH] = await fingerprint(
        fileSystem,
        LOCKFILE_PATH,
        'patched',
      )
    }

    const manifest = createManifest(context, services, files, {
      ...(context.manifest?.managedScripts ?? {}),
      ...plan.managedScripts,
    })
    await writeManifest(context.root, manifest)

    return Object.freeze({
      changed: true,
      changedFiles: Object.freeze(changedFiles),
      manifest: Object.freeze(manifest),
    })
  } catch (error) {
    const failures: unknown[] = []
    if (gitHooksActivation !== null) {
      try {
        await gitHooks.restore(context.root, gitHooksActivation)
      } catch (restoration) {
        failures.push(restoration)
      }
    }
    failures.push(
      ...(await restoreBackup(
        fileSystem,
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
