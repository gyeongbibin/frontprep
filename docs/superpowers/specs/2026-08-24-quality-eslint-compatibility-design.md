# Quality ESLint Compatibility Design

## Problem

The first real Git Hooks acceptance run installed the current Quality plan and
executed `eslint --fix` against a staged TypeScript file. The run resolved
`eslint@10.9.0`, `eslint-config-next@16.3.2`, and
`eslint-plugin-react@7.37.5`, then failed while loading
`react/display-name` because ESLint 10 no longer provides the context API used
by that plugin.

The package metadata confirms the incompatibility: `eslint-plugin-react`
7.37.5 declares support through ESLint 9.7, while `eslint-config-next` 16.3.2
currently brings that plugin into the generated flat config. TypeScript ESLint
supports both ESLint 9 and 10, so it does not constrain the correction.

## Decision

Frontprep v1 requests `eslint@^9.39.0` for generated consumer projects until
the React plugin used by Next.js declares and demonstrates ESLint 10 support.
The Frontprep repository aligns `eslint` and `@eslint/js` to `^9.39.0` so its
own lint harness exercises the same major.

ESLint 9.39 is marked unsupported upstream now that ESLint 10 is current. That
warning is accepted as a temporary compatibility tradeoff: a deprecated but
working lint pipeline is safer than generating a current package combination
that crashes before evaluating source code. This is an explicit pin, not an
unbounded downgrade policy, and a later compatibility PR may restore ESLint
10 after the complete Next.js plugin graph supports it.

The Node.js runtime remains `>=22.22.1`. No Quality config bytes, scripts,
Prettier policy, project detection, or module ownership rules change.

## Verification Contract

Fast tests pin both generated and repository dependency ranges. A separate
`pnpm verify:quality-compatibility` acceptance fixture runs outside
`pnpm check`: it applies the real Quality plan to a temporary `src/app`
project, installs the declared graph under exact Node.js `v22.22.1`, and runs
the generated `frontprep:lint:fix` and `frontprep:format:check` commands on a
real TypeScript file.

The fixture proves the failure that motivated this correction without making
the networked consumer installation part of the fast repository suite.

## Branch Boundary

This fix lands independently in `develop` before the Git Hooks branch is
rebased. The Git Hooks acceptance fixture then validates the same Quality
pipeline through a real Husky pre-commit hook.
