import { lstat } from 'node:fs/promises'
import { join } from 'node:path'

import { FrontprepError } from './errors.js'
import { ProcessFailure, ProcessRunner } from './process.js'

type Runner = Pick<ProcessRunner, 'run'>

export interface GitHooksActivation {
  readonly previousHooksPath: string | null
}

export interface GitHooksTarget {
  readonly packageDirectory: string
  readonly packageRoot: string
}

export interface GitHooksService {
  activate(
    root: string,
    signal?: AbortSignal,
    target?: GitHooksTarget,
  ): Promise<GitHooksActivation | null>
  restore(root: string, activation: GitHooksActivation): Promise<void>
}

function restorationFailure(original: unknown, restoration: unknown): Error {
  return new FrontprepError(
    'Frontprep could not restore Git hook configuration after Husky activation failed.',
    {
      cause: { original, restoration },
      code: 'ROLLBACK_FAILED',
      exitCode: 1,
      phase: 'application',
      recovery: 'Restore core.hooksPath with git config --local and retry.',
    },
  )
}

export async function readLocalHooksPath(
  root: string,
  runner: Runner = new ProcessRunner(),
): Promise<string | null> {
  const args = ['config', '--local', '--get', 'core.hooksPath'] as const
  try {
    const { stdout } = await runner.run('git', args, { cwd: root })
    return stdout.trim()
  } catch (error) {
    if (error instanceof ProcessFailure && error.exitCode === 1) return null
    throw error
  }
}

export async function resolveDefaultHooksDirectory(
  root: string,
  runner: Runner = new ProcessRunner(),
): Promise<string> {
  const { stdout } = await runner.run(
    'git',
    ['rev-parse', '--path-format=absolute', '--git-path', 'hooks'],
    { cwd: root },
  )
  const path = stdout.trim()
  if (path.length === 0) {
    throw new FrontprepError('Git returned an empty hooks directory path.', {
      code: 'GIT_HOOKS_PATH_INVALID',
      exitCode: 2,
      phase: 'git',
      recovery: 'Repair the Git repository metadata and retry.',
    })
  }
  return path
}

export async function hasHuskyDispatcher(root: string): Promise<boolean> {
  try {
    const metadata = await lstat(join(root, '.husky/_/h'))
    return metadata.isFile() && !metadata.isSymbolicLink()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    return false
  }
}

export class GitHooksManager implements GitHooksService {
  constructor(private readonly runner: Runner = new ProcessRunner()) {}

  async activate(
    root: string,
    signal?: AbortSignal,
    target?: GitHooksTarget,
  ): Promise<GitHooksActivation | null> {
    const hooksPath =
      target === undefined ? '.husky/_' : `${target.packageDirectory}/.husky/_`
    const dispatcherRoot = target?.packageRoot ?? root
    const previousHooksPath = await readLocalHooksPath(root, this.runner)
    if (
      previousHooksPath === hooksPath &&
      (await hasHuskyDispatcher(dispatcherRoot))
    ) {
      return null
    }

    const activation = Object.freeze({ previousHooksPath })
    try {
      await this.runner.run(
        'pnpm',
        target === undefined
          ? ['run', 'frontprep:prepare']
          : ['--dir', target.packageRoot, 'run', 'frontprep:prepare'],
        {
          cwd: root,
          signal,
        },
      )
      const currentHooksPath = await readLocalHooksPath(root, this.runner)
      if (currentHooksPath !== hooksPath) {
        throw new FrontprepError(
          `Husky activation did not set core.hooksPath to ${hooksPath}.`,
          {
            code: 'GIT_HOOKS_ACTIVATION_FAILED',
            exitCode: 1,
            phase: 'installation',
          },
        )
      }
      if (!(await hasHuskyDispatcher(dispatcherRoot))) {
        throw new FrontprepError(
          'Husky activation did not install its dispatcher.',
          {
            code: 'GIT_HOOKS_ACTIVATION_FAILED',
            exitCode: 1,
            path: `${hooksPath}/h`,
            phase: 'installation',
          },
        )
      }
      return activation
    } catch (error) {
      try {
        await this.restore(root, activation)
      } catch (restoration) {
        throw restorationFailure(error, restoration)
      }
      throw error
    }
  }

  async restore(root: string, activation: GitHooksActivation): Promise<void> {
    const currentHooksPath = await readLocalHooksPath(root, this.runner)
    if (currentHooksPath === activation.previousHooksPath) return
    if (activation.previousHooksPath === null) {
      await this.runner.run(
        'git',
        ['config', '--local', '--unset-all', 'core.hooksPath'],
        { cwd: root },
      )
      return
    }
    await this.runner.run(
      'git',
      ['config', '--local', 'core.hooksPath', activation.previousHooksPath],
      { cwd: root },
    )
  }
}
