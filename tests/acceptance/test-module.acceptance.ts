import { execFile } from 'node:child_process'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { delimiter, dirname, join } from 'node:path'
import { promisify } from 'node:util'

import { describe, expect, it } from 'vitest'

import { FileSystem } from '../../src/core/filesystem.js'
import { buildPlan } from '../../src/core/plan-builder.js'
import { detectProject } from '../../src/core/project-detector.js'
import { testModule } from '../../src/modules/test.js'
import { createProject } from '../helpers/project.js'

const execFileAsync = promisify(execFile)

async function applyTestModule(root: string): Promise<void> {
  const context = await detectProject(root)
  const analysis = await testModule.analyze(context)
  const plan = await buildPlan(
    context,
    await testModule.plan(context, analysis),
  )
  const fileSystem = new FileSystem(root)
  for (const operation of plan.operations) {
    await fileSystem.writeAtomic(
      operation.path,
      operation.afterBytes,
      operation.mode,
    )
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

describe('Test module dependency compatibility', () => {
  it('installs and runs the generated Vitest setup on Node.js 22.22.1', async () => {
    const project = await createProject()
    try {
      const packagePath = join(project.root, 'package.json')
      const packageJson = JSON.parse(await readFile(packagePath, 'utf8')) as {
        dependencies: Record<string, string>
        scripts?: Record<string, string>
      }
      packageJson.dependencies['react-dom'] = '19.2.0'
      packageJson.scripts = {
        'frontprep:check': 'pnpm run frontprep:quality',
        'frontprep:quality': 'echo quality fixture',
      }
      await writeFile(
        packagePath,
        `${JSON.stringify(packageJson, null, 2)}\n`,
        'utf8',
      )
      await writeFile(
        join(project.root, 'tsconfig.json'),
        `${JSON.stringify(
          {
            compilerOptions: {
              baseUrl: '.',
              jsx: 'react-jsx',
              paths: { '@/*': ['./src/*'] },
              strict: true,
            },
          },
          null,
          2,
        )}\n`,
        'utf8',
      )

      await applyTestModule(project.root)
      await mkdir(join(project.root, 'src/components'), { recursive: true })
      await writeFile(
        join(project.root, 'src/components/greeting.tsx'),
        `export function Greeting({ name }: { name: string }) {
  return <h1>Hello, {name}</h1>
}
`,
        'utf8',
      )
      await writeFile(
        join(project.root, 'src/test/greeting.test.tsx'),
        `import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { Greeting } from '@/components/greeting'

describe('Greeting', () => {
  it('renders through React Testing Library with jest-dom matchers', () => {
    render(<Greeting name="Frontprep" />)
    expect(screen.getByRole('heading')).toHaveTextContent('Hello, Frontprep')
  })
})
`,
        'utf8',
      )
      await writeFile(
        join(project.root, 'src/components/value.test.ts'),
        `import { expect, it } from 'vitest'

it('collects colocated application tests', () => {
  expect(1 + 1).toBe(2)
})
`,
        'utf8',
      )
      await mkdir(join(project.root, 'src/fixtures'), { recursive: true })
      await writeFile(
        join(project.root, 'src/fixtures/ignored.test.ts'),
        `import { it } from 'vitest'

it('does not collect fixtures', () => {
  throw new Error('fixture test must be excluded')
})
`,
        'utf8',
      )

      const updated = await detectProject(project.root)
      await expect(testModule.verify(updated)).resolves.toEqual({
        issues: [],
        valid: true,
      })

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
        'pnpm',
        ['install', '--ignore-scripts', '--no-frozen-lockfile'],
        {
          cwd: project.root,
          encoding: 'utf8',
          env: minimumNodeEnvironment,
          maxBuffer: 10 * 1024 * 1024,
          timeout: 180_000,
        },
      )

      const { stdout } = await execFileAsync(
        minimumNode,
        [join(project.root, 'node_modules/vitest/vitest.mjs'), 'run'],
        {
          cwd: project.root,
          encoding: 'utf8',
          maxBuffer: 10 * 1024 * 1024,
          timeout: 120_000,
        },
      )
      expect(stdout).toMatch(/2 passed/u)
    } finally {
      await rm(project.root, { force: true, recursive: true })
    }
  })
})
