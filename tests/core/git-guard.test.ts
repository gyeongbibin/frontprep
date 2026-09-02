import { execFile } from 'node:child_process'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { describe, expect, it } from 'vitest'

import { hashBytes } from '../../src/core/filesystem.js'
import { assertSafeGitState } from '../../src/core/git-guard.js'
import { serializeManifest, writeManifest } from '../../src/core/manifest.js'
import { detectProject } from '../../src/core/project-detector.js'
import type { FrontprepManifest } from '../../src/core/types.js'
import { createProject } from '../helpers/project.js'
import { manifestV2 } from '../helpers/manifest.js'

const execFileAsync = promisify(execFile)

function manifestWithFiles(
  files: FrontprepManifest['files']['package'],
): FrontprepManifest {
  return manifestV2({
    frontprepVersion: '0.1.0-beta.0',
    files: { package: files, repository: {} },
    managedScripts: {},
  })
}

async function git(root: string, ...args: string[]): Promise<void> {
  await execFileAsync('git', args, { cwd: root })
}

describe('Git guard', () => {
  it('accepts a clean first run', async () => {
    const project = await createProject()

    await expect(
      assertSafeGitState(await detectProject(project.root)),
    ).resolves.toBeUndefined()
  })

  it.each([
    ['tracked', 'src/app/globals.css'],
    ['untracked', 'untracked.txt'],
  ])('rejects a dirty %s path on the first run', async (_, path) => {
    const project = await createProject()
    await writeFile(join(project.root, path), 'dirty\n')

    await expect(
      assertSafeGitState(await detectProject(project.root)),
    ).rejects.toMatchObject({ code: 'UNSAFE_GIT_STATE', phase: 'git' })
  })

  it('accepts only the exact dirty files authorized by a canonical manifest', async () => {
    const project = await createProject()
    const packagePath = join(project.root, 'package.json')
    const packageBytes = Buffer.from(
      (await readFile(packagePath, 'utf8')).replace(
        '"private": true,',
        '"private": true,\n  "scripts": { "frontprep:check": "echo ok" },',
      ),
    )
    await writeFile(packagePath, packageBytes)
    await writeManifest(
      project.root,
      manifestWithFiles({
        'package.json': {
          hash: hashBytes(packageBytes),
          mode: '0644',
          ownership: 'patched',
        },
      }),
    )

    await expect(
      assertSafeGitState(await detectProject(project.root)),
    ).resolves.toBeUndefined()

    await writeFile(join(project.root, 'extra.txt'), 'not authorized\n')
    await expect(
      assertSafeGitState(await detectProject(project.root)),
    ).rejects.toThrow('extra.txt')
  })

  it('authorizes one repository-scoped managed record and rejects duplicates', async () => {
    const project = await createProject()
    const workflowPath = '.github/workflows/ci.yml'
    const workflowBytes = Buffer.from('name: CI\n')
    await mkdir(join(project.root, '.github/workflows'), { recursive: true })
    await writeFile(join(project.root, workflowPath), workflowBytes)
    const base = await detectProject(project.root)
    const record = {
      hash: hashBytes(workflowBytes),
      mode: '0644',
      ownership: 'managed' as const,
    }
    const repositoryManifest = manifestV2({
      frontprepVersion: '0.1.0-beta.0',
      files: { package: {}, repository: { [workflowPath]: record } },
    })

    await expect(
      assertSafeGitState({ ...base, manifest: repositoryManifest }),
    ).resolves.toBeUndefined()

    const duplicateManifest = manifestV2({
      frontprepVersion: '0.1.0-beta.0',
      files: {
        package: { [workflowPath]: record },
        repository: { [workflowPath]: record },
      },
    })
    await expect(
      assertSafeGitState({ ...base, manifest: duplicateManifest }),
    ).rejects.toThrow('multiple manifest records')
  })

  it('rejects a semantically valid but non-canonical manifest', async () => {
    const project = await createProject()
    const manifest = manifestWithFiles({})
    await writeFile(
      join(project.root, '.frontprep.json'),
      JSON.stringify(manifest),
    )

    await expect(
      assertSafeGitState(await detectProject(project.root)),
    ).rejects.toThrow('canonical')
    expect(
      await readFile(join(project.root, '.frontprep.json'), 'utf8'),
    ).not.toBe(serializeManifest(manifest))
  })

  it('rejects deleted and renamed managed files', async () => {
    const project = await createProject()
    const ownedPath = join(project.root, 'owned.txt')
    const ownedBytes = Buffer.from('owned\n')
    await writeFile(ownedPath, ownedBytes)
    await git(project.root, 'add', 'owned.txt')
    await git(project.root, 'commit', '-m', 'add owned file')
    await writeManifest(
      project.root,
      manifestWithFiles({
        'owned.txt': {
          hash: hashBytes(ownedBytes),
          mode: '0644',
          ownership: 'managed',
        },
      }),
    )

    await rm(ownedPath)
    await expect(
      assertSafeGitState(await detectProject(project.root)),
    ).rejects.toThrow('deleted')

    await writeFile(ownedPath, ownedBytes)
    await rename(ownedPath, join(project.root, 'renamed.txt'))
    await git(project.root, 'add', '--all')
    await expect(
      assertSafeGitState(await detectProject(project.root)),
    ).rejects.toThrow('renamed')
  })

  it('rejects an unresolved merge conflict', async () => {
    const project = await createProject()
    const conflictPath = join(project.root, 'conflict.txt')
    await writeFile(conflictPath, 'base\n')
    await git(project.root, 'add', 'conflict.txt')
    await git(project.root, 'commit', '-m', 'conflict base')
    await git(project.root, 'switch', '-c', 'other')
    await writeFile(conflictPath, 'other\n')
    await git(project.root, 'commit', '-am', 'other')
    await git(project.root, 'switch', '-')
    await writeFile(conflictPath, 'current\n')
    await git(project.root, 'commit', '-am', 'current')
    await expect(
      execFileAsync('git', ['merge', 'other'], { cwd: project.root }),
    ).rejects.toBeDefined()

    await expect(
      assertSafeGitState(await detectProject(project.root)),
    ).rejects.toThrow('conflicted')
  })

  it('rejects a dirty submodule', async () => {
    const project = await createProject()
    const source = await createProject()
    await git(
      project.root,
      '-c',
      'protocol.file.allow=always',
      'submodule',
      'add',
      source.root,
      'vendor/example',
    )
    await git(project.root, 'commit', '-am', 'add submodule')
    await writeFile(
      join(project.root, 'vendor/example/src/app/globals.css'),
      'dirty submodule\n',
    )

    await expect(
      assertSafeGitState(await detectProject(project.root)),
    ).rejects.toThrow('submodule')
  })
})
