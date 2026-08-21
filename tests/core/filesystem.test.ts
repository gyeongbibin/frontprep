import { lstat, mkdtemp, mkdir, readFile, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { FileSystem, hashBytes } from '../../src/core/filesystem.js'
import { toProjectPath } from '../../src/core/paths.js'

describe('filesystem service', () => {
  it('hashes exact bytes with SHA-256', () => {
    expect(hashBytes(Buffer.from('hello'))).toBe(
      'sha256:2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
    )
  })

  it('atomically writes bytes and applies the requested mode', async () => {
    const root = await mkdtemp(join(tmpdir(), 'frontprep-files-'))
    const fileSystem = new FileSystem(root)

    await fileSystem.writeAtomic(
      toProjectPath('nested/hook'),
      Buffer.from('pnpm test\n'),
      0o755,
    )

    expect(await readFile(join(root, 'nested/hook'), 'utf8')).toBe(
      'pnpm test\n',
    )
    expect((await lstat(join(root, 'nested/hook'))).mode & 0o777).toBe(0o755)
  })

  it('refuses to write through a symlinked directory', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'frontprep-files-'))
    const root = join(parent, 'project')
    const outside = join(parent, 'outside')
    await mkdir(root)
    await mkdir(outside)
    await symlink(outside, join(root, 'linked'))
    const fileSystem = new FileSystem(root)

    await expect(
      fileSystem.writeAtomic(
        toProjectPath('linked/file.txt'),
        Buffer.from('unsafe'),
        0o644,
      ),
    ).rejects.toThrow('Unsafe project path')
  })
})
