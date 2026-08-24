# Git Hooks Module Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add conflict-safe Husky, lint-staged, and commitlint setup whose hooks activate inside the existing Frontprep transaction and are verified with real commits at the exact Node.js floor.

**Architecture:** The module remains declarative: it analyzes project and Git state, then emits dependency, script, managed-file, and executable-file intents. A focused core `GitHooksManager` owns repository-local `core.hooksPath` mutation; `runInit` and `applyPlan` compose its activation receipt into existing verification and rollback boundaries, including no-file reruns.

**Tech Stack:** Node.js 22.22.1, TypeScript 5.9, pnpm 10, Husky 9.1, lint-staged 17.3, commitlint 21.2, Vitest 4, Git.

**Spec:** `docs/modules/git-hooks.md`

## Global Constraints

- The module works from the detected Git/package root and never assumes `app/` or `src/app/`.
- Requested dependencies are `husky@^9.1.0`, `lint-staged@^17.3.0`, `@commitlint/cli@^21.2.0`, and `@commitlint/config-conventional@^21.2.0`.
- Managed hooks are `.husky/pre-commit` and `.husky/commit-msg` with mode `0755`; managed JavaScript configs use `.mjs` and mode `0644`.
- Module methods return declarative intents only. Only `GitHooksManager` may run Husky or mutate repository-local Git configuration.
- Activation runs after an optional `pnpm install --ignore-scripts` and before module/project verification.
- Any later failure restores the previous `core.hooksPath`; Husky-owned `.husky/_` and package-manager-owned `node_modules` remain outside tracked-file rollback.
- `frontprep check` is read-only and never repairs hooks.
- The module remains outside the default registry until CI is implemented.

---

### Task 1: Git hook activation service

**Files:**

- Create: `src/core/git-hooks.ts`
- Create: `tests/core/git-hooks.test.ts`

**Interfaces:**

- Consumes: `ProcessRunner.run(command, args, options)` and Node `lstat`.
- Produces:

```ts
export interface GitHooksActivation {
  readonly previousHooksPath: string | null
}

export interface GitHooksService {
  activate(root: string, signal?: AbortSignal): Promise<GitHooksActivation | null>
  restore(root: string, activation: GitHooksActivation): Promise<void>
}

export async function readLocalHooksPath(
  root: string,
  runner?: Pick<ProcessRunner, 'run'>,
): Promise<string | null>

export async function resolveDefaultHooksDirectory(
  root: string,
  runner?: Pick<ProcessRunner, 'run'>,
): Promise<string>

export async function hasHuskyDispatcher(root: string): Promise<boolean>

export class GitHooksManager implements GitHooksService
```

- [x] **Step 1: Write failing Git inspection tests**

Use a recording runner to assert `readLocalHooksPath` executes:

```ts
;['git', ['config', '--local', '--get', 'core.hooksPath']]
```

Return `null` only for `ProcessFailure.exitCode === 1`, trim a successful value, and propagate every other failure. Assert `resolveDefaultHooksDirectory` uses `git rev-parse --path-format=absolute --git-path hooks` and returns a trimmed absolute path. Assert a regular `.husky/_/h` is accepted while missing files, directories, and symbolic links are rejected.

- [x] **Step 2: Run the focused tests and confirm missing exports fail**

Run: `pnpm exec vitest run tests/core/git-hooks.test.ts`

Expected: FAIL because `src/core/git-hooks.ts` does not exist.

- [x] **Step 3: Implement inspection and activation**

`activate` records the local value, returns `null` only when the value is `.husky/_` and the dispatcher is a regular non-symbolic file, otherwise runs:

```ts
await runner.run('pnpm', ['run', 'frontprep:prepare'], { cwd: root, signal })
```

It then requires both `core.hooksPath === '.husky/_'` and a valid dispatcher. On activation failure it restores the recorded value before rethrowing. `restore` uses `git config --local core.hooksPath <previous>` for a previous value and `git config --local --unset-all core.hooksPath` for `null`.

- [x] **Step 4: Verify command, no-op, validation, and restoration cases**

Cover unset and existing restoration, already-active no-op, incorrect post-command path, missing dispatcher, command failure, and restoration failure. Run:

`pnpm exec vitest run tests/core/git-hooks.test.ts`

Expected: all tests PASS.

- [x] **Step 5: Commit the service**

```bash
git add src/core/git-hooks.ts tests/core/git-hooks.test.ts
git commit -m "feat: add git hooks activation service"
```

---

### Task 2: Transactional init integration

**Files:**

- Modify: `src/core/transaction.ts`
- Modify: `src/commands/init.ts`
- Modify: `tests/core/transaction.test.ts`
- Modify: `tests/commands/init.test.ts`
- Modify: module command-service fixtures in `tests/modules/tailwind.test.ts` and `tests/modules/test.test.ts`

**Interfaces:**

- Consumes: `GitHooksService` and `GitHooksActivation` from Task 1.
- Produces optional transaction inputs `activateGitHooks?: boolean` and `gitHooks?: GitHooksService`, plus required production `CommandServices.gitHooks: GitHooksService`.

- [x] **Step 1: Write failing non-empty transaction tests**

Add a recording Git Hooks service. Assert activation occurs after dependency installation but before verification and that a verification failure invokes `restore` with the returned receipt. Assert install failure never activates hooks and a non-Git-Hooks transaction never calls the service.

- [x] **Step 2: Run transaction tests and observe missing integration**

Run: `pnpm exec vitest run tests/core/transaction.test.ts`

Expected: FAIL because `TransactionServices` and `applyPlan` do not accept or call the service.

- [x] **Step 3: Integrate activation into `applyPlan`**

After the optional dependency install, execute activation only when `activateGitHooks === true`. Preserve its receipt and, in the catch path, attempt Git restoration and tracked-file restoration independently, accumulating both restoration failures into the existing `ROLLBACK_FAILED` error.

- [x] **Step 4: Write failing empty-plan command tests**

For a registry containing `git-hooks`, assert `runInit` activates before structural verification even when `plan.operations` is empty. Force project verification to fail and assert the receipt is restored. Assert registries without `git-hooks` do not activate.

- [x] **Step 5: Integrate activation into `runInit`**

`createCommandServices` constructs one `GitHooksManager`. The non-empty path forwards that service and a module-presence flag into `applyPlan`. The empty path activates, runs structural/project verification, and restores only if later verification throws. Successful empty activation remains active while the returned `TransactionResult.changed` stays `false`.

- [x] **Step 6: Run focused command and transaction verification**

Run:

```bash
pnpm exec vitest run tests/core/transaction.test.ts tests/commands/init.test.ts tests/modules/tailwind.test.ts tests/modules/test.test.ts
pnpm typecheck
```

Expected: all tests and typecheck PASS.

- [x] **Step 7: Commit orchestration**

```bash
git add src/core/transaction.ts src/commands/init.ts tests/core/transaction.test.ts tests/commands/init.test.ts tests/modules/tailwind.test.ts tests/modules/test.test.ts
git commit -m "feat: activate git hooks transactionally"
```

---

### Task 3: Declarative Git Hooks module

**Files:**

- Create: `src/modules/git-hooks.ts`
- Create: `tests/modules/git-hooks.test.ts`

**Interfaces:**

- Consumes: existing dependency, script, managed-file, and executable-file intent constructors; `readLocalHooksPath`, `resolveDefaultHooksDirectory`, and `hasHuskyDispatcher` from Task 1.
- Produces `gitHooksModule: SetupModule<GitHooksAnalysis>` with:

```ts
export interface GitHooksAnalysis {
  readonly integratePrepare: boolean
}
```

- [ ] **Step 1: Write failing plan-contract tests**

Assert four development dependency intents, canonical `frontprep:prepare`, conditional `prepare` composition, two exact `.mjs` configs at `0644`, and these executable hook contents at `0755`:

```sh
pnpm exec lint-staged
```

```sh
pnpm exec commitlint --edit "$1"
```

Cover missing `prepare`, a custom stage, every recognized direct Husky stage, duplicate recognized stages, and the false substring `echo husky`.

- [ ] **Step 2: Run the focused module test and confirm the module is absent**

Run: `pnpm exec vitest run tests/modules/git-hooks.test.ts`

Expected: FAIL because `src/modules/git-hooks.ts` does not exist.

- [ ] **Step 3: Implement constants, prepare analysis, and intent creation**

Split scripts only on the literal delimiter `&&`. Recognize exactly `husky`, `pnpm husky`, `pnpm exec husky`, and `pnpm run frontprep:prepare`. Reject more than one recognized stage; set `integratePrepare` only when none exists. Emit no filesystem or process side effects.

- [ ] **Step 4: Add failing ownership and configuration-conflict tests**

Cover canonical missing/exact/manifest-owned files; unowned differing contents; wrong modes; symlinked `.husky` or managed paths; alternate root lint-staged and commitlint configs; nested lint-staged configs and package keys; competing hook-manager dependencies, keys, and root files; conflicting `core.hooksPath`; and non-sample default Git hook files. Confirm user hooks under `.husky/` and Git `.sample` files are preserved.

- [ ] **Step 5: Implement deterministic conflict inspection**

Scan sorted paths while ignoring `.git`, `.next`, `.turbo`, `.worktrees`, `build`, `coverage`, `dist`, `node_modules`, and `out`. Do not follow symbolic links. Accept unset `core.hooksPath` or `.husky/_`; reject every other value. Return the first sorted analysis conflict as `ConflictError` with module ID `git-hooks`.

- [ ] **Step 6: Add failing aggregate verification tests**

Assert verification reports all incompatible dependencies, changed scripts, wrong bytes/modes, alternate configs, competing managers, active-path drift, and missing dispatcher in one deterministic issue list. Also assert a canonical installed fixture returns `{ valid: true, issues: [] }`.

- [ ] **Step 7: Implement verification and run module checks**

Reuse conflict scanners without canonical ownership exceptions. Validate dependency range intersection, exactly one recognized prepare stage, exact owned script, canonical file snapshots, `.husky/_`, and `.husky/_/h`.

Run:

```bash
pnpm exec vitest run tests/modules/git-hooks.test.ts
pnpm typecheck
```

Expected: all tests and typecheck PASS.

- [ ] **Step 8: Commit the module**

```bash
git add src/modules/git-hooks.ts tests/modules/git-hooks.test.ts
git commit -m "feat: implement git hooks module"
```

---

### Task 4: Composition and real hook acceptance

**Files:**

- Create: `tests/acceptance/git-hooks-module.acceptance.ts`
- Modify: `tests/acceptance/test-module.acceptance.ts` only if shared exact-Node helpers are extracted
- Modify: `tests/acceptance/vitest.config.ts` only if separate named projects are needed
- Modify: `tests/package.test.ts`
- Modify: `package.json`
- Modify: `docs/modules/git-hooks.md` only for verified deviations

**Interfaces:**

- Consumes: Quality and Git Hooks module plans plus `GitHooksManager`.
- Produces `pnpm verify:git-hooks-compatibility` and an exact Node.js 22.22.1 real-install/real-commit fixture.

- [ ] **Step 1: Write failing composition and package-script tests**

In `tests/modules/git-hooks.test.ts`, build Quality, Tailwind, Test, and Git Hooks plans together and assert deterministic script/dependency/file composition without default registration. In `tests/package.test.ts`, assert:

```ts
expect(packageJson.scripts['verify:test-compatibility']).toBe(
  'vitest run --config tests/acceptance/vitest.config.ts tests/acceptance/test-module.acceptance.ts',
)
expect(packageJson.scripts['verify:git-hooks-compatibility']).toBe(
  'vitest run --config tests/acceptance/vitest.config.ts tests/acceptance/git-hooks-module.acceptance.ts',
)
```

- [ ] **Step 2: Run focused tests and confirm the script contract fails**

Run: `pnpm exec vitest run tests/package.test.ts tests/modules/git-hooks.test.ts`

Expected: FAIL because the package scripts and composition coverage are missing.

- [ ] **Step 3: Add the focused package scripts**

Keep both networked fixtures outside `pnpm check`; each command selects one acceptance file explicitly so Test verification does not run Git Hooks and vice versa.

- [ ] **Step 4: Implement the exact-floor acceptance fixture**

Resolve the official `node@22.22.1` npm binary, prepend its directory to `PATH`, apply real Quality and Git Hooks plans to a temporary project, install with pnpm 10 and `--ignore-scripts`, and call `GitHooksManager.activate`. Create and stage a deliberately unformatted TypeScript file. Under an offline/invalid-registry environment, prove a valid `git commit -m "feat: verify hooks"` succeeds and rewrites the file canonically; then prove `git commit -m "invalid message"` fails without advancing `HEAD`. Assert `core.hooksPath` is `.husky/_`.

- [ ] **Step 5: Run real compatibility acceptance**

Run: `pnpm verify:git-hooks-compatibility`

Expected: one fixture PASS under exactly `v22.22.1`, with real Husky, lint-staged, ESLint, Prettier, and commitlint execution.

- [ ] **Step 6: Run Test acceptance independently**

Run: `pnpm verify:test-compatibility`

Expected: only the Test fixture runs and PASSes.

- [ ] **Step 7: Commit acceptance coverage**

```bash
git add package.json tests/acceptance tests/package.test.ts tests/modules/git-hooks.test.ts docs/modules/git-hooks.md
git commit -m "test: verify git hooks compatibility"
```

---

### Task 5: Completion, review, and integration

**Files:**

- Modify only files required by verified review findings.

**Interfaces:**

- Consumes: complete Git Hooks branch diff and every repository/acceptance check.
- Produces: a reviewed PR merged into `develop`, leaving CI as the next module.

- [ ] **Step 1: Run fresh verification**

```bash
pnpm check
pnpm verify:package
pnpm verify:test-compatibility
pnpm verify:git-hooks-compatibility
git diff --check origin/develop...HEAD
git status --short
```

Expected: all checks PASS, the worktree is clean after commits, and exact-floor fixtures are independent.

- [ ] **Step 2: Push and open a draft PR**

Push `feat/git-hooks-module`, open a draft PR to `develop`, and include design, Node/package rationale, TDD failures, exact test counts, transaction rollback evidence, and real hook results.

- [ ] **Step 3: Request independent review**

Review module conflicts, script composition, Git worktree path handling, activation/restore ordering, symlink safety, hook shell quoting, exact Node inheritance, real offline commits, and stale documentation. Fix every Critical or Important finding through a failing test first.

- [ ] **Step 4: Mark ready and merge**

After fresh full verification and approved independent review, mark the PR ready, merge it into `develop` with a merge commit, fast-forward local `develop`, and confirm the feature head is an ancestor of `origin/develop`.
