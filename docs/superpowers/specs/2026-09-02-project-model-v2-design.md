# Frontprep Project Model v2 Design

## Status

- Date: 2026-09-02
- Target release: `0.1.0-beta.1`
- Base: `0.1.0-beta.0`
- Adapter: Next.js 16 App Router with TypeScript 5 and pnpm 10
- Decision: use deterministic signals first, explicit CLI path overrides for
  ambiguity, and the manifest as the authority after initialization

## Problem

Frontprep already installs and connects Quality, Tailwind, Test, Git Hooks,
and CI with conflict detection, rollback, verification, and idempotent reruns.
Its project model is nevertheless tied to a single package at the Git root and
to fixed utility and test directory candidates. The Next.js adapter only
recognizes relative stylesheet imports. These assumptions cause valid projects
such as `src/shared/lib`, aliased global CSS imports, and workspace applications
to be rejected or configured at the wrong location.

The generated Vitest configuration also uses Vitest's repository-wide default
test discovery. That can collect tool, fixture, or linked-worktree tests that
are not application tests. The Quality module accepts an ESLint compatibility
line that can emit a support warning, so a successful generated lint command is
not yet guaranteed to have zero warnings.

This design replaces the implicit folder guesses with one explicit project
layout contract while retaining Frontprep's existing safety properties.

## Goals

1. Record the application, layout, stylesheet, utility, and test paths in a
   versioned manifest.
2. Resolve static CSS imports through TypeScript `baseUrl` and `paths` aliases.
3. Remove fixed utility and test candidate scans.
4. Let callers select ambiguous paths using non-interactive CLI flags.
5. Restrict generated Vitest discovery to application-owned locations.
6. Require the generated ESLint command to finish with zero warnings.
7. Support one explicitly targeted Next.js application inside a pnpm workspace.
8. Read existing schema-v1 manifests and migrate them without requiring users
   to delete Frontprep-managed files.
9. Preserve preflight conflict detection, transactional rollback, managed-file
   fingerprints, read-only `check`, and idempotent reruns.

## Non-goals

- Configuring every application in a monorepo in one command.
- Managing more than one Frontprep target application in the same repository
  during the beta. Repository-wide Git Hooks and CI ownership would need a
  multi-application composition contract first.
- Supporting npm, Yarn, Bun, the Pages Router, JavaScript-only applications, or
  Next.js majors other than 16.
- Executing consumer TypeScript, JavaScript, ESLint, Vite, or Next.js config
  files during detection.
- Guessing arbitrary architectural concepts from directory names or source
  semantics.
- Automatically following a directory after the user moves it. A recorded path
  mismatch is reported and requires an explicit new path choice.
- Migrating Jest tests, custom Vitest workspaces, legacy Tailwind configuration,
  or user-owned conflicting configuration.

## Chosen Approach

Frontprep uses a hybrid resolver:

1. explicit command option;
2. existing manifest value;
3. an unambiguous structural signal;
4. a documented canonical default.

It does not recursively score conventional folder names. That approach would
replace a small hard-coded list with a larger, less predictable heuristic. It
also does not require a hand-written Frontprep config before initialization,
because that would undermine the CLI's zero-setup use case. Explicit flags are
the escape hatch, and the generated manifest persists the result.

## CLI Contract

`init` gains package-relative path options:

```text
frontprep init [--cwd <package-root>]
               [--stylesheet <path>]
               [--utility-dir <path>]
               [--test-dir <path>]
```

Examples:

```bash
frontprep init --cwd .
frontprep init --cwd apps/web
frontprep init --cwd apps/web \
  --stylesheet src/styles/global.css \
  --utility-dir src/shared/lib \
  --test-dir src/test
```

Rules:

- `--cwd` identifies the target package root. Frontprep does not search upward
  for an arbitrary package when the supplied directory is not a package root.
- Each path option is a normalized POSIX path relative to the package root.
- Absolute paths, backslashes, NUL bytes, `..` components, paths outside the
  package, and symbolic-link traversal are rejected before planning.
- Path options are accepted on first initialization.
- On a rerun, an option must equal the path recorded by the manifest. Changing
  a managed path is deferred to a future explicit relocation command; `init`
  never silently abandons an already managed file.
- `check` accepts only `--cwd`. It reads the manifest and never chooses paths or
  changes files.
- Non-interactive flags remain the only selection mechanism so local runs and
  CI use the same deterministic contract.

## Project Roots

`ProjectContext` separates three roots:

```ts
interface ProjectRoots {
  readonly packageRoot: string
  readonly repositoryRoot: string
  readonly workspaceRoot: string
  readonly packageDirectory: ProjectPath | '.'
}
```

- `packageRoot` contains the selected Next.js `package.json`, `tsconfig.json`,
  App Router, package scripts, and package-local configuration.
- `repositoryRoot` is returned by `git rev-parse --show-toplevel` and owns Git
  status, Git configuration, and `.github/workflows`.
- `workspaceRoot` contains `pnpm-workspace.yaml` and the shared
  `pnpm-lock.yaml`. For beta.1, it must equal `repositoryRoot` when the package
  is nested. A standalone package has all three roots equal.
- `packageDirectory` is `.` for a standalone package and the normalized
  repository-relative directory such as `apps/web` for a workspace package.

The detector accepts either a standalone package at the Git root or one nested
package that is included by the root pnpm workspace definition. A nested
package without a root `pnpm-workspace.yaml`, a workspace outside the Git root,
or a package not selected by the workspace is rejected with a recovery message
that names `--cwd` and the workspace declaration.

Workspace membership is delegated to pnpm rather than approximated with a
second glob implementation. The detector runs pnpm's read-only package listing
from `workspaceRoot` with the normalized directory filter and
`--fail-if-no-match`, then requires exactly one returned package whose real
path equals `packageRoot`. It does not run package scripts. Frontprep also
checks the listed workspace package roots for another `.frontprep.json` and
rejects a second managed target during the beta.

The pnpm version is read from the workspace-root `packageManager` declaration,
falling back to the package declaration only for a standalone project. The
selected package must still directly declare compatible Next.js 16 and
TypeScript 5 dependencies.

## Project Layout

The resolved package-relative layout is immutable:

```ts
type PathSelectionSource = 'default' | 'detected' | 'manifest' | 'option'

interface ProjectLayout {
  readonly appDirectory: ProjectPath
  readonly layoutPath: ProjectPath
  readonly sourceDirectory: ProjectPath | null
  readonly stylesheet: {
    readonly path: ProjectPath
    readonly source: PathSelectionSource
    readonly importKind: 'alias' | 'relative' | 'planned'
    readonly importSpecifier: string
  }
  readonly utilities: {
    readonly path: ProjectPath
    readonly source: PathSelectionSource
  }
  readonly tests: {
    readonly path: ProjectPath
    readonly source: PathSelectionSource
  }
  readonly testSetupPath: ProjectPath
}
```

The App Router rule remains exactly one `app/layout.{ts,tsx}` or
`src/app/layout.{ts,tsx}` in the selected package. `sourceDirectory` is `src`
for `src/app` and `null` for root `app`.

Default paths are:

| Value             | `src/app` package                          | root `app` package          |
| ----------------- | ------------------------------------------ | --------------------------- |
| stylesheet        | beside the layout as `src/app/globals.css` | `app/globals.css`           |
| utility directory | `src/shared/lib`                           | `shared/lib`                |
| test directory    | `src/test`                                 | `test`                      |
| test setup        | `<test-directory>/setup.ts`                | `<test-directory>/setup.ts` |

Utility and Test modules no longer scan `shared/utils`, `lib/utils`, `utils`,
`test`, or `tests` candidates. They consume the single resolved path from
`ProjectContext`. Existing beta projects retain their earlier selected paths
through manifest-v1 migration.

## TypeScript Alias Resolution

The adapter parses `tsconfig.json` as JSONC data. It reads only
`compilerOptions.baseUrl` and `compilerOptions.paths`; it does not process
`extends` in beta.1 and never imports the file.

The root layout scanner recognizes static side-effect CSS imports after
masking line comments, block comments, strings unrelated to import specifiers,
and template literals. Dynamic imports, `require`, URLs, packages, and imports
without a `.css` suffix are not global stylesheet candidates.

Resolution follows these rules:

1. A specifier beginning with `.` is resolved relative to the layout.
2. A bare specifier is matched against exact `paths` keys, then wildcard keys.
3. Each mapped target is resolved relative to `baseUrl` when present, otherwise
   to the tsconfig directory.
4. A bare specifier not matched by `paths` may resolve below `baseUrl`.
5. Only normalized paths inside `packageRoot` are eligible.
6. Existing regular files are preferred. A planned path may be selected only
   by `--stylesheet` or by the no-import sibling default.
7. Multiple distinct resolved CSS files are an ambiguity error.

If `--stylesheet` is supplied and the layout already imports a stylesheet, the
resolved import must equal the supplied path. If the layout has no stylesheet
import, Tailwind plans one relative side-effect import to the supplied or
default path. Existing alias imports are preserved byte-for-byte.

Unsupported alias shapes, multiple target files, unresolved bare CSS imports,
or paths escaping the package produce a detection error that shows the import
specifier and recommends `--stylesheet <package-relative-path>`.

## Manifest v2

The new schema is published as `schema/manifest-v2.json`. The package continues
shipping `manifest-v1.json` while v1 migration is supported.

The top-level structure is:

```json
{
  "$schema": "https://unpkg.com/@mingyeongbin/frontprep/schema/manifest-v2.json",
  "schemaVersion": 2,
  "frontprepVersion": "0.1.0-beta.1",
  "adapter": "next-app",
  "packageManager": "pnpm@10.22.0",
  "roots": {
    "package": "apps/web",
    "workspace": "."
  },
  "paths": {
    "app": "src/app",
    "layout": "src/app/layout.tsx",
    "stylesheet": "src/styles/global.css",
    "utilities": "src/shared/lib",
    "test": "src/test",
    "testSetup": "src/test/setup.ts"
  },
  "modules": {},
  "files": {
    "package": {},
    "repository": {}
  },
  "managedScripts": {}
}
```

All `paths` values are relative to `packageRoot`. `roots.package` and
`roots.workspace` are relative to `repositoryRoot`; `.` is the only allowed
workspace value in beta.1. `files.package` keys are package-relative and
`files.repository` keys are repository-relative. Each file record retains the
v1 hash, ownership, and mode contract.

The manifest remains at `<packageRoot>/.frontprep.json`. This keeps ownership
with the configured package and leaves space for a future multi-application
repository index without defining it prematurely.

### v1 Migration

`loadManifest` validates schema v1 or v2 by `schemaVersion` and `$schema`.
Migration converts a valid v1 manifest to the in-memory v2 model only when the
package and Git roots are equal.

Migration derives:

- `layout` from the uniquely detected App Router layout;
- `utilities` from the unique managed `*/cn.ts` plus matching `*/index.ts`;
- `testSetup` from the unique managed setup file referenced by the canonical
  managed `vitest.config.mts`;
- `test` from the parent of `testSetup`;
- existing `app` and `stylesheet` directly from v1;
- `pnpm-lock.yaml` and `.github/workflows/*` records into
  `files.repository`, and all other v1 file records into `files.package`;
- `roots.package` and `roots.workspace` as `.`.

Any missing or ambiguous derivation fails before mutation with a recovery
message. Frontprep does not invent a new path for an existing managed project.

The context records `manifestNeedsMigration`. `init` treats this as a
transaction even when no module file operation is needed: it verifies the
existing managed project, backs up the manifest, writes canonical v2 last, and
restores it on failure. `check` validates a v1 project read-only and reports a
non-failing migration notice; it never rewrites the manifest.

## Scoped File Operations

Every path-bearing change and file record gains a scope:

```ts
type FileScope = 'package' | 'repository'

interface ScopedProjectPath {
  readonly scope: FileScope
  readonly path: ProjectPath
}
```

Package scope is the default for module configuration, source files,
`package.json`, and `.frontprep.json`. Repository scope is limited to the
workspace lockfile and the managed GitHub Actions workflow in beta.1.

Path resolution first chooses the declared root and then applies all existing
absolute-path, traversal, and symbolic-link guards. Cross-scope collisions are
checked using canonical absolute targets. Two intents may not write the same
absolute file even if their logical scopes differ.

Transaction backup, fingerprinting, atomic writes, directory cleanup, and
rollback operate on scoped targets. The manifest is still written last. A
failure after changing either root restores both roots, the workspace lockfile,
Git hook activation, and the original manifest.

## Git Safety

Git status always runs at `repositoryRoot`. A first initialization requires the
entire repository to be clean, including untracked files outside the selected
package. This conservative boundary prevents package changes from being mixed
with unrelated repository work.

On rerun, a dirty status path is authorized only when it maps exactly to a
manifest file record:

- `files.package` maps through `packageDirectory`;
- `files.repository` maps directly from the repository root;
- the package manifest maps through `packageDirectory/.frontprep.json`.

The fingerprint and canonical-manifest checks remain unchanged after mapping.
Unrelated workspace-package changes, renames, deletions, conflicts, dirty
submodules, and type changes are rejected.

## Package Installation

For a standalone project, package installation retains the existing package
root behavior. For a workspace target:

- package dependency edits apply to the selected package's `package.json`;
- the shared lockfile is backed up from `workspaceRoot`;
- installation runs from `workspaceRoot` with a directory selector for the
  target package and `--fail-if-no-match`;
- verification commands run in `packageRoot`;
- dependency rebuild remains limited to Frontprep's trusted package set.

The command is derived from the normalized `packageDirectory`, never from a
package name, so duplicate or missing package names cannot select the wrong
workspace project.

## Module Changes

### Tailwind

Tailwind consumes `layout.utilities.path` and `layout.stylesheet.path`. It
removes utility candidate scanning and retains all existing managed-file,
barrel-symbol, CSS conflict, Prettier composition, and symlink checks. New
projects default to `shared/lib`; migrated v1 projects keep their existing
directory.

An aliased stylesheet import is considered connected when re-detection resolves
it to the recorded stylesheet. Tailwind only adds a relative import when the
adapter reports `kind: planned`.

### Test

Test consumes `layout.tests.path` and `layout.testSetupPath` and removes its
candidate scan. The generated Vitest config imports `configDefaults` and sets
a deterministic include list:

- `src/**/*.{test,spec}.?(c|m)[jt]s?(x)` for a `src/app` package;
- `<app-directory>/**/*.{test,spec}.?(c|m)[jt]s?(x)` for a root `app` package;
- `<test-directory>/**/*.{test,spec}.?(c|m)[jt]s?(x)` when it is not already
  contained by the first pattern.

It extends `configDefaults.exclude` with `.worktrees`, `.frontprep`, coverage,
and generated output patterns instead of replacing Vitest defaults. This makes
the application boundary explicit while still allowing colocated tests under
the application source root and centralized tests under the selected test
directory.

The repository package-test build hook receives an explicit timeout so normal
parallel load cannot fail the suite at Vitest's default hook timeout.

### Quality

Quality updates its real-install compatibility set only after testing the
currently resolved Next.js 16 ESLint graph. The generated config follows the
official flat-config ordering:

1. Next.js Core Web Vitals;
2. Next.js TypeScript;
3. `eslint-config-prettier/flat`;
4. named global ignores.

The package-local config supplies `settings.next.rootDir: '.'` in a final
matching config object, making the selected Next.js root explicit in both
standalone and workspace packages. The owned lint scripts use
`--max-warnings=0`, and verification requires those exact commands. Acceptance
creates a warning-producing fixture to prove that warnings fail and a
canonical fixture to prove normal generated output has no warnings.

### Git Hooks

Standalone behavior remains unchanged. In a nested package:

- package-local Husky hook files remain under `<packageRoot>/.husky`;
- the prepare command changes to the repository root and invokes Husky for the
  package-relative hook directory;
- the expected Git `core.hooksPath` becomes
  `<packageDirectory>/.husky/_`;
- hook bodies change to the selected package before running package-local
  `lint-staged` and `commitlint` commands;
- configuration and dependencies remain in the selected package.

Only normalized, statically rendered relative paths appear in shell commands.
Repository or package directories containing newlines or shell metacharacters
that cannot be represented safely are rejected rather than interpolated.

### CI

The managed workflow moves to repository scope. A standalone project retains
`.github/workflows/ci.yml`. A workspace target uses a deterministic path based
on a collision-resistant encoded package directory, for example
`.github/workflows/frontprep-apps-web.yml`.

The workspace workflow:

- caches the repository-root `pnpm-lock.yaml`;
- installs from `workspaceRoot` with `--frozen-lockfile`;
- runs the selected package's `frontprep:check` through a directory filter with
  `--fail-if-no-match`;
- includes package, lockfile, workspace declaration, and workflow path filters;
- keeps pinned actions, minimal permissions, concurrency, timeout, and
  `HUSKY=0` behavior.

## Diagnostics and Reporting

Detection reports the chosen package and paths before planning:

```text
Detected Next.js App Router package: apps/web
  app: src/app
  stylesheet: src/styles/global.css (alias @/styles/global.css)
  utilities: src/shared/lib (manifest)
  tests: src/test (option)
```

Each path carries a source of `option`, `manifest`, `detected`, or `default`.
Errors include the existing phase, module, path, and recovery fields plus the
stable error code. Ambiguity errors name the competing values and the relevant
flag. Workspace errors name the target package and workspace file. Process
failures continue to expose the underlying command output.

`--json` and an interactive wizard are not included in beta.1.

## Verification and Error Handling

The command flow remains:

1. detect roots and package;
2. load and migrate the manifest in memory;
3. resolve the project layout;
4. assert repository Git safety;
5. analyze every module read-only;
6. aggregate intents and detect scoped conflicts;
7. back up every target in both scopes;
8. apply atomic file operations;
9. run one filtered pnpm install when dependencies changed;
10. activate Git Hooks;
11. refresh detection and verify modules;
12. run the selected package's full check;
13. write manifest v2 last;
14. roll back both scopes and Git configuration on any failure.

`check` performs steps 1 through 4 and structural/module/project verification
without planning, migration writes, dependency installation, hook activation,
or file changes.

## Test Strategy

All behavior changes use red-green-refactor tests. Tests cover:

- manifest-v2 schema validation, canonical serialization, scoped files, and
  v1 migration success and ambiguity failures;
- standalone and workspace root detection, package membership, root-relative
  safety, and unsupported workspace layouts;
- exact and wildcard aliases, `baseUrl`, relative CSS, unresolved aliases,
  multiple targets, comments, imports outside the package, and explicit
  stylesheet agreement;
- CLI option parsing, unsafe values, first-run priority, manifest authority,
  and rerun mismatch behavior;
- `src/shared/lib` and arbitrary explicit utility/test directories without
  candidate scans;
- scoped plan conflicts, backups, fingerprints, lockfile changes, rollback,
  and dirty Git authorization;
- application-only Vitest include/exclude rendering plus real tests showing
  application tests run and fixture/worktree tests do not;
- generated ESLint with zero warnings and `--max-warnings=0` enforcement;
- standalone and nested Husky activation with real offline commits;
- standalone and workspace GitHub Actions rendering and static security checks;
- full init, idempotent rerun, read-only check, forced verification failure,
  and rollback in both project shapes;
- packed CLI smoke verification containing both schema files.

Real dependency compatibility gates run on Node.js 22.22.1 with pnpm 10.22.0.
The final release gate includes lint, formatting, typecheck, build, the complete
unit suite, package verification, all module acceptance suites, and a temporary
workspace consumer acceptance project.

## Delivery Sequence

Every branch starts from the latest merged `develop`. Each branch commits its
design document before tests and implementation, opens as a draft PR, passes
verification and review, becomes ready, and merges before the next branch.

1. `feat/project-layout-v2`
   - this complete design;
   - manifest v2 and v1 migration;
   - path options, layout resolution, and alias stylesheet detection;
   - Tailwind and Test consumption of resolved paths.
2. `feat/workspace-target`
   - root separation and scoped paths;
   - filtered installation, Git safety, transaction, Git Hooks, and CI.
3. `fix/test-discovery`
   - application-only Vitest collection;
   - stable package-test hook timeout.
4. `fix/quality-eslint`
   - zero-warning ESLint contract and tested dependency compatibility.
5. `chore/beta-1-release`
   - documentation, changelog, version, packed consumer verification, and
     `0.1.0-beta.1` release preparation.

Module-specific branches add or update only their focused module design and
reference this document. Publishing and tagging require a separate explicit
release approval after all pull requests are merged.

## Success Criteria

- A clean standalone app using `src/shared/lib` initializes and reruns without
  changing its selected paths.
- A layout importing `@/styles/global.css` is resolved and preserved.
- An ambiguous layout can be configured with `--stylesheet` and persists that
  decision in manifest v2.
- `frontprep init --cwd apps/web` configures only that declared pnpm workspace
  package while safely managing the shared lockfile, hooks, and CI workflow.
- Generated Vitest ignores non-application test fixtures and still executes
  colocated and selected centralized tests.
- Generated ESLint finishes canonical fixtures with zero warnings and rejects
  any warning through its owned script.
- A valid beta.0 manifest migrates transactionally to v2.
- Every failure before manifest commit restores package files, repository
  files, the lockfile, Git hook configuration, and the original manifest.
- A second `init` is byte-for-byte idempotent and `check` performs no writes.

## References

- [Next.js ESLint configuration](https://nextjs.org/docs/app/api-reference/config/eslint)
- [TypeScript `paths`](https://www.typescriptlang.org/tsconfig/paths.html)
- [TypeScript `baseUrl`](https://www.typescriptlang.org/tsconfig/baseUrl.html)
- [Vitest configuration](https://vitest.dev/config/)
- [Vitest test discovery](https://vitest.dev/guide/learn/writing-tests)
- [pnpm filtering](https://pnpm.io/filtering)
- [Husky project outside the Git root](https://typicode.github.io/husky/how-to.html#project-not-in-git-root-directory)
- [GitHub Actions working directories](https://docs.github.com/en/actions/how-tos/write-workflows/choose-what-workflows-do/set-default-values-for-jobs)
