# frontprep

`@mingyeongbin/frontprep` is an opinionated CLI that applies and verifies a
complete frontend tooling baseline. It is developed independently from any
consumer application.

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

For an explicit project root:

```text
frontprep init --cwd <project>
frontprep check --cwd <project>
pnpm run frontprep:check
```

`init` requires a clean Git worktree on first use. It analyzes all registered
modules, builds one aggregate plan, applies it transactionally, runs one pnpm
installation when dependencies change, verifies the project, and writes
`.frontprep.json` last. `check` is read-only and validates the recorded setup
before running the generated project check command.

The production CLI registers the complete v1 module set in fixed order:
Quality, Tailwind, Test, Git Hooks, and CI. Together they generate deterministic
quality scripts, Tailwind foundations, Vitest, local commit hooks, the Next.js
production build, and a least-privilege GitHub Actions workflow.

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
