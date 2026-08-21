import { describe, expect, it } from 'vitest'

import { FrontprepError } from '../../src/core/errors.js'
import { Reporter, type OutputWriter } from '../../src/core/reporter.js'
import { ProcessFailure } from '../../src/core/process.js'

class BufferWriter implements OutputWriter {
  contents = ''

  constructor(readonly isTTY: boolean) {}

  write(chunk: string): boolean {
    this.contents += chunk
    return true
  }
}

describe('Reporter', () => {
  it('prints deterministic non-TTY status without ANSI escapes', () => {
    const stdout = new BufferWriter(false)
    const stderr = new BufferWriter(false)
    const reporter = new Reporter(stdout, stderr, {})

    reporter.header('0.1.0-beta.0')
    reporter.detected()
    reporter.modulePassed('quality')
    reporter.alreadyApplied()
    reporter.noFilesChanged()
    reporter.projectPassed()

    expect(stdout.contents).toBe(
      [
        'frontprep 0.1.0-beta.0',
        '✓ Detected Next.js App Router with pnpm',
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

    expect(stderr.contents).toContain('[git] unsafe state')
    expect(stderr.contents).toContain('Path: package.json')
    expect(stderr.contents).toContain('Recovery: Commit changes.')
    expect(stderr.contents).toContain('install failed')
  })
})
