# Node.js 22 Baseline Design

## Context

Frontprep v1 currently declares Node.js 20.9 as its minimum runtime. Node.js
20 reached end of life on 2026-04-30. ESLint 10 requires Node.js 20.19,
Node.js 22.13, or Node.js 24, while the maintained lint-staged 17 line required
by the Git Hooks module requires Node.js 22.22.1. The later
[Quality ESLint compatibility decision](2026-08-24-quality-eslint-compatibility-design.md)
temporarily pins generated projects to ESLint 9 because Next.js 16's current
React plugin is not compatible with ESLint 10; this does not change the Node
runtime decision.

## Decision

Frontprep v1 requires Node.js `>=22.22.1` before the beta release. This is a
pre-release compatibility correction, not a backward-incompatible change to a
published stable version.

The exact floor is selected from the strictest maintained tool in the planned
v1 dependency graph, lint-staged 17. It also supports commitlint 21, Next.js
16, pnpm 10, Vitest 4, and the selected Vite 6 test pipeline. ESLint remains
at the compatibility-tested 9.39 line until the complete Next.js plugin graph
supports ESLint 10.

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

The fast `pnpm check` suite remains network-independent. When this baseline
shipped, exact-floor checks lived in `verify:package` and
`verify:test-compatibility`. The completed v1 adds separate Quality, Git Hooks,
and CI compatibility commands, so the current exact-floor matrix contains the
package check plus four module compatibility checks.

## Scope Boundaries

At the time of this migration, it did not upgrade Test module dependency
majors, change generated configuration bytes, add Git Hooks dependencies, or
register feature modules by default. Subsequent design-first branches added Git
Hooks and CI, resolved cross-module compatibility, and activated the completed
five-module default registry. Those later changes do not alter this baseline's
Node.js floor.

No Node.js 20 compatibility alias or warning mode is provided. Consumers that
must remain on Node.js 20 are outside the v1 beta support matrix.

## References

- [Node.js release schedule](https://github.com/nodejs/Release#release-schedule)
- [ESLint package metadata](https://www.npmjs.com/package/eslint)
- [lint-staged package metadata](https://www.npmjs.com/package/lint-staged)
- [commitlint package metadata](https://www.npmjs.com/package/@commitlint/cli)
