# Task 2 Report — Runtime adapter and durable session identity

Status: DONE

## Scope

- Implemented `HappierRuntimeAdapter` with the Task 1 JSON CLI wrappers.
- Added durable native-id reuse, restart reconciliation, typed recovery failures, bounded ambiguous-send reconciliation, runtime states, and plugin registration.
- Added lifecycle, restart, recovery, ambiguous-send, registration, event, and secret-boundary tests.
- Did not modify `packages/core`, start services, or use/touch port 4040.

## Canonical persistence audit

The existing canonical CLI session record is already durable:

- `packages/core/src/cli-session-types.ts:136` declares `CliSession.nativeSessionId`.
- `packages/core/src/cli-session-store.ts:87,153,165-178,297-299` reads, creates, inserts, and updates the field.
- `packages/core/src/db.ts:1542,5000` includes the SQLite column/schema migration.
- `packages/core/src/__tests__/cli-session-store.test.ts:75-89` updates the id and reopens a fresh store on the same database, proving the same value survives restart.

Audit decision: reuse the existing persisted native id as `session.sessionId`; no core type, store, schema, or test change was needed.

Fresh focused audit proof:

```text
corepack pnpm --filter @fusion/core exec vitest run src/__tests__/cli-session-store.test.ts --silent=passed-only --reporter=dot
Test Files  1 passed (1)
Tests       11 passed (11)
Exit code: 0
```

## TDD evidence

### Initial RED

Command:

```text
corepack pnpm --filter @fusion-plugin-examples/happier-runtime test
```

Observed at 2026-07-13 16:05:59 UTC+8:

```text
Test Files  2 failed | 2 passed (4)
Tests       2 failed | 36 passed (38)
```

Expected failures:

- `runtime-adapter.test.ts`: `runtime-adapter.js` did not exist.
- `index.test.ts`: the Task 1 entrypoint had no default plugin registration (`plugin` was undefined).

### Contract-shape RED

After replacing invented test shapes with Task 1's actual official JSON shapes (`session.active` and `{ type, text }` history content):

```text
corepack pnpm --filter @fusion-plugin-examples/happier-runtime exec vitest run src/__tests__/runtime-adapter.test.ts --silent=passed-only --reporter=dot
Test Files  1 failed (1)
Tests       4 failed | 3 passed (7)
Start       2026-07-13 19:15:08 UTC+8
```

Expected failures: active sessions were not recognized as resumable and accepted messages in official raw-history form were not recognized.

GREEN after the minimal adapter fix:

```text
Test Files  1 passed (1)
Tests       7 passed (7)
Start       2026-07-13 19:15:30 UTC+8
```

### Recovery-state RED

Added assertions that missing and non-resumable persisted sessions become visibly `blocked`:

```text
Test Files  1 failed (1)
Tests       2 failed | 5 passed (7)
Start       2026-07-13 19:16:09 UTC+8
Expected: blocked
Received: recovering
```

GREEN after the state transition fix:

```text
Test Files  1 passed (1)
Tests       7 passed (7)
Start       2026-07-13 19:16:21 UTC+8
```

## Implemented behavior

- First prompt calls `createHappierSession` once and writes the returned native id directly to the Fusion runtime session's `sessionId`.
- Subsequent prompts use the same id.
- A session constructed with a persisted id calls official status before send; the tests assert call order.
- `session.active === true`, explicit resumability, or an allowlisted official live state proves resumability.
- Missing and non-resumable sessions throw `HappierRecoveryError` with stable codes and never call create/send replacement paths.
- Runtime states are limited to `starting`, `ready`, `running`, `waitingOnInput`, `recovering`, `blocked`, `completed`, and `failed`.
- Ambiguous timeout/process/server/daemon sends perform exactly one status call and one bounded history call. A matching accepted prompt is not resent; an absent prompt permits at most one resend; unresolved reconciliation throws a typed failure.
- Plugin metadata exposes runtime id `happier`, emits `happier-runtime:loaded`, retains no provider credential setting, and logs only a static runtime-loaded fact.
- Registration calls a `definePlugin` identity binding statically constrained to the exact `@fusion/plugin-sdk` helper signature. This preserves the SDK helper contract while preventing the package entrypoint from evaluating the SDK's broad core re-exports during Task 1 CLI tests.

## Final verification

```text
corepack pnpm --filter @fusion-plugin-examples/happier-runtime test
Test Files  6 passed (6)
Tests       54 passed (54)
Exit code: 0

corepack pnpm --filter @fusion-plugin-examples/happier-runtime typecheck
tsc --noEmit
Exit code: 0

corepack pnpm --filter @fusion-plugin-examples/happier-runtime build
tsc
Exit code: 0

node --input-type=module -e <dist import assertions>
{"pluginId":"fusion-plugin-happier-runtime","runtimeId":"happier","adapter":"function"}
Exit code: 0

git diff --check
Exit code: 0
```

`git diff --check` emitted only the repository's Windows LF-to-CRLF notices for tracked TypeScript files; it found no whitespace errors.

## Boundaries

- No `packages/core` source changes.
- No service starts/stops.
- No port 4040 operations.
- No credential, secret, Kimi, or Moonshot configuration or routing.
