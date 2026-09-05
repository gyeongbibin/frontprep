import { mkdtemp } from 'node:fs/promises'
import { EventEmitter } from 'node:events'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  runCli,
  runCliWithSignals,
  type CliIo,
  type SignalSource,
} from '../src/cli.js'
import { createCommandServices } from '../src/commands/init.js'
import { detectProject } from '../src/core/project-detector.js'
import type { CommandReporter } from '../src/commands/init.js'
import { createProject } from './helpers/project.js'

function io(): CliIo & { stderrText: string; stdoutText: string } {
  return {
    stderrText: '',
    stdoutText: '',
    writeErr(value) {
      this.stderrText += value
    },
    writeOut(value) {
      this.stdoutText += value
    },
  }
}

const SILENT_REPORTER: CommandReporter = {
  alreadyApplied() {},
  detected() {},
  filesChanged() {},
  header() {},
  modulePassed() {},
  noFilesChanged() {},
  projectPassed() {},
}

describe('frontprep CLI', () => {
  it('lists init and check in help', async () => {
    const output = io()

    await expect(
      runCli(['node', 'frontprep', '--help'], undefined, output),
    ).resolves.toBe(0)
    expect(output.stdoutText).toContain('init')
    expect(output.stdoutText).toContain('check')
  })

  it('forwards init layout options to project detection', async () => {
    const project = await createProject({ layout: 'export default null\n' })
    const context = await detectProject(project.root)
    let received: unknown
    const services = {
      ...createCommandServices(SILENT_REPORTER, []),
      assertSafeGitState: async () => undefined,
      detectProject: async (_cwd: string, options?: unknown) => {
        received = options
        return context
      },
      runProjectCheck: async () => undefined,
      verifyStructure: async () => ({ issues: [], valid: true }),
    }

    await expect(
      runCli(
        [
          'node',
          'frontprep',
          'init',
          '--cwd',
          project.root,
          '--stylesheet',
          'src/styles/global.css',
          '--utility-dir',
          'src/shared/lib',
          '--test-dir',
          'src/spec',
        ],
        services,
        io(),
      ),
    ).resolves.toBe(0)
    expect(received).toEqual({
      stylesheet: 'src/styles/global.css',
      testDirectory: 'src/spec',
      utilityDirectory: 'src/shared/lib',
    })
  })

  it('prints the package version', async () => {
    const output = io()

    await expect(
      runCli(['node', 'frontprep', '--version'], undefined, output),
    ).resolves.toBe(0)
    expect(output.stdoutText).toBe('0.1.0-beta.2\n')
  })

  it('maps an unknown command to exit code 2', async () => {
    const output = io()

    await expect(
      runCli(['node', 'frontprep', 'unknown'], undefined, output),
    ).resolves.toBe(2)
    expect(output.stderrText).toContain('unknown command')
  })

  it('maps an unsupported project to exit code 2', async () => {
    const output = io()
    const root = await mkdtemp(join(tmpdir(), 'frontprep-unsupported-'))

    await expect(
      runCli(['node', 'frontprep', 'init', '--cwd', root], undefined, output),
    ).resolves.toBe(2)
    expect(output.stderrText).toContain('package.json')
  })

  it('forwards an injected abort signal to command services', async () => {
    const project = await createProject()
    const context = await detectProject(project.root)
    const controller = new AbortController()
    let receivedSignal: AbortSignal | undefined
    const services = {
      ...createCommandServices(SILENT_REPORTER),
      assertSafeGitState: async () => undefined,
      detectProject: async () => context,
      runProjectCheck: async (_root: string, signal?: AbortSignal) => {
        receivedSignal = signal
      },
      verifyStructure: async () => ({ issues: [], valid: true }),
    }

    await expect(
      runCli(
        ['node', 'frontprep', 'check', '--cwd', project.root],
        services,
        io(),
        controller.signal,
      ),
    ).resolves.toBe(0)
    expect(receivedSignal).toBe(controller.signal)
  })

  it.each(['SIGINT', 'SIGTERM'] as const)(
    'converts %s into an abort and removes process listeners',
    async (processSignal) => {
      const project = await createProject()
      const context = await detectProject(project.root)
      const source = new EventEmitter() as EventEmitter & SignalSource
      const output = io()
      let started: (() => void) | undefined
      const projectStarted = new Promise<void>((resolve) => {
        started = resolve
      })
      const services = {
        ...createCommandServices(SILENT_REPORTER),
        assertSafeGitState: async () => undefined,
        detectProject: async () => context,
        runProjectCheck: async (_root: string, signal?: AbortSignal) => {
          started?.()
          await new Promise<void>((_resolve, reject) => {
            signal?.addEventListener('abort', () => reject(signal.reason), {
              once: true,
            })
          })
        },
        verifyStructure: async () => ({ issues: [], valid: true }),
      }

      const pending = runCliWithSignals(
        ['node', 'frontprep', 'check', '--cwd', project.root],
        services,
        output,
        source,
      )
      await projectStarted
      source.emit(processSignal)
      expect(source.listenerCount(processSignal)).toBe(1)
      source.emit(processSignal)

      await expect(pending).resolves.toBe(1)
      expect(source.listenerCount('SIGINT')).toBe(0)
      expect(source.listenerCount('SIGTERM')).toBe(0)
      expect(output.stderrText).toContain(
        '[application:INTERRUPTED] Frontprep was interrupted.',
      )
      expect(output.stderrText).not.toContain('Unexpected failure')
    },
  )
})
