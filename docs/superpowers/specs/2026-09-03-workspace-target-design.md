# Workspace Target Design

## Goal

Allow one explicitly selected Next.js package inside a pnpm workspace to run
Frontprep through `--cwd apps/web`, while preserving the standalone behavior.
Frontprep does not scan and initialize every package.

This design extends the
[project model v2](./2026-09-02-project-model-v2-design.md). Package-local
configuration remains under the selected package. Git, the shared lockfile,
hooks activation, and GitHub Actions remain repository concerns.

## Supported Topology

A target is supported when:

- `--cwd` resolves to a real package directory inside the Git worktree;
- the repository root contains `pnpm-workspace.yaml`;
- the repository-root `package.json` declares `pnpm@10.x`;
- pnpm's filtered recursive package listing resolves the directory to exactly
  one workspace package;
- the selected package directly declares Next.js 16 and TypeScript 5;
- no second workspace package contains `.frontprep.json`.

For beta.1, `workspaceRoot` must equal `repositoryRoot`. Nested workspaces,
multiple managed packages, implicit package selection, and all-package mode are
rejected.

## Root Contract

`ProjectContext` keeps the compatibility `root` field as `packageRoot` and
adds a normalized `packageDirectory`:

```ts
interface ProjectRoots {
  packageRoot: string
  repositoryRoot: string
  workspaceRoot: string
  packageDirectory: ProjectPath | '.'
}
```

Package-scoped paths resolve from `packageRoot`. Repository-scoped paths
resolve from `repositoryRoot`. The workspace lockfile resolves from
`workspaceRoot`. A standalone project has equal roots and `packageDirectory`
is `.`.

Manifest v2 stores `roots.package` as the repository-relative package
directory and `roots.workspace` as `.`. A manifest whose recorded root differs
from the selected package is rejected.

## Detection

The detector first resolves `--cwd` and the Git top level. When they differ,
it validates the root workspace files and delegates membership to pnpm:

```text
pnpm --dir <repositoryRoot> \
  --filter ./<packageDirectory> \
  --fail-if-no-match \
  list --recursive --depth -1 --json
```

The command is read-only and must return exactly one package whose real path
equals `packageRoot`. Shell interpolation is not used. The package directory
must be a safe repository-relative POSIX path.

The root package manager declaration controls workspace execution. Standalone
projects retain the selected package's declaration. Framework, TypeScript,
App Router, stylesheet, utility, and test detection stay package-local.

## Scoped Planning and Transactions

The existing `package` and `repository` scopes become active:

- package files use `packageRoot`;
- repository workflows use `repositoryRoot`;
- `.frontprep.json` remains package-local;
- `pnpm-lock.yaml` is repository/workspace-scoped.

Backups, stale-plan checks, writes, fingerprints, rollback, and changed-file
reporting use the mapped root. A failure restores both roots and the original
manifest. Git status always runs from `repositoryRoot`; package manifest paths
map through `packageDirectory` before matching porcelain entries.

## Installation and Verification

Standalone installation is unchanged. Workspace dependency installation runs
at `workspaceRoot` with the directory filter and `--fail-if-no-match` so only
the selected package is targeted. The lockfile remains shared. Project checks
run in `packageRoot`.

## Git Hooks

Husky files and dependencies remain package-local. For a workspace target:

- `prepare` changes to the repository root and invokes Husky with the
  package-relative hook directory;
- `core.hooksPath` is `<packageDirectory>/.husky/_`;
- hook bodies change into the selected package before running package-local
  commands.

Only normalized paths safe for static shell rendering are accepted.

## CI

The workflow remains repository-scoped. Standalone projects keep
`.github/workflows/ci.yml`. A workspace package uses
`.github/workflows/frontprep-<encoded-package-directory>.yml`.

The workspace workflow installs from the repository root and runs:

```text
pnpm --filter ./<packageDirectory> --fail-if-no-match run frontprep:check
```

Path filters include the package directory, root lockfile,
`pnpm-workspace.yaml`, root `package.json`, and the workflow itself.

## Safety and Verification

Tests cover standalone regression, valid workspace selection, non-member and
missing workspace failures, a second managed package, root mapping, filtered
installation, repository dirty-state mapping, cross-root rollback, nested
Husky activation, workspace CI rendering, and full init/check idempotency.

The branch ships only after lint, format, typecheck, build, unit tests, package
verification, and a real temporary workspace acceptance project pass.
