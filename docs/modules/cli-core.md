# CLI Core Design

## Role

The CLI core turns five independent module descriptions into one safe, deterministic project change. It owns command parsing, project detection, planning, conflicts, filesystem mutation, pnpm execution, rollback, verification orchestration, reporting, and the manifest.

The core does not contain ESLint, Tailwind, Vitest, Git hook, or GitHub Actions policy. Those decisions belong to modules and are expressed through the common intent types defined by the [Frontprep v1 design](../superpowers/specs/2026-08-22-frontprep-v1-design.md).

## Source Boundaries

```text
src/
├── cli.ts                         executable entry and top-level error mapping
├── commands/
│   ├── init.ts                    init orchestration
│   └── check.ts                   read-only verification orchestration
├── core/
│   ├── errors.ts                  typed user-facing failures and exit codes
│   ├── context.ts                 immutable ProjectContext construction
│   ├── project-detector.ts        package, Git, framework, and workspace checks
│   ├── git-guard.ts               first-run and managed-rerun safety rules
│   ├── intents.ts                 closed ChangeIntent union
│   ├── plan-builder.ts            intent aggregation and deterministic ordering
│   ├── conflict-detector.ts       dependency, script, path, and ownership checks
│   ├── composers/
│   │   └── prettier.ts             typed shared-config fragment renderer
│   ├── filesystem.ts              normalized reads and atomic writes
│   ├── transaction.ts             backup, apply, restore, and cleanup
│   ├── package-manager.ts         pnpm version check and child processes
│   ├── manifest.ts                schema validation, hashing, and serialization
│   ├── verifier.ts                module and full-project verification
│   └── reporter.ts                stable human-readable status output
├── adapters/
│   └── next-app.ts                app root, layout, stylesheet, and source paths
├── modules/
│   ├── registry.ts                fixed v1 module order
│   └── types.ts                   SetupModule and verification contracts
└── schemas/
    └── manifest-v1.json           published JSON Schema
```

Files remain focused on one responsibility. The command files coordinate services but do not implement filesystem or module policy.

## Command Parsing

The executable is an ESM Node.js program with a `#!/usr/bin/env node` header. It accepts `init`, `check`, `--help`, `--version`, and an optional `--cwd` for both commands. Unknown commands, extra positional arguments, missing option values, and nonexistent directories are usage errors with exit code `2`.

The top-level entry catches only typed frontprep errors for concise output. Unexpected errors retain a stack trace when `DEBUG=frontprep` is set and otherwise print an incident identifier plus the underlying message.

## Detection Pipeline

`detectProject(cwd)` returns `ProjectContext` or throws a typed unsupported-project error. Detection runs in this order so the most actionable error is reported first:

1. Resolve and realpath the requested directory.
2. Confirm `package.json` exists and parse it as JSON.
3. Resolve the Git top level and require it to equal the package root.
4. Parse and validate `packageManager` as pnpm 10.
5. validate Next.js 16 and TypeScript 5 declarations.
6. Reject package workspaces and non-empty workspace package globs.
7. Invoke the Next App Router adapter.
8. Load and validate `.frontprep.json` when present.
9. Apply the Git safety policy.

The adapter requires exactly one root layout among `app/layout.{ts,tsx}` and `src/app/layout.{ts,tsx}`. It recognizes static relative CSS imports in that layout. One imported global stylesheet is selected; no import selects a sibling `globals.css`; multiple candidates produce an ambiguity error.

The detector never walks outside the resolved root and rejects paths whose realpath escapes through a symlink.

## Intent Model

The core exposes constructors rather than allowing modules to create unchecked objects:

```ts
dependencyIntent(moduleId, section, name, range, reason)
scriptIntent(moduleId, name, command, policy, reason)
managedFileIntent(moduleId, path, content, mode, reason)
configFragmentIntent(moduleId, composer, values, reason)
lineSetIntent(moduleId, path, lines, reason)
cssImportIntent(moduleId, path, importValue, reason)
staticImportIntent(moduleId, path, importValue, reason)
executableFileIntent(moduleId, path, content, reason)
```

All path-bearing constructors validate root-relative POSIX paths. Absolute paths, `..` segments, NUL bytes, and writes through symlinks are rejected. Config fragments use a closed composer identifier and composer-specific validated values; v1 includes the Prettier composer used by Quality and Tailwind.

The plan builder sorts intents by target path, intent kind, and module order. This makes generated output, diagnostics, tests, and manifest serialization deterministic.

## Conflict Detection

Conflict detection operates on the complete aggregated plan and current filesystem snapshot.

It rejects:

- incompatible dependency ranges for the same package;
- different commands for the same frontprep-owned script;
- whole-file and partial-file intents targeting the same file, except fragments consumed by the declared composer;
- different complete contents for the same managed path;
- a write whose parent or target resolves outside the project;
- a user-modified managed file;
- an unrecognized pre-existing configuration at a module-owned canonical path;
- an executable hook path already owned by unrelated user content.

Equivalent duplicate intents collapse into one change and retain every contributing module in diagnostics.

Planning returns both the final file operations and a summary grouped by module. A plan is empty only when no file bytes, modes, dependency declarations, or scripts need to change.

## Git Guard

The core obtains porcelain v1 status with NUL delimiters so filenames are parsed without quoting ambiguity.

Without a manifest, any dirty path blocks `init`.

With a manifest, dirty state is allowed only for the immediate idempotency case. Each dirty path must be present in `files`, and each current hash must equal its manifest hash. The manifest path itself is allowed only when its bytes equal canonical serialization. Deleted files, renamed files, submodule changes, conflicted entries, and additional untracked files always block execution.

`check` is read-only but uses the same guard. A clean committed project is always eligible for analysis even when user commits have changed a previously managed file; ownership validation then reports the exact managed-file drift without overwriting it.

## Transaction Algorithm

`applyPlan` performs these phases:

1. Revalidate that Git status and all source-file hashes still equal the planning snapshot.
2. Create a private temporary backup directory with owner-only permissions.
3. Copy existing target files, file modes, `package.json`, and `pnpm-lock.yaml` into the backup map.
4. Render the final `package.json` in memory.
5. Write planned files atomically and apply executable modes.
6. Run `pnpm install --ignore-scripts` once when dependency declarations
   changed, so unrelated consumer lifecycle scripts cannot escape rollback.
   Then rebuild the fixed trusted dependency allowlist (`esbuild` in v1).
7. Run module verifiers in registry order.
8. Run `pnpm run frontprep:check`.
9. Compute final hashes and ownership metadata for every changed file.
10. Atomically write `.frontprep.json`.
11. Remove the backup directory.

On failure in phases 5 through 10, restoration runs in reverse target order. Existing files and modes are restored, newly created paths are removed when empty, and the previous manifest is restored. Restoration failures are accumulated and reported alongside the original failure; the core does not hide the first cause.

The transaction records whether dependency declarations changed. An empty idempotent plan never calls pnpm.

## Manifest Service

The manifest service validates input against the bundled JSON Schema before trusting paths or hashes. It rejects unknown schema versions and newer frontprep versions with an instruction to upgrade the CLI.

Serialization uses two-space indentation, LF line endings, a final newline, fixed top-level key order, sorted module keys, sorted paths, and sorted script keys. Hashes use SHA-256 over exact file bytes.

`.frontprep.json` records the manifest itself only through its schema and version; it does not include its own hash.

## Process Execution

The package-manager service executes only these fixed programs:

- `git` for root and status inspection.
- `pnpm --version` for runtime compatibility.
- `pnpm install --ignore-scripts` after a dependency-plan change.
- `pnpm rebuild esbuild` for the v1 trusted build-dependency allowlist.
- `pnpm run frontprep:check` for final verification.

Commands use `spawn` with `shell: false`, an explicit working directory,
inherited standard input only when required, and captured output for
diagnostics. On POSIX, each child starts in its own process group so an abort
terminates pnpm and its descendants. SIGINT and SIGTERM are translated to an
abort signal, forwarded through command services, and kept under frontprep's
control until transaction restoration finishes.

## Verification

Core structural verification checks:

- the manifest parses and matches the running schema;
- every module and module version is present;
- each managed file exists with the recorded hash and mode;
- each managed script has the recorded command;
- the adapter still detects the recorded app and stylesheet paths;
- declared dependencies remain compatible;
- no configuration conflict has appeared.

`init` calls structural verification internally before running the project check. `check` reports all structural failures in one pass, skips the project command when structure is invalid, and returns exit code `1`.

## Reporter Contract

Normal output is concise and deterministic:

```text
frontprep 0.1.0-beta.0
✓ Detected Next.js App Router with pnpm
✓ quality
✓ tailwind
✓ test
✓ git-hooks
✓ ci
✓ Project verification passed
```

An idempotent rerun additionally prints:

```text
✓ All modules are already applied
✓ No files changed
```

Errors identify the phase, module when applicable, target path, reason, and a concrete recovery action. Terminal color is disabled when `NO_COLOR` is set or output is not a TTY.

## Core Test Matrix

Unit tests cover:

- every detection rejection and both App Router roots;
- static stylesheet selection and ambiguity;
- every intent-constructor path restriction;
- duplicate intent collapse and all conflict classes;
- deterministic plan ordering;
- first-run dirty rejection;
- manifest-authorized dirty rerun acceptance;
- manifest drift rejection;
- atomic write and file-mode preservation;
- rollback after write, install, module verification, and project-check failures;
- deterministic manifest serialization and hashing;
- child-process success, failure, signal, and argument handling;
- CLI parsing, output, and exit codes.

Fixture tests initialize temporary Git repositories and commit their baseline before executing `init`. Core fixtures use fake modules and a fake package-manager service so core behavior is tested without depending on feature-module implementation or the network.

Package acceptance compiles and installs the executable, runs the public `bin`,
and verifies help, version, unsupported-project, and uninitialized-project
diagnostics. CI acceptance separately packs and installs the same public
package, then drives that installed five-module CLI through a real Next.js
application under Node.js 22.22.1. It never invokes the repository's
`dist/cli.js` directly.

## Delivery and Package Acceptance

The package is published as `@mingyeongbin/frontprep` with the `frontprep`
binary and declares Node.js `>=22.22.1`; the production bundle targets
`node22`. The public `init` and `check` commands use all five v1 modules in
fixed order while explicit registries remain injectable for focused tests.

Each module branch starts from the latest merged `develop`, commits its module
design before implementation and tests, opens as a draft PR, passes complete
verification, becomes ready for review, and merges back into `develop` before
the next module branch begins.

`pnpm verify:package` runs under the exact minimum Node.js `v22.22.1`, builds a
non-splitting ESM executable, creates the real npm tarball, checks its exact
file list, installs it into an isolated npm prefix, verifies the public bin
metadata, executable mode, and Node shebang, and smoke-tests help, version,
unsupported-project, and core-only supported-project diagnostics through
`node_modules/.bin/frontprep`.

`pnpm verify:ci-compatibility` repeats the pack and isolated installation at
the complete product boundary. It invokes the installed `dist/cli.js` for the
five-module `init`, idempotent rerun, and `check`, while the generated project
executes its real quality, test, and production-build pipeline.

Consumer-specific repository paths are never part of the package or core
tests.
