# Git Hooks Module Design

## Role

The Git Hooks module installs and activates a deterministic commit-time
quality gate for a single-package Frontprep project. It implements the Git
Hooks responsibility from the
[Frontprep v1 design](../superpowers/specs/2026-08-22-frontprep-v1-design.md)
through the intent, transaction, and verification contracts defined by the
[CLI core](cli-core.md).

The module runs formatting and lint fixes only for staged files before a
commit, then validates the commit message against Conventional Commits. It
does not run the full typecheck, test, or build pipeline in a hook. Those
project-wide checks remain under `frontprep:check` and the CI module.

All managed hook and configuration paths are relative to the detected Git and
package root. They do not depend on whether the Next.js application uses
`app/` or `src/app/`.

## Dependency Compatibility

Git Hooks contributes these development dependencies:

| Package                           | Requested range | Purpose                            |
| --------------------------------- | --------------- | ---------------------------------- |
| `husky`                           | `^9.1.0`        | Git hook installation and dispatch |
| `lint-staged`                     | `^17.3.0`       | Staged-file task selection         |
| `@commitlint/cli`                 | `^21.2.0`       | Commit-message validation          |
| `@commitlint/config-conventional` | `^21.2.0`       | Conventional Commits policy        |

These are the maintained package lines compatible with Frontprep v1's exact
Node.js 22.22.1 floor. Husky 9 supports Node.js 18 or newer, lint-staged 17.3
requires Node.js 22.22.1 or newer, and commitlint 21.2 requires Node.js 22.12
or newer. The requested ranges therefore share Frontprep's declared runtime
contract without retaining deprecated package lines.

An existing declaration may remain in either `dependencies` or
`devDependencies` when its valid semver range intersects the requested range.
An invalid or disjoint range is a planning conflict. New declarations are
added to `devDependencies`.

The package set and file formats follow the official
[Husky setup](https://typicode.github.io/husky/get-started.html),
[lint-staged configuration](https://github.com/lint-staged/lint-staged#configuration),
and
[commitlint local setup](https://commitlint.js.org/guides/local-setup.html)
contracts.

## Managed Files

### `.husky/pre-commit`

Git Hooks manages this executable file with mode `0755`:

```sh
pnpm exec lint-staged
```

Husky 9 hook files contain the hook command directly. Frontprep does not add
the deprecated Husky 8 bootstrap shebang or `husky.sh` source line. The local
pnpm binary is used instead of downloading a package at commit time.

### `.husky/commit-msg`

Git Hooks manages this executable file with mode `0755`:

```sh
pnpm exec commitlint --edit "$1"
```

The message-file path remains a positional shell argument and is quoted. It is
not interpolated into a command by Frontprep. `ProcessRunner` continues to use
argument arrays and `shell: false`; this shell syntax exists only inside the
Git-managed hook file where Husky supplies `$1`.

### `lint-staged.config.mjs`

Git Hooks manages this file with mode `0644`:

```js
export default {
  '*.{cjs,cts,js,jsx,mjs,mts,ts,tsx}': ['eslint --fix', 'prettier --write'],
  '*.{css,json,jsonc,md,mdx,yaml,yml}': 'prettier --write',
}
```

The two patterns do not overlap. JavaScript and TypeScript files are linted
and then formatted sequentially, avoiding concurrent writers for the same
file. Data, stylesheet, and documentation formats use Prettier only. The
configuration relies on the Quality module's ESLint and Prettier dependencies
and is intentionally limited to formats owned by the v1 baseline.

The explicit `.mjs` extension is deterministic whether or not the consumer's
`package.json` declares `"type": "module"`.

### `commitlint.config.mjs`

Git Hooks manages this file with mode `0644`:

```js
export default {
  extends: ['@commitlint/config-conventional'],
}
```

Frontprep v1 uses the upstream Conventional Commits rules without adding a
custom type list, scope list, prompt, or release policy.

## Husky-Generated Installation Directory

Running Husky creates `.husky/_`, writes Husky's internal dispatch files, and
sets the repository-local Git configuration `core.hooksPath` to `.husky/_`.
Frontprep does not manage or fingerprint `.husky/_`: it is an ignored install
artifact owned by Husky, comparable to `node_modules`.

The committed `.husky/pre-commit` and `.husky/commit-msg` files remain fully
managed and fingerprinted by Frontprep. Other user hook files under `.husky/`
are preserved because the module owns only these two hook paths.

## Package Scripts

Git Hooks owns this internal script:

```json
{
  "frontprep:prepare": "husky"
}
```

The conventional `prepare` script follows the special composition rule from
the v1 architecture:

- when missing, add `prepare: "pnpm run frontprep:prepare"`;
- when it contains exactly one recognized Husky stage, preserve it;
- when it contains more than one recognized Husky stage, report a conflict;
- otherwise append `pnpm run frontprep:prepare` once with a literal `&&`
  pipeline delimiter.

Recognized stages are exactly `husky`, `pnpm husky`, `pnpm exec husky`, and
`pnpm run frontprep:prepare`. A substring such as `echo husky` does not count.
The analyzer splits only on the core script pipeline delimiter `&&` and does
not execute or shell-parse the consumer command.

`frontprep:prepare` uses the `owned` script policy. The conventional
`prepare` integration uses `append-once` only when a recognized Husky stage is
absent. Existing command bytes and order are retained before the appended
stage.

Git Hooks does not add `frontprep:lint-staged` or `frontprep:commitlint`
scripts. Hook files call the local CLIs directly, keeping the generated public
script surface identical to the complete v1 design.

## Immediate Activation and Transaction Boundary

The core package manager deliberately installs with
`pnpm install --ignore-scripts`, so adding `prepare` alone cannot activate
Husky during the current `frontprep init`. Git Hooks therefore adds an
explicit, narrowly scoped activation service.

`GitHooksManager` is a core service backed by `ProcessRunner`. It exposes:

```ts
export interface GitHooksActivation {
  readonly previousHooksPath: string | null
}

export interface GitHooksService {
  activate(
    root: string,
    signal?: AbortSignal,
  ): Promise<GitHooksActivation | null>
  restore(root: string, activation: GitHooksActivation): Promise<void>
}
```

Activation is requested only when the registered module list contains
`git-hooks`. `activate` reads the repository-local `core.hooksPath`. When it is
already `.husky/_` and Husky's internal dispatcher exists as a real file, it
returns `null` without running a command. Otherwise it records the prior value,
runs this fixed argument-array command, and confirms the resulting path:

```text
pnpm run frontprep:prepare
```

For a non-empty plan, `applyPlan` activates Git Hooks after file writes and the
optional dependency installation, but before module and project verification.
If activation or any later verification fails, the transaction restores the
previous `core.hooksPath` in addition to its existing tracked-file, mode,
lockfile, and manifest rollback.

For an empty file plan, `runInit` still invokes the same idempotent activation
service before structural verification. This repairs a missing Husky internal
installation without rewriting tracked files or reinstalling dependencies.
If subsequent verification fails, `runInit` restores the activation receipt.
`frontprep check` remains read-only: it never activates hooks and reports a
missing or changed active hook path as a verification issue.

If activation fails after creating or changing `.husky/_`, those ignored
Husky-owned files are not rolled back. The repository-local Git configuration
is restored, so Git cannot dispatch through the incomplete artifact. This is
the same explicit rollback boundary used for pnpm-owned `node_modules`.

## Analysis and Conflict Rules

Analysis reads package data, filesystem metadata, and Git configuration. It
never imports consumer JavaScript or TypeScript configuration.

- Missing canonical config and hook files are eligible for creation.
- Exact canonical contents and modes are already satisfied and are not
  rewritten.
- A differing unowned canonical file is a conflict before mutation. A
  manifest-owned unchanged file remains eligible for a versioned rewrite.
- `.husky` and every managed path component must be real directories or files;
  symbolic links and non-directory components are conflicts.
- User hook files other than `pre-commit` and `commit-msg` under `.husky/` are
  preserved.
- Any root `lint-staged.config.*` other than the canonical `.mjs` file, any
  `.lintstagedrc*`, or `package.json#lint-staged` configuration is a conflict.
- Nested lint-staged configuration and nested `package.json#lint-staged` are
  conflicts because lint-staged selects the closest configuration for each
  staged file. Generated and dependency trees use the same ignored-directory
  list as Quality and are never followed through symbolic links.
- Any root `commitlint.config.*` other than the canonical `.mjs` file, any
  `.commitlintrc*`, or `package.json#commitlint` configuration is a conflict.
- A direct declaration or package configuration for `simple-git-hooks`,
  `lefthook`, `@evilmartians/lefthook`, or `pre-commit`, and root Lefthook or
  pre-commit configuration files, are conflicts. Frontprep v1 does not merge
  hook managers.
- An unset repository-local `core.hooksPath` is eligible for Husky activation;
  `.husky/_` is recognized. Any other value is a conflict because switching it
  would silently disable another local hook setup.
- Existing non-sample files in Git's default hooks directory are conflicts
  when `core.hooksPath` is unset. Files whose names end in `.sample` are ignored.

Configuration scans report deterministic, sorted paths and stop analysis on
the first issue. Verification reuses the scanners and aggregates every issue.

## Intents

`plan` returns only existing common core intents:

- four `dependency` intents targeting `devDependencies`;
- two `executable-file` intents for the Husky hooks;
- two `managed-file` intents for lint-staged and commitlint configuration;
- one owned `script` intent for `frontprep:prepare`;
- zero or one append-once `script` intent for the conventional `prepare`
  integration, selected by analysis.

Immediate activation is transaction orchestration, not a module change intent.
The module never writes files, modifies Git configuration, installs packages,
or runs mutating commands from `analyze`, `plan`, or `verify`. Analysis and
verification may execute only fixed, read-only Git inspection commands through
core helpers: local `core.hooksPath` lookup and default hooks-directory
resolution.

The module remains out of the default CLI registry until the CI module exists
and all five v1 modules can be registered together. Its contract is exercised
directly and through an injected five-module registry in this branch.

## Verification

Git Hooks verification accumulates issues and checks:

1. every dependency is declared with a valid range intersecting the requested
   range;
2. `frontprep:prepare` is exact and `prepare` contains exactly one recognized
   Husky activation stage;
3. both hook files have canonical bytes and mode `0755`;
4. both JavaScript configuration files have canonical bytes and mode `0644`;
5. no alternate or nested lint-staged configuration, alternate commitlint
   configuration, conflicting hook manager, symbolic link, or unowned managed
   path appeared after installation;
6. repository-local `core.hooksPath` is exactly `.husky/_`;
7. `.husky/_/h`, Husky's internal dispatcher, exists as a real non-symbolic
   file.

Filesystem, package, and Git inspection failures become verification issues
and checking continues. Core structural verification additionally checks the
manifest fingerprint of the four managed files and every managed package
script.

## Test Matrix

Unit and integration tests cover:

- the complete dependency, script, config, hook, content, and mode intent
  contract;
- missing, custom, already-composed, directly invoked, duplicated, and false
  substring `prepare` scripts;
- compatible existing dependencies in either package section and incompatible
  ranges;
- exact canonical files, manifest-backed rewrites, user-owned conflicts,
  non-regular files, and symbolic links in any path component;
- alternate and nested lint-staged configuration, alternate commitlint
  configuration, competing hook managers, and package-level keys;
- default Git hook samples, conflicting local hooks, unset hooks paths,
  recognized `.husky/_`, and conflicting `core.hooksPath` values;
- aggregated verification for dependencies, scripts, file bytes, modes,
  configuration conflicts, the active hooks path, and the Husky dispatcher;
- `GitHooksManager` command arguments, idempotent no-op behavior, activation
  failure restoration, and restoration of both unset and existing Git config;
- successful, no-change, installation-failure, activation-failure, project-
  check-failure, and rollback-producing `runInit` transactions;
- an immediate second init that performs no pnpm installation and leaves all
  tracked bytes unchanged;
- composition after Quality, Tailwind, and Test without registering the module
  by default.

A separate `pnpm verify:git-hooks-compatibility` acceptance fixture applies the
real Quality and Git Hooks plans to a temporary project, performs a real pnpm
10 installation under Node.js 22.22.1, activates Husky, and proves:

- a staged JavaScript or TypeScript file is linted and formatted by the real
  pre-commit hook;
- a valid Conventional Commit message succeeds;
- an invalid commit message is rejected by the real commit-msg hook;
- `core.hooksPath` resolves to `.husky/_` and no package is downloaded during
  hook execution.

The networked compatibility fixture remains separate from the fast
`pnpm check` suite, following the Test module's acceptance-test convention.
