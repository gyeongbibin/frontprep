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

`init` requires a clean Git worktree on first use. It analyzes all registered
modules, builds one aggregate plan, applies it transactionally, runs one pnpm
installation when dependencies change, verifies the project, and writes
`.frontprep.json` last. `check` is read-only and validates the recorded setup
before running the generated project check command.

The `init/cli-core` branch contains the reusable engine and intentionally has
no feature modules registered yet. Quality, Tailwind, test, Git-hooks, and CI
modules are delivered through separate design-first pull requests based on the
latest `develop` branch.

## Development

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm verify:package
```

`verify:package` creates the actual npm tarball, installs it into an isolated
npm prefix, and smoke-tests the public `frontprep` bin. Consumer projects
remain external acceptance targets.
