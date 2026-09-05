# Release Prepack Hotfix Design

## Incident

`@mingyeongbin/frontprep@0.1.0-beta.1` was published from the merged `develop`
worktree without rebuilding its ignored `dist` directory. The package metadata
reported beta.1, but the bundled CLI was the previous beta.0 build. Repository
and release-worktree verification passed because those checks built their own
local bundle; publication did not enforce that invariant.

npm versions are immutable, so the corrected public artifact is
`0.1.0-beta.2`. The `beta` dist-tag moves to beta.2. Beta.1 remains historical
and is marked deprecated after the corrected package is verified.

## Prevention

The package owns this lifecycle script:

```json
{
  "prepack": "pnpm --silent build --silent"
}
```

Both `npm pack` and `npm publish` therefore rebuild `dist` from the checked-out
source immediately before creating the tarball. Publication correctness no
longer depends on which worktree last produced ignored build output.
The silent flags keep `npm pack --json` machine-readable while preserving the
build exit status.

Package metadata tests require the exact `prepack` script. The public smoke
check must execute the registry artifact outside the repository and require
`frontprep --version` to equal the published package version.

## Release

- version: `0.1.0-beta.2`
- npm dist-tag: `beta`
- Git/GitHub tag: `v0.1.0-beta.2`
- source branch: `fix/release-prepack`
- target branch: `develop`

Before merging, run the complete repository check and package verification.
After merging, run `npm pack --dry-run` from `develop` and confirm the bundled
CLI reports beta.2, then publish. Finally verify both the npm dist-tag and a
fresh external `pnpm dlx @mingyeongbin/frontprep@beta --version` invocation.
