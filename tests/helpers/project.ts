import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export interface ProjectOptions {
  appDirectory?: 'app' | 'src/app'
  layout?: string
  nextVersion?: string
  packageManager?: string
  packageWorkspaces?: string[]
  pnpmWorkspace?: string
  secondAppRoot?: boolean
  typescriptVersion?: string | null
}

export async function writeProjectFile(
  root: string,
  path: string,
  contents: string,
): Promise<void> {
  const absolutePath = join(root, path)
  await mkdir(dirname(absolutePath), { recursive: true })
  await writeFile(absolutePath, contents, 'utf8')
}

export async function createProject(
  options: ProjectOptions = {},
): Promise<{ root: string }> {
  const root = await mkdtemp(join(tmpdir(), 'frontprep-project-'))
  const appDirectory = options.appDirectory ?? 'src/app'
  const packageJson = {
    name: 'fixture',
    private: true,
    packageManager: options.packageManager ?? 'pnpm@10.22.0',
    dependencies: {
      next: options.nextVersion ?? '16.3.2',
      react: '19.2.0',
      ...(options.typescriptVersion === null
        ? {}
        : { typescript: options.typescriptVersion ?? '^5.9.0' }),
    },
    ...(options.packageWorkspaces === undefined
      ? {}
      : { workspaces: options.packageWorkspaces }),
  }

  await writeProjectFile(
    root,
    'package.json',
    `${JSON.stringify(packageJson, null, 2)}\n`,
  )
  await writeProjectFile(
    root,
    'tsconfig.json',
    '{\n  // JSONC is valid for TypeScript\n  "compilerOptions": { "strict": true }\n}\n',
  )
  await writeProjectFile(
    root,
    `${appDirectory}/layout.tsx`,
    options.layout ??
      "import './globals.css'\n\nexport default function Layout() { return null }\n",
  )
  await writeProjectFile(root, `${appDirectory}/globals.css`, 'body {}\n')

  if (options.secondAppRoot === true) {
    const secondRoot = appDirectory === 'app' ? 'src/app' : 'app'
    await writeProjectFile(
      root,
      `${secondRoot}/layout.tsx`,
      'export default function Layout() { return null }\n',
    )
  }
  if (options.pnpmWorkspace !== undefined) {
    await writeProjectFile(root, 'pnpm-workspace.yaml', options.pnpmWorkspace)
  }

  await execFileAsync('git', ['init'], { cwd: root })
  await execFileAsync('git', ['config', 'user.email', 'fixture@example.com'], {
    cwd: root,
  })
  await execFileAsync('git', ['config', 'user.name', 'Fixture'], { cwd: root })
  await execFileAsync('git', ['add', '--all'], { cwd: root })
  await execFileAsync('git', ['commit', '-m', 'fixture'], { cwd: root })

  return { root }
}

export async function createWorkspaceProject(): Promise<{
  packageRoot: string
  repositoryRoot: string
}> {
  const repositoryRoot = await mkdtemp(join(tmpdir(), 'frontprep-workspace-'))
  const packageRoot = join(repositoryRoot, 'apps/web')
  await writeProjectFile(
    repositoryRoot,
    'package.json',
    `${JSON.stringify(
      {
        name: 'workspace-root',
        private: true,
        packageManager: 'pnpm@10.22.0',
      },
      null,
      2,
    )}\n`,
  )
  await writeProjectFile(
    repositoryRoot,
    'pnpm-workspace.yaml',
    "packages:\n  - 'apps/*'\n",
  )
  await writeProjectFile(
    packageRoot,
    'package.json',
    `${JSON.stringify(
      {
        name: 'web',
        private: true,
        dependencies: {
          next: '16.3.2',
          react: '19.2.0',
          typescript: '^5.9.0',
        },
      },
      null,
      2,
    )}\n`,
  )
  await writeProjectFile(
    packageRoot,
    'tsconfig.json',
    '{"compilerOptions":{"strict":true}}\n',
  )
  await writeProjectFile(
    packageRoot,
    'src/app/layout.tsx',
    "import './globals.css'\nexport default function Layout() { return null }\n",
  )
  await writeProjectFile(packageRoot, 'src/app/globals.css', 'body {}\n')

  await execFileAsync('git', ['init'], { cwd: repositoryRoot })
  await execFileAsync('git', ['config', 'user.email', 'fixture@example.com'], {
    cwd: repositoryRoot,
  })
  await execFileAsync('git', ['config', 'user.name', 'Fixture'], {
    cwd: repositoryRoot,
  })
  await execFileAsync('git', ['add', '--all'], { cwd: repositoryRoot })
  await execFileAsync('git', ['commit', '-m', 'fixture'], {
    cwd: repositoryRoot,
  })
  return { packageRoot, repositoryRoot }
}
