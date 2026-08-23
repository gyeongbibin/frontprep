# Test Module Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a folder-aware, conflict-safe Vitest and React Testing Library module to Frontprep's declarative setup engine.

**Architecture:** A single `SetupModule<TestAnalysis>` performs non-executing filesystem and package inspection, emits only existing core intents, and verifies the installed state without importing consumer configuration. The Test module composes after Quality by appending one deterministic stage to `frontprep:check`; it remains out of the default registry until all v1 modules exist.

**Tech Stack:** TypeScript 5, Vitest 4, Node.js filesystem APIs, semver, Frontprep change intents and transaction engine.

**Spec:** `docs/modules/test.md`

## Global Constraints

- Node.js 20.9 or newer, Next.js 16 App Router, TypeScript 5, and pnpm 10.
- One Next.js application at the Git and package root, using exactly one of `app/` or `src/app/`.
- Consumer JavaScript and TypeScript configuration is inspected as text and never imported or executed.
- All paths are project-relative POSIX paths; symbolic links are rejected for managed targets and detected setup candidates.
- Modules return declarative intents only and never write files or run commands directly.
- The design document is committed before implementation and tests.

---

### Task 1: Test analysis and plan contract

**Files:**

- Create: `src/modules/test.ts`
- Create: `tests/modules/test.test.ts`

**Interfaces:**

- Consumes: `ProjectContext`, `ChangeIntent`, `FileSystem`, `ConflictError`, and `SetupModule` from the existing core.
- Produces: `testModule: SetupModule<TestAnalysis>` with `TestAnalysis = { readonly setupDirectory: string; readonly setupPath: string }`.

- [ ] **Step 1: Write the failing plan and path-selection tests**

Add tests that call `detectProject`, `testModule.analyze`, and
`testModule.plan`, then assert literal intent projections:

```ts
expect(analysis).toEqual({
  setupDirectory: 'src/test',
  setupPath: 'src/test/setup.ts',
})
expect(
  intents
    .filter((intent) => intent.kind === 'dependency')
    .map(({ name, range, section }) => ({ name, range, section })),
).toEqual([
  {
    name: '@testing-library/dom',
    range: '^10.0.0',
    section: 'devDependencies',
  },
  {
    name: '@testing-library/jest-dom',
    range: '>=6.0.0 <6.10.0',
    section: 'devDependencies',
  },
  {
    name: '@testing-library/react',
    range: '^16.0.0',
    section: 'devDependencies',
  },
  { name: '@vitejs/plugin-react', range: '^4.7.0', section: 'devDependencies' },
  { name: 'jsdom', range: '^26.0.0', section: 'devDependencies' },
  { name: 'vite', range: '^6.0.0', section: 'devDependencies' },
  { name: 'vite-tsconfig-paths', range: '^6.0.0', section: 'devDependencies' },
  { name: 'vitest', range: '^4.0.0', section: 'devDependencies' },
])
```

Add independent cases for root `app`, reuse of `test` and `tests`, multiple
candidate directories, non-directory candidates, and symbolic links in any
path component.

- [ ] **Step 2: Run the focused test and confirm the missing-module failure**

Run: `pnpm test:run tests/modules/test.test.ts`

Expected: FAIL because `src/modules/test.ts` does not exist.

- [ ] **Step 3: Implement minimal deterministic analysis and intents**

Create constants for the dependency table, scripts, canonical setup bytes,
alternate Vitest/Jest paths, and Jest dependency names. Implement candidate
selection with `lstat`, reject symbolic-link components, and return frozen
analysis. Render config bytes from `analysis.setupPath`:

```ts
function renderVitestConfig(setupPath: string): string {
  return `import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'
import tsconfigPaths from 'vite-tsconfig-paths'

export default defineConfig({
  plugins: [tsconfigPaths(), react()],
  test: {
    environment: 'jsdom',
    passWithNoTests: true,
    setupFiles: ['./${setupPath}'],
  },
})
`
}
```

Emit eight dependency intents, the two managed files, and the four script
intents described by `docs/modules/test.md`.

- [ ] **Step 4: Run focused tests and refactor while green**

Run: `pnpm test:run tests/modules/test.test.ts`

Expected: all plan and path-selection cases PASS.

Extract only helpers that are reused by analysis and verification. Keep all
consumer inspection non-executing.

---

### Task 2: Configuration and ownership conflicts

**Files:**

- Modify: `src/modules/test.ts`
- Modify: `tests/modules/test.test.ts`

**Interfaces:**

- Consumes: `TestAnalysis` and canonical renderers from Task 1.
- Produces: preflight conflict detection used by `testModule.analyze` and reusable issue collection for `verify`.

- [ ] **Step 1: Write failing conflict tests**

Add table-driven tests for alternate `vitest.config.*`,
`vitest.workspace.*`, `jest.config.*`, `package.json#jest`, and each direct
Jest tool. Add cases proving that a root `vite.config.ts` is allowed, exact
canonical managed files are accepted, differing unowned files are rejected,
and manifest-owned unchanged files remain eligible for rewrite.

- [ ] **Step 2: Run the focused test and confirm conflicts are not detected**

Run: `pnpm test:run tests/modules/test.test.ts`

Expected: FAIL on the first alternate or Jest configuration case because
analysis currently accepts it.

- [ ] **Step 3: Implement non-executing conflict collection**

Inspect root entries and package data without importing configuration. For a
canonical file, accept exact expected bytes or a manifest-owned file whose
recorded hash equals the current hash; reject all other existing contents.
Convert the first analysis issue into:

```ts
throw new ConflictError(first.message, first.path, 'test')
```

Keep root Vite configuration out of the conflict set because the dedicated
Vitest config overrides it.

- [ ] **Step 4: Run focused tests and the core plan-builder tests**

Run: `pnpm test:run tests/modules/test.test.ts tests/core/plan-builder.test.ts`

Expected: all selected tests PASS.

---

### Task 3: Structural verification and pipeline composition

**Files:**

- Modify: `src/modules/test.ts`
- Modify: `tests/modules/test.test.ts`

**Interfaces:**

- Consumes: `testModule.verify(context)` from the `SetupModule` contract and Quality's existing first-stage pipeline rule.
- Produces: an aggregated `VerificationResult` for dependencies, scripts, paths, managed bytes, modes, and post-install conflicts.

- [ ] **Step 1: Write failing apply-and-verify tests**

Build one plan from Quality and Test intents, apply its operations through the
real `FileSystem`, refresh project detection, and assert:

```ts
expect(await testModule.verify(updatedContext)).toEqual({
  issues: [],
  valid: true,
})
expect(updatedContext.packageJson.scripts?.['frontprep:check']).toBe(
  'pnpm run frontprep:quality && pnpm run frontprep:test',
)
```

Add failing cases for missing or incompatible dependencies, changed modes and
bytes, missing aliases, reordered or duplicate check stages, a valid later
build stage, and multiple simultaneous post-install conflicts.

- [ ] **Step 2: Run the focused test and confirm verification is incomplete**

Run: `pnpm test:run tests/modules/test.test.ts`

Expected: FAIL because `verify` does not yet validate the complete installed
contract.

- [ ] **Step 3: Implement aggregated verification**

Collect configuration issues first, then validate each dependency using
`validRange` and `intersects`. Split `frontprep:check` on the literal
`' && '` delimiter and require these first two stages exactly once:

```ts
const required = [
  'pnpm run frontprep:quality',
  'pnpm run frontprep:test',
] as const
```

Re-run deterministic setup selection inside `try/catch`; on failure, record an
issue and use the default candidate so remaining file checks still execute.
Use `FileSystem.snapshot` wrappers so unreadable and non-regular paths produce
issues rather than aborting verification.

- [ ] **Step 4: Run focused tests and all module tests**

Run: `pnpm test:run tests/modules`

Expected: all Quality, Tailwind, registry, and Test module tests PASS.

---

### Task 4: Transaction, rollback, and idempotency

**Files:**

- Modify: `tests/modules/test.test.ts`

**Interfaces:**

- Consumes: `runInit`, `createCommandServices`, `applyPlan`, `qualityModule`, `testModule`, and passive modules for unfinished v1 stages.
- Produces: integration evidence that the Test plan is transactional and manifest-backed idempotent.

- [ ] **Step 1: Write the transaction integration tests**

Create command services with modules in fixed order:

```ts
;[
  qualityModule,
  passiveModule('tailwind'),
  testModule,
  passiveModule('git-hooks'),
  passiveModule('ci'),
]
```

Use the real transaction with a recording package manager and disabled Git
guard. The successful case runs `runInit` twice, asserts one install, an empty
second change set, preserved custom `test`, canonical config/setup files, and a
manifest that records both managed paths. The failure case injects a project
check error and asserts package/config/setup/manifest restoration.

- [ ] **Step 2: Run the focused test and confirm the new integration case fails**

Run: `pnpm test:run tests/modules/test.test.ts`

Expected: FAIL if any ownership, managed-script, rollback, or idempotency
contract is not implemented correctly.

- [ ] **Step 3: Make only test-driven corrections required by integration**

Correct production logic only when the integration failure exposes a real
contract gap. Do not register Test globally and do not weaken transaction or
manifest checks.

- [ ] **Step 4: Run focused and full verification**

Run: `pnpm test:run tests/modules/test.test.ts`

Expected: all Test module cases PASS.

Run: `pnpm check`

Expected: formatting, linting, type checking, build, and every repository test
PASS with no warnings or errors.

- [ ] **Step 5: Commit implementation and tests**

```bash
git add src/modules/test.ts tests/modules/test.test.ts
git commit -m "feat: implement test module"
```

---

### Task 5: Independent review and pull-request delivery

**Files:**

- Modify only files required by verified review findings.

**Interfaces:**

- Consumes: the design commit, implementation commit, and full git diff from `origin/develop`.
- Produces: a reviewed draft PR that becomes ready and merges into `develop` only after fresh full verification.

- [ ] **Step 1: Run plan self-review**

Re-read `docs/modules/test.md` and map every dependency, file, path,
conflict, intent, verification, and test-matrix requirement to a passing test.
Search this plan for placeholder language and verify all type and function names
match the implementation.

- [ ] **Step 2: Request independent code review**

Dispatch a read-only reviewer with base `origin/develop`, branch HEAD, this
plan, and `docs/modules/test.md`. Correct every Critical or Important finding
through a new failing test before production changes.

- [ ] **Step 3: Run fresh completion verification**

Run: `pnpm check`

Expected: exit code `0`, all repository checks PASS.

Run: `git diff --check origin/develop...HEAD && git status --short`

Expected: no whitespace errors and no uncommitted implementation files.

- [ ] **Step 4: Push, open draft PR, and integrate through the agreed workflow**

Push `feat/test-module`, create a draft PR targeting `develop`, report review
and verification evidence, mark it ready, and merge it only after required
checks and approvals pass. Keep the Test worktree until the PR is merged.
