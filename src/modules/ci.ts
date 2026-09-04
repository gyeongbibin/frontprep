import { createHash } from 'node:crypto'

import {
  managedFileIntent,
  scriptIntent,
  type ChangeIntent,
  type ScriptPolicy,
} from '../core/intents.js'
import { ConflictError } from '../core/errors.js'
import { FileSystem, type FileSnapshot } from '../core/filesystem.js'
import { toProjectPath } from '../core/paths.js'
import { manifestFile, scopedProjectPath } from '../core/scoped-paths.js'
import type { ProjectContext } from '../core/types.js'
import type {
  SetupModule,
  VerificationIssue,
  VerificationResult,
} from './types.js'

const MODULE_ID = 'ci' as const
const WORKFLOW_PATH = '.github/workflows/ci.yml'
const CI_WORKFLOW = `name: CI

on:
  push:
    branches:
      - develop
      - main
  pull_request:
    branches:
      - develop
      - main

permissions:
  contents: read

concurrency:
  group: ci-\${{ github.workflow }}-\${{ github.event.pull_request.number || github.ref }}
  cancel-in-progress: true

env:
  HUSKY: '0'

jobs:
  check:
    name: Frontprep check
    runs-on: ubuntu-latest
    timeout-minutes: 20

    steps:
      - name: Checkout
        uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          persist-credentials: false
      - name: Set up pnpm
        uses: pnpm/action-setup@0e279bb959325dab635dd2c09392533439d90093 # v6.0.8
      - name: Set up Node.js
        uses: actions/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7.0.0
        with:
          node-version: '22.22.1'
          cache: pnpm
          cache-dependency-path: pnpm-lock.yaml
      - name: Install dependencies
        run: pnpm install --frozen-lockfile
      - name: Run Frontprep checks
        run: pnpm run frontprep:check
`

const SCRIPTS = Object.freeze([
  ['frontprep:build', 'next build', 'owned'],
  ['frontprep:check', 'pnpm run frontprep:build', 'append-once'],
] as const satisfies readonly (readonly [string, string, ScriptPolicy])[])
const FULL_CHECK =
  'pnpm run frontprep:quality && pnpm run frontprep:test && pnpm run frontprep:build'

function workspaceWorkflow(context: ProjectContext): {
  contents: string
  path: string
} {
  if (context.packageDirectory === '.') {
    return { contents: CI_WORKFLOW, path: WORKFLOW_PATH }
  }
  const slug = context.packageDirectory.replace(/[^A-Za-z0-9]+/gu, '-')
  const hash = createHash('sha256')
    .update(context.packageDirectory)
    .digest('hex')
    .slice(0, 8)
  const path = `.github/workflows/frontprep-${slug}-${hash}.yml`
  const packageDirectory = context.packageDirectory
  const contents = `name: CI (${packageDirectory})

on:
  push:
    branches:
      - develop
      - main
    paths:
      - '${packageDirectory}/**'
      - 'package.json'
      - 'pnpm-lock.yaml'
      - 'pnpm-workspace.yaml'
      - '${path}'
  pull_request:
    branches:
      - develop
      - main
    paths:
      - '${packageDirectory}/**'
      - 'package.json'
      - 'pnpm-lock.yaml'
      - 'pnpm-workspace.yaml'
      - '${path}'

permissions:
  contents: read

concurrency:
  group: ci-\${{ github.workflow }}-\${{ github.event.pull_request.number || github.ref }}
  cancel-in-progress: true

env:
  HUSKY: '0'

jobs:
  check:
    name: Frontprep check
    runs-on: ubuntu-latest
    timeout-minutes: 20

    steps:
      - name: Checkout
        uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          persist-credentials: false
      - name: Set up pnpm
        uses: pnpm/action-setup@0e279bb959325dab635dd2c09392533439d90093 # v6.0.8
      - name: Set up Node.js
        uses: actions/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7.0.0
        with:
          node-version: '22.22.1'
          cache: pnpm
          cache-dependency-path: pnpm-lock.yaml
      - name: Install dependencies
        run: pnpm install --frozen-lockfile
      - name: Run Frontprep checks
        run: pnpm --filter ./${packageDirectory} --fail-if-no-match run frontprep:check
`
  return { contents, path }
}

async function safeWorkflowSnapshot(
  context: ProjectContext,
): Promise<FileSnapshot | null> {
  const workflow = workspaceWorkflow(context)
  try {
    return await new FileSystem(context.repositoryRoot).snapshot(
      toProjectPath(workflow.path),
    )
  } catch {
    return null
  }
}

function workflowIssue(path: string): VerificationIssue {
  return {
    message: 'Managed GitHub Actions workflow is missing or changed.',
    path,
  }
}

async function workflowConflict(
  context: ProjectContext,
): Promise<VerificationIssue | null> {
  const workflow = workspaceWorkflow(context)
  const snapshot = await safeWorkflowSnapshot(context)
  if (snapshot?.exists === false) return null
  if (
    snapshot !== null &&
    snapshot.bytes?.equals(Buffer.from(workflow.contents)) &&
    snapshot.mode === 0o644
  ) {
    return null
  }
  const recorded = manifestFile(
    context.manifest,
    scopedProjectPath(workflow.path, 'repository'),
  )
  if (
    snapshot !== null &&
    recorded?.ownership === 'managed' &&
    recorded.hash === snapshot.hash
  ) {
    return null
  }
  return {
    message: `GitHub Actions workflow conflicts at ${workflow.path}.`,
    path: workflow.path,
  }
}

function verificationResult(
  issues: readonly VerificationIssue[],
): VerificationResult {
  return {
    issues: Object.freeze(
      [...issues].sort(
        (left, right) =>
          (left.path ?? '').localeCompare(right.path ?? '') ||
          left.message.localeCompare(right.message),
      ),
    ),
    valid: issues.length === 0,
  }
}

function createIntents(context: ProjectContext): readonly ChangeIntent[] {
  const workflow = workspaceWorkflow(context)
  return Object.freeze([
    ...SCRIPTS.map(([name, command, policy]) =>
      scriptIntent(
        MODULE_ID,
        name,
        command,
        policy,
        name === 'frontprep:build'
          ? 'CI provides the deterministic production build.'
          : 'CI adds the production build to the full check.',
      ),
    ),
    managedFileIntent(
      MODULE_ID,
      workflow.path,
      workflow.contents,
      0o644,
      'CI owns the GitHub Actions workflow.',
      'repository',
    ),
  ])
}

export const ciModule: SetupModule<void> = Object.freeze({
  id: MODULE_ID,
  version: '2.0.0',
  async analyze(context: ProjectContext): Promise<void> {
    const conflict = await workflowConflict(context)
    if (conflict !== null) {
      throw new ConflictError(conflict.message, conflict.path, MODULE_ID)
    }
  },
  async plan(context: ProjectContext): Promise<readonly ChangeIntent[]> {
    return createIntents(context)
  },
  async verify(context: ProjectContext): Promise<VerificationResult> {
    const issues: VerificationIssue[] = []
    const workflow = workspaceWorkflow(context)
    const snapshot = await safeWorkflowSnapshot(context)
    if (
      snapshot === null ||
      !snapshot.exists ||
      !snapshot.bytes?.equals(Buffer.from(workflow.contents)) ||
      snapshot.mode !== 0o644
    ) {
      issues.push(workflowIssue(workflow.path))
    }
    if (context.packageJson.scripts?.['frontprep:build'] !== 'next build') {
      issues.push({
        message:
          'Frontprep-owned script frontprep:build is missing or changed.',
        path: 'package.json',
      })
    }
    if (context.packageJson.scripts?.['frontprep:check'] !== FULL_CHECK) {
      issues.push({
        message:
          'Frontprep-owned script frontprep:check is missing or changed.',
        path: 'package.json',
      })
    }
    return verificationResult(issues)
  },
})
