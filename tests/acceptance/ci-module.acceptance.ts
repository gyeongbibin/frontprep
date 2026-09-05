import { execFile } from 'node:child_process'
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  readlink,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join, posix, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { format } from 'prettier'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'

import { hashBytes } from '../../src/core/filesystem.js'
import type { FrontprepManifest } from '../../src/core/types.js'
import { createProject } from '../helpers/project.js'

const execFileAsync = promisify(execFile)
const repositoryRoot = fileURLToPath(new URL('../..', import.meta.url))
const excludedDirectories = new Set(['.git', '.next', 'node_modules'])

function isGeneratedIgnoredFile(name: string): boolean {
  return name === 'next-env.d.ts' || name.endsWith('.tsbuildinfo')
}

interface WorkflowDocument {
  concurrency: { 'cancel-in-progress': boolean; group: string }
  env: { HUSKY: string }
  jobs: {
    check: {
      steps: Array<{
        name: string
        run?: string
        uses?: string
        with?: Record<string, unknown>
      }>
    }
  }
  on: Record<string, { branches: string[] }>
  permissions: { contents: string }
}

interface InstalledCli {
  cli: string
  root: string
}

interface PackResult {
  filename: string
}

async function installPackedCli(): Promise<InstalledCli> {
  const root = await mkdtemp(join(tmpdir(), 'frontprep-ci-package-'))
  try {
    const packDirectory = join(root, 'pack')
    const installDirectory = join(root, 'install')
    const npmEnvironment = {
      ...process.env,
      npm_config_cache: join(root, 'npm-cache'),
    }
    await mkdir(packDirectory)
    const { stdout } = await execFileAsync(
      'npm',
      ['pack', '--json', '--pack-destination', packDirectory],
      {
        cwd: repositoryRoot,
        encoding: 'utf8',
        env: npmEnvironment,
      },
    )
    const [packed] = JSON.parse(stdout) as PackResult[]
    if (packed === undefined || packed.filename.length === 0) {
      throw new Error('npm pack did not return a tarball filename.')
    }
    await execFileAsync(
      'npm',
      [
        'install',
        '--ignore-scripts',
        '--no-audit',
        '--no-fund',
        '--prefix',
        installDirectory,
        join(packDirectory, packed.filename),
      ],
      {
        cwd: root,
        encoding: 'utf8',
        env: npmEnvironment,
        maxBuffer: 10 * 1024 * 1024,
        timeout: 120_000,
      },
    )
    const cli = join(
      installDirectory,
      'node_modules',
      '@mingyeongbin',
      'frontprep',
      'dist',
      'cli.js',
    )
    await stat(cli)
    return { cli, root }
  } catch (error) {
    await rm(root, { force: true, recursive: true })
    throw error
  }
}

async function minimumNodeExecutable(): Promise<string> {
  const { stdout } = await execFileAsync(
    'pnpm',
    [
      '--silent',
      'dlx',
      '--package=node@22.22.1',
      'node',
      '-p',
      'process.execPath',
    ],
    { encoding: 'utf8', timeout: 120_000 },
  )
  return stdout.trim()
}

async function writeFixture(root: string): Promise<void> {
  const packagePath = join(root, 'package.json')
  const packageJson = JSON.parse(await readFile(packagePath, 'utf8')) as {
    dependencies: Record<string, string>
    devDependencies?: Record<string, string>
  }
  packageJson.dependencies['react-dom'] = '19.2.0'
  packageJson.devDependencies = {
    ...packageJson.devDependencies,
    '@types/react': '19.2.0',
    '@types/react-dom': '19.2.0',
  }
  await writeFile(
    packagePath,
    `${JSON.stringify(packageJson, null, 2)}\n`,
    'utf8',
  )
  const tsconfig = {
    compilerOptions: {
      allowJs: true,
      esModuleInterop: true,
      incremental: true,
      isolatedModules: true,
      jsx: 'react-jsx',
      lib: ['dom', 'dom.iterable', 'esnext'],
      module: 'esnext',
      moduleResolution: 'bundler',
      noEmit: true,
      paths: { '@/*': ['./src/*'] },
      plugins: [{ name: 'next' }],
      resolveJsonModule: true,
      skipLibCheck: true,
      strict: true,
      target: 'ES2017',
    },
    exclude: ['node_modules'],
    include: [
      'next-env.d.ts',
      '**/*.ts',
      '**/*.tsx',
      '.next/types/**/*.ts',
      '.next/dev/types/**/*.ts',
    ],
  }
  await writeFile(
    join(root, 'tsconfig.json'),
    await format(JSON.stringify(tsconfig), { parser: 'json' }),
  )
  await writeFile(
    join(root, 'src/app/globals.css'),
    await format('body {}\n', { parser: 'css' }),
  )
  await writeFile(
    join(root, '.gitignore'),
    '.next\nnode_modules\n*.tsbuildinfo\nnext-env.d.ts\n',
  )
  await writeFile(
    join(root, 'next-env.d.ts'),
    `/// <reference types="next" />
/// <reference types="next/image-types/global" />
import "./.next/types/routes.d.ts";

// NOTE: This file should not be edited
// see https://nextjs.org/docs/app/api-reference/config/typescript for more information.
`,
  )
  await writeFile(
    join(root, 'src/app/layout.tsx'),
    `import type { ReactNode } from 'react'

import './globals.css'

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  )
}
`,
  )
  await writeFile(
    join(root, 'src/app/page.tsx'),
    `export default function Home() {
  return <main>Frontprep acceptance</main>
}
`,
  )
  await execFileAsync('git', ['add', '--all'], { cwd: root })
  await execFileAsync('git', ['commit', '-m', 'test: prepare Next fixture'], {
    cwd: root,
  })
}

async function snapshotProject(root: string): Promise<Map<string, string>> {
  const snapshots = new Map<string, string>()
  const directories = ['']
  while (directories.length > 0) {
    const directory = directories.shift()!
    const entries = await readdir(join(root, directory), {
      withFileTypes: true,
    })
    entries.sort((left, right) => left.name.localeCompare(right.name))
    for (const entry of entries) {
      if (entry.isDirectory() && excludedDirectories.has(entry.name)) continue
      if (!entry.isDirectory() && isGeneratedIgnoredFile(entry.name)) continue
      const absolutePath = join(root, directory, entry.name)
      const projectPath = posix.join(
        relative(root, join(root, directory)).split(delimiter).join('/'),
        entry.name,
      )
      if (entry.isDirectory()) {
        directories.push(posix.join(directory, entry.name))
      } else if (entry.isSymbolicLink()) {
        snapshots.set(projectPath, `link:${await readlink(absolutePath)}`)
      } else if (entry.isFile()) {
        const mode = (await stat(absolutePath)).mode & 0o777
        snapshots.set(
          projectPath,
          `${mode.toString(8)}:${hashBytes(await readFile(absolutePath))}`,
        )
      }
    }
  }
  return snapshots
}

describe('complete v1 compatibility', () => {
  it('runs the public five-module CLI and full check on Node.js 22.22.1', async () => {
    const installation = await installPackedCli()
    const project = await createProject().catch(async (error: unknown) => {
      await rm(installation.root, { force: true, recursive: true })
      throw error
    })
    try {
      const frontprepCli = installation.cli
      expect(frontprepCli).toContain(
        join('node_modules', '@mingyeongbin', 'frontprep', 'dist', 'cli.js'),
      )
      await writeFixture(project.root)
      const minimumNode = await minimumNodeExecutable()
      const { stdout: nodeVersion } = await execFileAsync(
        minimumNode,
        ['--version'],
        { encoding: 'utf8' },
      )
      expect(nodeVersion.trim()).toBe('v22.22.1')
      const minimumNodeEnvironment = {
        ...process.env,
        PATH: `${dirname(minimumNode)}${delimiter}${process.env.PATH ?? ''}`,
      }

      await execFileAsync(
        minimumNode,
        [frontprepCli, 'init', '--cwd', project.root],
        {
          cwd: repositoryRoot,
          encoding: 'utf8',
          env: minimumNodeEnvironment,
          maxBuffer: 30 * 1024 * 1024,
          timeout: 300_000,
        },
      )

      const manifest = JSON.parse(
        await readFile(join(project.root, '.frontprep.json'), 'utf8'),
      ) as FrontprepManifest
      expect(manifest.modules).toEqual({
        ci: '2.0.0',
        'git-hooks': '3.0.0',
        quality: '2.0.0',
        tailwind: '2.0.0',
        test: '3.0.0',
      })
      expect(
        manifest.files.repository['.github/workflows/ci.yml'],
      ).toMatchObject({
        mode: '0644',
        ownership: 'managed',
      })

      const packageJson = JSON.parse(
        await readFile(join(project.root, 'package.json'), 'utf8'),
      ) as { scripts: Record<string, string> }
      expect(packageJson.scripts['frontprep:check']).toBe(
        'pnpm run frontprep:quality && pnpm run frontprep:test && pnpm run frontprep:build',
      )
      const workflow = parse(
        await readFile(join(project.root, '.github/workflows/ci.yml'), 'utf8'),
      ) as WorkflowDocument
      expect(workflow).toMatchObject({
        concurrency: {
          'cancel-in-progress': true,
          group:
            'ci-${{ github.workflow }}-${{ github.event.pull_request.number || github.ref }}',
        },
        env: { HUSKY: '0' },
        on: {
          pull_request: { branches: ['develop', 'main'] },
          push: { branches: ['develop', 'main'] },
        },
        permissions: { contents: 'read' },
      })
      expect(workflow.jobs.check.steps.at(-2)?.run).toBe(
        'pnpm install --frozen-lockfile',
      )
      expect(workflow.jobs.check.steps.at(-1)?.run).toBe(
        'pnpm run frontprep:check',
      )

      const firstSnapshot = await snapshotProject(project.root)
      await execFileAsync(
        minimumNode,
        [frontprepCli, 'init', '--cwd', project.root],
        {
          cwd: repositoryRoot,
          encoding: 'utf8',
          env: minimumNodeEnvironment,
          maxBuffer: 30 * 1024 * 1024,
          timeout: 300_000,
        },
      )
      expect(await snapshotProject(project.root)).toEqual(firstSnapshot)

      await execFileAsync(
        minimumNode,
        [frontprepCli, 'check', '--cwd', project.root],
        {
          cwd: repositoryRoot,
          encoding: 'utf8',
          env: minimumNodeEnvironment,
          maxBuffer: 30 * 1024 * 1024,
          timeout: 300_000,
        },
      )
      expect(
        (await stat(join(project.root, '.husky/pre-commit'))).mode & 0o777,
      ).toBe(0o755)
    } finally {
      await Promise.all([
        rm(project.root, { force: true, recursive: true }),
        rm(installation.root, { force: true, recursive: true }),
      ])
    }
  }, 900_000)
})
