import { FileSystem } from './filesystem.js'
import { ProcessRunner } from './process.js'
import { toProjectPath } from './paths.js'
import { MODULE_ORDER, type ProjectContext } from './types.js'
import type {
  SetupModule,
  VerificationIssue,
  VerificationResult,
} from '../modules/types.js'

function result(issues: readonly VerificationIssue[]): VerificationResult {
  return { issues: Object.freeze([...issues]), valid: issues.length === 0 }
}

function modeString(mode: number | null): string | null {
  return mode === null ? null : `0${mode.toString(8).padStart(3, '0')}`
}

export async function verifyModules(
  context: ProjectContext,
  modules: readonly SetupModule[],
): Promise<VerificationResult> {
  const issues: VerificationIssue[] = []
  for (const setupModule of modules) {
    try {
      const moduleResult = await setupModule.verify(context)
      for (const issue of moduleResult.issues) {
        issues.push({ ...issue, moduleId: setupModule.id })
      }
    } catch (error) {
      issues.push({
        message:
          error instanceof Error
            ? error.message
            : 'Module verification failed.',
        moduleId: setupModule.id,
      })
    }
  }
  return result(issues)
}

export async function verifyStructure(
  context: ProjectContext,
  modules: readonly SetupModule[],
): Promise<VerificationResult> {
  const issues: VerificationIssue[] = []
  const manifest = context.manifest
  if (manifest === null) {
    issues.push({
      message: 'Frontprep manifest is missing.',
      path: '.frontprep.json',
    })
  }

  const modulesById = new Map(
    modules.map((setupModule) => [setupModule.id, setupModule]),
  )
  for (const moduleId of MODULE_ORDER) {
    const setupModule = modulesById.get(moduleId)
    if (setupModule === undefined) {
      issues.push({ message: 'Registered module is missing.', moduleId })
    } else if (
      manifest !== null &&
      manifest.modules[moduleId] !== setupModule.version
    ) {
      issues.push({
        message: 'Module version does not match the manifest.',
        moduleId,
      })
    }
  }

  if (manifest !== null) {
    if (
      manifest.paths.app !== context.appDirectory ||
      manifest.paths.stylesheet !== context.stylesheetPath
    ) {
      issues.push({
        message: 'Detected application paths do not match the manifest.',
        path: '.frontprep.json',
      })
    }

    const fileSystem = new FileSystem(context.root)
    for (const [path, recorded] of Object.entries(manifest.files).sort(
      ([left], [right]) => left.localeCompare(right),
    )) {
      if (recorded.ownership !== 'managed') continue
      try {
        const snapshot = await fileSystem.snapshot(toProjectPath(path))
        if (
          snapshot.hash !== recorded.hash ||
          modeString(snapshot.mode) !== recorded.mode
        ) {
          issues.push({
            message: 'Managed file fingerprint does not match.',
            path,
          })
        }
      } catch {
        issues.push({
          message: 'Managed file fingerprint does not match.',
          path,
        })
      }
    }

    for (const [name, command] of Object.entries(manifest.managedScripts).sort(
      ([left], [right]) => left.localeCompare(right),
    )) {
      if (context.packageJson.scripts?.[name] !== command) {
        issues.push({
          message: 'Managed package script is missing or changed.',
          path: 'package.json',
        })
      }
    }
  }

  const moduleResult = await verifyModules(context, modules)
  issues.push(...moduleResult.issues)
  return result(issues)
}

export async function runProjectCheck(
  root: string,
  signal?: AbortSignal,
  runner: Pick<ProcessRunner, 'run'> = new ProcessRunner(),
): Promise<void> {
  await runner.run('pnpm', ['run', 'frontprep:check'], { cwd: root, signal })
}
