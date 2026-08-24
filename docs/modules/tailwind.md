# Tailwind Module Design

## Role

The Tailwind module installs a Tailwind CSS v4 foundation and the shared class
utilities used by later UI code. It implements the Tailwind responsibility from
the [Frontprep v1 design](../superpowers/specs/2026-08-22-frontprep-v1-design.md)
through the intent and verification contracts defined by the
[CLI core](cli-core.md).

The module derives every application path from the detected Next.js project
context. It supports the v1 application layouts `app/` and `src/app/`; it does
not assume that a consumer uses Frontprep's own repository layout.

## Dependencies

Tailwind contributes these runtime dependencies:

| Package                    | Requested range | Purpose                         |
| -------------------------- | --------------- | ------------------------------- |
| `class-variance-authority` | `^0.7.0`        | Typed component variants        |
| `clsx`                     | `^2.0.0`        | Conditional class construction  |
| `tailwind-merge`           | `^3.0.0`        | Tailwind-aware class resolution |

It also contributes these development dependencies:

| Package                       | Requested range | Purpose                     |
| ----------------------------- | --------------- | --------------------------- |
| `@tailwindcss/postcss`        | `^4.0.0`        | Tailwind v4 PostCSS plugin  |
| `postcss`                     | `^8.0.0`        | CSS transformation pipeline |
| `prettier-plugin-tailwindcss` | `^0.8.0`        | Deterministic class sorting |
| `tailwindcss`                 | `^4.0.0`        | Tailwind CSS v4 engine      |

An existing declaration may remain in either `dependencies` or
`devDependencies` when its valid semver range intersects the requested range.
An invalid or disjoint range is a planning conflict. New runtime declarations
are added to `dependencies`; new build and formatting tools are added to
`devDependencies`.

The package split and configuration follow Tailwind's official
[Next.js guide](https://tailwindcss.com/docs/installation/framework-guides/nextjs),
[PostCSS guide](https://tailwindcss.com/docs/installation/using-postcss), and
the official
[Prettier plugin configuration](https://github.com/tailwindlabs/prettier-plugin-tailwindcss#options).

## Detected Paths

The core adapter provides the application directory, source directory, root
layout, and global stylesheet. Tailwind uses those values without scanning for
a second application root.

The utility directory is selected inside the detected source root. The source
root is `src/` for `src/app/` projects and the project root for `app/` projects.
Tailwind inspects these candidates in order:

1. `<source-root>/shared/utils`
2. `<source-root>/lib/utils`
3. `<source-root>/utils`

If exactly one candidate already exists as a real directory, Tailwind uses it.
If none exists, it creates `<source-root>/shared/utils`. If multiple candidates
exist, or a candidate or any of its path components is a symbolic link or
non-directory entry, analysis fails rather than guessing or following the
link.

This produces `src/shared/utils` by default for a `src/app` project and
`shared/utils` by default for an `app` project.

## Managed and Patched Files

### `postcss.config.mjs`

Tailwind manages the root file with mode `0644`:

```js
const config = {
  plugins: {
    '@tailwindcss/postcss': {},
  },
}

export default config
```

### Detected global stylesheet

Tailwind patches the stylesheet reported by the core adapter with exactly one
canonical first-line import:

```text
@import 'tailwindcss';
```

Existing CSS after the import is preserved, including `@theme`, `@source`,
`@utility`, and user rules. If the root layout did not already import a global
stylesheet, Tailwind also patches that detected layout with a relative,
side-effect import such as:

```ts
import './globals.css'
```

The exact relative path is calculated from the detected layout and stylesheet;
it is never hard-coded to `src/app/globals.css`.

### `<detected-utils>/cn.ts`

Tailwind manages this file with mode `0644`:

```ts
import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs))
}
```

### `<detected-utils>/index.ts`

Tailwind preserves unrelated barrel exports and appends each missing canonical
line once:

```ts
export { cva, type VariantProps } from 'class-variance-authority'
export { cn } from './cn'
```

A different export or declaration of `cn`, `cva`, or `VariantProps` is a
conflict. Static analysis does not import or execute the TypeScript barrel.

### `prettier.config.mjs`

Tailwind contributes this fragment to the core Prettier composer:

```js
{
  plugins: ['prettier-plugin-tailwindcss'],
  tailwindFunctions: ['clsx', 'cn', 'cva'],
  tailwindStylesheet: './<detected-stylesheet>',
}
```

`tailwindStylesheet` is relative to the root Prettier config. The core composer
retains the Quality base values, combines compatible fragments, and keeps
`prettier-plugin-tailwindcss` last as required by the plugin.

## Analysis and Conflict Rules

Analysis reads configuration as text or filesystem metadata and never imports
consumer JavaScript or TypeScript.

- A missing canonical file is eligible for creation.
- Exact canonical `postcss.config.mjs` and `cn.ts` contents are recognized
  without rewriting.
- A differing unowned canonical managed file is a conflict before mutation.
- Alternate PostCSS configuration (`postcss.config.{js,cjs,ts,mts,cts}`,
  `.postcssrc*`, or `package.json#postcss`) is a conflict because a second
  active configuration would be ambiguous.
- Legacy Tailwind configuration (`tailwind.config.{js,cjs,mjs,ts,mts,cts}`) is
  a conflict. Frontprep v1 installs the Tailwind v4 CSS-first contract and does
  not silently migrate JavaScript configuration.
- A stylesheet with no Tailwind import is patchable. Exactly one canonical
  import is compatible. Duplicate imports, a noncanonical import targeting
  `tailwindcss` (including CSS-escaped targets and quoted or unquoted `url()`
  forms), or legacy `@tailwind base`, `@tailwind components`, or
  `@tailwind utilities` directives are conflicts.
- A root layout that already imports the detected stylesheet is preserved. If
  the adapter marks the import as missing, a static relative import is added.
- Each exact, active required barrel line must occur at most once. Comments do
  not count as exports. When a required symbol is absent, its canonical line is
  appended. A commented canonical line, duplicate line, or noncanonical
  declaration or export of a required symbol is a conflict so Frontprep cannot
  create or approve a duplicate.
- Symbolic links are not followed for canonical files, stylesheets, layouts,
  or utility candidates. An unreadable or non-regular required path is a
  conflict.

## Intents

`plan` returns only common core intents:

- seven `dependency` intents;
- one `managed-file` intent for PostCSS;
- one `css-import` intent for the detected stylesheet;
- zero or one `static-import` intent for the detected root layout;
- one `managed-file` intent for `cn.ts`;
- one `line-set` intent containing only missing barrel exports;
- one `config-fragment` intent for Prettier.

The module does not add package scripts. Tailwind participates in the existing
build pipeline through PostCSS; later CI work owns build and aggregate check
stages. The module is not added to the default CLI registry until all five v1
modules exist. Its contract is exercised directly and through the core plan
builder in this branch.

## Verification

Tailwind verification accumulates all issues instead of stopping after the
first failure. It checks:

1. every dependency is declared with a valid range intersecting the requested
   range;
2. `postcss.config.mjs` has the canonical bytes and mode;
3. the detected stylesheet begins with exactly one canonical Tailwind import
   and has no noncanonical import or legacy directive;
4. refreshing project detection finds the same stylesheet connected to the
   root layout;
5. `cn.ts` has the canonical bytes and mode;
6. the utility barrel contains both canonical export lines and no conflicting
   required-symbol declaration;
7. `prettier.config.mjs` contains the plugin, class functions, and detected
   stylesheet exactly once in the core composer's static ESM shape without
   importing it;
8. no alternate PostCSS, legacy Tailwind, package-level, symbolic-link, or
   ambiguous utility-directory conflict appeared after installation.

Per-path filesystem and parse failures become verification issues and checking
continues, so one bad path cannot hide independent dependency or configuration
failures. Core structural verification additionally checks manifest
fingerprints for every managed and patched file.

## Test Matrix

Module tests cover:

- the complete dependency, file, CSS import, layout import, barrel, and
  Prettier intent contract;
- both `src/app` and root `app` projects;
- reuse of each supported existing utility directory and the default path;
- rejection of ambiguous, symbolic-link, and non-directory utility paths;
- preservation of existing CSS and unrelated barrel exports;
- exact canonical projects and idempotent replanning;
- conflicting managed files, alternate PostCSS configuration, package-level
  PostCSS, legacy Tailwind configuration, legacy directives, duplicate or
  noncanonical CSS imports, and conflicting barrel symbols;
- successful verification after applying the plan;
- successful and rollback-producing `runInit` transactions with an injected
  five-module registry and package-manager service;
- aggregated verification failures for dependencies, modes, managed files,
  stylesheet and layout linkage, utility exports, Prettier values, and
  post-install conflicts;
- composition with the Quality Prettier base and application through the core
  plan builder without registering the module by default.
