# Zero-Warning Quality Design

## Goal

Frontprep must generate a project that finishes ESLint with zero warnings and
must fail future checks when any warning is introduced. A green
`frontprep:check` therefore means both zero errors and zero warnings.

## Script Contract

Quality owns these updated commands:

```text
frontprep:lint      eslint . --max-warnings=0
frontprep:lint:fix  eslint . --fix --max-warnings=0
```

The fix command still applies autofixes, then exits non-zero if non-fixable
warnings remain. Conventional aliases continue to call the owned commands, so
projects with custom `lint` scripts are preserved while Frontprep verification
always uses the strict policy.

This managed-script change advances the Quality module from `1.0.0` to
`2.0.0`. Existing manifest-owned commands are updated transactionally; an
unowned conflicting command remains a planning conflict.

## Generated Configuration Cleanup

Next.js' ESLint preset reports `import/no-anonymous-default-export` for the two
Git Hooks configuration files. Git Hooks renders named constants before their
default exports:

```js
const lintStagedConfig = { /* ... */ }
export default lintStagedConfig

const commitlintConfig = { /* ... */ }
export default commitlintConfig
```

The configuration behavior does not change, but the managed bytes and
verification contract do. The Git Hooks module advances from `2.0.0` to
`3.0.0` so an unchanged managed project receives the cleanup on the next
`init`.

## Verification

Tests must prove:

- both owned lint commands contain `--max-warnings=0` exactly once;
- Quality verification rejects the previous non-strict commands;
- lint-staged and commitlint configurations use named default exports;
- an actual generated five-module project produces no ESLint warnings;
- a deliberate warning makes `frontprep:lint` exit non-zero;
- repeated initialization remains byte-for-byte idempotent;
- module-version expectations are updated to Quality `2.0.0` and Git Hooks
  `3.0.0`.
