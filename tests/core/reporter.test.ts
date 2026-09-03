import { describe, expect, it } from 'vitest'

import { FrontprepError } from '../../src/core/errors.js'
import { Reporter, type OutputWriter } from '../../src/core/reporter.js'
import { ProcessFailure } from '../../src/core/process.js'
import { scopedProjectPath } from '../../src/core/scoped-paths.js'
import { detectProject } from '../../src/core/project-detector.js'
import { createProject } from '../helpers/project.js'

class BufferWriter implements OutputWriter {
  contents = ''

  constructor(readonly isTTY: boolean) {}

  write(chunk: string): boolean {
    this.contents += chunk
    return true
  }
}

describe('Reporter', () => {
  it('prints deterministic non-TTY status without ANSI escapes', async () => {
    const stdout = new BufferWriter(false)
    const stderr = new BufferWriter(false)
    const reporter = new Reporter(stdout, stderr, {})
    const project = await createProject()
    const context = await detectProject(project.root)

    reporter.header('0.1.0-beta.0')
    reporter.detected(context)
    reporter.modulePassed('quality')
    reporter.alreadyApplied()
    reporter.noFilesChanged()
    reporter.projectPassed()

    expect(stdout.contents).toBe(
      [
        'frontprep 0.1.0-beta.0',
        '✓ Detected Next.js App Router with pnpm',
        '  App: src/app (src/app/layout.tsx)',
        '  Stylesheet: src/app/globals.css [detected, relative: ./globals.css]',
        '  Utilities: src/shared/lib [default]',
        '  Tests: src/test [default]',
        '✓ quality',
        '✓ All modules are already applied',
        '✓ No files changed',
        '✓ Project verification passed',
        '',
      ].join('\n'),
    )
    expect(stdout.contents).not.toContain('\u001B[')
  })

  it('disables color when NO_COLOR is present on a TTY', () => {
    const stdout = new BufferWriter(true)
    const reporter = new Reporter(stdout, new BufferWriter(true), {
      NO_COLOR: '',
    })

    reporter.modulePassed('tailwind')

    expect(stdout.contents).toBe('✓ tailwind\n')
  })

  it('uses color only on an eligible TTY', () => {
    const stdout = new BufferWriter(true)
    const reporter = new Reporter(stdout, new BufferWriter(true), {})

    reporter.modulePassed('test')

    expect(stdout.contents).toContain('\u001B[32m')
  })

  it('labels repository-scoped changed files', () => {
    const stdout = new BufferWriter(false)
    const reporter = new Reporter(stdout, new BufferWriter(false), {})

    reporter.filesChanged([
      scopedProjectPath('package.json'),
      scopedProjectPath('.github/workflows/ci.yml', 'repository'),
    ])

    expect(stdout.contents).toBe(
      '✓ Changed 2 files\n  package.json\n  [repository] .github/workflows/ci.yml\n',
    )
  })

  it('prints typed recovery details and process diagnostics', () => {
    const stderr = new BufferWriter(false)
    const reporter = new Reporter(new BufferWriter(false), stderr, {})
    const typed = new FrontprepError('unsafe state', {
      code: 'UNSAFE_GIT_STATE',
      exitCode: 2,
      path: 'package.json',
      phase: 'git',
      recovery: 'Commit changes.',
    })
    const processFailure = new ProcessFailure('pnpm', ['install'], {
      exitCode: 1,
      signal: null,
      stderr: 'install failed\n',
      stdout: 'progress\n',
    })

    reporter.error(typed)
    reporter.error(processFailure)

    expect(stderr.contents).toContain('[git:UNSAFE_GIT_STATE] unsafe state')
    expect(stderr.contents).toContain('Path: package.json')
    expect(stderr.contents).toContain('Recovery: Commit changes.')
    expect(stderr.contents).toContain('install failed')
  })
})
