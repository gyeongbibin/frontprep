# Beta.1 Release Design

## Release Identity

- npm package: `@mingyeongbin/frontprep`
- version: `0.1.0-beta.1`
- npm dist-tag: `beta`
- Git tag and GitHub prerelease: `v0.1.0-beta.1`
- target branch: `develop`

The package remains a prerelease. No `latest` dist-tag is created, moved, or
deleted.

## Included Changes

Beta.1 includes the changes already merged to `develop` after beta.0:

- schema v2 with persisted application, stylesheet, utility, and test paths;
- deterministic beta.0 manifest migration;
- static relative and TypeScript-alias stylesheet discovery;
- explicit `--stylesheet`, `--utility-dir`, and `--test-dir` choices;
- package- and repository-scoped transactional file ownership;
- one explicitly selected Next.js package in a pnpm workspace;
- repository-aware Git safety, Husky activation, filtered installs, and CI;
- application-only Vitest discovery with fixture exclusions;
- zero-warning ESLint checks and warning-free managed hook configurations.

## Release Changes

The release branch changes the package version in `package.json` and the CLI
version constant, updates the public CLI version test, adds this release to the
changelog, and clarifies the README support matrix. Manifest fixtures that
intentionally represent beta.0 remain unchanged so migration and upgrade
coverage is preserved.

## Verification and Publication

Before the PR is ready:

1. install exactly from `pnpm-lock.yaml`;
2. run `pnpm check`;
3. run `pnpm verify:package`;
4. run all four generated-project compatibility checks;
5. inspect `npm pack --dry-run` and verify the package version;
6. require the GitHub Release checks to pass.

After merging, publication uses the exact merged commit. Verify npm identity,
publish with public access and the `beta` dist-tag, verify the registry version
and dist-tag, create and push the annotated Git tag, then create a GitHub
prerelease. If npm requires browser/2FA authorization, publication pauses only
for that authentication step and resumes from the unchanged release commit.

## Consumer Commands

Standalone project:

```sh
pnpm dlx @mingyeongbin/frontprep@beta init --cwd .
```

Selected workspace package:

```sh
pnpm dlx @mingyeongbin/frontprep@beta init --cwd apps/web
```

Read-only verification uses the corresponding `check` command. Pinning
`@mingyeongbin/frontprep@0.1.0-beta.1` is supported for reproducible trials.
