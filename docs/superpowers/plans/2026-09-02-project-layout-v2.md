# Project Layout v2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Frontprep's fixed utility/test folder guesses with a
manifest-backed project layout, resolve aliased global CSS imports, and migrate
beta.0 manifests transactionally to schema v2.

**Architecture:** Introduce scoped project paths and a schema-v2 manifest as
the stable foundation, while keeping every root equal for this first PR. Split
static import extraction and TypeScript alias resolution into focused adapter
helpers, then let the Next.js adapter resolve one immutable layout using the
priority option → manifest → detected → default. Tailwind and Test consume that
layout instead of rescanning directories.

**Tech Stack:** TypeScript 5.9, Node.js 22.22.1, pnpm 10.22.0, Commander 14,
AJV 8, jsonc-parser 3, Vitest 4, native `node:fs` and `node:path` APIs.

**Spec:**
`docs/superpowers/specs/2026-09-02-project-model-v2-design.md`

## Global Constraints

- Keep support limited to Next.js 16 App Router, TypeScript 5, pnpm 10, and one
  package whose root equals the Git root in this PR.
- Continue rejecting non-empty package workspaces and pnpm workspace package
  globs until `feat/workspace-target` implements root separation.
- Read both schema-v1 and schema-v2 manifests; write only canonical schema v2.
- Keep the first `init` clean-Git requirement, preflight conflict detection,
  atomic writes, rollback, managed fingerprints, and read-only `check`.
- Never import or execute consumer config during detection.
- Reject absolute paths, backslashes, NUL bytes, `..` components, package
  escapes, and symbolic-link traversal.
- Preserve existing beta.0 utility and test paths during v1 migration.
- New projects default to `src/shared/lib` or `shared/lib` for utilities and
  `src/test` or `test` for the test directory.
- Path selection priority is explicit option, manifest, detected stylesheet,
  then canonical default.
- Module order remains Quality, Tailwind, Test, Git Hooks, CI.
- Do not add Vitest include/exclude changes, workspace execution, or ESLint
  dependency changes in this PR; each has a later isolated branch.

## File Responsibility Map

### New files

- `schema/manifest-v2.json` — closed JSON Schema for the new roots, paths, and
  package/repository file-record maps.
- `src/core/scoped-paths.ts` — `FileScope`, `ScopedProjectPath`, stable keying,
  scope-root selection, and manifest record lookup.
- `src/core/manifest-migration.ts` — pure v1-to-v2 path derivation plus the
  minimal file read needed to find the canonical Vitest setup path.
- `src/adapters/static-imports.ts` — lexical extraction of static side-effect
  CSS imports without executing the layout.
- `src/adapters/typescript-paths.ts` — JSONC `baseUrl`/`paths` loading and local
  alias resolution.
- `tests/core/scoped-paths.test.ts` — scope key, root, and record tests.
- `tests/core/manifest-migration.test.ts` — successful and rejected v1
  migrations.
- `tests/adapters/static-imports.test.ts` — import scanner behavior.
- `tests/adapters/typescript-paths.test.ts` — exact, wildcard, baseUrl, and
  unsafe alias behavior.
- `tests/helpers/manifest.ts` — canonical manifest fixtures shared across tests.

### Existing files with focused changes

- `src/core/types.ts` — v1 persisted shape, v2 runtime shape, resolved layout,
  selection provenance, and `manifestNeedsMigration`.
- `src/core/intents.ts`, `src/core/plan.ts`, `src/core/conflict-detector.ts`,
  `src/core/plan-builder.ts` — add scope to all file targets and group them by
  stable scoped key.
- `src/core/manifest.ts` — validate both schemas, normalize to v2, serialize
  v2, and keep v1 read compatibility.
- `src/core/transaction.ts`, `src/core/verifier.ts`, `src/core/git-guard.ts` —
  write nested scoped fingerprints and use scoped lookups. Both scopes point to
  the package root until the workspace PR.
- `src/adapters/next-app.ts` — resolve layout, relative/aliased stylesheet,
  utility directory, test directory, and path provenance.
- `src/core/project-detector.ts`, `src/core/context.ts` — orchestrate raw
  manifest loading, adapter detection, migration, and immutable context.
- `src/cli.ts`, `src/commands/init.ts`, `src/commands/check.ts`,
  `src/core/reporter.ts` — expose path flags, forward detection options, report
  selected paths, and run manifest-only migrations.
- `src/modules/tailwind.ts`, `src/modules/test.ts` — consume the resolved paths
  and remove candidate scanning.
- `src/modules/ci.ts` — mark the workflow as repository-scoped even though the
  roots are identical in this PR.
- `tests/**/*.test.ts`, `tests/helpers/project.ts` — use schema-v2 fixtures and
  cover the changed contracts.
- `docs/modules/cli-core.md`, `docs/modules/tailwind.md`,
  `docs/modules/test.md`, `README.md` — document v2 paths, flags, alias support,
  and the retained single-root boundary.
- `tests/package.test.ts`, `scripts/verify-package.mjs` — require both published
  manifest schemas.

---

### Task 1: Define scoped paths and the schema-v2 data contract

**Files:**

- Create: `schema/manifest-v2.json`
- Create: `src/core/scoped-paths.ts`
- Create: `tests/core/scoped-paths.test.ts`
- Create: `tests/helpers/manifest.ts`
- Modify: `src/core/types.ts`

**Interfaces:**

- Produces:
  `type FileScope = 'package' | 'repository'`.
- Produces:
  `interface ScopedProjectPath { scope: FileScope; path: ProjectPath }`.
- Produces:
  `scopedProjectPath(path: string, scope?: FileScope): ScopedProjectPath`.
- Produces:
  `scopedPathKey(target: ScopedProjectPath): string` using
  `${scope}:${path}`.
- Produces additive `FrontprepManifestV2` with `roots`, complete `paths`, and
  `files: Record<FileScope, Record<string, ManifestFile>>`.
- Renames the current persisted contract to `FrontprepManifestV1` and keeps
  `FrontprepManifest` as a temporary alias of v1 until Task 3 performs the
  atomic runtime switch.
- Does not change intents, operations, `ProjectContext`, or transaction result
  types in this task, keeping the repository compilable between commits.

- [ ] **Step 1: Write failing scoped-path tests**

Add tests that express the desired scoped-path API:

```ts
it('keys equal relative paths independently by scope', () => {
  expect(scopedPathKey(scopedProjectPath('same.txt'))).toBe('package:same.txt')
  expect(scopedPathKey(scopedProjectPath('same.txt', 'repository'))).toBe(
    'repository:same.txt',
  )
})
```

Add an AJV assertion in `tests/core/manifest.test.ts` for a v2 fixture with all
six path values and both file maps.

- [ ] **Step 2: Run the focused tests and verify RED**

Run:

```bash
pnpm exec vitest run tests/core/scoped-paths.test.ts tests/core/manifest.test.ts
```

Expected: FAIL because `scoped-paths.ts` and the v2 manifest shape do not exist.

- [ ] **Step 3: Add the schema and TypeScript contracts**

Define the additive v2 manifest shape exactly:

```ts
export type PathSelectionSource = 'default' | 'detected' | 'manifest' | 'option'

export interface FrontprepManifestV2 {
  $schema: 'https://unpkg.com/@mingyeongbin/frontprep/schema/manifest-v2.json'
  adapter: 'next-app'
  files: Record<FileScope, Record<string, ManifestFile>>
  frontprepVersion: string
  managedScripts: Record<string, string>
  modules: Record<ModuleId, string>
  packageManager: string
  paths: {
    app: string
    layout: string
    stylesheet: string
    utilities: string
    test: string
    testSetup: string
  }
  roots: { package: string; workspace: '.' }
  schemaVersion: 2
}
```

`manifest-v2.json` must use `additionalProperties: false`, require every key
shown in the spec, reuse the existing safe project-path pattern, allow `.` only
for `roots.workspace`, and validate separate package/repository file maps.

- [ ] **Step 4: Add canonical fixture factories**

Create helpers that prevent hundreds of handwritten stale manifests:

```ts
export function manifestV2(
  overrides: Partial<FrontprepManifestV2> = {},
): FrontprepManifestV2

export function manifestV1(
  overrides: Partial<FrontprepManifestV1> = {},
): FrontprepManifestV1
```

Use complete valid defaults, clone nested objects before applying overrides,
and return mutable test data rather than freezing it. Compile
`manifest-v2.json` directly with a test-local AJV instance so this additive task
does not switch the production loader yet.

- [ ] **Step 5: Run focused tests and verify GREEN**

Run the Task 1 command again. Expected: PASS with no warnings.

- [ ] **Step 6: Commit Task 1**

```bash
git add schema/manifest-v2.json src/core/scoped-paths.ts src/core/types.ts tests/core/scoped-paths.test.ts tests/core/manifest.test.ts tests/helpers/manifest.ts
git commit -m "feat: define project layout v2 contract"
```

### Task 2: Validate and migrate persisted manifests

**Files:**

- Create: `src/core/manifest-migration.ts`
- Create: `tests/core/manifest-migration.test.ts`
- Modify: `src/core/manifest.ts`
- Modify: `tests/core/manifest.test.ts`
- Modify: `tests/helpers/project.ts`

**Interfaces:**

- Consumes `FrontprepManifestV1`, `FrontprepManifestV2`, and v2 fixture helpers.
- Produces:
  `loadPersistedManifest(root: string): Promise<FrontprepManifestV1 | FrontprepManifestV2 | null>`.
- Produces:
  `normalizeManifest(root, persisted, detected): Promise<NormalizedManifest>`.
- Produces:

```ts
interface NormalizedManifest {
  readonly manifest: FrontprepManifestV2 | null
  readonly needsMigration: boolean
}

interface DetectedManifestPaths {
  readonly app: ProjectPath
  readonly layout: ProjectPath
  readonly stylesheet: ProjectPath
}
```

- Produces `serializeManifestV2` and `writeManifestV2` without replacing the v1
  production aliases until Task 3.

- [ ] **Step 1: Write v1 migration tests**

Create a beta.0 fixture with managed `src/shared/utils/cn.ts`, patched
`src/shared/utils/index.ts`, managed `vitest.config.mts`, and managed
`src/test/setup.ts`. Write the real canonical Vitest config so migration reads:

```ts
setupFiles: ['./src/test/setup.ts'],
```

Assert the normalized result has:

```ts
expect(result).toMatchObject({
  needsMigration: true,
  manifest: {
    schemaVersion: 2,
    roots: { package: '.', workspace: '.' },
    paths: {
      app: 'src/app',
      layout: 'src/app/layout.tsx',
      stylesheet: 'src/app/globals.css',
      utilities: 'src/shared/utils',
      test: 'src/test',
      testSetup: 'src/test/setup.ts',
    },
  },
})
```

Also assert that `pnpm-lock.yaml` and `.github/workflows/ci.yml` records land in
`files.repository`, all other records land in `files.package`, and ambiguous
`*/cn.ts` or setup paths reject with `INVALID_MANIFEST` before writing.

- [ ] **Step 2: Run migration tests and verify RED**

```bash
pnpm exec vitest run tests/core/manifest-migration.test.ts tests/core/manifest.test.ts
```

Expected: FAIL because the dual-schema loader and migration do not exist.

- [ ] **Step 3: Implement dual-schema loading**

Compile one AJV validator per schema. Parse JSON once, dispatch only when
`schemaVersion` is exactly `1` or `2`, validate `$schema`, validate semantic
version ordering, and report the selected validator's full instance paths.
Unknown schema versions must return `INVALID_MANIFEST` with the existing
restore/remove recovery text.

- [ ] **Step 4: Implement deterministic v1 derivation**

In `manifest-migration.ts`:

- find one managed path ending `/cn.ts` whose sibling `index.ts` is recorded;
- read the recorded managed `vitest.config.mts` as UTF-8;
- extract exactly one package-relative `setupFiles: ['./...']` literal;
- require its file record and filename `setup.ts`;
- use the detected App Router layout supplied by the caller;
- reject missing, duplicate, unsafe, non-recorded, or absolute results;
- map lockfile and workflow records to repository scope and the rest to package
  scope;
- preserve hashes, ownership, modes, module versions, and managed scripts.

Return v2 input unchanged with `needsMigration: false`.

- [ ] **Step 5: Make manifest writing v2-only**

Order canonical serialization as schema, version, adapter, package manager,
roots, paths, modules, files.package, files.repository, and managed scripts.
Refuse `writeManifestV2` input not accepted by the v2 validator. Keep the
existing v1 `serializeManifest` and `writeManifest` exports unchanged through
this commit.

- [ ] **Step 6: Run migration and manifest tests**

Run the Task 2 command. Expected: PASS with no warnings.

- [ ] **Step 7: Commit Task 2**

```bash
git add src/core/manifest.ts src/core/manifest-migration.ts tests/core/manifest.test.ts tests/core/manifest-migration.test.ts tests/helpers/project.ts
git commit -m "feat: migrate beta manifests to schema v2"
```

### Task 3: Carry file scope through planning, verification, and transactions

**Files:**

- Modify: `src/core/scoped-paths.ts`
- Modify: `src/core/types.ts`
- Modify: `src/core/intents.ts`
- Modify: `src/core/plan.ts`
- Modify: `src/core/manifest.ts`
- Modify: `src/core/conflict-detector.ts`
- Modify: `src/core/plan-builder.ts`
- Modify: `src/core/transaction.ts`
- Modify: `src/core/verifier.ts`
- Modify: `src/core/git-guard.ts`
- Modify: `src/core/reporter.ts`
- Modify: `src/commands/init.ts`
- Modify: `src/modules/quality.ts`
- Modify: `src/modules/tailwind.ts`
- Modify: `src/modules/test.ts`
- Modify: `src/modules/git-hooks.ts`
- Modify: `src/modules/ci.ts`
- Modify: `tests/core/intents.test.ts`
- Modify: `tests/core/conflict-detector.test.ts`
- Modify: `tests/core/plan-builder.test.ts`
- Modify: `tests/core/transaction.test.ts`
- Modify: `tests/core/verifier.test.ts`
- Modify: `tests/core/git-guard.test.ts`
- Modify: `tests/core/reporter.test.ts`
- Modify: `tests/commands/init.test.ts`
- Modify: `tests/modules/quality.test.ts`
- Modify: `tests/modules/tailwind.test.ts`
- Modify: `tests/modules/test.test.ts`
- Modify: `tests/modules/git-hooks.test.ts`
- Modify: `tests/modules/ci.test.ts`

**Interfaces:**

- Consumes `ScopedProjectPath`, `scopedPathKey`, and nested manifest file maps.
- Switches the runtime `FrontprepManifest` alias, `ProjectContext.manifest`,
  serializer, and writer from v1 to v2 as one compile-safe change.
- Gives every path-bearing file intent and `FileOperation` a required scope;
  intent constructors default their final `scope` argument to `package`.
- Changes `TransactionResult.changedFiles` and
  `CommandReporter.filesChanged` to `readonly ScopedProjectPath[]`.
- Produces:

```ts
export function rootForScope(context: ProjectContext, scope: FileScope): string

export function manifestFile(
  manifest: FrontprepManifest | null,
  target: ScopedProjectPath,
): ManifestFile | undefined
```

- Keeps both scopes mapped to `context.root` in this PR.

- [ ] **Step 1: Write failing scope propagation tests**

Add tests proving:

- package and repository intents for the same relative path do not conflict;
- two same-scope incompatible intents still conflict;
- CI creates a repository-scoped workflow operation;
- plan snapshots use `package:path` and `repository:path` keys;
- a repository-scoped managed record authorizes ownership;
- transaction result reports `ScopedProjectPath` objects without collapsing
  keys;
- verification fingerprints both nested maps.

Use this expected operation shape:

```ts
expect(operation).toMatchObject({
  scope: 'repository',
  path: '.github/workflows/ci.yml',
  ownership: 'managed',
})
```

- [ ] **Step 2: Run the focused core tests and verify RED**

```bash
pnpm exec vitest run tests/core/intents.test.ts tests/core/conflict-detector.test.ts tests/core/plan-builder.test.ts tests/core/transaction.test.ts tests/core/verifier.test.ts tests/core/git-guard.test.ts tests/core/reporter.test.ts tests/commands/init.test.ts tests/modules/quality.test.ts tests/modules/tailwind.test.ts tests/modules/test.test.ts tests/modules/git-hooks.test.ts tests/modules/ci.test.ts
```

Expected: FAIL because grouping and manifest ownership still ignore scope.

- [ ] **Step 3: Update conflict detection and planning**

First switch `FrontprepManifest` to the v2 runtime alias and make
`serializeManifest`/`writeManifest` delegate to the already tested v2
implementations. Update all non-migration fixtures to `manifestV2()`.

Give `ManagedFileIntent`, `ExecutableFileIntent`, `LineSetIntent`,
`CssImportIntent`, `StaticImportIntent`, and `FileOperation` a required
`scope`. Add the optional final `scope: FileScope = 'package'` argument to each
file-intent constructor. Dependency, script, and config-fragment intents do not
gain a scope.

Group complete and partial file intents by `scopedPathKey` rather than raw
path. Select a `FileSystem` with `rootForScope` for every snapshot. Treat
`package.json` and composed Prettier config as package targets. Sort operations
by scoped key and emit the same key in `ChangePlan.snapshot`.

Mark the CI workflow intent explicitly:

```ts
managedFileIntent(
  MODULE_ID,
  WORKFLOW_PATH,
  CI_WORKFLOW,
  0o644,
  'CI owns the GitHub Actions workflow.',
  'repository',
)
```

- [ ] **Step 4: Update transaction backup and rollback**

Key backup entries with `scopedPathKey`. Keep the lockfile repository-scoped,
the manifest package-scoped, and plan operations in their declared scope.
Create backup paths using an encoded scope directory followed by the safe
project path. Assert stale plans and restoration against the correct scope.

Write new fingerprints to `manifest.files[scope][path]`. Preserve existing
records in both maps and return immutable `ScopedProjectPath` changed targets
so repository and package paths cannot be confused. The reporter renders a
package target as its normal path and a repository target as
`[repository] <path>`.

- [ ] **Step 5: Update verifier and Git guard lookups**

Iterate both manifest file maps. Resolve each record using its scope and include
the scope in duplicate diagnostics. Replace direct
`context.manifest.files[path]` access in every module with `manifestFile`.
For the retained single-root Git guard, authorize a status path when exactly
one matching scoped record has the same fingerprint; reject conflicting
records rather than choosing one.

- [ ] **Step 6: Run focused tests and verify GREEN**

Run the Task 3 command. Expected: PASS with no warnings.

- [ ] **Step 7: Commit Task 3**

```bash
git add src/core/scoped-paths.ts src/core/types.ts src/core/intents.ts src/core/plan.ts src/core/manifest.ts src/core/conflict-detector.ts src/core/plan-builder.ts src/core/transaction.ts src/core/verifier.ts src/core/git-guard.ts src/core/reporter.ts src/commands/init.ts src/modules/quality.ts src/modules/tailwind.ts src/modules/test.ts src/modules/git-hooks.ts src/modules/ci.ts tests/core/intents.test.ts tests/core/conflict-detector.test.ts tests/core/plan-builder.test.ts tests/core/transaction.test.ts tests/core/verifier.test.ts tests/core/git-guard.test.ts tests/core/reporter.test.ts tests/commands/init.test.ts tests/modules/quality.test.ts tests/modules/tailwind.test.ts tests/modules/test.test.ts tests/modules/git-hooks.test.ts tests/modules/ci.test.ts
git commit -m "refactor: preserve file scope through transactions"
```

### Task 4: Parse CSS imports and resolve TypeScript path aliases

**Files:**

- Create: `src/adapters/static-imports.ts`
- Create: `src/adapters/typescript-paths.ts`
- Create: `tests/adapters/static-imports.test.ts`
- Create: `tests/adapters/typescript-paths.test.ts`

**Interfaces:**

- Produces:
  `extractStaticCssImports(contents: string): readonly string[]`.
- Produces:

```ts
interface TypeScriptPaths {
  readonly baseUrl: string | null
  readonly mappings: readonly {
    readonly pattern: string
    readonly targets: readonly string[]
  }[]
}

export function parseTypeScriptPaths(
  contents: string,
  tsconfigPath: string,
): TypeScriptPaths

export async function resolveTypeScriptImport(
  packageRoot: string,
  config: TypeScriptPaths,
  specifier: string,
): Promise<readonly ProjectPath[]>
```

- [ ] **Step 1: Write scanner tests**

Cover semicolon/no-semicolon, whitespace, single/double quotes, multiline
comments, commented imports, ordinary strings, template literals, dynamic
imports, `require`, default imports, and duplicates. Required behavior:

```ts
expect(
  extractStaticCssImports(`
    // import './ignored.css'
    import '@/styles/global.css'
    import './theme.css';
    const value = "import './not-real.css'"
  `),
).toEqual(['@/styles/global.css', './theme.css'])
```

- [ ] **Step 2: Write alias resolver tests**

Create real temporary package files and cover:

- `@/*` → `./src/*`;
- exact `styles/global.css` mapping;
- `baseUrl: "src"` without `paths`;
- path arrays where one or multiple targets exist;
- unmatched package-like specifiers;
- targets outside the package;
- invalid JSONC, non-string baseUrl, multi-star patterns, and non-string target
  arrays.

The resolver must return normalized existing regular-file candidates only and
must never follow an escaping symlink.

- [ ] **Step 3: Run adapter helper tests and verify RED**

```bash
pnpm exec vitest run tests/adapters/static-imports.test.ts tests/adapters/typescript-paths.test.ts
```

Expected: FAIL because both helpers are absent.

- [ ] **Step 4: Implement the lexical scanner**

Use a character-state scanner with code, line-comment, block-comment,
single-quote, double-quote, and template states. Recognize only an `import`
token followed directly by one quoted module specifier and require a `.css`
suffix before an optional query/hash. Preserve discovery order and de-duplicate
identical specifiers.

- [ ] **Step 5: Implement JSONC alias resolution**

Use `jsonc-parser` with trailing commas allowed. Store the absolute base
directory internally but expose only normalized data. Match exact keys before
wildcards and allow exactly one `*` per mapping. Substitute the captured value
into each target, resolve from `baseUrl` or the tsconfig directory, validate
with the existing safe-path and symlink rules, and return sorted unique
package-relative regular files.

- [ ] **Step 6: Run adapter helper tests and verify GREEN**

Run the Task 4 command. Expected: PASS with no warnings.

- [ ] **Step 7: Commit Task 4**

```bash
git add src/adapters/static-imports.ts src/adapters/typescript-paths.ts tests/adapters/static-imports.test.ts tests/adapters/typescript-paths.test.ts
git commit -m "feat: resolve aliased stylesheet imports"
```

### Task 5: Resolve and report one manifest-backed Next.js layout

**Files:**

- Modify: `src/adapters/next-app.ts`
- Modify: `src/core/project-detector.ts`
- Modify: `src/core/context.ts`
- Modify: `src/core/types.ts`
- Modify: `src/core/reporter.ts`
- Modify: `src/commands/init.ts`
- Modify: `src/commands/check.ts`
- Modify: `src/cli.ts`
- Modify: `tests/adapters/next-app.test.ts`
- Modify: `tests/core/project-detector.test.ts`
- Modify: `tests/core/reporter.test.ts`
- Modify: `tests/commands/init.test.ts`
- Modify: `tests/commands/check.test.ts`
- Modify: `tests/commands/support/recording-reporter.ts`
- Modify: `tests/cli.test.ts`

**Interfaces:**

- Consumes manifest normalization and adapter helper APIs from Tasks 2 and 4.
- Produces:

```ts
export interface ProjectDetectionOptions {
  readonly stylesheet?: string
  readonly testDirectory?: string
  readonly utilityDirectory?: string
}

export interface PathSelection<T extends string = string> {
  readonly source: PathSelectionSource
  readonly value: T
}

export async function detectProject(
  cwd: string,
  options?: ProjectDetectionOptions,
): Promise<ProjectContext>
```

- `ProjectContext` retains compatibility getters such as `stylesheetPath` for
  module migration in this PR and adds immutable `layout`,
  `manifestNeedsMigration`, and root fields all equal to `root`.

- [ ] **Step 1: Write failing layout-priority tests**

Cover these cases independently:

1. `@/*` resolves `@/styles/global.css` to `src/styles/global.css` and reports
   source `detected` with import kind `alias`.
2. `--stylesheet styles/theme.css` with no import selects source `option` and
   plans a relative layout import.
3. An option disagreeing with a resolved existing import rejects.
4. A v2 manifest path wins over defaults and is source `manifest`.
5. An option disagreeing with the manifest rejects and names the flag.
6. No import defaults beside the layout.
7. Utility/test defaults are `src/shared/lib` and `src/test`.
8. Unsafe, symlinked, or non-directory utility/test values reject.
9. Multiple distinct stylesheet imports and multi-target aliases reject with
   `--stylesheet` recovery guidance.

Expected context excerpt:

```ts
expect(context.layout).toMatchObject({
  stylesheet: {
    path: 'src/styles/global.css',
    source: 'detected',
    importKind: 'alias',
    importSpecifier: '@/styles/global.css',
  },
  utilities: { path: 'src/shared/lib', source: 'default' },
  tests: { path: 'src/test', source: 'default' },
})
```

- [ ] **Step 2: Write failing CLI forwarding tests**

Inject a `detectProject` spy and run:

```ts
await runCli(
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
    'src/test',
  ],
  services,
  output,
)
```

Assert the exact `ProjectDetectionOptions`. Also assert `check --stylesheet`
is rejected by Commander with exit code 2.

- [ ] **Step 3: Run detector and CLI tests and verify RED**

```bash
pnpm exec vitest run tests/adapters/next-app.test.ts tests/core/project-detector.test.ts tests/core/reporter.test.ts tests/commands/init.test.ts tests/commands/check.test.ts tests/cli.test.ts
```

Expected: FAIL because the options, alias-aware layout, and reporting contract
do not exist.

- [ ] **Step 4: Implement adapter selection priority**

Detect the unique App Router first. Load static CSS import specifiers, resolve
relative imports directly and bare imports through the TypeScript helper, and
reduce them to one unique package path. Then select each final value by option,
manifest, detected stylesheet, or default. Validate any higher-priority choice
against a lower-priority existing import instead of silently overriding it.

For utility and test directories, allow a missing path because Frontprep will
create it, allow an existing real directory, and reject every other file type
or symbolic-link component. Set `testSetupPath` to `<testDirectory>/setup.ts`.

- [ ] **Step 5: Integrate persisted manifest normalization**

`detectProject` must:

1. validate package, tsconfig, Git root, pnpm, Next.js, and TypeScript as now;
2. read the persisted v1/v2 manifest without writing;
3. detect App Router and stylesheet using raw recorded path plus caller option;
4. normalize v1 with the detected layout;
5. finalize utility/test paths with normalized manifest plus caller options;
6. freeze the complete context, nested layout, selections, roots, package
   manager, and package JSON.

- [ ] **Step 6: Forward CLI options and improve reporting**

Add the three Commander options to `init`, map them to camel-case detection
options, and keep `check` unchanged. Change `CommandReporter.detected` to accept
`ProjectContext`. Render the selected app, stylesheet specifier/kind, utility,
test, and provenance lines. Add `[<error.code>]` to structured error output
while preserving phase, module, path, and recovery lines.

- [ ] **Step 7: Run detector and CLI tests and verify GREEN**

Run the Task 5 command. Expected: PASS with no warnings.

- [ ] **Step 8: Commit Task 5**

```bash
git add src/adapters/next-app.ts src/core/project-detector.ts src/core/context.ts src/core/types.ts src/core/reporter.ts src/commands/init.ts src/commands/check.ts src/cli.ts tests/adapters/next-app.test.ts tests/core/project-detector.test.ts tests/core/reporter.test.ts tests/commands/init.test.ts tests/commands/check.test.ts tests/commands/support/recording-reporter.ts tests/cli.test.ts
git commit -m "feat: resolve configurable project paths"
```

### Task 6: Make Tailwind consume the resolved utility and stylesheet paths

**Files:**

- Modify: `src/modules/tailwind.ts`
- Modify: `tests/modules/tailwind.test.ts`
- Modify: `docs/modules/tailwind.md`

**Interfaces:**

- Consumes `context.layout.utilities.path`,
  `context.layout.stylesheet.path`, and stylesheet import metadata.
- Produces Tailwind module version `2.0.0`.
- Removes `utilityCandidates` and `selectUtilityDirectory`.

- [ ] **Step 1: Write failing Tailwind path tests**

Add tests proving:

- a new project plans `src/shared/lib/cn.ts` and
  `src/shared/lib/index.ts`;
- `--utility-dir src/domain/ui/lib` targets that exact directory;
- existing `src/lib/utils` no longer changes selection without an option or
  manifest;
- a migrated beta.0 manifest continues using `src/shared/utils`;
- an existing alias stylesheet import does not produce a static-import intent;
- verify uses the recorded utility path even when another conventional
  directory is added later.

- [ ] **Step 2: Run Tailwind tests and verify RED**

```bash
pnpm exec vitest run tests/modules/tailwind.test.ts
```

Expected: FAIL because Tailwind still scans three fixed candidates.

- [ ] **Step 3: Replace candidate scanning with resolved-path validation**

Read `utilsDirectory` directly from the context. Keep
`assertNoSymbolicLinkComponents` and `pathMetadata`; run them against only the
resolved path. A missing directory is eligible, a real directory is reusable,
and a non-directory or symlink is a conflict. Use the same resolved path in
analysis, intents, manifest ownership, and verification fallback diagnostics.

Use stylesheet import metadata instead of calling candidate detection to decide
whether to add a relative layout import. Preserve an existing alias or relative
specifier.

- [ ] **Step 4: Update Tailwind module documentation**

Replace the candidate list with option/manifest/default priority, the new
`shared/lib` default, alias stylesheet behavior, and v1 path preservation.
Reference the project-model-v2 design.

- [ ] **Step 5: Run Tailwind tests and verify GREEN**

Run the Task 6 command. Expected: PASS with no warnings.

- [ ] **Step 6: Commit Task 6**

```bash
git add src/modules/tailwind.ts tests/modules/tailwind.test.ts docs/modules/tailwind.md
git commit -m "feat: use resolved Tailwind utility paths"
```

### Task 7: Make Test consume the resolved test path

**Files:**

- Modify: `src/modules/test.ts`
- Modify: `tests/modules/test.test.ts`
- Modify: `docs/modules/test.md`

**Interfaces:**

- Consumes `context.layout.tests.path` and
  `context.layout.testSetupPath`.
- Produces Test module version `2.0.0`.
- Removes `setupCandidates` and `selectSetupDirectory`.
- Does not change Vitest discovery globs in this task.

- [ ] **Step 1: Write failing Test path tests**

Add tests proving:

- the default setup remains `src/test/setup.ts` for `src/app`;
- `--test-dir tests/unit` renders `./tests/unit/setup.ts` in the managed config;
- an existing `src/tests` directory no longer changes selection without an
  option or manifest;
- a migrated beta.0 manifest using `src/tests/setup.ts` keeps that path;
- verification uses the manifest path after a second conventional directory is
  created;
- a resolved non-directory or symbolic-link component remains a conflict.

- [ ] **Step 2: Run Test module tests and verify RED**

```bash
pnpm exec vitest run tests/modules/test.test.ts
```

Expected: FAIL because Test still scans `test` and `tests` candidates.

- [ ] **Step 3: Replace candidate scanning with the resolved path**

Build `TestAnalysis` directly from context. Validate only the resolved test
directory and setup path using the existing non-directory and symlink safety
checks. Render and verify the exact context setup path. Keep dependency,
scripts, Jest/Vitest conflicts, setup contents, and `passWithNoTests` unchanged.

- [ ] **Step 4: Update Test module documentation**

Document `--test-dir`, manifest authority, the canonical defaults, beta.0 path
migration, and explicitly state that application-only discovery is delivered
by the next `fix/test-discovery` PR.

- [ ] **Step 5: Run Test module tests and verify GREEN**

Run the Task 7 command. Expected: PASS with no warnings.

- [ ] **Step 6: Commit Task 7**

```bash
git add src/modules/test.ts tests/modules/test.test.ts docs/modules/test.md
git commit -m "feat: use resolved Vitest setup paths"
```

### Task 8: Commit schema migration through the transaction boundary

**Files:**

- Modify: `src/core/transaction.ts`
- Modify: `src/commands/init.ts`
- Modify: `src/commands/check.ts`
- Modify: `src/core/reporter.ts`
- Modify: `tests/core/transaction.test.ts`
- Modify: `tests/commands/init.test.ts`
- Modify: `tests/commands/check.test.ts`
- Modify: `tests/core/reporter.test.ts`

**Interfaces:**

- Extends `TransactionServices` with
  `writeManifestWhenUnchanged?: boolean`.
- `runInit` sends that flag when `context.manifestNeedsMigration` is true.
- `check` emits a non-failing `migrationAvailable()` reporter event for v1.

- [ ] **Step 1: Write failing migration transaction tests**

Cover:

- empty module plan plus v1 context invokes `applyPlan` once;
- the transaction backs up and writes only `.frontprep.json` when all managed
  files already match;
- a forced verification failure restores the exact v1 manifest bytes;
- successful migration returns `changed: true` and the manifest path;
- `check` reports migration availability but performs no write;
- ordinary v2 empty plans still use the current no-transaction fast path.

- [ ] **Step 2: Run transaction and command tests and verify RED**

```bash
pnpm exec vitest run tests/core/transaction.test.ts tests/commands/init.test.ts tests/commands/check.test.ts tests/core/reporter.test.ts
```

Expected: FAIL because an empty plan bypasses manifest writing.

- [ ] **Step 3: Implement manifest-only transaction behavior**

When `writeManifestWhenUnchanged` is true, do not return through the empty-plan
path. Back up the manifest, run the normal Git recheck and verification,
serialize the normalized v2 manifest last, and include `.frontprep.json` in
changed files only if its bytes changed. No dependency install or file/module
operation should run.

`runInit` must pass the flag only for a v1 normalized context. `runCheck` calls
`reporter.migrationAvailable()` after detection but otherwise follows the same
read-only flow.

- [ ] **Step 4: Run transaction and command tests and verify GREEN**

Run the Task 8 command. Expected: PASS with no warnings.

- [ ] **Step 5: Commit Task 8**

```bash
git add src/core/transaction.ts src/commands/init.ts src/commands/check.ts src/core/reporter.ts tests/core/transaction.test.ts tests/commands/init.test.ts tests/commands/check.test.ts tests/core/reporter.test.ts
git commit -m "feat: migrate manifests transactionally"
```

### Task 9: Update core documentation and packaged-schema verification

**Files:**

- Modify: `README.md`
- Modify: `docs/modules/cli-core.md`
- Modify: `tests/package.test.ts`
- Modify: `scripts/verify-package.mjs`
- Modify: `tests/acceptance/ci-module.acceptance.ts`
- Modify: `tests/core/git-guard.test.ts`
- Modify: `tests/core/plan-builder.test.ts`
- Modify: `tests/core/project-detector.test.ts`
- Modify: `tests/core/verifier.test.ts`
- Modify: `tests/modules/ci.test.ts`
- Modify: `tests/modules/git-hooks.test.ts`
- Modify: `tests/modules/test.test.ts`

**Interfaces:**

- Documents only behavior implemented in Tasks 1–8.
- Package verification requires both
  `schema/manifest-v1.json` and `schema/manifest-v2.json`.

- [ ] **Step 1: Write the failing package-content assertion**

Change the expected tarball file list so it includes both schema files and no
other new runtime artifact. Update the installed smoke script to assert both
files are readable from the unpacked package.

- [ ] **Step 2: Run package tests and verify RED**

```bash
pnpm exec vitest run tests/package.test.ts
```

Expected: FAIL until the package assertions and built output agree on the v2
schema contract. If the sandbox blocks npm cache writes, rerun this exact test
with approved external cache access; do not change npm ownership as part of the
repository task.

- [ ] **Step 3: Update user and core documentation**

README quick start must show standalone defaults and one explicit-path example.
The CLI core document must replace manifest v1 writing with dual-read/v2-write,
list all path fields and provenance, explain alias resolution and migration,
and state that nested workspace execution remains deferred to the next PR.

Search and update test fixtures that construct the old runtime manifest type;
use `manifestV1()` only in migration tests and `manifestV2()` everywhere else.

- [ ] **Step 4: Run package and full fast tests**

```bash
pnpm exec vitest run tests/package.test.ts
pnpm test:run
```

Expected: both commands PASS with no failed or skipped Frontprep contract tests.

- [ ] **Step 5: Commit Task 9**

```bash
git add README.md docs/modules/cli-core.md tests/package.test.ts scripts/verify-package.mjs tests
git commit -m "docs: document configurable project layouts"
```

### Task 10: Run release-grade verification and prepare the draft PR

**Files:**

- No file change is planned for this verification task.
- Do not bump the package version or publish in this branch.

**Interfaces:**

- Verifies every first-PR success criterion from the approved spec.
- Produces a draft PR targeting `develop`.

- [ ] **Step 1: Run static and unit verification**

```bash
pnpm lint
pnpm format:check
pnpm typecheck
pnpm build
pnpm test:run
```

Expected: all commands exit 0, tests report zero failures, and lint output has
no warnings from this repository.

- [ ] **Step 2: Run package and module acceptance gates**

```bash
pnpm verify:package
pnpm verify:quality-compatibility
pnpm verify:test-compatibility
pnpm verify:git-hooks-compatibility
pnpm verify:ci-compatibility
```

Expected: all five commands exit 0. This branch does not alter the dependency
compatibility lines, but the generated schema and paths must remain consumable.
If a command fails, stop this task, add a failing regression test to the owning
earlier task, implement the smallest fix there, rerun that task's focused gate,
and then restart Task 10 from Step 1.

- [ ] **Step 3: Exercise a packed CLI against path variants**

Use temporary committed Next.js fixtures and the packed CLI to verify:

```text
relative stylesheet + defaults
aliased stylesheet + src/shared/lib
explicit stylesheet + explicit utility/test directories
beta.0 manifest migration + idempotent second init
read-only check before and after migration
```

For each successful `init`, assert the expected paths in `.frontprep.json`, run
`frontprep check`, run a second `init`, and require an empty Git diff after
committing the first result. Inject one verification failure and compare all
pre/post file hashes to prove rollback.

- [ ] **Step 4: Review the complete diff against the spec**

```bash
git diff develop...HEAD --check
git diff develop...HEAD --stat
git status --short
```

Confirm no workspace execution, Vitest discovery, ESLint version, release
version, tag, or publish change slipped into this branch.

- [ ] **Step 5: Push and open the draft PR**

```bash
git push -u origin feat/project-layout-v2
gh pr create --base develop --head feat/project-layout-v2 --draft --title "feat: add manifest-backed project layouts" --body-file <reviewed-pr-body-path>
```

The reviewed PR body must summarize the design link, v1 migration, CLI flags,
alias resolution, scoped transaction foundation, module version changes, exact
test counts, acceptance results, rollback evidence, and deferred follow-up PRs.

- [ ] **Step 6: Request independent review, resolve findings with TDD, and merge**

Review path safety, schema compatibility, import parsing, ownership lookup,
migration rollback, idempotency, and stale documentation. Reproduce every
accepted behavior finding with a failing test before changing production code.
After all checks and review are green, mark the PR ready and merge to
`develop`. Delete only this clean worktree and preserve all pre-existing
worktrees, stashes, and `/Users/mingyeongbin/frontprep/.pnpm-store/`.
