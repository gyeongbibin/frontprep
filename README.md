# frontprep

`@mingyeongbin/frontprep` is an opinionated CLI that applies and verifies a
complete frontend tooling baseline. It is developed independently from any
consumer application.

The current public release is available on the `beta` tag. Run it directly in
the project you want to configure:

```sh
pnpm dlx @mingyeongbin/frontprep@beta init --cwd .
pnpm dlx @mingyeongbin/frontprep@beta check --cwd .
```

Or install it as a project development dependency:

```sh
pnpm add --save-dev @mingyeongbin/frontprep@beta
pnpm exec frontprep init --cwd .
pnpm exec frontprep check --cwd .
```

The first `init` requires a clean Git worktree so every change can be reviewed
or rolled back safely. Commit or stash existing work before running it.

## Version 1 support

- Node.js 22.22.1 or newer
- Next.js 16 App Router with TypeScript 5
- pnpm 10 declared in `packageManager`
- one application at the Git repository root
- either `app/` or `src/app/`

All-package workspace initialization, the Pages Router, JavaScript-only
projects, and package managers other than pnpm are outside the v1 scope.

One explicit Next.js package in a pnpm workspace is supported by pointing
`--cwd` at its package directory:

```sh
pnpm dlx @mingyeongbin/frontprep@beta init --cwd apps/web
pnpm dlx @mingyeongbin/frontprep@beta check --cwd apps/web
```

The repository root must own `pnpm-workspace.yaml`, the pnpm 10 declaration,
and the shared lockfile. Frontprep configures only the selected package while
placing its workflow at the repository root. Beta support is limited to one
managed package per repository.

## Commands

```text
frontprep init [--cwd <path>] [--stylesheet <path>] [--utility-dir <path>] [--test-dir <path>]
frontprep check [--cwd <path>]
frontprep --help
frontprep --version
```

For an explicit project root from another directory:

```sh
pnpm exec frontprep init --cwd <project>
pnpm exec frontprep check --cwd <project>
```

For a `src/app` project, Frontprep defaults to `src/app/globals.css`,
`src/shared/lib`, and `src/test`. Root `app` projects default to
`app/globals.css`, `shared/lib`, and `test`. An existing static stylesheet
import wins over the stylesheet default, including TypeScript path aliases.

Override paths explicitly when a project uses another convention:

```sh
pnpm dlx @mingyeongbin/frontprep@beta init --cwd . \
  --stylesheet src/styles/global.css \
  --utility-dir src/domain/ui/lib \
  --test-dir tests/unit
```

Path priority is explicit option, existing `.frontprep.json`, detected
stylesheet import, then default. Frontprep stops when these sources disagree
instead of silently moving an existing setup. The selected paths and their
source are printed before planning.

`init` requires a clean Git worktree on first use. It analyzes all registered
modules, builds one aggregate plan, applies it transactionally, runs one pnpm
installation when dependencies change, verifies the project, and writes
`.frontprep.json` last. `check` is read-only and validates the recorded setup
before running the generated project check command.

After initialization, the generated project-wide verification is also
available directly:

```sh
pnpm run frontprep:check
```

Running `init` again is idempotent when the managed setup has not drifted.
Beta.0 manifests are read and upgraded transactionally to schema v2; `check`
reports the available migration without modifying files.

The production CLI registers the complete v1 module set in fixed order:
Quality, Tailwind, Test, Git Hooks, and CI. Together they generate deterministic
quality scripts, Tailwind foundations, Vitest, local commit hooks, the Next.js
production build, and a least-privilege GitHub Actions workflow.

Frontprep stops on user-owned configuration at its canonical paths instead of
silently overwriting or merging it. Review the reported conflict and choose
which configuration should own that concern.

## Development

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm verify:package
pnpm verify:quality-compatibility
pnpm verify:test-compatibility
pnpm verify:git-hooks-compatibility
pnpm verify:ci-compatibility
```

`verify:package` creates the actual npm tarball, installs it into an isolated
npm prefix, and smoke-tests the public `frontprep` bin. The compatibility
commands exercise generated consumer projects; CI runs the full five-module
public CLI under the exact minimum Node.js version.
