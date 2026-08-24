# frontprep

`@mingyeongbin/frontprep` is an opinionated CLI that applies and verifies a
complete frontend tooling baseline. It is developed independently from any
consumer application.

The current release is `0.1.0-beta.0`. Install it in the project you want to
configure, then run the local binary:

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

Workspaces, the Pages Router, JavaScript-only projects, and package managers
other than pnpm are outside the v1 scope.

## Commands

```text
frontprep init [--cwd <path>]
frontprep check [--cwd <path>]
frontprep --help
frontprep --version
```

For an explicit project root from another directory:

```sh
pnpm exec frontprep init --cwd <project>
pnpm exec frontprep check --cwd <project>
```

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
