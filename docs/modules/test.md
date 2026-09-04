# Test Module Design

## Role

The Test module installs a deterministic Vitest environment for synchronous
Next.js unit and component tests. It implements the Test responsibility from
the [Frontprep v1 design](../superpowers/specs/2026-08-22-frontprep-v1-design.md)
through the intent and verification contracts defined by the
[CLI core](cli-core.md).

The module derives its setup path from the detected Next.js application. It
supports the v1 layouts `app/` and `src/app/`; it never assumes that a consumer
uses Frontprep's repository structure. Async Server Components remain outside
this unit-test contract and should be covered by a later end-to-end workflow.

## Dependency Compatibility

Test contributes these development dependencies:

| Package                     | Requested range   | Purpose                                          |
| --------------------------- | ----------------- | ------------------------------------------------ |
| `@testing-library/dom`      | `^10.0.0`         | DOM queries required by React Testing Library    |
| `@testing-library/jest-dom` | `>=6.0.0 <6.10.0` | Vitest-compatible DOM matchers                   |
| `@testing-library/react`    | `^16.0.0`         | React component rendering and queries            |
| `@vitejs/plugin-react`      | `^4.7.0`          | React JSX transformation on Vite 6               |
| `jsdom`                     | `^26.0.0`         | Browser-like DOM for the tested v1 package set   |
| `vite`                      | `^6.0.0`          | Transform pipeline for the tested v1 package set |
| `vite-tsconfig-paths`       | `^6.0.0`          | TypeScript `baseUrl` and `paths` resolution      |
| `vitest`                    | `^4.0.0`          | Unit-test runner                                 |

Vite 6, React plugin 4, jsdom 26, and jest-dom below 6.10 remain Frontprep
v1's tested compatibility set; every declared range supports the Node.js
22.22.1 floor. A direct Vite 6 requirement also prevents Vitest's broad Vite
dependency range from selecting an unverified major. The ranges are tested as
one compatibility set by `pnpm verify:test-compatibility`. That acceptance
check applies the real module plan to a temporary `src/app` project, runs a
real pnpm install under Node.js 22.22.1, and executes the generated Vitest
config with a React Testing Library render and jest-dom assertion.

An existing declaration may remain in either `dependencies` or
`devDependencies` when its valid semver range intersects the requested range.
An invalid or disjoint range is a planning conflict. New declarations are
added to `devDependencies`.

The package set and configuration follow the official
[Next.js Vitest guide](https://nextjs.org/docs/app/guides/testing/vitest),
[Vitest configuration](https://vitest.dev/config/), and
[React Testing Library setup](https://testing-library.com/docs/react-testing-library/setup/).

## Resolved Setup Path

Test consumes the single setup directory selected by the core project model.
Priority is the explicit `--test-dir` value, then `.frontprep.json`, then
`src/test` for `src/app` or `test` for root `app` projects. It does not scan
`test` and `tests` candidates, so adding another conventional directory later
cannot redirect verification.

The resulting setup file is `<resolved-test-directory>/setup.ts`. A selected
directory may be missing and is then created. Existing paths must be real and
must not contain symbolic-link components. Beta.0 manifests are migrated with
their managed setup path preserved. See the
[project model v2 design](../superpowers/specs/2026-09-02-project-model-v2-design.md)
for the complete path authority contract.

Test discovery is limited to the detected application source root and the
resolved test directory. A `src/app` project therefore searches `src`; a root
`app` project searches `app` plus `test` unless the selected test directory is
already below the application root. An explicit directory outside the source
root is included without widening discovery to the rest of the package.

Every discovery root uses
`**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}`. Vitest's default exclusions
remain active and `fixtures` plus `__fixtures__` directories are excluded, so
sample tests cannot be collected as application tests.

## Managed Files

### `vitest.config.mts`

Test manages the root file with mode `0644`. The setup path is rendered from
the detected directory:

```ts
import react from '@vitejs/plugin-react'
import { configDefaults, defineConfig } from 'vitest/config'
import tsconfigPaths from 'vite-tsconfig-paths'

export default defineConfig({
  plugins: [tsconfigPaths(), react()],
  test: {
    environment: 'jsdom',
    exclude: [...configDefaults.exclude, '**/{__fixtures__,fixtures}/**'],
    include: ['src/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}'],
    passWithNoTests: true,
    setupFiles: ['./src/test/setup.ts'],
  },
})
```

The `.mts` extension is intentional. The Next.js TypeScript guide uses an ESM
config, and `vite-tsconfig-paths` requires either an ESM package or an explicit
ESM config extension. Frontprep does not change the consumer's
`package.json#type`, so `.mts` is deterministic for both supported package
shapes. A dedicated Vitest config also overrides and isolates any unrelated
`vite.config.*` file, as documented by Vitest.

The config does not enable Vitest globals. Test files import `test`, `expect`,
and hooks explicitly from `vitest`, matching the Next.js example and avoiding
a `tsconfig.json` mutation for `vitest/globals`.

The Test module contract version is `3.0.0`. Existing unchanged managed
configurations are rewritten transactionally to gain scoped discovery; an
unowned differing configuration remains a planning conflict.

### `<detected-test-directory>/setup.ts`

Test manages this file with mode `0644`:

```ts
import '@testing-library/jest-dom/vitest'
import { cleanup } from '@testing-library/react'
import { afterEach } from 'vitest'

afterEach(() => {
  cleanup()
})
```

The Vitest-specific jest-dom entry extends Vitest's matcher instance. Cleanup
is registered explicitly because React Testing Library's automatic cleanup
depends on a global `afterEach`, while this module keeps Vitest globals off.
Keeping the setup file under the detected source root also includes it in the
standard Next.js TypeScript project without adding a second TypeScript config.

## Scripts

Test contributes these package scripts:

| Name              | Command                   | Policy              |
| ----------------- | ------------------------- | ------------------- |
| `frontprep:test`  | `vitest run`              | `owned`             |
| `frontprep:check` | `pnpm run frontprep:test` | `append-once`       |
| `test`            | `vitest`                  | `preserve-existing` |
| `test:run`        | `vitest run`              | `preserve-existing` |

Quality creates `frontprep:check` with the Quality stage. Test appends its run
stage once, yielding:

```text
pnpm run frontprep:quality && pnpm run frontprep:test
```

CI may later append `pnpm run frontprep:build`. Verification therefore
requires exactly one Quality stage first and exactly one Test stage second,
while allowing later stages. Existing conventional `test` and `test:run`
aliases are preserved; Frontprep automation always uses `frontprep:test`.

## Analysis and Conflict Rules

Analysis reads configuration as text or filesystem metadata and never imports
consumer JavaScript or TypeScript.

- A missing canonical config or setup file is eligible for creation.
- Exact canonical contents and mode are already satisfied and are not
  rewritten.
- A differing unowned canonical managed file is a conflict before mutation.
  A manifest-owned unchanged file remains eligible for a versioned rewrite.
- Any alternate root `vitest.config.*` file or `vitest.workspace.*` file is a
  conflict because Frontprep cannot prove which test graph should run without
  executing consumer configuration.
- Root `vite.config.*` files are not conflicts. Vitest documents that a
  dedicated `vitest.config.*` has higher priority and ignores the Vite config.
- Root `jest.config.*`, `package.json#jest`, or a direct Jest tool declaration
  (`jest`, `@jest/core`, `@swc/jest`, `@types/jest`, `babel-jest`,
  `jest-environment-jsdom`, or `ts-jest`) is a conflict. Frontprep v1 does not
  migrate Jest tests or install two overlapping unit-test environments.
- Existing Playwright or Cypress configuration is allowed because those tools
  serve an end-to-end role and do not replace the managed Vitest unit runner.
- Symbolic links are not followed for config files, setup candidates, or the
  setup file. Unreadable or non-regular required paths are conflicts.

## Intents

`plan` returns only common core intents:

- eight `dependency` intents targeting `devDependencies`;
- one `managed-file` intent for `vitest.config.mts`;
- one `managed-file` intent for the detected setup file;
- one owned `script` intent for `frontprep:test`;
- one append-once `script` intent for the Test stage of `frontprep:check`;
- two preserve-existing `script` intents for `test` and `test:run`.

The production CLI registers Test third in the fixed five-module order. Its
contract is exercised directly, through injected registries, and through the
complete public CLI acceptance path.

## Verification

Test verification accumulates all issues instead of stopping after the first
failure. It checks:

1. every dependency is declared with a valid range intersecting the requested
   range;
2. `frontprep:test` is exact, both conventional aliases exist, and the full
   check pipeline contains the Quality and Test stages exactly once in order;
3. refreshing directory selection resolves to the same deterministic setup
   path without ambiguity or symbolic links;
4. `vitest.config.mts` has the canonical path-aware bytes and mode;
5. the detected setup file has the canonical bytes and mode;
6. discovery includes only the application and selected centralized test roots
   while retaining the canonical default and fixture exclusions;
7. no alternate Vitest workspace, Jest, package-level, dependency, symbolic-
   link, or path ambiguity conflict appeared after installation.

Per-path filesystem and parse failures become verification issues and checking
continues, so one bad path cannot hide independent dependency, script, or
configuration failures. Core structural verification additionally checks the
manifest fingerprint of both managed files and every managed script.

The full transaction runs `pnpm run frontprep:check`; `passWithNoTests: true`
therefore makes a newly configured project with no test files valid while
preserving a failing exit for real test failures.

Repository acceptance verification is intentionally separate from the fast
unit suite because it downloads the declared consumer dependency graph. Run
`pnpm verify:test-compatibility` to resolve that graph with pnpm 10 and execute
it using the exact supported Node.js floor, `v22.22.1`.

## Test Matrix

Module tests cover:

- the complete dependency, script, config, and setup intent contract;
- default paths for both `src/app` and root `app` projects;
- reuse of existing `test` and `tests` directories;
- rejection of ambiguous, symbolic-link, and non-directory test paths;
- rejection when the detected `src` source-directory component is itself a
  symbolic link;
- exact canonical projects and manifest-backed idempotent replanning;
- conflicting managed files, alternate Vitest configurations, Vitest
  workspaces, Jest files, package configuration, and direct Jest tools;
- compatible existing dependencies in either package section and incompatible
  version ranges;
- preservation of conventional user-owned test aliases;
- successful verification after applying the Quality and Test plans;
- acceptance of a later build stage and rejection of missing, reordered, or
  duplicated Quality and Test stages;
- aggregation of dependency, script, mode, managed-file, and post-install
  configuration failures;
- successful and rollback-producing `runInit` transactions with an injected
  five-module registry and package-manager service;
- composition with Quality through the core plan builder without registering
  Test by default;
- a separate real-install acceptance fixture that runs generated alias
  resolution, React rendering, cleanup setup, and jest-dom matchers on Node.js
  22.22.1.
