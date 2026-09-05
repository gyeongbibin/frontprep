# Quality Module Design

## Role

The Quality module installs and configures the deterministic lint, format, and
typecheck foundation used by every later frontprep module. It implements the
Quality responsibility from the [Frontprep v1 design](../superpowers/specs/2026-08-22-frontprep-v1-design.md)
through the intent and verification contracts defined by the
[CLI core](cli-core.md).

Users run the conventional pnpm commands (`pnpm lint`, `pnpm format`,
`pnpm typecheck`, `pnpm quality`, and `pnpm check`). Frontprep keeps the
`frontprep:*` script namespace internally so it can compose and verify its own
pipeline without overwriting an existing project's conventional scripts.

## Dependencies

Quality contributes these development dependencies:

| Package              | Requested range | Purpose                                      |
| -------------------- | --------------- | -------------------------------------------- |
| `eslint`             | `^9.39.0`       | Next.js-compatible ESLint flat-config CLI    |
| `eslint-config-next` | `^16.0.0`       | Next.js Core Web Vitals and TypeScript rules |
| `prettier`           | `^3.0.0`        | Deterministic formatting and format checks   |

ESLint 9.39 is the tested v1 compatibility line because the React plugin
currently selected by `eslint-config-next` 16 declares ESLint support through
major 9 and crashes while loading rules under ESLint 10. Frontprep keeps its
Node.js 22.22.1 runtime floor and will restore ESLint 10 only after the full
Next.js plugin graph supports it.

An existing declaration may remain in either `dependencies` or
`devDependencies` when its valid semver range intersects the requested range.
An invalid or disjoint range is a planning conflict. These ranges follow the
Next.js 16 [ESLint configuration](https://nextjs.org/docs/app/api-reference/config/eslint)
and Prettier [configuration-file](https://prettier.io/docs/configuration) and
[CLI](https://prettier.io/docs/cli) contracts.

## Managed and Patched Files

### `eslint.config.mjs`

Quality manages this file with mode `0644`:

```js
import { defineConfig, globalIgnores } from 'eslint/config'
import nextVitals from 'eslint-config-next/core-web-vitals'
import nextTs from 'eslint-config-next/typescript'

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  globalIgnores(['.next/**', 'out/**', 'build/**', 'next-env.d.ts']),
])

export default eslintConfig
```

This is the official Next.js 16 flat-config composition with Core Web Vitals
and the TypeScript rules. Next.js 16 removed `next lint`, so scripts invoke the
ESLint CLI directly.

### `prettier.config.mjs`

Quality contributes this base fragment to the core Prettier composer:

```js
{
  arrowParens: 'always',
  bracketSameLine: false,
  bracketSpacing: true,
  endOfLine: 'lf',
  printWidth: 100,
  proseWrap: 'preserve',
  semi: false,
  singleQuote: true,
  tabWidth: 2,
  trailingComma: 'all',
  useTabs: false,
}
```

The core renders the fragment as an ESM `prettier.config.mjs`. Tailwind may
later add plugins through the same composer; it cannot replace Quality's base
values.

### `.prettierignore`

Quality patches this line set, preserving unrelated existing lines:

```text
.next
coverage
dist
node_modules
pnpm-lock.yaml
```

### `.editorconfig`

Quality manages this file with mode `0644`:

```ini
root = true

[*]
charset = utf-8
end_of_line = lf
insert_final_newline = true
indent_style = space
indent_size = 2
trim_trailing_whitespace = true

[*.md]
trim_trailing_whitespace = false
```

## Package Scripts

Quality owns these internal scripts:

```json
{
  "frontprep:lint": "eslint . --max-warnings=0",
  "frontprep:lint:fix": "eslint . --fix --max-warnings=0",
  "frontprep:format": "prettier --write .",
  "frontprep:format:check": "prettier --check .",
  "frontprep:typecheck": "tsc --noEmit",
  "frontprep:quality": "pnpm run frontprep:lint && pnpm run frontprep:format:check && pnpm run frontprep:typecheck",
  "frontprep:check": "pnpm run frontprep:quality"
}
```

Later modules extend `frontprep:check` with `append-once` intents. On a project
without the corresponding conventional script, Quality also adds these
aliases:

```json
{
  "lint": "pnpm run frontprep:lint",
  "lint:fix": "pnpm run frontprep:lint:fix",
  "format": "pnpm run frontprep:format",
  "format:check": "pnpm run frontprep:format:check",
  "typecheck": "pnpm run frontprep:typecheck",
  "quality": "pnpm run frontprep:quality",
  "check": "pnpm run frontprep:check"
}
```

Conventional aliases use `preserve-existing`: a user-owned command remains
unchanged. The frontprep-owned scripts use `owned`: an unrecorded differing
command is a conflict, while a command recorded in the manifest may be updated
by a later frontprep version.

`--max-warnings=0` makes warnings fail both the read-only and autofix commands.
The Quality module contract version is `2.0.0`; unchanged manifest-owned v1
commands are upgraded transactionally on the next `init`.

## Analysis and Conflict Rules

Analysis inspects configuration as data or text and never imports consumer
JavaScript.

- A missing canonical config is eligible for creation.
- Exact canonical `eslint.config.mjs`, `.editorconfig`, and Quality-only
  `prettier.config.mjs` contents are recognized without rewriting.
- A differing unowned canonical config is a conflict before mutation.
- Alternate ESLint configuration (`eslint.config.{js,cjs,ts,mts,cts}`,
  `.eslintrc*`, or `package.json#eslintConfig`) is a conflict because creating a
  second active or legacy configuration would make behavior ambiguous.
- Alternate Prettier configuration (`.prettierrc*`, `prettier.config` with an
  extension other than `.mjs`, or `package.json#prettier`) is a conflict for the
  same reason.
- The same file names, nested `.editorconfig` files, and nested package-level
  configuration keys are detected below the project root. Generated trees
  (`.git`, `.next`, `.turbo`, `.worktrees`, `build`, `coverage`, `dist`,
  `node_modules`, and `out`) are excluded, and symbolic-link directories are
  never followed. A configuration file or nested `package.json` symbolic link
  is reported as a conflict without following the link.
- Existing `.prettierignore` content is retained and missing required lines are
  appended once.

## Intents

`plan` returns only common core intents:

- three `dependency` intents;
- seven owned and seven preserve-existing `script` intents;
- two `managed-file` intents for ESLint and EditorConfig;
- one `config-fragment` intent for Prettier;
- one `line-set` intent for `.prettierignore`.

The production CLI registers Quality first in the fixed five-module order. Its
contract is exercised directly, through the core plan builder, and through the
complete public CLI acceptance path.

## Verification

Quality verification accumulates all issues instead of stopping after the
first failure. It checks:

1. each dependency is declared with a valid range intersecting the requested
   range;
2. every frontprep-owned script has its exact command, except
   `frontprep:check`, which must start with exactly one
   `pnpm run frontprep:quality` stage and may contain later modules' appended
   stages;
3. every conventional alias exists, without replacing a preserved user
   command;
4. `eslint.config.mjs` and `.editorconfig` have the canonical bytes and mode;
5. `prettier.config.mjs` contains every required base property in the core
   composer's static ESM shape, without importing the file;
6. `.prettierignore` contains every required line exactly once or more.

The analyzer and verifier share the same non-executing scanner for alternate,
nested, and package-level conflicts. Full canonical-byte ownership is checked
only during analysis. Verification checks the managed ESLint and EditorConfig
files directly and recognizes the required Prettier base properties inside a
legitimate shared composition such as Tailwind's plugin fragment. Verification
also converts per-path filesystem and parse failures into issues and continues,
so one unreadable or non-regular path cannot hide independent dependency,
script, or file failures. Once a manifest exists, core structural verification
still requires the exact final composed `frontprep:check` command recorded by
the transaction.

Core structural verification additionally checks manifest fingerprints and
all recorded managed scripts.

## Test Matrix

Module tests cover:

- the complete intent contract and script policies;
- plan output for dependencies, scripts, files, and modes;
- preservation of existing conventional scripts and ignore entries;
- conflicts from alternate, differing, and incompatible configurations;
- an idempotent exact canonical project;
- successful verification after applying the plan;
- aggregated verification failures for missing dependencies, scripts, config
  properties, ignore lines, wrong file modes, and non-regular paths;
- a later module appending to `frontprep:check`, including duplicate Quality
  stage rejection;
- root, nested, package-level, and post-install configuration conflicts;
- first-run Prettier composition with the Tailwind fragment and symlinked
  configuration rejection.
