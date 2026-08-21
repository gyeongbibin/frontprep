import { mkdtemp, mkdir, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { UnsafePathError } from '../../src/core/errors.js'
import { resolveProjectPath, toProjectPath } from '../../src/core/paths.js'

describe('project paths', () => {
  it('normalizes a safe root-relative POSIX path', () => {
    expect(toProjectPath('./src/app/globals.css')).toBe('src/app/globals.css')
  })

  it.each(['/tmp/file', '../file', 'src/../file', 'a\0b', 'src\\file'])(
    'rejects unsafe path %s',
    (value) => {
      expect(() => toProjectPath(value)).toThrow(UnsafePathError)
    },
  )

  it('rejects a path that escapes through a symlinked parent', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'frontprep-paths-'))
    const root = join(parent, 'project')
    const outside = join(parent, 'outside')
    await mkdir(root)
    await mkdir(outside)
    await symlink(outside, join(root, 'linked'))

    await expect(
      resolveProjectPath(root, toProjectPath('linked/file.txt')),
    ).rejects.toBeInstanceOf(UnsafePathError)
  })
})
