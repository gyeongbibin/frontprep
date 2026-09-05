import { execFile } from 'node:child_process'
import { readFile, rm, writeFile } from 'node:fs/promises'
import { delimiter, dirname, join } from 'node:path'
import { promisify } from 'node:util'

import { describe, expect, it } from 'vitest'

import { FileSystem } from '../../src/core/filesystem.js'
import { buildPlan } from '../../src/core/plan-builder.js'
import { detectProject } from '../../src/core/project-detector.js'
import { qualityModule } from '../../src/modules/quality.js'
import { createProject } from '../helpers/project.js'

const execFileAsync = promisify(execFile)

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

async function applyQualityModule(root: string): Promise<void> {
  const context = await detectProject(root)
  const analysis = await qualityModule.analyze(context)
  const plan = await buildPlan(
    context,
    await qualityModule.plan(context, analysis),
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

describe('Quality dependency compatibility', () => {
  it('installs and runs the generated lint pipeline on Node.js 22.22.1', async () => {
    const project = await createProject()
    try {
      await applyQualityModule(project.root)
      const fixturePath = join(project.root, 'src/quality-fixture.ts')
      await writeFile(fixturePath, 'export const greeting = "hello";\n')

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
          maxBuffer: 20 * 1024 * 1024,
          timeout: 180_000,
        },
      )
      const { stdout: eslintVersion } = await execFileAsync(
        minimumNode,
        [join(project.root, 'node_modules/eslint/bin/eslint.js'), '--version'],
        { cwd: project.root, encoding: 'utf8' },
      )
      expect(eslintVersion.trim()).toMatch(/^v9\./u)

      for (const script of [
        'frontprep:lint:fix',
        'frontprep:format',
        'frontprep:format:check',
      ]) {
        await execFileAsync('pnpm', ['run', script], {
          cwd: project.root,
          encoding: 'utf8',
          env: minimumNodeEnvironment,
          maxBuffer: 20 * 1024 * 1024,
          timeout: 120_000,
        })
      }
      expect(await readFile(fixturePath, 'utf8')).toBe(
        "export const greeting = 'hello'\n",
      )

      await writeFile(
        fixturePath,
        'const warningFixture = {}\n\nexport default warningFixture\n',
      )
      await writeFile(
        join(project.root, 'src/warning-fixture.ts'),
        'export default {}\n',
      )
      await expect(
        execFileAsync('pnpm', ['run', 'frontprep:lint'], {
          cwd: project.root,
          encoding: 'utf8',
          env: minimumNodeEnvironment,
          maxBuffer: 20 * 1024 * 1024,
          timeout: 120_000,
        }),
      ).rejects.toMatchObject({ code: 1 })
    } finally {
      await rm(project.root, { force: true, recursive: true })
    }
  })
})
