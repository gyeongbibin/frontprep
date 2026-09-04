import { lstat } from 'node:fs/promises'

import { FrontprepError } from './errors.js'
import { FileSystem } from './filesystem.js'
import { MANIFEST_PATH, serializeManifest } from './manifest.js'
import { resolveProjectPath, toProjectPath, type ProjectPath } from './paths.js'
import { ProcessRunner } from './process.js'
import { rootForScope, type FileScope } from './scoped-paths.js'
import type { ManifestFile, ProjectContext } from './types.js'

interface GitStatusEntry {
  originalPath?: string
  path: string
  status: string
}

const CONFLICT_STATUSES = new Set(['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU'])

function unsafeGitState(message: string, path?: string): FrontprepError {
  return new FrontprepError(message, {
    code: 'UNSAFE_GIT_STATE',
    exitCode: 2,
    path,
    phase: 'git',
    recovery: 'Commit or restore unrelated changes before running frontprep.',
  })
}

export function parseGitStatus(output: string): readonly GitStatusEntry[] {
  const records = output.split('\0')
  const entries: GitStatusEntry[] = []

  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]
    if (record === undefined || record.length === 0) continue
    if (record.length < 4 || record[2] !== ' ') {
      throw unsafeGitState('Git returned an unrecognized status record.')
    }
    const status = record.slice(0, 2)
    const path = record.slice(3)
    if (status.includes('R') || status.includes('C')) {
      const originalPath = records[index + 1]
      if (originalPath === undefined || originalPath.length === 0) {
        throw unsafeGitState(`Git returned an incomplete rename for ${path}.`)
      }
      entries.push({ originalPath, path, status })
      index += 1
    } else {
      entries.push({ path, status })
    }
  }

  return Object.freeze(entries.map((entry) => Object.freeze(entry)))
}

function assertOrdinaryStatus(entry: GitStatusEntry): void {
  if (CONFLICT_STATUSES.has(entry.status)) {
    throw unsafeGitState(`Git path is conflicted: ${entry.path}`, entry.path)
  }
  if (entry.originalPath !== undefined) {
    throw unsafeGitState(`Git path was renamed: ${entry.path}`, entry.path)
  }
  if (entry.status.includes('D')) {
    throw unsafeGitState(`Git path was deleted: ${entry.path}`, entry.path)
  }
  if (entry.status.includes('T')) {
    throw unsafeGitState(`Git path changed type: ${entry.path}`, entry.path)
  }
  if (entry.status !== '??' && /[a-z?]/u.test(entry.status)) {
    throw unsafeGitState(`Git submodule is dirty: ${entry.path}`, entry.path)
  }
}

async function assertNotSubmodule(
  root: string,
  entry: GitStatusEntry,
): Promise<void> {
  if (entry.status === '??') return
  const path = toProjectPath(entry.path)
  try {
    const stats = await lstat(await resolveProjectPath(root, path))
    if (stats.isDirectory()) {
      throw unsafeGitState(`Git submodule is dirty: ${entry.path}`, entry.path)
    }
  } catch (error) {
    if (error instanceof FrontprepError) throw error
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}

async function assertManifestPath(
  context: ProjectContext,
  repositoryPath: ProjectPath,
): Promise<void> {
  const manifestPath = toProjectPath(
    context.packageDirectory === '.'
      ? MANIFEST_PATH
      : `${context.packageDirectory}/${MANIFEST_PATH}`,
  )
  if (repositoryPath === manifestPath) {
    const fileSystem = new FileSystem(context.packageRoot)
    const bytes = await fileSystem.read(toProjectPath(MANIFEST_PATH))
    if (
      bytes === null ||
      bytes.toString('utf8') !== serializeManifest(context.manifest!)
    ) {
      throw unsafeGitState(
        'The dirty .frontprep.json is not in canonical form.',
        repositoryPath,
      )
    }
    return
  }

  const packagePrefix =
    context.packageDirectory === '.' ? '' : `${context.packageDirectory}/`
  const packagePath = repositoryPath.startsWith(packagePrefix)
    ? toProjectPath(repositoryPath.slice(packagePrefix.length))
    : null
  const candidates: Array<{
    path: ProjectPath
    recorded: ManifestFile
    scope: FileScope
  }> = []
  const repositoryRecord = context.manifest!.files.repository[repositoryPath]
  if (repositoryRecord !== undefined) {
    candidates.push({
      path: repositoryPath,
      recorded: repositoryRecord,
      scope: 'repository' as const,
    })
  }
  if (packagePath !== null) {
    const packageRecord = context.manifest!.files.package[packagePath]
    if (packageRecord !== undefined) {
      candidates.push({
        path: packagePath,
        recorded: packageRecord,
        scope: 'package' as const,
      })
    }
  }
  if (candidates.length === 0) {
    throw unsafeGitState(
      `Git path is not authorized: ${repositoryPath}`,
      repositoryPath,
    )
  }

  try {
    const matching = []
    for (const candidate of candidates) {
      const fileSystem = new FileSystem(rootForScope(context, candidate.scope))
      const snapshot = await fileSystem.snapshot(candidate.path)
      if (snapshot.exists && snapshot.hash === candidate.recorded.hash) {
        matching.push(candidate)
      }
    }
    if (matching.length > 1) {
      throw unsafeGitState(
        `Git path has multiple manifest records: ${repositoryPath}`,
        repositoryPath,
      )
    }
    if (matching.length !== 1) {
      throw unsafeGitState(
        `Git path does not match its manifest fingerprint: ${repositoryPath}`,
        repositoryPath,
      )
    }
  } catch (error) {
    if (error instanceof FrontprepError) throw error
    throw unsafeGitState(
      `Git submodule or unsafe path is dirty: ${repositoryPath}`,
      repositoryPath,
    )
  }
}

export async function assertSafeGitState(
  context: ProjectContext,
  runner: Pick<ProcessRunner, 'run'> = new ProcessRunner(),
): Promise<void> {
  const { stdout } = await runner.run(
    'git',
    ['status', '--porcelain=v1', '-z', '--untracked-files=all'],
    { cwd: context.repositoryRoot },
  )
  const entries = parseGitStatus(stdout)
  if (entries.length === 0) return

  for (const entry of entries) {
    assertOrdinaryStatus(entry)
    await assertNotSubmodule(context.repositoryRoot, entry)
  }

  if (context.manifest === null) {
    throw unsafeGitState(
      `Git worktree must be clean before the first init: ${entries[0]!.path}`,
      entries[0]!.path,
    )
  }

  for (const entry of entries) {
    await assertManifestPath(context, toProjectPath(entry.path))
  }
}
