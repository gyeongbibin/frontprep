# Node.js 22 Baseline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move every active Frontprep runtime and acceptance contract from Node.js 20.9 to the maintained Node.js 22.22.1 floor before the beta release.

**Architecture:** Package metadata and the production build declare the new floor, while existing exact-floor acceptance harnesses resolve the official npm `node@22.22.1` binary and execute real generated or packed artifacts. The migration leaves module behavior and dependency majors unchanged except for aligning repository Node type definitions.

**Tech Stack:** Node.js 22.22.1, TypeScript 5.9, pnpm 10, tsup 8, Vitest 4, npm package acceptance.

**Spec:** `docs/superpowers/specs/2026-08-24-node22-baseline-design.md`

## Global Constraints

- Node.js `>=22.22.1` is the single v1 runtime floor.
- pnpm remains major version 10.
- Fast `pnpm check` tests do not download runtime or consumer packages.
- Exact-floor package and Test checks remain explicit `verify:*` commands.
- Test module generated configuration and dependency ranges do not change.
- Git Hooks implementation remains outside this branch.

---

### Task 1: Package and build runtime contract

**Files:**

- Modify: `tests/package.test.ts`
- Modify: `package.json`
- Modify: `pnpm-lock.yaml`
- Modify: `tsup.config.ts`

**Interfaces:**

- Consumes: package metadata read by `tests/package.test.ts` and tsup's `target` option.
- Produces: `engines.node = ">=22.22.1"`, `@types/node = "^22.20.0"`, and a `node22` production bundle target.

- [x] **Step 1: Write the failing package metadata test**

Extend the local `PackageJson` projection and assertions:

```ts
interface PackageJson {
  bin: Record<string, string>
  devDependencies: Record<string, string>
  engines: { node: string }
  files: string[]
  name: string
  scripts: Record<string, string>
}

expect(packageJson.engines.node).toBe('>=22.22.1')
expect(packageJson.devDependencies['@types/node']).toBe('^22.20.0')
```

- [x] **Step 2: Run the focused test and confirm the old floor fails**

Run: `pnpm exec vitest run tests/package.test.ts`

Expected: FAIL because the current metadata contains `>=20.9.0` and
`^20.19.43`.

- [x] **Step 3: Update metadata, lockfile, and bundle target**

Change `package.json` to:

```json
{
  "engines": { "node": ">=22.22.1" },
  "devDependencies": { "@types/node": "^22.20.0" }
}
```

Change the tsup option to:

```ts
target: 'node22'
```

Run `pnpm install` to update only the lockfile and installed Node types.

- [x] **Step 4: Run focused metadata and build verification**

Run: `pnpm exec vitest run tests/package.test.ts && pnpm typecheck && pnpm build`

Expected: all commands exit `0`; tsup reports target `node22`.

---

### Task 2: Exact-floor Test module acceptance

**Files:**

- Modify: `tests/acceptance/test-module.acceptance.ts`
- Modify: `docs/modules/test.md`
- Modify: `docs/superpowers/plans/2026-08-23-test-module.md`

**Interfaces:**

- Consumes: the existing `pnpm verify:test-compatibility` harness.
- Produces: a real install and generated Vitest run under exactly Node.js `v22.22.1`.

- [x] **Step 1: Change only the acceptance assertion to the new floor**

Keep the bootstrap package unchanged and change:

```ts
expect(nodeVersion.trim()).toBe('v22.22.1')
```

- [x] **Step 2: Run acceptance and confirm it still resolves Node 20**

Run: `pnpm verify:test-compatibility`

Expected: FAIL with received version `v20.9.0`, proving the assertion catches
the old bootstrap runtime before the dependency installation runs.

- [x] **Step 3: Move the bootstrap helper to Node 22.22.1**

Rename `node20Executable` to `minimumNodeExecutable`, request
`node@22.22.1`, rename `node20` and `node20Environment` variables to
`minimumNode` and `minimumNodeEnvironment`, and keep the PATH-prepend install
mechanism unchanged.

- [x] **Step 4: Run the real compatibility fixture**

Run: `pnpm verify:test-compatibility`

Expected: one acceptance test passes after a real pnpm install and generated
Vitest/RTL/jest-dom run under `v22.22.1`.

- [x] **Step 5: Correct Test module compatibility prose**

Replace Node 20 pinning rationale with: the existing Vite 6, React plugin 4,
jsdom 26, and jest-dom ranges are the tested v1 set and all support the new
Node 22.22.1 floor. Update acceptance command descriptions and observed
version text without changing generated dependency ranges.

---

### Task 3: Packed CLI exact-floor acceptance

**Files:**

- Modify: `tests/package.test.ts`
- Modify: `package.json`

**Interfaces:**

- Consumes: `scripts/verify-package.mjs` and the npm `node` binary package.
- Produces: `pnpm verify:package` that executes the packed CLI smoke under Node.js 22.22.1.

- [x] **Step 1: Write the failing script-contract assertion**

Add this literal metadata assertion:

```ts
expect(packageJson.scripts['verify:package']).toBe(
  'pnpm build && pnpm --silent dlx --package=node@22.22.1 node scripts/verify-package.mjs',
)
```

- [x] **Step 2: Run the focused test and confirm the old script fails**

Run: `pnpm exec vitest run tests/package.test.ts`

Expected: FAIL because `verify:package` still uses the ambient `node` binary.

- [x] **Step 3: Update the package script**

Set the script to the exact string asserted above. Do not change
`scripts/verify-package.mjs`; its spawned packed executable inherits the
Node-22-first PATH supplied by pnpm dlx.

- [x] **Step 4: Run packaged acceptance**

Run: `pnpm verify:package`

Expected: build succeeds and stdout contains `frontprep package verified`.

---

### Task 4: Active documentation and contract consistency

**Files:**

- Modify: `README.md`
- Modify: `docs/modules/cli-core.md`
- Modify: `docs/modules/test.md`
- Modify: `docs/superpowers/specs/2026-08-22-frontprep-v1-design.md`
- Modify: `docs/superpowers/plans/2026-08-22-cli-core.md`
- Modify: `docs/superpowers/plans/2026-08-23-test-module.md`

**Interfaces:**

- Consumes: the approved Node 22 baseline spec and verified commands from Tasks 1-3.
- Produces: one non-contradictory v1 support statement across active docs.

- [x] **Step 1: Replace active Node 20.9 runtime statements**

Use `Node.js 22.22.1 or newer`, `Node.js 22.22.1+`, or `>=22.22.1` according
to the surrounding prose or code shape. Update the CLI-core dependency plan to
`@types/node@^22.20.0`; the later Quality compatibility decision supersedes
its ESLint range with `eslint@^9.39.0` and `@eslint/js@^9.39.0`.

- [x] **Step 2: Rewrite compatibility rationale rather than blind replacement**

Remove claims that Test dependencies are pinned specifically to retain Node
20.9. State that they remain the tested v1 compatibility set and satisfy Node
22.22.1. Preserve links and generated config contracts.

- [x] **Step 3: Scan for stale runtime claims and format docs**

Run:

```bash
rg -n "Node(?:\\.js)? 20\\.9|node@20\\.9\\.0|v20\\.9\\.0|>=20\\.9\\.0|node20" README.md docs package.json tests src tsup.config.ts
pnpm exec prettier --check README.md docs package.json tests/acceptance/test-module.acceptance.ts tsup.config.ts
```

Expected: the first command returns no active stale matches; Prettier exits
`0`.

---

### Task 5: Completion, review, and delivery

**Files:**

- Modify only files required by verified review findings.

**Interfaces:**

- Consumes: the complete diff from `origin/develop` and both exact-floor acceptance commands.
- Produces: a reviewed PR merged into `develop`, ready for Git Hooks rebase.

- [x] **Step 1: Run fresh verification**

Run:

```bash
pnpm check
pnpm verify:package
pnpm verify:test-compatibility
git diff --check origin/develop...HEAD
git status --short
```

Expected: all checks pass, the exact-floor acceptances report success, and no
uncommitted implementation files remain after commit.

- [x] **Step 2: Commit implementation**

```bash
git add README.md docs package.json pnpm-lock.yaml tsup.config.ts tests
git commit -m "chore: require Node 22 runtime"
```

- [x] **Step 3: Push and open a draft PR**

Push `chore/node22-baseline`, create a draft PR to `develop`, and include the
Node 20 EOL evidence, dependency-engine rationale, exact test counts, and both
acceptance results.

- [x] **Step 4: Request independent review**

Review package metadata, build target, stale documentation, exact Node binary
selection, and whether spawned packed/test processes inherit the intended
PATH. Fix every Critical or Important finding through a failing test first.

- [ ] **Step 5: Mark ready and merge**

After a fresh full verification and approved review, mark the PR ready, merge
it with a merge commit, fast-forward local `develop`, and confirm the branch
head is an ancestor of `origin/develop`.
