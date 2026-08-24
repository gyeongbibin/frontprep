# Beta Release Hardening Design

## Context

Frontprep v1 now has a complete production registry in the fixed order
Quality, Tailwind, Test, Git Hooks, and CI. The repository passes its fast
suite with 300 tests and has exact Node.js 22.22.1 compatibility checks for
the published CLI and every module boundary. The package is already versioned
as `0.1.0-beta.0`, but the repository still lacks the release-facing license,
changelog, installation guide, and its own GitHub Actions workflow.

This branch makes the existing beta artifact auditable and reproducible. It
does not add another consumer module or change the generated project policy.

## Release Boundary

This work prepares and independently verifies the beta through a pull request
to `develop`. It may build, pack, install, and execute the actual npm tarball
locally. It may also query npm authentication and package-name availability as
read-only checks.

The following external mutations remain a separate, explicit release gate:

- `npm publish`;
- creating or pushing a version tag;
- creating a GitHub Release;
- promoting or changing an npm dist-tag.

No command in this branch performs those operations. After the branch is
merged and all release checks are green, the operator must explicitly approve
the publish gate.

## Public Package Contract

`package.json` retains:

- package name `@mingyeongbin/frontprep`;
- version `0.1.0-beta.0`;
- public access through `publishConfig.access`;
- Node.js `>=22.22.1` and pnpm `10.22.0` requirements;
- the `frontprep` bin at `dist/cli.js`;
- MIT as the declared license.

Release metadata additionally includes:

- homepage `https://github.com/gyeongbibin/frontprep#readme`;
- issue tracker `https://github.com/gyeongbibin/frontprep/issues`;
- focused discovery keywords for frontend setup, Next.js, pnpm, and tooling.

The repository adds the canonical MIT license text with:

```text
Copyright (c) 2026 Mingyeongbin
```

`npm pack` must include only the license, README, executable bundle and
sourcemap, package metadata, and manifest schema. Tests assert that exact file
set and the executable mode so an accidental source, test, secret, or local
artifact cannot enter the package.

## User Documentation

The README leads with the beta installation and first-use flow:

```sh
pnpm add --save-dev @mingyeongbin/frontprep@beta
pnpm exec frontprep init --cwd .
pnpm exec frontprep check --cwd .
```

It clearly states the clean-Git requirement for first initialization, the
supported project shape, the generated five-module baseline, idempotent reruns,
and the distinction between project-local `pnpm exec` usage and contributor
verification commands.

`CHANGELOG.md` follows Keep a Changelog structure and records
`0.1.0-beta.0` as a prerelease dated 2026-08-24. It summarizes the CLI core,
all five modules, safety guarantees, exact minimum runtime, and packaging and
compatibility verification without claiming a stable release.

## Repository CI

Frontprep's own `.github/workflows/ci.yml` is distinct from the workflow the CI
module generates for consumer projects. It runs on pushes and pull requests
for `develop` and `main`, grants only `contents: read`, cancels stale runs for
the same branch or pull request, disables Husky with `HUSKY=0`, and uses a
20-minute timeout.

The job uses these reviewed immutable action references:

- `actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1`
  (v7.0.1), with persisted credentials disabled;
- `pnpm/action-setup@0e279bb959325dab635dd2c09392533439d90093`
  (v6.0.8), reading pnpm 10.22.0 from `packageManager`;
- `actions/setup-node@820762786026740c76f36085b0efc47a31fe5020`
  (v7.0.0), with exact Node.js 22.22.1 and pnpm lockfile caching.

After `pnpm install --frozen-lockfile`, the workflow runs these commands in
this exact order:

```sh
pnpm check
pnpm verify:package
pnpm verify:quality-compatibility
pnpm verify:test-compatibility
pnpm verify:git-hooks-compatibility
pnpm verify:ci-compatibility
```

The sequence is intentionally explicit. A failure identifies the contract
boundary that failed, and the heaviest complete-project acceptance runs last.
Repository tests parse this workflow and pin its triggers, permissions,
versions, security settings, and command order.

## Installed-Tarball Consumer Verification

The existing package smoke check already packs and installs the public bin,
but the complete five-module acceptance currently invokes `dist/cli.js`
directly from the repository. That leaves a gap: a correct source build could
pass while the published file list or installed resolution fails in a real
consumer.

The CI acceptance test closes the gap by:

1. running `npm pack --json` into a private temporary directory;
2. installing that tarball into an isolated npm prefix with lifecycle scripts
   disabled;
3. resolving the installed
   `node_modules/@mingyeongbin/frontprep/dist/cli.js`;
4. running `init`, an idempotent second `init`, and `check` with that installed
   entry under exact Node.js 22.22.1;
5. applying all five modules to a clean minimal Next.js 16 project and running
   its actual pnpm install, lint, formatting, type check, Vitest, and Next.js
   production build;
6. deleting both the installed package prefix and consumer fixture in `finally`
   blocks.

The acceptance test never falls back to the repository bundle. This makes
`pnpm verify:ci-compatibility` the release-level consumer dry run while keeping
`pnpm verify:package` as the faster public-bin smoke check.

## Failure Handling

All release checks are non-publishing and safe to rerun. Temporary tarballs,
install prefixes, and consumer projects are created under the operating
system's temporary directory and removed whether verification passes or fails.

The repository CI does not receive an npm token and cannot publish. Package
verification installs local tarballs with `--ignore-scripts`, `--no-audit`, and
`--no-fund`. Consumer acceptance retains normal pnpm behavior only inside its
disposable fixture because validating generated dependency installation is
part of the product contract.

## Verification and Integration

The release branch must pass:

```sh
pnpm check
pnpm verify:package
pnpm verify:quality-compatibility
pnpm verify:test-compatibility
pnpm verify:git-hooks-compatibility
pnpm verify:ci-compatibility
```

It then follows the established workflow: draft pull request, repository CI,
independent code review, ready-for-review conversion, and merge to the latest
`develop`. Only after that merge is the explicit external publish gate offered
to the operator.
