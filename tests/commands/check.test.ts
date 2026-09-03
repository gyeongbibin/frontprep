import { describe, expect, it } from 'vitest'

import { VerificationError } from '../../src/core/errors.js'
import { detectProject } from '../../src/core/project-detector.js'
import { runCheck, type CheckServices } from '../../src/commands/check.js'
import type { ModuleId } from '../../src/core/types.js'
import { createProject } from '../helpers/project.js'
import { RecordingReporter } from './support/recording-reporter.js'

describe('runCheck', () => {
  it('does not run the project command when structural verification fails', async () => {
    const project = await createProject()
    const context = await detectProject(project.root)
    let projectChecks = 0
    const services: CheckServices = {
      assertSafeGitState: async () => undefined,
      detectProject: async () => context,
      frontprepVersion: '0.1.0-beta.0',
      modules: [],
      reporter: new RecordingReporter(),
      runProjectCheck: async () => {
        projectChecks += 1
      },
      verifyStructure: async () => ({
        issues: [{ message: 'lint drift', moduleId: 'quality' as ModuleId }],
        valid: false,
      }),
    }

    await expect(
      runCheck({ cwd: project.root }, services),
    ).rejects.toBeInstanceOf(VerificationError)
    expect(projectChecks).toBe(0)
  })

  it('runs the project command after valid structural verification', async () => {
    const project = await createProject()
    const context = await detectProject(project.root)
    const reporter = new RecordingReporter()
    const calls: string[] = []
    const services: CheckServices = {
      assertSafeGitState: async () => {
        calls.push('git')
      },
      detectProject: async () => context,
      frontprepVersion: '0.1.0-beta.0',
      modules: [],
      reporter,
      runProjectCheck: async () => {
        calls.push('project')
      },
      verifyStructure: async () => {
        calls.push('structure')
        return { issues: [], valid: true }
      },
    }

    await runCheck({ cwd: project.root }, services)

    expect(calls).toEqual(['git', 'structure', 'project'])
    expect(reporter.events).toEqual([
      'header:0.1.0-beta.0',
      'detected',
      'project',
    ])
  })

  it('reports an available manifest migration without writing', async () => {
    const project = await createProject()
    const detected = await detectProject(project.root)
    const context = Object.freeze({
      ...detected,
      manifestNeedsMigration: true,
    })
    const reporter = new RecordingReporter()
    const services: CheckServices = {
      assertSafeGitState: async () => undefined,
      detectProject: async () => context,
      frontprepVersion: '0.1.0-beta.0',
      modules: [],
      reporter,
      runProjectCheck: async () => undefined,
      verifyStructure: async () => ({ issues: [], valid: true }),
    }

    await runCheck({ cwd: project.root }, services)

    expect(reporter.events).toContain('migration-available')
  })
})
