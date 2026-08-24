# Frontprep v1 Design

## Purpose

Frontprep is an independent, opinionated CLI that applies a complete frontend tooling baseline to an existing Next.js application. It is published as `@mingyeongbin/frontprep` and exposes the `frontprep` executable.

The CLI must not depend on a specific consumer repository. Consumer applications are used only after packaging as external acceptance-test targets.

## Version 1 Scope

Frontprep v1 supports projects that satisfy all of these conditions:

- Node.js 22.22.1 or newer.
- Next.js 16 with the App Router.
- TypeScript 5.
- pnpm 10 declared through the `packageManager` field.
- One Next.js application at the Git repository root.
- Either `app/` or `src/app/`, with exactly one App Router root.
- A Git worktree whose root is also the package root.

Frontprep v1 does not support Vite, the Pages Router, JavaScript-only projects, npm, Yarn, Bun, multi-package workspaces, interactive module selection, migrations, or arbitrary custom configuration rewriting. Vite support belongs in a later adapter. Versioned migrations belong to the future `frontprep update` command.

## Product Interface

The initial package version is `0.1.0-beta.0`.

```json
{
  "name": "@mingyeongbin/frontprep",
  "bin": {
    "frontprep": "dist/cli.js"
  }
}
```

The public commands are:

```text
frontprep init [--cwd <path>]
frontprep check [--cwd <path>]
frontprep --help
frontprep --version
```

`init` analyzes the project, creates one complete change plan, applies it, installs dependencies with pnpm, verifies the result, and writes `.frontprep.json`. It is non-interactive and applies every v1 module.

`check` performs no writes. It validates the manifest and module-owned configuration, then runs the generated full project verification script.

Exit codes are stable:

- `0`: configuration is valid, including an idempotent no-change `init`.
- `1`: application, dependency installation, or project verification failed.
- `2`: unsupported project, unsafe Git state, configuration conflict, or invalid command input.

## Architectural Approach

Frontprep uses a declarative module engine. Modules describe desired changes; they never write files or run commands directly. The core combines all module intents, detects conflicts before the first write, applies the plan through a transaction, installs dependencies once, and verifies every module.

```text
CLI command
  -> project detector
  -> Next App Router adapter
  -> module analysis
  -> intent aggregation
  -> conflict detection
  -> transactional file application
  -> one pnpm install
  -> module verification
  -> full project verification
  -> manifest write
```

The fixed v1 module order is:

1. `quality`
2. `tailwind`
3. `test`
4. `git-hooks`
5. `ci`

The order is deterministic for output and diagnostics. Dependencies and file intents are still aggregated before any change is applied.

## Core Contracts

```ts
export type ModuleId = 'quality' | 'tailwind' | 'test' | 'git-hooks' | 'ci'

export interface SetupModule<TAnalysis = unknown> {
  readonly id: ModuleId
  readonly version: string
  analyze(context: ProjectContext): Promise<TAnalysis>
  plan(
    context: ProjectContext,
    analysis: TAnalysis,
  ): Promise<readonly ChangeIntent[]>
  verify(context: ProjectContext): Promise<VerificationResult>
}

export interface ProjectContext {
  readonly root: string
  readonly packageJsonPath: string
  readonly packageJson: PackageJson
  readonly adapter: 'next-app'
  readonly appDirectory: string
  readonly sourceDirectory: string | null
  readonly layoutPath: string
  readonly stylesheetPath: string
  readonly packageManager: {
    readonly name: 'pnpm'
    readonly version: string
  }
  readonly manifest: FrontprepManifest | null
}
```

Change intents are a closed union owned by the core:

- `dependency`: add a compatible runtime or development dependency.
- `script`: add a package script using an explicit conflict policy.
- `managed-file`: create or update a complete frontprep-owned file.
- `config-fragment`: contribute typed values to a core-rendered shared configuration.
- `line-set`: add unique lines to a line-oriented file.
- `css-import`: ensure one CSS import appears in the detected stylesheet.
- `static-import`: ensure one relative static import appears in a detected source file.
- `executable-file`: create a managed file and record executable mode.

Every intent contains its module owner and a human-readable reason. The planner rejects two incompatible intents for the same dependency, script, file, or file mode.

## Project Detection

Detection is based on project characteristics rather than repository names or consumer-specific paths.

The detector must establish all of the following without modifying the project:

1. `--cwd`, or the process working directory when omitted, resolves to an existing directory.
2. The directory is the Git worktree root.
3. A parseable `package.json` and `tsconfig.json` exist at that root.
4. `package.json.packageManager` is `pnpm@10.x`.
5. `next` is a direct dependency whose complete declared range is contained
   within major version 16.
6. TypeScript is a direct dependency or development dependency whose complete
   declared range is contained within major version 5.
7. Exactly one of `app/` and `src/app/` contains an App Router root layout.
8. A package-level workspace declaration does not identify additional packages.
9. A `pnpm-workspace.yaml`, when present, does not declare additional workspace package globs.

The adapter selects the source directory from the detected App Router root. It detects the stylesheet imported by the root layout. If no local global stylesheet is imported, it selects `globals.css` beside the layout and plans both the file and a static import. Multiple ambiguous global stylesheet imports are a conflict.

Frontprep never imports or executes a consumer's JavaScript configuration during analysis. JSON and YAML are parsed as data; JavaScript, TypeScript, CSS, and shell files are inspected as text.

## Change Planning and Ownership

The core builds the entire plan in memory before applying it.

Package dependency rules:

- Frontprep releases carry a tested dependency compatibility table.
- Existing compatible dependency declarations are preserved, including their original version range.
- A dependency in the opposite package section is preserved when its installed role remains valid.
- Existing incompatible major versions produce a conflict; frontprep does not silently upgrade them.
- New declarations are written to `package.json`, after which a single
  `pnpm install --ignore-scripts` updates the lockfile and installation without
  running unrelated consumer lifecycle scripts. Frontprep then explicitly
  rebuilds only its fixed trusted build-dependency allowlist (`esbuild` in v1).

Package script rules:

- Frontprep always owns deterministic `frontprep:*` scripts used by its verifier and CI.
- Conventional scripts such as `lint`, `format`, `typecheck`, `test`, and `check` are added only when absent.
- Existing conventional scripts are preserved.
- A frontprep-owned script that differs from its manifest fingerprint is a conflict.
- An existing `prepare` script is preserved and has `pnpm run frontprep:prepare` appended once when Husky is not already invoked.

Managed file rules:

- A missing file can be created.
- A file whose bytes equal the planned bytes is already satisfied.
- A file recorded in the manifest can be replaced only when its current SHA-256 hash equals the recorded hash.
- A user-modified managed file is never overwritten.
- A pre-existing user-owned JavaScript configuration is preserved only when a non-executing recognizer can prove it satisfies the module. Otherwise planning stops with a conflict before any write.
- Shared generated configuration, currently Prettier, is rendered from typed module fragments. Quality supplies the base and Tailwind contributes its plugin, stylesheet, and function settings; modules never rewrite one another's complete file intent.
- Line-oriented files and CSS imports use normalized newline-aware set insertion and preserve all existing content.

All generated text files use UTF-8 and LF endings. Existing files retain their final-newline convention unless a line must be appended.

## Git Safety and Idempotency

The first `init` requires a clean Git worktree. This prevents generated changes from being mixed with unrelated user work.

After a successful uncommitted `init`, an immediate second `init` is allowed only when:

- every dirty path is recorded in `.frontprep.json`, apart from the canonical manifest file itself, and
- each current recorded file hash equals the post-application hash in the manifest, and
- there are no extra untracked or modified paths.

This exception exists solely to verify idempotency before committing. Any unrelated dirty path causes exit code `2`.

A second successful `init` must produce an empty change plan, skip dependency installation, leave every file byte-for-byte unchanged, and report that all modules are already applied.

## Transaction and Failure Handling

Before applying a non-empty plan, the core copies every existing target file and its mode into a temporary directory outside the consumer repository. It also records which planned files do not yet exist.

Application uses atomic same-directory temporary-file renames where supported.
The core then runs one `pnpm install --ignore-scripts`, verifies modules, and
runs `pnpm rebuild esbuild` for the trusted v1 build allowlist, verifies
modules, and runs the full project check. `.frontprep.json` is the last file
written.

If a write, install, or verification step fails, the core restores every planned file, its previous mode, `package.json`, and `pnpm-lock.yaml`, and deletes planned files that were newly created. It reports the failed phase and command output. Contents of ignored `node_modules` are not rolled back because pnpm owns that directory; this limitation does not leave tracked project changes.

Child processes are spawned with argument arrays and `shell: false`. Frontprep
does not interpolate consumer-controlled values into shell command strings.
SIGINT and SIGTERM abort the active process group and remain handled until the
transaction has restored files and modes.

## Manifest

`.frontprep.json` is written only after complete success.

```json
{
  "$schema": "https://unpkg.com/@mingyeongbin/frontprep/schema/manifest-v1.json",
  "schemaVersion": 1,
  "frontprepVersion": "0.1.0-beta.0",
  "adapter": "next-app",
  "packageManager": "pnpm@10.22.0",
  "paths": {
    "app": "src/app",
    "stylesheet": "src/app/globals.css"
  },
  "modules": {
    "quality": "1.0.0",
    "tailwind": "1.0.0",
    "test": "1.0.0",
    "git-hooks": "1.0.0",
    "ci": "1.0.0"
  },
  "files": {
    "eslint.config.mjs": {
      "hash": "sha256:<hex-digest>",
      "ownership": "managed",
      "mode": "0644"
    },
    "package.json": {
      "hash": "sha256:<hex-digest>",
      "ownership": "patched",
      "mode": "0644"
    }
  },
  "managedScripts": {
    "frontprep:lint": "eslint ."
  }
}
```

`managed` means frontprep owns the entire file. `patched` means frontprep owns only declared additions and must reanalyze the user's surrounding content on later clean runs. Every file changed by frontprep, including `package.json`, the pnpm lockfile, a patched layout, and a patched stylesheet, is fingerprinted.

Manifest paths are root-relative POSIX paths. The manifest contains no absolute paths, timestamps, usernames, hostnames, or secrets, so two equivalent applications produce identical tracked content. The manifest does not hash itself; the Git guard authorizes it only when its bytes equal canonical manifest serialization.

## Module Responsibilities

### Quality

Quality owns ESLint flat configuration, Prettier base configuration, `.prettierignore`, `.editorconfig`, and lint/format/typecheck scripts. It uses the Next.js Core Web Vitals and TypeScript flat configs. It preserves existing conventional scripts while providing deterministic `frontprep:*` scripts.

### Tailwind

Tailwind owns the Tailwind CSS v4 PostCSS integration, the single `@import "tailwindcss";` entry, runtime styling utilities, and Tailwind-aware Prettier contributions. It creates `shared/utils` under the detected source root and exports `cn`, `cva`, and `VariantProps`.

### Test

Test owns `vitest.config.mts`, a setup file under the detected source root, jsdom, React Testing Library, jest-dom matchers, TypeScript path resolution, and watch/run scripts. A project with no test files remains valid through Vitest's `passWithNoTests` setting.

### Git Hooks

Git Hooks owns Husky initialization, `pre-commit`, `commit-msg`, lint-staged configuration, commitlint configuration, and the prepare integration. Hook files are executable. Pre-commit runs lint-staged; commit-msg runs commitlint with the message-file argument.

### CI

CI owns `.github/workflows/ci.yml`. Pull requests and pushes to `main` or `develop` install pnpm dependencies with a frozen lockfile and run the deterministic frontprep full-check script. The workflow uses read-only contents permission, pnpm caching, concurrency cancellation, and `HUSKY=0`.

Each module feature branch adds a dedicated design document describing exact files, dependency compatibility ranges, recognized pre-existing configurations, change intents, verification rules, and tests. The module document references this architecture instead of redefining the core contracts.

## Generated Verification Scripts

Frontprep owns these scripts:

```json
{
  "frontprep:lint": "eslint .",
  "frontprep:lint:fix": "eslint . --fix",
  "frontprep:format": "prettier --write .",
  "frontprep:format:check": "prettier --check .",
  "frontprep:typecheck": "tsc --noEmit",
  "frontprep:quality": "pnpm run frontprep:lint && pnpm run frontprep:format:check && pnpm run frontprep:typecheck",
  "frontprep:test": "vitest run",
  "frontprep:build": "next build",
  "frontprep:check": "pnpm run frontprep:quality && pnpm run frontprep:test && pnpm run frontprep:build",
  "frontprep:prepare": "husky"
}
```

On a clean project, conventional pnpm aliases are also added. Existing
user-owned aliases are preserved:

```json
{
  "lint": "pnpm run frontprep:lint",
  "lint:fix": "pnpm run frontprep:lint:fix",
  "format": "pnpm run frontprep:format",
  "format:check": "pnpm run frontprep:format:check",
  "typecheck": "pnpm run frontprep:typecheck",
  "quality": "pnpm run frontprep:quality",
  "test": "vitest",
  "test:run": "vitest run",
  "check": "pnpm run frontprep:check",
  "prepare": "pnpm run frontprep:prepare"
}
```

`frontprep check` first performs structural verification and then executes `pnpm run frontprep:check`.

## Testing Strategy

Unit tests cover project detection, intent aggregation, dependency compatibility, script conflicts, file ownership, Git safety, manifest serialization, rollback, and every module analyzer and verifier.

Repository-owned fixture projects cover:

- App Router under `app/`.
- App Router under `src/app/`.
- An existing recognized configuration.
- A configuration conflict.
- A dirty first application.
- An immediate uncommitted idempotent rerun.
- npm, Yarn, and Vite rejection.
- Multi-package workspace rejection.
- Installation or verification failure rollback.

Package acceptance builds the CLI, runs `npm pack`, inspects the tarball for `dist/cli.js`, templates, schemas, and package metadata, and executes the packed binary against a temporary Git fixture. It applies the tarball twice and asserts the second run changes no file and does not run pnpm installation.

The CLI repository's `pnpm check` runs formatting, linting, type checking, unit and fixture tests, the production build, and package-content verification.

## Delivery Workflow

`develop` integrates the next release. `main` contains only npm stable releases.

Work proceeds sequentially:

1. `init/cli-core`
2. `feat/quality-module`
3. `feat/tailwind-module`
4. `feat/test-module`
5. `feat/git-hooks-module`
6. `feat/github-actions-module`

Every branch starts from the latest merged `develop`. It first commits its design document, then implementation and tests. It opens as a draft pull request, passes verification, becomes ready for review, and merges into `develop` before the next branch starts.

The `init/cli-core` pull request includes this complete v1 design once. Later module pull requests add only their module-specific design document.

After all modules merge, version `0.1.0-beta.0` is packed and tested locally. A beta registry release uses the `next` dist-tag. Stable `0.1.0` is released only after external tarball and registry acceptance, through a `develop` to `main` release pull request.

## Primary Technical References

- [Next.js ESLint configuration](https://nextjs.org/docs/app/api-reference/config/eslint)
- [Tailwind CSS v4 with Next.js](https://tailwindcss.com/docs/installation/framework-guides/nextjs)
- [Tailwind Prettier plugin](https://github.com/tailwindlabs/prettier-plugin-tailwindcss)
- [Vitest setup files](https://vitest.dev/guide/learn/setup-teardown)
- [Husky setup](https://typicode.github.io/husky/get-started.html)
- [commitlint local setup](https://commitlint.js.org/guides/local-setup.html)
- [GitHub Actions Node.js workflow](https://docs.github.com/en/actions/tutorials/build-and-test-code/nodejs)
