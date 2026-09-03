import { valid } from 'semver'

import { FrontprepError } from './errors.js'
import { ProcessRunner } from './process.js'

export interface ProcessService {
  run: ProcessRunner['run']
}

export interface WorkspaceInstallOptions {
  readonly packageDirectory: string
}

const TRUSTED_BUILD_DEPENDENCIES = ['esbuild'] as const

function unsupportedPnpm(version: string): FrontprepError {
  return new FrontprepError(
    `Frontprep requires a pnpm 10 runtime; received ${JSON.stringify(version)}.`,
    {
      code: 'UNSUPPORTED_PNPM',
      exitCode: 2,
      phase: 'installation',
      recovery: 'Activate pnpm 10 with Corepack and retry.',
    },
  )
}

export class PnpmPackageManager {
  constructor(private readonly runner: ProcessService = new ProcessRunner()) {}

  async assertSupported(root: string, signal?: AbortSignal): Promise<void> {
    const result = await this.runner.run('pnpm', ['--version'], {
      cwd: root,
      signal,
    })
    const version = result.stdout.trim()
    if (valid(version) === null || !version.startsWith('10.')) {
      throw unsupportedPnpm(version)
    }
  }

  async install(
    root: string,
    signal?: AbortSignal,
    options?: WorkspaceInstallOptions,
  ): Promise<void> {
    const filter =
      options === undefined
        ? []
        : ['--filter', `./${options.packageDirectory}`, '--fail-if-no-match']
    await this.runner.run('pnpm', [...filter, 'install', '--ignore-scripts'], {
      cwd: root,
      signal,
    })
    await this.runner.run(
      'pnpm',
      [...filter, 'rebuild', ...TRUSTED_BUILD_DEPENDENCIES],
      { cwd: root, signal },
    )
  }
}
