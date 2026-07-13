### Task 3: Health probe and bundled plugin registration

Source of truth: `docs/superpowers/plans/2026-07-13-fusion-happier-runtime-plan.md`, Task 3.

**Owned files**

- Create `plugins/fusion-plugin-happier-runtime/src/probe.ts`.
- Create `plugins/fusion-plugin-happier-runtime/src/__tests__/probe.test.ts`.
- Modify only the canonical workspace/plugin bundle registries and their exact regression tests listed in Task 3 of the plan.
- Write `.superpowers/sdd/task-3-report.md`.

**Required behavior**

1. Implement `probeHappierRuntime(settings): Promise<HappierRuntimeHealth>` with distinct fields for discovery, executable, server reachability, authentication, daemon, backend availability, readiness, and sanitized diagnostics.
2. Use official non-mutating commands/contracts: executable `--help`, `auth status --json`, `daemon status` (or its structured official equivalent), and a read-only backend/profile availability command verified against the current Happier source/help.
3. `--help` success alone must never mean ready. Readiness requires every required layer for the selected backend.
4. Never expose access keys, tokens, authorization headers, credential paths containing secret values, or raw unbounded stdout/stderr. Reuse the Task 1 redaction and output-boundary helpers.
5. Mirror the existing Hermes bundled-plugin registration across every canonical Fusion workspace, CLI, core, dashboard, desktop, staged-plugin, and source-alias registry. Development aliases must point to `plugins/fusion-plugin-happier-runtime/src/index.ts`, not stale `dist`.
6. Do not add Docker/WSL assumptions. Windows-native paths and executable discovery must work.

**TDD and verification**

- Start with failing tests for missing binary, executable but unauthenticated, server unreachable, daemon stopped, selected backend unavailable, full readiness, malformed JSON, timeout, and redaction.
- Add/extend exact registry regression tests before implementation.
- Run the plugin package tests/typecheck/build plus the narrow CLI/core/dashboard/desktop registry tests from the plan.
- Do not run an unbounded monorepo suite. Record every exact command, result, and proof limitation in the report.
- Commit only Task 3 files with a scoped message; do not push.
