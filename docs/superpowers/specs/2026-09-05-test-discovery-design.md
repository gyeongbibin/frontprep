# Application Test Discovery Design

## Goal

Frontprep's generated Vitest configuration must run application tests without
collecting repository fixtures, generated output, or unrelated tooling tests.
It must preserve colocated tests and the test directory selected by the project
model.

## Discovery Contract

The Test module derives discovery roots from `ProjectContext.layout`:

- a `src/app` project includes the `src` source root;
- a root `app` project includes the `app` directory;
- the resolved test directory is also included when it is not already inside
  another discovery root;
- duplicate and descendant roots are removed deterministically.

Each root renders one Vitest include pattern:

```text
<root>/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}
```

The generated configuration extends Vitest's default exclusions and also
excludes every `fixtures` and `__fixtures__` directory. This keeps package
manager directories, build output, coverage output, and VCS data excluded by
Vitest while preventing fixture samples named `*.test.*` from executing.

An explicitly selected centralized directory outside the source root remains
supported. Frontprep does not scan arbitrary package directories or infer test
roots from existing files; the detected application layout and persisted test
directory remain the only authorities.

## Managed Configuration

`vitest.config.mts` imports `configDefaults` and `defineConfig` from
`vitest/config`, then renders canonical `include` and `exclude` arrays. The
existing jsdom environment, setup file, TypeScript paths plugin, React plugin,
and `passWithNoTests` behavior remain unchanged.

Because the managed bytes and verification contract change, the Test module
version advances from `2.0.0` to `3.0.0`. An unchanged manifest-owned config is
rewritten transactionally; unowned differing configs remain conflicts.

## Repository Test Stability

The repository package smoke suite builds the CLI in `beforeAll`. That hook
spawns a real build process, so it receives an explicit 30-second timeout rather
than inheriting Vitest's short hook default. The existing four-worker repository
limit remains the concurrency boundary for process-heavy tests.

## Verification

Unit coverage must prove:

- `src/app` projects include `src` once;
- root `app` projects include both `app` and the resolved test directory;
- an explicit external test directory is included without widening discovery;
- fixture directories and Vitest defaults are excluded;
- analysis, planning, and verification use the same canonical bytes;
- Test module version expectations advance to `3.0.0`;
- the package build hook has the explicit timeout.

The compatibility acceptance test creates one real colocated application test,
one selected centralized test, and one failing fixture-shaped test. Running the
owned `frontprep:test` command must execute the two application tests and ignore
the fixture.
