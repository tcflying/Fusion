# Task 1 Report: Happier JSON CLI Contract

## Scope

Implemented only the six Task 1 files plus this report:

- `plugins/fusion-plugin-happier-runtime/package.json`
- `plugins/fusion-plugin-happier-runtime/tsconfig.json`
- `plugins/fusion-plugin-happier-runtime/manifest.json`
- `plugins/fusion-plugin-happier-runtime/src/types.ts`
- `plugins/fusion-plugin-happier-runtime/src/cli-spawn.ts`
- `plugins/fusion-plugin-happier-runtime/src/__tests__/cli-spawn.test.ts`
- `.superpowers/sdd/task-1-report.md`

## Implementation

- Added Hermes-pattern package metadata for `@fusion-plugin-examples/happier-runtime`.
- Added typed CLI settings, invocation, error codes, and session result records.
- Added shell-free `spawn` execution with `shell: false`, bounded stdout/stderr, abort handling, timeout termination, and stable process/timeout/JSON/auth/server/daemon/backend/session errors.
- Added redaction for bearer, token, secret, password, API key, authorization, and key fields before diagnostics are retained.
- Added official session create/send/status/history wrappers with argument construction and session/result validation.

## TDD Evidence

RED was observed with the package-local Vitest runner before `src/cli-spawn.ts` existed:

```text
Error: Cannot find module '/src/cli-spawn.js'
```

The brief's workspace-filter command was also attempted, but Task 1 intentionally does not modify `pnpm-workspace.yaml`; it returned `No projects matched the filters` without executing tests.

GREEN was observed with the existing Hermes package Vitest binary from the new package directory:

```text
Test Files  1 passed (1)
Tests       10 passed (10)
```

## Verification

- Focused tests: PASS, 10/10.
- Strict production-source typecheck: PASS using the existing Hermes-installed TypeScript and Node types; the new package cannot run its standard pnpm filter/typecheck until the later workspace-registration task links dependencies.
- `git diff --check`: PASS.
- No service was started, no port 4040 was touched, and no Kimi/Moonshot route or credential field was added.
