# Node.js 22 Baseline Design

## Context

Frontprep v1 currently declares Node.js 20.9 as its minimum runtime. Node.js
20 reached end of life on 2026-04-30. The maintained ESLint 10 line requires
Node.js 20.19, Node.js 22.13, or Node.js 24, while the maintained lint-staged
17 line required by the upcoming Git Hooks module requires Node.js 22.22.1.
Keeping Node.js 20.9 would force a newly released CLI to generate the
deprecated ESLint 9 line and emit package-manager warnings for consumers.

## Decision

Frontprep v1 requires Node.js `>=22.22.1` before the beta release. This is a
pre-release compatibility correction, not a backward-incompatible change to a
published stable version.

The exact floor is selected from the strictest maintained tool in the planned
v1 dependency graph. It permits ESLint 10, lint-staged 17, commitlint 21,
Next.js 16, pnpm 10, Vitest 4, and the already selected Vite 6 test pipeline.

## Repository Contract

- `package.json#engines.node` is `>=22.22.1`.
- repository Node types use `@types/node@^22.20.0`.
- tsup targets `node22`.
- package metadata tests assert the literal runtime and type ranges.
- README and active architecture/module documentation state Node.js 22.22.1
  or newer.
- historical implementation plans are corrected where they describe the
  active runtime or dependency contract.

Frontprep continues to require pnpm 10 and does not add a custom runtime
version parser. The npm `engines` field remains the package installation
contract, while the production bundle target prevents accidental reliance on
newer Node.js syntax.

## Compatibility Verification

`pnpm verify:package` builds the CLI and then uses the npm `node@22.22.1`
binary to run the existing tarball installation and public-bin smoke test. The
packed `frontprep` executable inherits the same PATH, so its shebang resolves
to the exact supported floor.

`pnpm verify:test-compatibility` continues to apply the real Test module plan,
perform a real pnpm installation, and run the generated Vitest, React Testing
Library, alias-resolution, and jest-dom assertion. Its bootstrap binary and
assertion move from Node.js 20.9.0 to Node.js 22.22.1.

The fast `pnpm check` suite remains network-independent. Networked exact-floor
checks stay in the two explicit `verify:*` commands.

## Scope Boundaries

This migration does not upgrade Test module dependency majors, change
generated configuration bytes, add Git Hooks dependencies, or register any
feature module by default. The Git Hooks branch will rebase after this change
and select the maintained dependency lines allowed by the new floor.

No Node.js 20 compatibility alias or warning mode is provided. Consumers that
must remain on Node.js 20 are outside the v1 beta support matrix.

## References

- [Node.js release schedule](https://github.com/nodejs/Release#release-schedule)
- [ESLint package metadata](https://www.npmjs.com/package/eslint)
- [lint-staged package metadata](https://www.npmjs.com/package/lint-staged)
- [commitlint package metadata](https://www.npmjs.com/package/@commitlint/cli)
