# Task 3 report: Happier health probe and bundled registration

## Outcome

- Added `probeHappierRuntime(settings)` with independent discovery, executable, server, authentication, daemon, selected-backend, and aggregate readiness fields.
- The probe uses only official non-mutating Happier surfaces: selected-backend `--help`, `auth status --json`, `status --json`, and `profiles list --json`.
- Readiness fails closed unless every required layer is true. Diagnostics are fixed bounded codes; raw stdout, stderr, credentials, tokens, and exception text are not returned.
- Registered `fusion-plugin-happier-runtime` in the canonical Fusion CLI/core/staging/dashboard/desktop/workspace registries. Vite and Vitest aliases point to source, not `dist`.
- Corrected the desktop registry test's pre-existing POSIX-only expected path so the same assertion verifies Windows paths.

## Verification

All commands ran from `G:\codex-project\fusion\.worktrees\happier-runtime`.

- `rtk corepack pnpm --filter @fusion-plugin-examples/happier-runtime test` — passed, 4 files / 52 tests.
- `rtk corepack pnpm --filter @fusion-plugin-examples/happier-runtime typecheck` — passed.
- `rtk corepack pnpm --filter @fusion-plugin-examples/happier-runtime build` — passed.
- `rtk corepack pnpm --filter @runfusion/fusion exec vitest run src\plugins\__tests__\bundled-plugin-install.test.ts -t "bundled plugin id set" --reporter=dot --maxWorkers=1` — passed, 1 targeted test.
- `rtk corepack pnpm --filter @runfusion/fusion exec vitest run src\commands\__tests__\plugin.test.ts -t "prints built-in plugin catalog" --reporter=dot --maxWorkers=1` — passed, 1 targeted test.
- `rtk corepack pnpm --filter @fusion/core exec vitest run src\plugins\__tests__\bundled-plugin-install.test.ts -t "includes the full bundled plugin id set" --reporter=dot --maxWorkers=1` — passed, 1 targeted test.
- `rtk corepack pnpm --filter @fusion/dashboard exec vitest run src\__tests__\runtime-plugin-alias-regression.test.ts --reporter=dot --maxWorkers=1` — passed, 2 tests.
- `rtk corepack pnpm --filter @fusion/desktop exec vitest run src\__tests__\bundled-plugin-dirs.test.ts --reporter=dot --maxWorkers=1` — passed, 4 tests.
- `rtk corepack pnpm install --lockfile-only` — passed; workspace lock records the dashboard dependency.

The first combined CLI test invocation was intentionally not counted as proof: it ran two mock-heavy files together and produced existing cross-file mock/path failures plus Windows SQLite `EBUSY` cleanup failures. The exact registry assertions were rerun serially and passed. No monorepo-wide suite was run.

## Live local probe

The built plugin was invoked against the checked-out Happier CLI and the local stack URL `http://localhost:52211`, selecting `codex`. Observed result:

```json
{
  "discovered": true,
  "executable": true,
  "server": false,
  "authenticated": false,
  "daemon": false,
  "backend": true,
  "ready": false,
  "backendId": "codex",
  "details": [
    "authentication-required",
    "server-not-probed",
    "daemon-stopped"
  ]
}
```

This is the expected honest state before the user completes Happier authentication and the daemon is started. It proves CLI/backend discovery and fail-closed health reporting, not an authenticated end-to-end session.

## Remaining boundary

- Live authenticated create/send/history/archive proof remains for the later E2E task.
- Server reachability is not inferred from a configured URL. It becomes true only from official reachability evidence or successful authenticated status validation.
