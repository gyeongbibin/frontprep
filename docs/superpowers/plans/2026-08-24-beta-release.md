# Beta Release Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make `0.1.0-beta.0` auditable and release-ready without publishing,
tagging, or creating a GitHub Release.

**Architecture:** Release-facing metadata is protected by fast contract tests.
Frontprep's repository workflow is a checked-in, parsed, exact policy separate
from the workflow generated for consumers. The slow complete-project acceptance
packs and installs the real tarball before invoking the five-module public CLI.

**Tech Stack:** TypeScript 5.9, Node.js 22.22.1, pnpm 10.22, Vitest 4,
YAML 2, npm pack/install, GitHub Actions

**Spec:**
`docs/superpowers/specs/2026-08-24-beta-release-design.md`

## Global Constraints

- Work only in `.worktrees/release-beta` on `chore/release-beta`, based on the
  latest merged `develop`.
- Keep actual npm publication, version tags, GitHub Releases, and dist-tag
  mutation outside this branch and behind explicit operator approval.
- Use the reviewed full action SHAs recorded in the design; do not use mutable
  tags.
- Keep package contents minimal and assert the exact tarball file set.
- The full consumer acceptance must invoke only the installed tarball entry,
  never the repository `dist/cli.js`.
- Create temporary tarball/install/project roots privately and remove them in
  `finally` blocks.
- Add or change behavior only after observing its focused test fail.
- Use `apply_patch` for source, test, configuration, and documentation edits.

---

### Task 1: Public release metadata and documentation

**Files:**

- Create: `LICENSE`
- Create: `CHANGELOG.md`
- Modify: `package.json`
- Modify: `README.md`
- Modify: `tests/package.test.ts`
- Modify: `scripts/verify-package.mjs`

- [ ] **Step 1: Write failing metadata and packed-file tests**

Extend `tests/package.test.ts` to assert the homepage, issue tracker, keywords,
license, publish access, repository, and the exact packed file list including
`LICENSE`. Human-facing README and changelog prose are reviewed directly rather
than frozen by source-text tests.

- [ ] **Step 2: Confirm the focused release tests fail**

Run:

```sh
pnpm exec vitest run tests/package.test.ts
```

Expected: FAIL because release files and metadata are absent and the tarball
contract still reflects the previous file set.

- [ ] **Step 3: Add the release files and metadata**

Add the canonical MIT text, Keep a Changelog beta entry, package homepage,
bugs URL, focused keywords, and README beta quick start. Update both tarball
file expectations to the actual minimal npm order. Format and review the human
documentation without adding tests that merely grep prose.

- [ ] **Step 4: Run focused tests and package smoke verification**

Run:

```sh
pnpm exec vitest run tests/package.test.ts
pnpm verify:package
```

Expected: PASS; the tarball installs and the public bin reports the beta
version under exact Node.js 22.22.1.

- [ ] **Step 5: Commit release metadata**

```sh
git add LICENSE CHANGELOG.md README.md package.json \
  tests/package.test.ts scripts/verify-package.mjs
git commit -m "docs: add beta release metadata"
```

---

### Task 2: Frontprep repository CI

**Files:**

- Create: `.github/workflows/ci.yml`
- Create: `tests/repository-ci.test.ts`

- [ ] **Step 1: Write a failing workflow policy test**

Parse `.github/workflows/ci.yml` with `yaml`. Assert the `develop`/`main`
push and pull-request triggers, `contents: read`, scoped concurrency,
`HUSKY=0`, Ubuntu runner, 20-minute timeout, immutable action SHAs, disabled
checkout credentials, exact Node.js 22.22.1, pnpm cache settings, frozen
installation, and the six verification commands in exact order. Assert every
action reference ends in a 40-character lowercase SHA.

- [ ] **Step 2: Confirm the workflow test fails because the file is absent**

Run:

```sh
pnpm exec vitest run tests/repository-ci.test.ts
```

Expected: FAIL reading `.github/workflows/ci.yml`.

- [ ] **Step 3: Add the least-privilege workflow**

Create the exact policy from the release design. Keep each verification as a
named step so GitHub identifies its failing contract boundary.

- [ ] **Step 4: Run the workflow test and fast suite**

Run:

```sh
pnpm exec vitest run tests/repository-ci.test.ts
pnpm check
```

Expected: PASS.

- [ ] **Step 5: Commit repository CI**

```sh
git add .github/workflows/ci.yml tests/repository-ci.test.ts
git commit -m "ci: verify frontprep repository"
```

---

### Task 3: Installed-tarball complete consumer acceptance

**Files:**

- Modify: `tests/acceptance/ci-module.acceptance.ts`
- Modify: `docs/modules/ci.md`
- Modify: `docs/modules/cli-core.md`

- [ ] **Step 1: Add a failing installed-entry assertion**

Replace the repository `dist/cli.js` constant with a package installation
helper contract. The test must assert that the selected entry lives below an
isolated `node_modules/@mingyeongbin/frontprep` directory. Before implementing
the helper, run the acceptance and observe the missing installed entry fail.

- [ ] **Step 2: Pack and install the package once per acceptance run**

Use `mkdtemp`, `npm pack --json --pack-destination`, and
`npm install --ignore-scripts --no-audit --no-fund --prefix`. Return the
temporary root and installed `dist/cli.js`, and execute all `init` and `check`
calls with that path under the exact minimum Node executable.

- [ ] **Step 3: Guarantee cleanup and update contracts**

Remove both package installation and consumer roots in `finally`. Update CI
and CLI Core documentation to say the release-level acceptance uses the packed
and installed CLI rather than merely the built repository bundle.

- [ ] **Step 4: Run the full installed-package acceptance**

Run:

```sh
pnpm verify:ci-compatibility
```

Expected: PASS after a real tarball installation, project dependency install,
quality/test/build pipeline, idempotent second init, and public check on exact
Node.js 22.22.1.

- [ ] **Step 5: Commit the consumer dry run**

```sh
git add tests/acceptance/ci-module.acceptance.ts \
  docs/modules/ci.md docs/modules/cli-core.md
git commit -m "test: verify installed beta consumer"
```

---

### Task 4: Complete release verification and integration

**Files:**

- Modify only if a verification defect is discovered through TDD.

- [ ] **Step 1: Run every release gate from a clean build**

Run sequentially:

```sh
pnpm check
pnpm verify:package
pnpm verify:quality-compatibility
pnpm verify:test-compatibility
pnpm verify:git-hooks-compatibility
pnpm verify:ci-compatibility
git diff --check
git status --short
```

Expected: all commands pass and only intentional branch commits remain.

- [ ] **Step 2: Inspect the final package without publishing**

Run:

```sh
npm pack --json --dry-run
npm whoami
```

The pack manifest must match the tested file set. `npm whoami` records whether
the later publish gate is authenticated but does not mutate registry state.

- [ ] **Step 3: Open a draft pull request and run independent review**

Push `chore/release-beta`, open a draft PR to `develop`, wait for GitHub checks,
and request an independent code review. Address only verified findings and
rerun affected plus full checks.

- [ ] **Step 4: Ready and merge to develop**

After local verification, hosted checks, and review are green, mark the PR
ready and merge it to `develop`. Update the main worktree without discarding
unrelated worktrees or stashes.

- [ ] **Step 5: Stop at the external release gate**

Report the merged commit, test evidence, package manifest, authentication
state, and the exact remaining publish/tag/release actions. Do not execute
those actions without explicit operator approval.
