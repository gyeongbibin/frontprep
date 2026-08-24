import { readFile } from 'node:fs/promises'

import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'

const workflowUrl = new URL('../.github/workflows/ci.yml', import.meta.url)

interface WorkflowStep {
  name: string
  run?: string
  uses?: string
  with?: Record<string, unknown>
}

interface RepositoryWorkflow {
  concurrency: { 'cancel-in-progress': boolean; group: string }
  env: { HUSKY: string }
  jobs: {
    check: {
      name: string
      'runs-on': string
      steps: WorkflowStep[]
      'timeout-minutes': number
    }
  }
  on: Record<string, { branches: string[] }>
  permissions: { contents: string }
}

async function readWorkflow(): Promise<RepositoryWorkflow | null> {
  try {
    return parse(await readFile(workflowUrl, 'utf8')) as RepositoryWorkflow
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return null
    }
    throw error
  }
}

describe('repository CI', () => {
  it('runs every beta release gate with immutable least-privilege actions', async () => {
    const workflow = await readWorkflow()

    expect(workflow).not.toBeNull()
    expect(workflow?.concurrency).toEqual({
      'cancel-in-progress': true,
      group:
        'ci-${{ github.workflow }}-${{ github.event.pull_request.number || github.ref }}',
    })
    expect(workflow?.env).toEqual({ HUSKY: '0' })
    expect(workflow?.on).toEqual({
      pull_request: { branches: ['develop', 'main'] },
      push: { branches: ['develop', 'main'] },
    })
    expect(workflow?.permissions).toEqual({ contents: 'read' })
    expect(Object.keys(workflow?.jobs ?? {})).toEqual(['check'])
    expect(workflow?.jobs.check).toMatchObject({
      name: 'Release checks',
      'runs-on': 'ubuntu-latest',
      'timeout-minutes': 20,
    })
    expect(Object.keys(workflow?.jobs.check ?? {}).sort()).toEqual([
      'name',
      'runs-on',
      'steps',
      'timeout-minutes',
    ])

    const steps = workflow?.jobs.check.steps ?? []
    const actionSteps = steps.filter(
      (step): step is WorkflowStep & { uses: string } => Boolean(step.uses),
    )
    expect(actionSteps).toEqual([
      {
        name: 'Checkout',
        uses: 'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1',
        with: { 'persist-credentials': false },
      },
      {
        name: 'Set up pnpm',
        uses: 'pnpm/action-setup@0e279bb959325dab635dd2c09392533439d90093',
      },
      {
        name: 'Set up Node.js',
        uses: 'actions/setup-node@820762786026740c76f36085b0efc47a31fe5020',
        with: {
          cache: 'pnpm',
          'cache-dependency-path': 'pnpm-lock.yaml',
          'node-version': '22.22.1',
        },
      },
    ])
    expect(
      steps
        .filter((step): step is WorkflowStep & { run: string } =>
          Boolean(step.run),
        )
        .map(({ run }) => run),
    ).toEqual([
      'pnpm install --frozen-lockfile',
      'pnpm check',
      'pnpm verify:package',
      'pnpm verify:quality-compatibility',
      'pnpm verify:test-compatibility',
      'pnpm verify:git-hooks-compatibility',
      'pnpm verify:ci-compatibility',
    ])
    expect(actionSteps.every(({ uses }) => /@[0-9a-f]{40}$/u.test(uses))).toBe(
      true,
    )
  })
})
