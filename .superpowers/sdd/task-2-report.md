# Task 2 Follow-up Report — Runtime adapter and durable session identity

Status: DONE

## Reopen reason

Independent review correctly found that the first Task 2 commit (`b98dbe196`) used a plugin-local `AgentRuntimeOptions.sessionId` shape that no engine caller supplied. It also allowed a duplicate send after ambiguous absence, treated `send --wait` metadata as output, lacked per-session serialization, used a local `definePlugin` identity, and had divergent versions. Those claims are superseded by this report.

## Real engine and persistence path

- The production runtime creation path is `createResolvedAgentSession` → resolved plugin runtime → `runtime.createSession(AgentRuntimeOptions)`.
- `packages/engine/src/agent-runtime.ts` now owns `AgentRuntimeNativeSessionBinding` and `createCliSessionNativeSessionBinding`.
- The helper reads `CliSession.nativeSessionId` from the canonical `CliSessionStore` and persists through `CliSessionStore.updateSession(..., { nativeSessionId })`.
- Happier imports the real engine contract from `@fusion/engine/agent-runtime`; the plugin-local fake runtime option interfaces were removed.
- A newly-created Happier id is awaited through `persistNativeSessionId` before history or send. Persistence failure blocks and sends zero messages.
- A fresh binding after restart re-reads the durable id. The adapter starts in recovery, calls official status, and only then sends. Missing/non-resumable records remain blocked and are never silently replaced.
- No core source/schema change was needed: `CliSession.nativeSessionId` and `CliSessionStore.updateSession` were already durable canonical storage.

Focused engine integration proof uses the actual `createResolvedAgentSession`, actual `HappierRuntimeAdapter`, and an actual SQLite-backed `CliSessionStore` to prove:

```text
first runtime create -> hp_engine_durable persisted before send
fresh CliSessionStore + fresh adapter -> hp_engine_durable loaded
official status call -> second send
createHappierSession call count = 1
```

## Runtime behavior fixed

- A WeakMap-backed queue serializes all work for one runtime session. `Promise.all` on two first prompts creates one native session and sends in order. Different session objects can send concurrently.
- Ambiguous timeout/process/server/daemon outcomes perform one bounded status/history reconciliation and never resend. Only a newly-added matching user message after the pre-send watermark proves acceptance; history absence yields typed `ambiguous-send-unresolved` with state `blocked` and one send total.
- Each send captures bounded pre-send history, calls official `send --wait`, then reads bounded official history and status. Assistant output is selected from newly-added messages, correlated with `localId` when available, and emitted through `onText`; old assistant text is not replayed.
- Final runtime state is mapped from official status. Explicit `resumable:true` overrides `active:false`; explicit non-resumability blocks.
- The outer error handler preserves `blocked` for missing, non-resumable, persistence, and unresolved ambiguous recovery failures.
- `definePlugin` is imported from `@fusion/plugin-sdk`. Package, JSON manifest, runtime metadata, plugin manifest, and loaded-event versions are all `0.2.73`, with a test enforcing equality.
- No provider credential or secret surface was added.

## TDD evidence

### Critical-review RED

Command:

```text
corepack pnpm --filter @fusion-plugin-examples/happier-runtime exec vitest run src/__tests__/runtime-adapter.test.ts src/__tests__/index.test.ts --silent=passed-only --reporter=dot
```

Observed 2026-07-13 19:40:55 UTC+8:

```text
Test Files  2 failed (2)
Tests       12 failed | 3 passed (15)
```

Failures covered missing canonical persistence, restart reuse, blocked-state preservation, concurrent creation, send serialization, assistant output/no replay, no-resend ambiguity, persistence-before-send, real SDK registration, and version equality.

Engine binding RED at 2026-07-13 19:41:04 UTC+8:

```text
Test Files  1 failed (1)
Tests       2 failed (2)
TypeError: createCliSessionNativeSessionBinding is not a function
```

### Critical-review GREEN

Focused adapter/registration GREEN at 2026-07-13 19:46:41 UTC+8:

```text
Test Files  2 passed (2)
Tests       15 passed (15)
```

Direct engine/store/adapter integration GREEN at 2026-07-13 19:49:28 UTC+8:

```text
Test Files  1 passed (1)
Tests       3 passed (3)
```

### Explicit inactive-resumable RED/GREEN

The plan-required `active:false, resumable:true` case was added separately.

RED at 2026-07-13 19:50:56 UTC+8:

```text
Test Files  1 failed (1)
Tests       1 failed | 12 passed (13)
HappierRecoveryError: Happier session hp_session_1 is not resumable
```

GREEN at 2026-07-13 19:51:12 UTC+8:

```text
Test Files  1 passed (1)
Tests       13 passed (13)
```

### Build/test discovery regression

Running package test and build concurrently exposed that Vitest could discover generated `dist/__tests__` mid-run (`1 failed | 66 passed`). The package test script was narrowed to `vitest run src ...`. With `dist` present, the stable package test is GREEN:

```text
Test Files  3 passed (3)
Tests       34 passed (34)
Start       2026-07-13 19:52:26 UTC+8
```

## Final verification

```text
corepack pnpm --filter @fusion-plugin-examples/happier-runtime test
Test Files  3 passed (3)
Tests       34 passed (34)
Exit code: 0

corepack pnpm --filter @fusion-plugin-examples/happier-runtime typecheck
tsc --noEmit
Exit code: 0

corepack pnpm --filter @fusion-plugin-examples/happier-runtime build
tsc
Exit code: 0

corepack pnpm --filter @fusion/engine exec vitest run src/__tests__/agent-runtime-native-session.test.ts --silent=passed-only --reporter=dot
Test Files  1 passed (1)
Tests       3 passed (3)
Exit code: 0

corepack pnpm --filter @fusion/engine typecheck
tsc --noEmit
Exit code: 0

corepack pnpm --filter @fusion/engine build
tsc
Exit code: 0

node --input-type=module -e <dist import assertions>
{"pluginId":"fusion-plugin-happier-runtime","pluginVersion":"0.2.73","runtimeId":"happier","runtimeVersion":"0.2.73","adapter":"function"}
Exit code: 0
```

`git diff --check` is run again immediately before commit. It may print the repository's Windows LF-to-CRLF notices; those are not whitespace errors.

## Boundaries and audit notes

- No `packages/core` source/schema file changed.
- No service was started or stopped; port 4040 was not touched.
- No Kimi/Moonshot route, configuration, or package was used.
- Generated `.codegraph` was removed before final verification at the user's request.
- A root offline install attempt was blocked by an unrelated uncached WhatsApp dependency tarball. It downloaded nothing and changed no lock data. The single deterministic workspace link for `@fusion/engine` was added to `pnpm-lock.yaml`; package tests, typecheck, build, and dist import all pass.
