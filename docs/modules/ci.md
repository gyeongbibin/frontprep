# CI module design

## Scope

The CI module completes the Frontprep v1 module set described by the
[Frontprep v1 design](../superpowers/specs/2026-08-22-frontprep-v1-design.md).
It owns the deterministic production build stage and one GitHub Actions
workflow. It also activates the fixed five-module registry used by the public
`frontprep init` and `frontprep check` commands.

The module works from the detected package and Git worktree root. It does not
inspect a repository name, organization, remote, or consumer-specific source
layout. The workflow runs only package-root commands, so `app/` and `src/app/`
projects share the same CI configuration.

CI does not deploy, publish artifacts, upload coverage, create releases, test a
Node matrix, or manage repository settings in v1. Those are separate policies
and remain user-owned.

## Owned outputs

The module emits three intents:

| Target                     | Intent                    | Contract                                |
| -------------------------- | ------------------------- | --------------------------------------- |
| `frontprep:build`          | owned script              | exactly `next build`                    |
| `frontprep:check`          | append-once script        | adds exactly `pnpm run frontprep:build` |
| `.github/workflows/ci.yml` | managed file, mode `0644` | exact workflow below                    |

Quality creates `frontprep:check` with the quality stage. Test appends its test
stage, and CI appends the build stage. The fixed module order therefore renders:

```text
pnpm run frontprep:quality && pnpm run frontprep:test && pnpm run frontprep:build
```

CI does not add a conventional `build` alias. Existing consumer scripts remain
untouched unless they use a Frontprep-owned name.

## Canonical workflow

```yaml
name: CI

on:
  push:
    branches:
      - develop
      - main
  pull_request:
    branches:
      - develop
      - main

permissions:
  contents: read

concurrency:
  group: ci-${{ github.workflow }}-${{ github.event.pull_request.number || github.ref }}
  cancel-in-progress: true

env:
  HUSKY: '0'

jobs:
  check:
    name: Frontprep check
    runs-on: ubuntu-latest
    timeout-minutes: 20

    steps:
      - name: Checkout
        uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          persist-credentials: false
      - name: Set up pnpm
        uses: pnpm/action-setup@0e279bb959325dab635dd2c09392533439d90093 # v6.0.8
      - name: Set up Node.js
        uses: actions/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7.0.0
        with:
          node-version: '22.22.1'
          cache: pnpm
          cache-dependency-path: pnpm-lock.yaml
      - name: Install dependencies
        run: pnpm install --frozen-lockfile
      - name: Run Frontprep checks
        run: pnpm run frontprep:check
```

Pushes and pull requests targeting `main` or `develop` run one Ubuntu job.
Concurrency is scoped to the workflow and pull-request number when available,
otherwise to the Git ref, so a newer commit cancels stale work without
cancelling a different branch or pull request.

Workflow-level `contents: read` is the only token permission. Checkout also
disables persisted credentials because no later step performs authenticated Git
operations. GitHub documents explicit permissions as the way to minimize
`GITHUB_TOKEN` access, and the Checkout action identifies `contents: read` as
its required permission.

`HUSKY=0` prevents dependency installation from reactivating local hooks on the
ephemeral runner. Installation otherwise runs normal dependency lifecycle
scripts and requires the committed lockfile through `--frozen-lockfile`.

The pnpm setup action reads the exact pnpm 10 version already required in the
consumer's `packageManager` field. Setup Node enables pnpm store caching from
`pnpm-lock.yaml`; it does not cache `node_modules`.

Every action is pinned to a full commit SHA and annotated with its reviewed
release. The selected versions are Checkout 7.0.1, Setup Node 7.0.0, and Setup
pnpm 6.0.8. Frontprep deliberately retains Setup pnpm 6.0.8 for pnpm 10 rather
than the newer pnpm 11-only `pnpm/setup` action.

Primary references:

- [GitHub Actions workflow syntax](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax)
- [GitHub Actions concurrency](https://docs.github.com/en/actions/concepts/workflows-and-actions/concurrency)
- [GitHub Actions security hardening](https://docs.github.com/en/code-security/tutorials/secure-your-organization/protect-against-threats)
- [Checkout action](https://github.com/actions/checkout)
- [Setup Node action and pnpm cache](https://github.com/actions/setup-node)
- [Setup pnpm action](https://github.com/pnpm/action-setup)

## Analysis and conflicts

Analysis is read-only and emits no commands. It inspects the canonical workflow
as bytes and file metadata without parsing or importing consumer code.

Planning is allowed when `.github/workflows/ci.yml` is:

- missing;
- already byte-for-byte canonical with mode `0644`; or
- recorded as a Frontprep-managed file whose current hash still matches the
  manifest, allowing a later Frontprep release to update its own unmodified
  workflow.

Any other existing canonical path is a configuration conflict before mutation.
This includes an unowned regular file, symbolic link, directory, unreadable
path, or user-modified managed workflow. Frontprep does not overwrite or merge
arbitrary workflow YAML.

Other files in `.github/workflows/`, including `ci.yaml`, are user-owned and
preserved. Multiple workflows can serve distinct purposes, and v1 has no sound
non-executing basis for deciding that another filename competes with Frontprep's
workflow.

Script conflicts follow the common core contract:

- an existing differing `frontprep:build` is a conflict;
- `frontprep:check` must contain exactly one recognized quality, test, and
  build stage after all modules compose;
- a missing CI build stage is appended once;
- duplicate build stages are a conflict;
- user-owned conventional scripts are preserved.

## Verification

Verification is read-only and aggregates every issue. It requires:

- `.github/workflows/ci.yml` to match the canonical bytes and mode `0644`;
- `frontprep:build` to equal `next build`;
- `frontprep:check` to contain exactly one quality, test, and build stage in
  that order, with only the conventional `&&` pipeline delimiter;
- no additional action, command, permission, trigger, or environment setting
  in the managed workflow.

Exact workflow verification is intentional. It detects semantic drift without
executing YAML or accepting equivalent but unreviewed action references.
`frontprep check` reports drift and never rewrites it.

## Default registry integration

Until this branch, production command services intentionally had an empty
default registry while module branches exercised injected registries. CI is the
fifth v1 module, so this branch changes the production default to:

```text
quality -> tailwind -> test -> git-hooks -> ci
```

Explicitly injected module arrays remain supported for isolated tests and core
consumers. The registry still rejects duplicate IDs and normalizes any injected
array to the fixed module order.

With the default registry active, a normal `frontprep init` plans all modules in
memory, performs one dependency installation, activates Git Hooks within the
transaction boundary, verifies all modules, runs the full project check, and
writes one manifest containing all five module versions.

## Failure and rollback

CI adds no new mutation mechanism. The common transaction backs up the workflow
and package file before writing. A write, install, hook activation, module
verification, test, or Next build failure restores planned files, modes,
scripts, package metadata, lockfile, and the previous Git hooks path according
to the existing core contract. `.frontprep.json` remains the last write.

Generated build output under `.next/` and package-manager state under
`node_modules/` remain tool-owned ignored directories and are not rolled back.
Frontprep never adds repository secrets or writes GitHub repository settings.

## Test strategy

Unit tests cover:

- exact intents, script ordering, and idempotent repeat planning;
- unowned, modified, wrong-mode, symbolic-link, and non-file workflow conflicts;
- preservation of unrelated workflow files;
- aggregated verification drift;
- YAML parsing of the canonical workflow and every security, trigger, cache,
  action-pin, install, and check field;
- the five-module default registry and explicit injected registry behavior;
- manifest recording for all five modules and the workflow;
- transaction rollback when the project check fails.

Acceptance verification creates a clean minimal Next.js 16 project, runs the
packaged CLI under Node.js 22.22.1 with the production default registry,
installs from a generated lockfile, and proves that:

- all five modules apply through one public `frontprep init`;
- `pnpm run frontprep:check` executes lint, formatting, type checking, Vitest,
  and a real Next production build;
- the generated workflow parses as YAML and matches the canonical policy;
- a second `frontprep init` is byte-for-byte idempotent and skips installation;
- public `frontprep check` succeeds on the installed result.

GitHub-hosted runner execution itself is not emulated locally. The acceptance
test validates every workflow field plus the exact commands the runner will
execute; the merged repository's own GitHub Actions run remains the platform
integration check.
