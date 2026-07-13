# Fusion Happier Runtime Bridge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a first-class Fusion runtime plugin that creates, continues, supervises, and resumes Happier-owned Codex, Claude Code, and OpenCode sessions, with multi-agent operations and truthful dashboard health.

**Architecture:** A bundled Fusion plugin wraps Happier's documented `--json` CLI commands. Happier owns auth, encryption, transcripts, and provider sessions; Fusion persists the Happier session/run identity and remains the visual scheduler, monitor, evaluator, and recovery controller.

**Tech Stack:** TypeScript, Fusion Plugin SDK, Node child processes, Vitest, React dashboard, Happier JSON CLI.

## Global Constraints

- Do not call undocumented Happier HTTP internals when an official CLI command exists.
- Do not copy Happier bearer tokens, encryption keys, provider credentials, or transcripts into Fusion settings/logs.
- Native Windows support is mandatory; no Docker or WSL.
- Every session uses its own Happier session id unless sharing is explicitly requested.
- Ambiguous message-send failures must be reconciled by status/history, never blindly retried.
- Fusion remains the sole task board and scheduler.
- Behavior changes must follow RED-GREEN TDD.
- Do not enable or route to retired Kimi/Moonshot surfaces.

---

### Task 1: Happier JSON CLI contract

**Files:**
- Create: `plugins/fusion-plugin-happier-runtime/package.json`
- Create: `plugins/fusion-plugin-happier-runtime/tsconfig.json`
- Create: `plugins/fusion-plugin-happier-runtime/manifest.json`
- Create: `plugins/fusion-plugin-happier-runtime/src/types.ts`
- Create: `plugins/fusion-plugin-happier-runtime/src/cli-spawn.ts`
- Create: `plugins/fusion-plugin-happier-runtime/src/__tests__/cli-spawn.test.ts`

**Interfaces:**
- Produces: `resolveHappierCliSettings`, `invokeHappierJson`, `createHappierSession`, `sendHappierMessage`, `getHappierSessionStatus`, `getHappierSessionHistory`, and typed result/error records.

- [ ] **Step 1: Scaffold package metadata from the Hermes plugin pattern**

Use package name `@fusion-plugin-examples/happier-runtime`, runtime id `happier`, plugin id `fusion-plugin-happier-runtime`, and scripts `build`, `typecheck`, and `test` matching the Hermes package.

- [ ] **Step 2: Write failing settings/argument/JSON tests**

```ts
it('builds a source CLI invocation without shell interpolation', () => {
  expect(buildHappierInvocation(['session', 'status', 'abc', '--json'], {
    executable: 'C:\\Program Files\\nodejs\\node.exe',
    entrypoint: 'G:\\codex-project\\happier\\apps\\cli\\dist\\index.mjs',
    serverUrl: 'http://127.0.0.1:52211',
    webappUrl: 'http://127.0.0.1:8081',
  })).toEqual({
    command: 'C:\\Program Files\\nodejs\\node.exe',
    args: ['G:\\codex-project\\happier\\apps\\cli\\dist\\index.mjs', '--server-url', 'http://127.0.0.1:52211', '--webapp-url', 'http://127.0.0.1:8081', 'session', 'status', 'abc', '--json'],
  });
});

it('rejects non-JSON and redacts sensitive output', async () => {
  await expect(parseHappierJson('token=secret-value')).rejects.toMatchObject({ code: 'invalid-json' });
});
```

Cover direct executable mode, source entrypoint mode, server/profile flags, timeout, nonzero exit, malformed JSON, and redaction.

- [ ] **Step 3: Verify RED**

```powershell
corepack pnpm --filter @fusion-plugin-examples/happier-runtime test
```

Expected: FAIL because package/functions do not exist.

- [ ] **Step 4: Implement a shell-free JSON invoker**

Use `spawn(command, args, { shell: false, stdio: ['ignore', 'pipe', 'pipe'] })`, bounded stdout/stderr, an abortable timeout, and a redactor covering bearer/token/secret/key fields. Parse a single JSON envelope and map process, timeout, invalid JSON, authentication, server, daemon, backend, and session failures to stable error codes.

- [ ] **Step 5: Add typed session wrappers**

Construct only official commands:

```ts
['session', 'create', '--path', cwd, '--backend', backend, '--title', title, '--json']
['session', 'send', sessionId, message, '--wait', '--timeout', String(timeoutSeconds), '--json']
['session', 'status', sessionId, '--json']
['session', 'history', sessionId, '--limit', String(limit), '--format', 'raw', '--json']
```

Validate session ids and result shapes before returning.

- [ ] **Step 6: Run tests/typecheck and commit**

```powershell
corepack pnpm --filter @fusion-plugin-examples/happier-runtime test
corepack pnpm --filter @fusion-plugin-examples/happier-runtime typecheck
git add plugins/fusion-plugin-happier-runtime
git commit -m "feat: add Happier JSON CLI contract"
```

---

### Task 2: Runtime adapter and durable session identity

**Files:**
- Create: `plugins/fusion-plugin-happier-runtime/src/runtime-adapter.ts`
- Create: `plugins/fusion-plugin-happier-runtime/src/index.ts`
- Create: `plugins/fusion-plugin-happier-runtime/src/__tests__/runtime-adapter.test.ts`
- Create: `plugins/fusion-plugin-happier-runtime/src/__tests__/index.test.ts`
- Modify if required by persistence audit: `packages/core/src/cli-session-types.ts`, `packages/core/src/cli-session-store.ts`, and their existing tests.

**Interfaces:**
- Consumes: Task 1 session wrappers.
- Produces: `HappierRuntimeAdapter` implementing Fusion `AgentRuntime`, with `session.sessionId` equal to the Happier session id and typed recovery metadata.

- [ ] **Step 1: Inventory existing runtime identity persistence**

Trace Hermes runtime and CLI executor session serialization. If `session.sessionId` already survives Fusion restart, reuse it. If it does not, add a typed `nativeSessionId` field to the canonical CLI session record and migrate callers/tests in the same task.

- [ ] **Step 2: Write failing lifecycle tests**

Test: first prompt creates one Happier session; second prompt sends to the same id; reopening with a persisted id calls status before send; inactive resumable status resumes; missing/non-resumable status returns a typed recovery error without creating a replacement session.

```ts
expect(createSession).toHaveBeenCalledTimes(1);
expect(sendMessage).toHaveBeenNthCalledWith(2, expect.objectContaining({ sessionId: 'hp_session_1' }));
expect(runtimeSession.sessionId).toBe('hp_session_1');
```

- [ ] **Step 3: Verify RED**

```powershell
corepack pnpm --filter @fusion-plugin-examples/happier-runtime test
```

- [ ] **Step 4: Implement create/send/reconcile/recovery state machine**

Use states `starting`, `ready`, `running`, `waitingOnInput`, `recovering`, `blocked`, `completed`, and `failed`. On ambiguous send failure, call status and bounded history once; do not resend unless Happier proves the message was not accepted.

- [ ] **Step 5: Register the plugin manifest/runtime factory**

`definePlugin` must expose runtime metadata, log only non-sensitive health facts, and emit `happier-runtime:loaded` with runtime id/version. It must not receive or mutate Fusion provider credentials.

- [ ] **Step 6: Run tests/typechecks and commit**

```powershell
corepack pnpm --filter @fusion-plugin-examples/happier-runtime test
corepack pnpm --filter @fusion-plugin-examples/happier-runtime typecheck
corepack pnpm --filter @fusion/core test -- cli-session
git add plugins/fusion-plugin-happier-runtime packages/core/src/cli-session-types.ts packages/core/src/cli-session-store.ts
git commit -m "feat: run agents through durable Happier sessions"
```

Stage only core files actually changed.

---

### Task 3: Health probe and bundled plugin registration

**Files:**
- Create: `plugins/fusion-plugin-happier-runtime/src/probe.ts`
- Create: `plugins/fusion-plugin-happier-runtime/src/__tests__/probe.test.ts`
- Modify: `pnpm-workspace.yaml`
- Modify: `packages/cli/src/commands/plugin.ts`
- Modify: `packages/cli/src/plugins/staged-bundled-plugin-ids.ts`
- Modify: `packages/core/src/plugins/bundled-plugin-install.ts`
- Modify: `packages/dashboard/package.json`
- Modify: `packages/dashboard/vitest.config.ts`
- Modify: `packages/cli/vitest.config.ts`
- Modify: `packages/desktop/scripts/workspace-tools.ts`
- Modify: `packages/cli/src/__tests__/bin.test.ts`
- Modify: `packages/cli/src/plugins/__tests__/bundled-plugin-install.test.ts`
- Modify: `packages/core/src/plugins/__tests__/bundled-plugin-install.test.ts`
- Modify: `packages/dashboard/src/__tests__/runtime-plugin-alias-regression.test.ts`
- Modify: `packages/desktop/src/__tests__/bundled-plugin-dirs.test.ts`

**Interfaces:**
- Produces: `probeHappierRuntime(settings): Promise<HappierRuntimeHealth>` with separate discovered/executable/server/authenticated/daemon/backend fields.

- [ ] **Step 1: Write failing probe tests**

Cover binary missing, CLI executable but unauthenticated, server unreachable, daemon stopped, backend unavailable, and fully ready. Assert no credential strings appear in health details.

- [ ] **Step 2: Implement probe with official commands**

Use `--help`, `auth status --json`, `daemon status`, and a non-mutating backend/profile availability command. A successful `--help` alone must not report ready.

- [ ] **Step 3: Add plugin to all canonical workspace/bundle registries**

Mirror every Hermes registry/alias/build entry with Happier values. Update exact existing tests so source aliases point to `plugins/fusion-plugin-happier-runtime/src/index.ts`, never stale `dist` during development.

- [ ] **Step 4: Run package lanes and commit**

```powershell
corepack pnpm --filter @fusion-plugin-examples/happier-runtime test
corepack pnpm --filter @fusion/cli test
corepack pnpm --filter @fusion/dashboard test -- runtime-plugin-alias-regression
corepack pnpm --filter @fusion/desktop test -- bundled-plugin-dirs
git add pnpm-workspace.yaml plugins/fusion-plugin-happier-runtime packages/cli packages/core/src/plugins packages/dashboard/package.json packages/dashboard/vitest.config.ts packages/desktop/scripts/workspace-tools.ts
git commit -m "feat: bundle the Happier runtime plugin"
```

---

### Task 4: Dashboard runtime health and session visibility

**Files:**
- Create: `packages/dashboard/app/components/HappierRuntimeCard.tsx`
- Create: `packages/dashboard/app/components/__tests__/HappierRuntimeCard.test.tsx`
- Modify: `packages/dashboard/app/components/SettingsModal.tsx`
- Modify: `packages/dashboard/app/components/PluginManager.tsx`
- Modify: `packages/dashboard/app/components/settings/section-keys.ts`
- Modify: `packages/dashboard/src/runtime-provider-probes.ts`
- Modify: `packages/dashboard/src/routes/register-runtime-provider-routes.ts`
- Modify: `packages/dashboard/app/components/__tests__/PluginManager.test.tsx`
- Modify: `packages/dashboard/app/components/__tests__/PluginManager.toggle.test.tsx`
- Modify: `packages/dashboard/src/__tests__/plugin-routes.routes.test.ts`
- Modify: `packages/dashboard/src/__tests__/routes-plugin-registry.test.ts`

**Interfaces:**
- Consumes: Task 3 health probe and plugin settings endpoint.
- Produces: a Happier settings/runtime card and authenticated health route with no secrets.

- [ ] **Step 1: Write failing UI and route tests**

Assert the card shows distinct badges for CLI, server, auth, daemon, and backend; session id/resumability appears in live session details; settings save executable/entrypoint/server/backend but never credentials.

- [ ] **Step 2: Implement the card and route**

Follow `HermesRuntimeCard` layout tokens and existing settings APIs. Add a “Happier” runtime section, backend selector limited to `codex`, `claude`, and `opencode`, source-entrypoint fields, and a refresh probe action.

- [ ] **Step 3: Surface session status without a second board**

Reuse existing CLI session banner/run detail components. Map Happier runtime state to existing waiting, blocked, recovering, and running indicators; show a copyable `happier attach <id>` or `happier resume <id>` command when applicable.

- [ ] **Step 4: Run dashboard tests/build and commit**

```powershell
corepack pnpm --filter @fusion/dashboard test
corepack pnpm --filter @fusion/dashboard build
git add packages/dashboard
git commit -m "feat(dashboard): monitor Happier runtime sessions"
```

---

### Task 5: Happier multi-agent operation adapter

**Files:**
- Create: `plugins/fusion-plugin-happier-runtime/src/operations.ts`
- Create: `plugins/fusion-plugin-happier-runtime/src/__tests__/operations.test.ts`
- Modify: `plugins/fusion-plugin-happier-runtime/src/index.ts`
- Modify the canonical Fusion run metadata type/store only if the existing extension metadata field cannot hold operation ids.

**Interfaces:**
- Produces: `startHappierReview`, `startHappierPlan`, `startHappierDelegate`, `waitForHappierRun`, and `readHappierRun`, returning session/run ids plus per-participant state.

- [ ] **Step 1: Write failing operation tests**

Assert exact official command construction for `review start`, `plan start`, `delegate start`, and `run get/list/wait`; verify one failed participant yields partial failure rather than converting unrelated Fusion tasks to blocked.

- [ ] **Step 2: Implement typed operation wrappers**

Validate backend lists, operation ids, participant statuses, and result envelopes. Persist operation/run ids in the owning Fusion run's extension metadata, not in a new task store.

- [ ] **Step 3: Connect operations to runtime/session actions**

Expose review/plan/delegate through the plugin's supported action surface and existing Fusion run detail, retaining Fusion as scheduler and owner.

- [ ] **Step 4: Test and commit**

```powershell
corepack pnpm --filter @fusion-plugin-examples/happier-runtime test
corepack pnpm --filter @fusion/engine test -- happier
git add plugins/fusion-plugin-happier-runtime packages/engine packages/core
git commit -m "feat: expose Happier multi-agent operations"
```

Stage only engine/core files actually changed.

---

### Task 6: Real cross-product E2E

**Files:**
- Test/evidence only; do not add fake-provider fixtures as production proof.

**Interfaces:**
- Consumes: running Happier Windows stack and Fusion development dashboard.
- Produces: exact live evidence for session continuity, recovery, and multi-agent operation behavior.

- [ ] **Step 1: Start both development systems on distinct ports**

Confirm Fusion remains on `4040`; read Happier's generated runtime ports. Record PIDs, health responses, and log paths.

- [ ] **Step 2: Probe real provider availability**

Run current executable/help/auth checks for Codex, Claude Code, and OpenCode through Happier. Separate installed, authenticated, and live-session capable states.

- [ ] **Step 3: Execute Codex continuity proof**

From Fusion create a Happier/Codex session, send two prompts, record the unchanged Happier session id, continue it from Happier CLI/Web, and verify Fusion sees the added history.

- [ ] **Step 4: Execute Claude Code and OpenCode continuity proofs**

Repeat creation and cross-surface continuation. If a provider is unavailable, retain the exact command/error and mark only that provider's live proof blocked.

- [ ] **Step 5: Execute restart recovery proof**

Restart Fusion without killing Happier, then restart Happier without deleting state. Verify the same session id resumes after each restart.

- [ ] **Step 6: Execute one real multi-agent operation**

Use two authenticated backends with `plan start`, `review start`, or `delegate start`; verify per-participant state and final/partial verdict in Fusion.

- [ ] **Step 7: Run final validation**

```powershell
corepack pnpm --filter @fusion-plugin-examples/happier-runtime test
corepack pnpm --filter @fusion-plugin-examples/happier-runtime typecheck
corepack pnpm --filter @fusion/dashboard build
corepack pnpm --filter @fusion/engine test -- happier
git diff --check
git status --short
```

Expected: all local lanes PASS; real proof status reported separately per provider and operation.
