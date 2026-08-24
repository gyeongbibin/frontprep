# Quality ESLint Compatibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the crashing ESLint 10/Next.js React-plugin combination with one verified ESLint 9 compatibility set before Git Hooks integration.

**Architecture:** The Quality module changes only its requested ESLint range. Repository lint dependencies align to that major, while a new exact-Node networked acceptance fixture installs and executes the generated consumer lint pipeline so future package graph drift is detected.

**Tech Stack:** Node.js 22.22.1, pnpm 10, ESLint 9.39, @eslint/js 9.39, eslint-config-next 16, Vitest 4.

**Spec:** `docs/superpowers/specs/2026-08-24-quality-eslint-compatibility-design.md`

## Global Constraints

- Frontprep and consumers keep the Node.js `>=22.22.1` floor.
- Generated Quality configuration bytes and all script names/commands remain unchanged.
- Generated projects request `eslint@^9.39.0`; the repository requests both `eslint@^9.39.0` and `@eslint/js@^9.39.0`.
- Networked installation stays outside `pnpm check`.
- The fix merges to `develop` before Git Hooks is rebased and resumed.

---

### Task 1: Pin the compatible ESLint major

**Files:**

- Modify: `tests/modules/quality.test.ts`
- Modify: `tests/package.test.ts`
- Modify: `src/modules/quality.ts`
- Modify: `package.json`
- Modify: `pnpm-lock.yaml`
- Modify: `docs/modules/quality.md`

**Interfaces:**

- Consumes: existing Quality dependency intent and package metadata tests.
- Produces: generated `eslint@^9.39.0`, repository `eslint@^9.39.0`, and repository `@eslint/js@^9.39.0`.

- [x] **Step 1: Write failing dependency-contract tests**

Change every Quality expected range and verification message from
`^10.0.0` to `^9.39.0`. Extend the package metadata test with:

```ts
expect(packageJson.devDependencies.eslint).toBe('^9.39.0')
expect(packageJson.devDependencies['@eslint/js']).toBe('^9.39.0')
```

- [x] **Step 2: Run focused tests and confirm old ranges fail**

Run:

`pnpm exec vitest run tests/modules/quality.test.ts tests/package.test.ts`

Expected: FAIL on the generated `^10.0.0` range and repository ESLint 10 metadata.

- [x] **Step 3: Update module, repository metadata, lockfile, and design prose**

Set the three ranges exactly as specified, run `pnpm install`, and update the
Quality dependency table/rationale to record that Next.js 16's current React
plugin supports ESLint through 9. Keep Node 22 and every generated config byte
unchanged.

- [x] **Step 4: Run focused verification**

```bash
pnpm exec vitest run tests/modules/quality.test.ts tests/package.test.ts
pnpm lint
pnpm typecheck
```

Expected: all commands PASS with ESLint 9.39 resolved.

- [x] **Step 5: Commit the compatibility pin**

```bash
git add docs/modules/quality.md package.json pnpm-lock.yaml src/modules/quality.ts tests/modules/quality.test.ts tests/package.test.ts
git commit -m "fix: use compatible ESLint major"
```

---

### Task 2: Real generated Quality acceptance

**Files:**

- Create: `tests/acceptance/quality-module.acceptance.ts`
- Modify: `tests/package.test.ts`
- Modify: `package.json`

**Interfaces:**

- Consumes: the real Quality analysis/plan and exact Node bootstrap pattern from Test acceptance.
- Produces `pnpm verify:quality-compatibility` selecting only the Quality fixture.

- [x] **Step 1: Write the failing package-script contract**

Assert:

```ts
expect(packageJson.scripts['verify:quality-compatibility']).toBe(
  'vitest run --config tests/acceptance/vitest.config.ts tests/acceptance/quality-module.acceptance.ts',
)
```

- [x] **Step 2: Run package tests and confirm the script is missing**

Run: `pnpm exec vitest run tests/package.test.ts`

Expected: FAIL because the script does not exist.

- [x] **Step 3: Add the focused acceptance command and fixture**

The fixture resolves `node@22.22.1`, applies the Quality plan to a temporary
`src/app` project, installs with pnpm 10 and `--ignore-scripts`, writes
`export const greeting = "hello";`, and invokes:

```text
pnpm run frontprep:lint:fix
pnpm run frontprep:format
pnpm run frontprep:format:check
```

using a PATH headed by the exact Node binary. Assert the source becomes
`export const greeting = 'hello'` with no semicolon and the installed ESLint
major is 9.

- [x] **Step 4: Run exact-floor Quality acceptance**

Run: `pnpm verify:quality-compatibility`

Expected: one real-install fixture PASS under Node.js `v22.22.1`.

- [x] **Step 5: Commit acceptance coverage**

```bash
git add package.json tests/package.test.ts tests/acceptance/quality-module.acceptance.ts
git commit -m "test: verify Quality dependency compatibility"
```

---

### Task 3: Verify, review, and integrate

**Files:**

- Modify only files required by verified review findings.

- [x] **Step 1: Run fresh completion verification**

```bash
pnpm check
pnpm verify:package
pnpm verify:quality-compatibility
pnpm verify:test-compatibility
git diff --check origin/develop...HEAD
git status --short
```

- [ ] **Step 2: Open a draft PR and request independent review**

Push `fix/quality-eslint-compatibility`, open a draft PR to `develop`, and
request read-only review of the root cause, range alignment, exact-floor
fixture, and whether any ESLint 10 assumption remains active.

- [ ] **Step 3: Mark ready and merge**

After resolving every Critical or Important finding through a failing test
first, rerun all verification, mark ready, merge with a merge commit, and
fast-forward local `develop`.
