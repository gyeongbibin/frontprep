import { execFile } from 'node:child_process'
import { readFile, rm, writeFile } from 'node:fs/promises'
import { delimiter, dirname, join } from 'node:path'
import { promisify } from 'node:util'

import { describe, expect, it } from 'vitest'

import { FileSystem } from '../../src/core/filesystem.js'
import { GitHooksManager } from '../../src/core/git-hooks.js'
import { buildPlan } from '../../src/core/plan-builder.js'
import {
  ProcessRunner,
  type ProcessOptions,
  type ProcessResult,
} from '../../src/core/process.js'
import { detectProject } from '../../src/core/project-detector.js'
import { gitHooksModule } from '../../src/modules/git-hooks.js'
import { qualityModule } from '../../src/modules/quality.js'
import { createProject } from '../helpers/project.js'

const execFileAsync = promisify(execFile)

class EnvironmentRunner implements Pick<ProcessRunner, 'run'> {
  constructor(
    private readonly environment: NodeJS.ProcessEnv,
    private readonly runner = new ProcessRunner(),
  ) {}

  run(
    command: string,
    args: readonly string[],
    options: ProcessOptions,
  ): Promise<ProcessResult> {
    return this.runner.run(command, args, {
      ...options,
      env: this.environment,
    })
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

async function applyModules(root: string): Promise<void> {
  const context = await detectProject(root)
  const qualityAnalysis = await qualityModule.analyze(context)
  const gitHooksAnalysis = await gitHooksModule.analyze(context)
  const plan = await buildPlan(context, [
    ...(await qualityModule.plan(context, qualityAnalysis)),
    ...(await gitHooksModule.plan(context, gitHooksAnalysis)),
  ])
  const fileSystem = new FileSystem(root)
  for (const operation of plan.operations) {
    await fileSystem.writeAtomic(
      operation.path,
      operation.afterBytes,
      operation.mode,
    )
  }
}

describe('Git Hooks dependency compatibility', () => {
  it('runs real staged-file and commit-message hooks on Node.js 22.22.1', async () => {
    const project = await createProject()
    try {
      await applyModules(project.root)
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

      await new GitHooksManager(
        new EnvironmentRunner(minimumNodeEnvironment),
      ).activate(project.root)

      const hookEnvironment = {
        ...minimumNodeEnvironment,
        npm_config_offline: 'true',
        npm_config_registry: 'http://127.0.0.1:9',
        PNPM_OFFLINE: 'true',
      }
      const fixturePath = join(project.root, 'src/hook-fixture.ts')
      await writeFile(fixturePath, 'export const greeting = "hello";\n')
      await execFileAsync('git', ['add', 'src/hook-fixture.ts'], {
        cwd: project.root,
        env: hookEnvironment,
      })
      await execFileAsync('git', ['commit', '-m', 'feat: verify hooks'], {
        cwd: project.root,
        encoding: 'utf8',
        env: hookEnvironment,
        maxBuffer: 20 * 1024 * 1024,
        timeout: 120_000,
      })

      expect(await readFile(fixturePath, 'utf8')).toBe(
        "export const greeting = 'hello'\n",
      )
      const { stdout: hooksPath } = await execFileAsync(
        'git',
        ['config', '--local', '--get', 'core.hooksPath'],
        { cwd: project.root, encoding: 'utf8' },
      )
      expect(hooksPath.trim()).toBe('.husky/_')

      const { stdout: acceptedHead } = await execFileAsync(
        'git',
        ['rev-parse', 'HEAD'],
        { cwd: project.root, encoding: 'utf8' },
      )
      await writeFile(fixturePath, 'export const greeting = "changed";\n')
      await execFileAsync('git', ['add', 'src/hook-fixture.ts'], {
        cwd: project.root,
        env: hookEnvironment,
      })
      await expect(
        execFileAsync('git', ['commit', '-m', 'invalid message'], {
          cwd: project.root,
          encoding: 'utf8',
          env: hookEnvironment,
          maxBuffer: 20 * 1024 * 1024,
          timeout: 120_000,
        }),
      ).rejects.toMatchObject({ code: 1 })
      const { stdout: rejectedHead } = await execFileAsync(
        'git',
        ['rev-parse', 'HEAD'],
        { cwd: project.root, encoding: 'utf8' },
      )
      expect(rejectedHead).toBe(acceptedHead)
    } finally {
      await rm(project.root, { force: true, recursive: true })
    }
  })
})
