# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0-beta.0] - 2026-08-24

### Added

- Added the transactional `frontprep init` and read-only `frontprep check`
  commands with deterministic manifests, conflict detection, and rollback.
- Added the complete fixed v1 module set: Quality, Tailwind, Test, Git Hooks,
  and CI.
- Added project-shape detection for pnpm 10, Next.js 16 App Router, and
  TypeScript 5 projects at a Git repository root.
- Added exact Node.js 22.22.1 package and generated-project compatibility
  verification, including real dependency installation and production builds.
- Added npm tarball installation and public-bin smoke verification.

### Security

- Generated GitHub Actions workflows use least-privilege permissions,
  immutable action SHAs, and disabled persisted Git credentials.
- Dependency mutation is transactional, and Frontprep refuses unsafe or
  ambiguous project state instead of overwriting user-owned configuration.

[0.1.0-beta.0]: https://github.com/gyeongbibin/frontprep/releases/tag/v0.1.0-beta.0
