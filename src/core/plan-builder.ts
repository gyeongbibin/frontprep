import { intersects, validRange } from 'semver'

import { composePrettierConfig } from './composers/prettier.js'
import {
  assertCompatibleDependencies,
  assertCompatiblePathIntents,
} from './conflict-detector.js'
import { ConflictError } from './errors.js'
import { FileSystem } from './filesystem.js'
import type {
  ChangeIntent,
  ConfigFragmentIntent,
  DependencyIntent,
  ExecutableFileIntent,
  ManagedFileIntent,
  ScriptIntent,
} from './intents.js'
import type { ChangePlan, FileOperation } from './plan.js'
import {
  manifestFile,
  rootForScope,
  scopedPathKey,
  scopedProjectPath,
  type ScopedProjectPath,
} from './scoped-paths.js'
import {
  MODULE_ORDER,
  type ModuleId,
  type PackageJson,
  type ProjectContext,
} from './types.js'

const PACKAGE_TARGET = scopedProjectPath('package.json')
const PRETTIER_TARGET = scopedProjectPath('prettier.config.mjs')

function serializePackageJson(packageJson: PackageJson): Buffer {
  return Buffer.from(`${JSON.stringify(packageJson, null, 2)}\n`)
}

function uniqueModuleIds(
  intents: readonly ChangeIntent[],
): readonly ModuleId[] {
  const present = new Set(intents.map(({ moduleId }) => moduleId))
  return Object.freeze(MODULE_ORDER.filter((moduleId) => present.has(moduleId)))
}

function appendUniqueLines(contents: string, lines: readonly string[]): string {
  const existingLines =
    contents.length === 0 ? [] : contents.replace(/\n$/u, '').split('\n')
  const seen = new Set(existingLines)
  for (const line of lines) {
    if (!seen.has(line)) {
      existingLines.push(line)
      seen.add(line)
    }
  }
  return existingLines.length === 0 ? '' : `${existingLines.join('\n')}\n`
}

function ensureCssImport(contents: string, value: string): string {
  const statement = `@import '${value}';`
  if (contents.split('\n').some((line) => line.trim() === statement)) {
    return contents
  }
  return contents.length === 0
    ? `${statement}\n`
    : `${statement}\n\n${contents}`
}

function ensureStaticImport(contents: string, value: string): string {
  const singleQuoted = `import '${value}'`
  const doubleQuoted = `import "${value}"`
  if (
    contents
      .split('\n')
      .some((line) =>
        [
          singleQuoted,
          `${singleQuoted};`,
          doubleQuoted,
          `${doubleQuoted};`,
        ].includes(line.trim()),
      )
  ) {
    return contents
  }
  return contents.length === 0
    ? `${singleQuoted}\n`
    : `${singleQuoted}\n\n${contents}`
}

function findDeclaredDependency(
  packageJson: PackageJson,
  name: string,
): { range: string; section: 'dependencies' | 'devDependencies' } | null {
  if (packageJson.dependencies?.[name] !== undefined) {
    return { range: packageJson.dependencies[name], section: 'dependencies' }
  }
  if (packageJson.devDependencies?.[name] !== undefined) {
    return {
      range: packageJson.devDependencies[name],
      section: 'devDependencies',
    }
  }
  return null
}

function applyDependencies(
  packageJson: PackageJson,
  intents: readonly DependencyIntent[],
): boolean {
  assertCompatibleDependencies(intents)
  let changed = false
  const byName = new Map<string, DependencyIntent[]>()
  for (const intent of intents) {
    const group = byName.get(intent.name) ?? []
    group.push(intent)
    byName.set(intent.name, group)
  }

  for (const [name, group] of [...byName].sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    const requested = group[0]!
    const existing = findDeclaredDependency(packageJson, name)
    if (existing !== null) {
      if (
        validRange(existing.range) === null ||
        !intersects(existing.range, requested.range)
      ) {
        throw new ConflictError(
          `Existing dependency ${name}@${existing.range} is incompatible with ${requested.range}.`,
        )
      }
      continue
    }

    packageJson[requested.section] ??= {}
    packageJson[requested.section]![name] = requested.range
    changed = true
  }
  return changed
}

function applyScripts(
  packageJson: PackageJson,
  intents: readonly ScriptIntent[],
  context: ProjectContext,
): Record<string, string> {
  const managedScripts: Record<string, string> = {}
  packageJson.scripts ??= {}

  for (const intent of intents) {
    const existing = packageJson.scripts[intent.name]
    if (intent.policy === 'preserve-existing') {
      packageJson.scripts[intent.name] ??= intent.command
      continue
    }
    if (intent.policy === 'append-once') {
      packageJson.scripts[intent.name] =
        existing === undefined
          ? intent.command
          : existing.includes(intent.command)
            ? existing
            : `${existing} && ${intent.command}`
      managedScripts[intent.name] = packageJson.scripts[intent.name]
      continue
    }

    const recorded = context.manifest?.managedScripts[intent.name]
    if (
      existing !== undefined &&
      existing !== intent.command &&
      existing !== recorded
    ) {
      throw new ConflictError(
        `User-owned script conflicts with ${intent.name}.`,
        'package.json',
        intent.moduleId,
      )
    }
    packageJson.scripts[intent.name] = intent.command
    managedScripts[intent.name] = intent.command
  }

  if (Object.keys(packageJson.scripts).length === 0) {
    delete packageJson.scripts
  }
  return managedScripts
}

async function managedOperation(
  context: ProjectContext,
  target: ScopedProjectPath,
  contents: string,
  mode: number,
  intents: readonly ChangeIntent[],
): Promise<FileOperation | null> {
  const fileSystem = new FileSystem(rootForScope(context, target.scope))
  const snapshot = await fileSystem.snapshot(target.path)
  const afterBytes = Buffer.from(contents)
  if (
    snapshot.hash === (await import('./filesystem.js')).hashBytes(afterBytes) &&
    snapshot.mode === mode
  ) {
    return null
  }

  if (snapshot.exists) {
    const recorded = manifestFile(context.manifest, target)
    if (recorded?.ownership !== 'managed' || recorded.hash !== snapshot.hash) {
      throw new ConflictError(
        `User-modified managed file: ${target.path}`,
        target.path,
      )
    }
  }

  return Object.freeze({
    afterBytes,
    beforeHash: snapshot.hash,
    mode,
    moduleIds: uniqueModuleIds(intents),
    ownership: 'managed' as const,
    path: target.path,
    scope: target.scope,
  })
}

export async function buildPlan(
  context: ProjectContext,
  intents: readonly ChangeIntent[],
): Promise<ChangePlan> {
  assertCompatiblePathIntents(intents)
  const packageFileSystem = new FileSystem(
    rootForScope(context, PACKAGE_TARGET.scope),
  )
  const operations: FileOperation[] = []
  const dependencyIntents = intents.filter(
    (intent): intent is DependencyIntent => intent.kind === 'dependency',
  )
  const scriptIntents = intents.filter(
    (intent): intent is ScriptIntent => intent.kind === 'script',
  )

  const packageJson = structuredClone(context.packageJson)
  const dependenciesChanged = applyDependencies(packageJson, dependencyIntents)
  const managedScripts = applyScripts(packageJson, scriptIntents, context)
  const packageSnapshot = await packageFileSystem.snapshot(PACKAGE_TARGET.path)
  const packageBytes = serializePackageJson(packageJson)
  const { hashBytes } = await import('./filesystem.js')
  if (packageSnapshot.hash !== hashBytes(packageBytes)) {
    operations.push({
      afterBytes: packageBytes,
      beforeHash: packageSnapshot.hash,
      mode: packageSnapshot.mode ?? 0o644,
      moduleIds: uniqueModuleIds([...dependencyIntents, ...scriptIntents]),
      ownership: 'patched',
      path: PACKAGE_TARGET.path,
      scope: PACKAGE_TARGET.scope,
    })
  }

  const configFragments = intents.filter(
    (intent): intent is ConfigFragmentIntent =>
      intent.kind === 'config-fragment',
  )
  if (configFragments.length > 0) {
    const operation = await managedOperation(
      context,
      PRETTIER_TARGET,
      composePrettierConfig(configFragments),
      0o644,
      configFragments,
    )
    if (operation !== null) operations.push(operation)
  }

  const completeByPath = new Map<
    string,
    {
      intents: Array<ExecutableFileIntent | ManagedFileIntent>
      target: ScopedProjectPath
    }
  >()
  for (const intent of intents) {
    if (intent.kind !== 'managed-file' && intent.kind !== 'executable-file')
      continue
    const target = scopedProjectPath(intent.path, intent.scope)
    const key = scopedPathKey(target)
    const entry = completeByPath.get(key) ?? { intents: [], target }
    entry.intents.push(intent)
    completeByPath.set(key, entry)
  }
  for (const { intents: group, target } of completeByPath.values()) {
    const contents = group[0]!.content
    const mode = group[0]!.kind === 'executable-file' ? 0o755 : group[0]!.mode
    if (
      group.some(
        (intent) =>
          intent.content !== contents ||
          (intent.kind === 'executable-file' ? 0o755 : intent.mode) !== mode,
      )
    ) {
      throw new ConflictError(
        `Conflicting managed contents for ${target.path}.`,
        target.path,
      )
    }
    const operation = await managedOperation(
      context,
      target,
      contents,
      mode,
      group,
    )
    if (operation !== null) operations.push(operation)
  }

  const partialByPath = new Map<
    string,
    { intents: ChangeIntent[]; target: ScopedProjectPath }
  >()
  for (const intent of intents) {
    if (
      intent.kind !== 'line-set' &&
      intent.kind !== 'css-import' &&
      intent.kind !== 'static-import'
    ) {
      continue
    }
    const target = scopedProjectPath(intent.path, intent.scope)
    const key = scopedPathKey(target)
    const entry = partialByPath.get(key) ?? { intents: [], target }
    entry.intents.push(intent)
    partialByPath.set(key, entry)
  }
  for (const { intents: group, target } of partialByPath.values()) {
    const fileSystem = new FileSystem(rootForScope(context, target.scope))
    const snapshot = await fileSystem.snapshot(target.path)
    let contents = snapshot.bytes?.toString('utf8') ?? ''
    for (const intent of group) {
      if (intent.kind === 'line-set') {
        contents = appendUniqueLines(contents, intent.lines)
      } else if (intent.kind === 'css-import') {
        contents = ensureCssImport(contents, intent.importValue)
      } else if (intent.kind === 'static-import') {
        contents = ensureStaticImport(contents, intent.importValue)
      }
    }
    const afterBytes = Buffer.from(contents)
    if (snapshot.hash !== hashBytes(afterBytes)) {
      operations.push({
        afterBytes,
        beforeHash: snapshot.hash,
        mode: snapshot.mode ?? 0o644,
        moduleIds: uniqueModuleIds(group),
        ownership: 'patched',
        path: target.path,
        scope: target.scope,
      })
    }
  }

  operations.sort((left, right) =>
    scopedPathKey(left).localeCompare(scopedPathKey(right)),
  )
  const summary = Object.fromEntries(
    MODULE_ORDER.map((id) => [id, 0]),
  ) as Record<ModuleId, number>
  for (const operation of operations) {
    for (const moduleId of operation.moduleIds) summary[moduleId] += 1
  }

  return Object.freeze({
    dependenciesChanged,
    managedScripts: Object.freeze({ ...managedScripts }),
    operations: Object.freeze(
      operations.map((operation) => Object.freeze(operation)),
    ),
    snapshot: Object.freeze(
      Object.fromEntries(
        operations.map((operation) => [
          scopedPathKey(operation),
          operation.beforeHash,
        ]),
      ),
    ),
    summary: Object.freeze(summary),
  })
}
