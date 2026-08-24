import { createHash, randomUUID } from 'node:crypto'
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  readFile,
  rename,
  rm,
  rmdir,
  writeFile,
} from 'node:fs/promises'
import { dirname, posix } from 'node:path'

import { resolveProjectPath, toProjectPath, type ProjectPath } from './paths.js'

export interface FileSnapshot {
  bytes: Buffer | null
  exists: boolean
  hash: string | null
  mode: number | null
}

export function hashBytes(bytes: Uint8Array): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`
}

export class FileSystem {
  constructor(readonly root: string) {}

  async snapshot(path: ProjectPath): Promise<FileSnapshot> {
    const absolutePath = await resolveProjectPath(this.root, path)
    try {
      const stats = await lstat(absolutePath)
      if (stats.isSymbolicLink() || !stats.isFile()) {
        throw new Error(`Expected a regular file: ${path}`)
      }
      const bytes = await readFile(absolutePath)
      return {
        bytes,
        exists: true,
        hash: hashBytes(bytes),
        mode: stats.mode & 0o777,
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { bytes: null, exists: false, hash: null, mode: null }
      }
      throw error
    }
  }

  async read(path: ProjectPath): Promise<Buffer | null> {
    return (await this.snapshot(path)).bytes
  }

  async writeAtomic(
    path: ProjectPath,
    bytes: Uint8Array,
    mode: number,
  ): Promise<void> {
    const absolutePath = await resolveProjectPath(this.root, path)
    const parent = dirname(absolutePath)
    await mkdir(parent, { recursive: true })
    const temporaryPath = `${absolutePath}.frontprep-${randomUUID()}`
    try {
      await writeFile(temporaryPath, bytes, { flag: 'wx', mode })
      await chmod(temporaryPath, mode)
      await rename(temporaryPath, absolutePath)
    } catch (error) {
      await rm(temporaryPath, { force: true }).catch(() => undefined)
      throw error
    }
  }

  async copy(source: ProjectPath, destination: string): Promise<void> {
    const absoluteSource = await resolveProjectPath(this.root, source)
    await mkdir(dirname(destination), { recursive: true })
    await copyFile(absoluteSource, destination)
  }

  async remove(path: ProjectPath): Promise<void> {
    const absolutePath = await resolveProjectPath(this.root, path)
    await rm(absolutePath, { force: true })
  }

  async missingParentDirectories(
    path: ProjectPath,
  ): Promise<readonly ProjectPath[]> {
    const missing: ProjectPath[] = []
    let parent = posix.dirname(path)
    while (parent !== '.') {
      const projectPath = toProjectPath(parent)
      const absolutePath = await resolveProjectPath(this.root, projectPath)
      try {
        const stats = await lstat(absolutePath)
        if (!stats.isDirectory()) {
          throw new Error(`Expected a directory: ${projectPath}`)
        }
        break
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        missing.push(projectPath)
        parent = posix.dirname(parent)
      }
    }
    return Object.freeze(missing)
  }

  async removeDirectoryIfEmpty(path: ProjectPath): Promise<void> {
    const absolutePath = await resolveProjectPath(this.root, path)
    try {
      await rmdir(absolutePath)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'ENOENT' && code !== 'ENOTEMPTY' && code !== 'EEXIST') {
        throw error
      }
    }
  }
}
