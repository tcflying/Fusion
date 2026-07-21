# Fusion Task-Bound Happier Direct Session Implementation Plan

> **For implementation:** Use `superpowers:executing-plans` to execute this plan task by task. Follow RED-GREEN-REFACTOR and commit after each completed task. Complete the Happier CLI plan first.

**Goal:** Let an operator attach one paused Fusion task to one existing Codex, Claude Code, or OpenCode session through Happier, see the durable binding in the task detail UI, open the corresponding Happier page, survive Fusion restarts, and later resume the same native session without creating a duplicate.

**Architecture:** Fusion calls the public `happier direct-session ensure` command through the existing argument-safe Happier runtime plugin. A task-scoped dashboard route validates the paused task, asks Happier to ensure the link, then atomically claims the returned native session ID in Fusion's existing CLI session store using the deterministic key `executor:<taskId>:primary`. Non-secret binding metadata is kept under `autonomyPosture.happierDirectSession`; the browser URL is rebuilt from current plugin settings. A project-local bridge agent is created/reused and explicitly assigned only after the binding succeeds. Connecting never starts execution or sends a prompt.

**Tech stack:** TypeScript, Fusion plugin SDK, SQLite/Postgres task stores, Express dashboard API, React task-detail UI, Vitest/React Testing Library, pnpm workspaces, Happier CLI.

**Source design:** `docs/superpowers/specs/2026-07-15-happier-existing-session-task-binding-design.md`

**Prerequisite plan:** `G:\codex-project\happier\docs\superpowers\plans\2026-07-15-direct-session-cli-ensure-plan.md`

---

## Binding contract and safety boundary

The dashboard API is task-scoped:

```text
GET  /api/tasks/:taskId/happier-direct-session?projectId=<project-id>
POST /api/tasks/:taskId/happier-direct-session
```

POST body:

```json
{
  "projectId": "project-id",
  "uri": "codex://threads/019f22f6-6581-7781-bb37-84cf4d63d81d",
  "machineId": "optional-exact-machine-id"
}
```

Connected response:

```json
{
  "connected": true,
  "taskId": "fusion-task-id",
  "cliSessionId": "cli-happier-execute-<deterministic-digest>",
  "nativeSessionId": "happier-session-id",
  "providerId": "codex",
  "remoteSessionId": "019f22f6-6581-7781-bb37-84cf4d63d81d",
  "machineId": "machine-id",
  "serverId": "server-profile-id",
  "openUrl": "http://127.0.0.1:18287/session/happier-session-id?serverId=server-profile-id",
  "created": false
}
```

Required invariants:

- Only a paused, non-terminal, non-deleted task may be linked.
- Linking does not create a worktree, start an executor, move task status, or send a prompt.
- The Fusion CLI-session identity is deterministic from `executor:<taskId>:primary` and runtime `happier`.
- A task can claim only one Happier native session. Repeating the same link is idempotent; a different native ID returns 409.
- The native ID claim and binding metadata update are atomic inside the task store transaction/serialized write path available to that backend.
- `openUrl` is never persisted. GET rebuilds it from current Happier plugin `webappUrl` and the persisted `serverId`/`nativeSessionId`.
- The project-local bridge agent uses `{ runtimeHint: 'happier', assignmentPolicy: 'explicit-only', allowParallelExecution: true, autoClaimRelevantTasks: false }`.
- A connect failure leaves the task unassigned and unbound.
- A browser popup failure does not roll back a successful durable binding.

## Task 1: Add the Happier Direct Session plugin wrapper

**Files:**

- Modify: `plugins/fusion-plugin-happier-runtime/src/cli-spawn.ts`
- Modify: `plugins/fusion-plugin-happier-runtime/src/types.ts`
- Modify: `plugins/fusion-plugin-happier-runtime/src/index.ts`
- Modify: `plugins/fusion-plugin-happier-runtime/src/__tests__/cli-spawn.test.ts`

### Step 1: Write failing wrapper tests

Add tests for a public wrapper:

```ts
export type HappierDirectSessionEnsureResult = {
  providerId: 'codex' | 'claude' | 'opencode';
  remoteSessionId: string;
  machineId: string;
  serverId: string;
  sessionId: string;
  created: boolean;
  openUrl: string;
};

export async function ensureHappierDirectSession(input: {
  uri: string;
  machineId?: string;
  settings: HappierCliSettings;
}): Promise<HappierDirectSessionEnsureResult>;
```

Pin the exact child-process arguments:

```text
direct-session ensure --uri <uri> [--machine-id <id>] --json
```

The test must also prove:

- executable/server/profile/home settings use the existing argument-safe spawn path;
- no shell is enabled;
- expected JSON kind is exactly `direct_session_ensure`;
- malformed envelopes, wrong kinds, and non-zero exits preserve typed errors;
- values containing spaces or shell metacharacters remain a single argv value;
- `buildHappierSessionOpenUrl` normalizes a trailing slash and encodes IDs.

Run:

```powershell
rtk corepack pnpm --filter @fusion-plugin-examples/happier-runtime exec vitest run src/__tests__/cli-spawn.test.ts
```

Expected RED: missing wrapper/export or expectation mismatch.

### Step 2: Implement through the existing JSON invocation helper

Call `invokeHappierJsonForKind` with the exact expected kind. Do not add a second process runner. Export both the result type and wrapper from `src/index.ts`.

Keep the plugin result normalized: reject a result whose `providerId`, `remoteSessionId`, or `sessionId` is empty even if the envelope says `ok: true`.

### Step 3: Re-run the plugin test and typecheck

```powershell
rtk corepack pnpm --filter @fusion-plugin-examples/happier-runtime exec vitest run src/__tests__/cli-spawn.test.ts
rtk corepack pnpm --filter @fusion-plugin-examples/happier-runtime typecheck
```

Expected GREEN: tests pass and TypeScript exits 0.

### Step 4: Commit

```powershell
rtk git add plugins/fusion-plugin-happier-runtime/src/cli-spawn.ts plugins/fusion-plugin-happier-runtime/src/types.ts plugins/fusion-plugin-happier-runtime/src/index.ts plugins/fusion-plugin-happier-runtime/src/__tests__/cli-spawn.test.ts
rtk git commit -m "feat(happier): wrap direct session ensure CLI"
```

## Task 2: Add durable CLI-session metadata updates

**Files:**

- Modify: `packages/core/src/async-cli-session-store.ts`
- Modify: `packages/core/src/__tests__/async-cli-session-store.test.ts`
- Reference: the synchronous `CliSessionStore.updateSession` implementation

### Step 1: Write the failing async-store test

Add `CliSessionUpdateInput` and `AsyncCliSessionStore.updateSession(id, update)`. Test:

- updating `nativeSessionId`, `agentState`, and `autonomyPosture` returns the updated row;
- omitted properties are preserved;
- `undefined` means no change, while an explicitly supported nullable field follows the synchronous store semantics;
- an unknown session ID returns the same not-found behavior as the synchronous store;
- JSON objects are serialized once and read back without shape drift.

Run:

```powershell
rtk corepack pnpm --filter @fusion/core exec vitest run src/__tests__/async-cli-session-store.test.ts
```

Expected RED: `updateSession` does not exist.

### Step 2: Implement parity with the synchronous store

Mirror the synchronous field whitelist and JSON serialization. Do not add raw SQL fields that the synchronous store cannot represent. Use the existing query adapter and timestamp conventions.

### Step 3: Re-run tests and typecheck

```powershell
rtk corepack pnpm --filter @fusion/core exec vitest run src/__tests__/async-cli-session-store.test.ts
rtk corepack pnpm --filter @fusion/core typecheck
```

Expected GREEN: store tests and typecheck pass.

### Step 4: Commit

```powershell
rtk git add packages/core/src/async-cli-session-store.ts packages/core/src/__tests__/async-cli-session-store.test.ts
rtk git commit -m "feat(core): update async CLI session metadata"
```

## Task 3: Implement deterministic, idempotent task binding

**Files:**

- Modify: `packages/engine/src/agent-runtime.ts`
- Create: `packages/engine/src/happier-direct-session-binding.ts`
- Create: `packages/engine/src/__tests__/happier-direct-session-binding.test.ts`
- Modify: `packages/engine/src/index.ts`

### Step 1: Write failing deterministic-ID and binding tests

Extract and export the existing ID calculation without changing its value:

```ts
export function resolveTaskHappierCliSessionId(input: {
  taskId: string;
  purpose: 'execute';
}): string;
```

Test that it equals the ID already produced by `createTaskStoreNativeSessionBinding` for:

```text
runtimeHint = happier
sessionKey = executor:<taskId>:primary
purpose = execute
```

Add a binding service contract:

```ts
export type TaskHappierDirectSessionBinding = {
  cliSessionId: string;
  nativeSessionId: string;
  providerId: 'codex' | 'claude' | 'opencode';
  remoteSessionId: string;
  machineId: string;
  serverId: string;
  linkedAt: string;
};

export async function bindTaskHappierDirectSession(input: {
  store: Store;
  taskId: string;
  worktreePath?: string | null;
  ensured: HappierDirectSessionEnsureMetadata;
}): Promise<TaskHappierDirectSessionBinding>;

export async function readTaskHappierDirectSessionBinding(input: {
  store: Store;
  taskId: string;
}): Promise<TaskHappierDirectSessionBinding | null>;
```

The RED tests must cover both async/Postgres-style and sync/SQLite-style stores:

- first bind creates/reuses deterministic CLI session and claims the Happier session ID;
- metadata is under `autonomyPosture.happierDirectSession` and preserves unrelated posture keys;
- repeated same-ID bind returns the same data and does not duplicate a row;
- different-ID bind raises a typed conflict;
- claim failure leaves no false connected metadata;
- read ignores malformed/stale metadata and reports a typed integrity error when native ID and metadata disagree;
- `openUrl` is absent from persisted metadata.

Run:

```powershell
rtk corepack pnpm --filter @fusion/engine exec vitest run src/__tests__/happier-direct-session-binding.test.ts
```

Expected RED: missing module and helper export.

### Step 2: Implement using the existing native-session binding primitive

Call `createTaskStoreNativeSessionBinding` with the exact executor session key. Claim the returned Happier `sessionId` before writing connected metadata. For backends that cannot wrap both writes in a database transaction, use the store's serialized mutation path and make every retry idempotent; never mark metadata connected before a successful claim.

The engine package must not import the Happier plugin package. Define a small normalized metadata input locally so engine remains provider-adapter independent.

### Step 3: Re-run binding and adjacent runtime tests

```powershell
rtk corepack pnpm --filter @fusion/engine exec vitest run src/__tests__/happier-direct-session-binding.test.ts src/__tests__/agent-runtime-postgres-native-session.test.ts src/__tests__/agent-runtime-layers.test.ts
rtk corepack pnpm --filter @fusion/engine typecheck
```

Expected GREEN: deterministic ID is unchanged, the new binding tests and both existing native-session/runtime-layer tests pass, and typecheck exits 0.

### Step 4: Commit

```powershell
rtk git add packages/engine/src/agent-runtime.ts packages/engine/src/happier-direct-session-binding.ts packages/engine/src/__tests__/happier-direct-session-binding.test.ts packages/engine/src/index.ts
rtk git commit -m "feat(engine): bind tasks to Happier direct sessions"
```

## Task 4: Add task-scoped dashboard API routes and bridge-agent assignment

**Files:**

- Create: `packages/dashboard/src/routes/register-happier-direct-session-routes.ts`
- Create: `packages/dashboard/src/routes/__tests__/register-happier-direct-session-routes.test.ts`
- Modify: `packages/dashboard/src/routes.ts`
- Use: `packages/core/src/agent-store.ts`

### Step 1: Write failing GET/POST route tests

Build the route registrar with injected dependencies so tests use a fake Happier CLI result and real in-memory task/session stores.

Pin GET behavior:

- 404 for an unknown/deleted task;
- `{connected:false}` when no binding exists;
- connected result returns persisted IDs and a newly rebuilt `openUrl`;
- a changed plugin `webappUrl` changes GET's URL without modifying stored metadata;
- malformed binding metadata returns a typed integrity error, not false success.

Pin POST guards:

- rejects done, archived, in-progress, in-review, deleted, or unpaused tasks before calling Happier;
- accepts a paused, non-terminal task;
- calls `ensureHappierDirectSession` exactly once with configured plugin settings;
- same binding is idempotent;
- different native session returns 409;
- CLI `daemon_unavailable`, `auth_required`, `candidate_not_found`, `candidate_ambiguous`, and `machine_mismatch` codes retain machine-readable response codes;
- CLI failure leaves no binding and no agent assignment;
- success does not create a worktree, start the executor, send a prompt, or change task workflow status.

Pin bridge-agent behavior:

- finds or creates one project-local agent named `Happier Session Bridge`;
- runtime config is exactly:

```json
{
  "runtimeHint": "happier",
  "assignmentPolicy": "explicit-only",
  "allowParallelExecution": true,
  "autoClaimRelevantTasks": false
}
```

- explicitly assigns the task after binding succeeds;
- a retry reuses the same bridge agent;
- a pre-existing same-name agent with incompatible runtime config produces a conflict instead of silently rewriting user configuration.

Run:

```powershell
rtk corepack pnpm --filter @fusion/dashboard exec vitest run --project dashboard-api src/routes/__tests__/register-happier-direct-session-routes.test.ts
```

Expected RED: registrar/module does not exist.

### Step 2: Implement the registrar and mount it

Use `getProjectContext(req)` for project scoping. Resolve current Happier plugin settings through the existing dashboard plugin store/runtime configuration; do not read a new environment variable or hard-code `127.0.0.1`.

GET must call the engine read helper and `buildHappierSessionOpenUrl`. POST order must be:

```text
validate project/task and paused state
resolve Happier plugin settings
call Happier ensure CLI
atomically bind/claim native session
find or create compatible project bridge agent
explicitly assign task
return connected response
```

If bridge-agent assignment fails after a successful binding, return a typed partial error that says the session is bound but assignment failed. Do not delete the valid binding or create a second session on retry.

### Step 3: Run focused route and adjacent task-route tests

```powershell
rtk corepack pnpm --filter @fusion/dashboard exec vitest run --project dashboard-api src/routes/__tests__/register-happier-direct-session-routes.test.ts src/routes/__tests__/register-task-workflow-routes.unpause.test.ts src/routes/__tests__/register-task-workflow-routes.runtime-fallback.test.ts
rtk corepack pnpm --filter @fusion/dashboard typecheck
```

Expected GREEN: route contract and existing task workflow behavior pass.

### Step 4: Commit

```powershell
rtk git add packages/dashboard/src/routes/register-happier-direct-session-routes.ts packages/dashboard/src/routes/__tests__/register-happier-direct-session-routes.test.ts packages/dashboard/src/routes.ts
rtk git commit -m "feat(dashboard): add task Happier session routes"
```

## Task 5: Add the task-detail Happier connection card

**Files:**

- Create: `packages/dashboard/app/components/HappierDirectSessionCard.tsx`
- Create: `packages/dashboard/app/components/__tests__/HappierDirectSessionCard.test.tsx`
- Modify: `packages/dashboard/app/components/TaskDetailModal.tsx`
- Modify: `packages/dashboard/app/components/__tests__/TaskDetailModal.terminal-tab.test.tsx`
- Modify: `packages/dashboard/app/api.ts`
- Modify: `packages/dashboard/app/components/TaskDetailModal.css`

### Step 1: Write failing component/API tests

The disconnected card must show:

- `Happier Direct Session` status;
- native Session URI input;
- Connect button;
- a collapsed optional machine-ID input or a machine selector when the API reports ambiguity;
- daemon/auth/not-found errors with stable codes and retry action.

The connected card must show:

- provider, native ID, Happier ID, machine ID, and server ID;
- `Open in Happier` button;
- copy controls for long IDs;
- a clear `Bound, not running` state while the task remains paused.

Test these behaviors:

- GET runs when task detail opens;
- Connect POST uses the current task/project and exact URI;
- successful POST updates the card and calls `window.open(openUrl, '_blank', 'noopener,noreferrer')`;
- popup failure leaves the card connected and exposes a clickable fallback link;
- repeat Connect is disabled while a request is pending;
- terminal tab still renders and its existing continuation information remains intact;
- the card is visible before a live process exists;
- long IDs use wrapping/truncation plus accessible full-value copy controls;
- narrow layout stacks actions and does not require horizontal scrolling.

Run:

```powershell
rtk corepack pnpm --filter @fusion/dashboard exec vitest run --project dashboard-app app/components/__tests__/HappierDirectSessionCard.test.tsx app/components/__tests__/TaskDetailModal.terminal-tab.test.tsx
```

Expected RED: component/API exports missing.

### Step 2: Add typed API functions

In `packages/dashboard/app/api.ts`, add typed GET/POST helpers matching the server response. Preserve stable error codes in the thrown/UI error object rather than collapsing everything to `Request failed`.

### Step 3: Implement and mount the card

Mount the card in the task summary/routing area, not only inside the terminal tab. Use the existing component library and task-detail design tokens. Do not introduce a separate modal or global control plane.

The card must not offer a Start action. Starting remains the normal Fusion task action after the operator has inspected the binding.

### Step 4: Add responsive styling

At desktop width, keep status and actions compact. At narrow/mobile width, stack URI input and controls, apply `min-width: 0` to flex children, and use `overflow-wrap: anywhere` for identifiers. Avoid fixed widths wider than the task modal.

### Step 5: Re-run UI tests and typecheck

```powershell
rtk corepack pnpm --filter @fusion/dashboard exec vitest run --project dashboard-app app/components/__tests__/HappierDirectSessionCard.test.tsx app/components/__tests__/TaskDetailModal.terminal-tab.test.tsx
rtk corepack pnpm --filter @fusion/dashboard typecheck
```

Expected GREEN: card behavior, terminal regression, and typecheck pass.

### Step 6: Commit

Stage the component, tests, API client, and the stylesheet directly imported by `TaskDetailModal.tsx`:

```powershell
rtk git status --short
rtk git add packages/dashboard/app/components/HappierDirectSessionCard.tsx packages/dashboard/app/components/__tests__/HappierDirectSessionCard.test.tsx packages/dashboard/app/components/TaskDetailModal.tsx packages/dashboard/app/components/__tests__/TaskDetailModal.terminal-tab.test.tsx packages/dashboard/app/api.ts
rtk git add packages/dashboard/app/components/TaskDetailModal.css
rtk git commit -m "feat(dashboard): show task Happier session binding"
```

## Task 6: Prove prebound runtime reuse and no duplicate session creation

**Files:**

- Modify: `plugins/fusion-plugin-happier-runtime/src/__tests__/runtime-adapter.test.ts`
- Modify only if the new regression test fails for a real defect: `plugins/fusion-plugin-happier-runtime/src/runtime-adapter.ts`

### Step 1: Add the failing regression test

Create a prebound CLI-session record whose `nativeSessionId` equals the ensured Happier session ID. Start the runtime adapter and assert:

- `createHappierSession` is never called;
- the adapter refreshes and uses the persisted native ID;
- the first later user-authorized prompt is sent to that exact ID;
- stop/cancel targets the same ID;
- no alternate ID is written back.

Run:

```powershell
rtk corepack pnpm --filter @fusion-plugin-examples/happier-runtime exec vitest run src/__tests__/runtime-adapter.test.ts
```

Expected RED only if current behavior is not fully pinned; if it passes immediately, retain the test as regression evidence and do not alter runtime code.

### Step 2: Make the minimum runtime correction if needed

Preserve the current preference for the persisted native ID. Do not add fallback session creation after a send error; surface the send error so the operator can repair the binding explicitly.

### Step 3: Re-run all plugin tests and typecheck

```powershell
rtk corepack pnpm --filter @fusion-plugin-examples/happier-runtime test
rtk corepack pnpm --filter @fusion-plugin-examples/happier-runtime typecheck
```

Expected GREEN: all plugin tests pass and no duplicate-create path remains.

### Step 4: Commit

```powershell
rtk git add plugins/fusion-plugin-happier-runtime/src/__tests__/runtime-adapter.test.ts plugins/fusion-plugin-happier-runtime/src/runtime-adapter.ts
rtk git commit -m "test(happier): preserve prebound native sessions"
```

If runtime code was unchanged, stage and commit only the test file.

## Task 7: Run cross-package verification

**Files:**

- Modify only when a failing test demonstrates a defect in the files from Tasks 1-6

### Step 1: Run the new focused suites

```powershell
rtk corepack pnpm --filter @fusion-plugin-examples/happier-runtime test
rtk corepack pnpm --filter @fusion/core exec vitest run src/__tests__/async-cli-session-store.test.ts
rtk corepack pnpm --filter @fusion/engine exec vitest run src/__tests__/happier-direct-session-binding.test.ts
rtk corepack pnpm --filter @fusion/dashboard exec vitest run --project dashboard-api src/routes/__tests__/register-happier-direct-session-routes.test.ts
rtk corepack pnpm --filter @fusion/dashboard exec vitest run --project dashboard-app app/components/__tests__/HappierDirectSessionCard.test.tsx app/components/__tests__/TaskDetailModal.terminal-tab.test.tsx
```

Expected: every command exits 0.

### Step 2: Run package typechecks

```powershell
rtk corepack pnpm --filter @fusion-plugin-examples/happier-runtime typecheck
rtk corepack pnpm --filter @fusion/core typecheck
rtk corepack pnpm --filter @fusion/engine typecheck
rtk corepack pnpm --filter @fusion/dashboard typecheck
```

Expected: every command exits 0 with no new suppression.

### Step 3: Run repository-level checks required by the current branch

```powershell
rtk corepack pnpm lint
rtk corepack pnpm test
```

Expected: both exit 0. If unrelated pre-existing failures exist, record the exact command, test, and original error; the focused new suites must still be green.

### Step 4: Inspect the scoped diff

```powershell
rtk git diff --check
rtk git status --short
rtk git diff --stat
```

Expected: no whitespace errors, no secrets, no generated database, no modifications to the six-board writing project, and no unrelated files.

### Step 5: Route any failure back to its owning task

No cross-package verification commit is planned. If a command fails, return to Task 1-6, add a focused regression test in that task's named test file, make the minimum correction in its named source files, repeat the task's focused test and this cross-package check, then use the task's exact scoped `git add` list. Do not create an empty commit and do not use `git add -A`.

## Task 8: Execute the real Windows end-to-end proof

**Files/evidence:**

- Create: `docs/superpowers/evidence/2026-07-15-fusion-happier-task-binding.md`

**Exact target:**

```text
Codex URI: codex://threads/019f22f6-6581-7781-bb37-84cf4d63d81d
Project cwd: G:\zcode-project\s60-Ga-cl-cc-cl-zcode
Handshake after idle only: 只回复 FUSION_HAPPIER_CONNECTED，不执行其他操作。
```

### Step 1: Preflight Happier and Fusion development services

```powershell
rtk happier doctor --json
rtk happier auth status --json
```

Start Happier and Fusion through their documented Windows development commands if they are not already healthy. Record PIDs, ports, active server/profile, and China Standard Time. Do not use Docker or WSL.

### Step 2: Create one dedicated paused Fusion task

In Fusion, create exactly one task for this integration proof with:

- project path `G:\zcode-project\s60-Ga-cl-cc-cl-zcode`;
- a title clearly identifying the target Codex thread;
- no initial prompt execution;
- paused state before linking.

Record the Fusion task ID. Do not reuse an unrelated production or six-board task.

### Step 3: Connect through the Fusion card

Enter the exact Codex URI and click Connect. Record the API response and UI fields:

- Fusion task ID;
- deterministic Fusion CLI-session ID;
- Happier native session ID;
- Codex remote thread ID;
- provider, machine, and server IDs;
- returned open URL;
- bridge agent ID and task assignment;
- unchanged paused/task workflow state.

Expected: the card says connected/bound but not running, and no model turn begins.

### Step 4: Verify the exact Happier page

Use `Open in Happier`. Confirm the browser displays the target Codex task and the Happier route contains the returned `sessionId` and `serverId`. Capture visible proof that the native remote ID is `019f22f6-6581-7781-bb37-84cf4d63d81d`; URL equality alone is insufficient.

### Step 5: Prove idempotency and restart persistence

Repeat Connect with the same URI and verify every durable ID is unchanged and no duplicate bridge agent/session/task is created.

Restart Fusion only, reopen the task, and verify GET reconstructs the same binding and a valid current `openUrl`. Happier must still show the same session.

### Step 6: Wait for the original Codex task to be idle

Inspect the original native Codex task state. Do not send the handshake while it is running, generating, or waiting on a tool. Record the idle evidence and timestamp.

This wait does not authorize any GA provider, generation, matrix, gateway, sidecar, or six-board action.

### Step 7: Send the one-message handshake through Fusion

Use the normal Fusion start/send action only after Step 6. Send exactly:

```text
只回复 FUSION_HAPPIER_CONNECTED，不执行其他操作。
```

Expected response exactly:

```text
FUSION_HAPPIER_CONNECTED
```

Verify the same turn appears in:

- Fusion task activity;
- the linked Happier session;
- the original Codex task when reopened in Codex.

Stop after the response. Do not continue the session or invoke the six-board code.

### Step 8: Record and commit evidence

The evidence file must include:

- Git SHAs for both Happier and Fusion;
- service PIDs/ports and timestamps;
- all non-secret identifiers listed in Step 3;
- first/repeat/restart observations;
- exact handshake request/response;
- proof locations for all three visible surfaces;
- original errors and proof boundary for any blocked step.

```powershell
rtk git add docs/superpowers/evidence/2026-07-15-fusion-happier-task-binding.md
rtk git commit -m "test(happier): prove task-bound session continuation"
```

## Completion gate

This plan is complete only when all of the following are true:

- Fusion uses the official Happier CLI command, not private database access or a second auth path;
- the binding is task-scoped, deterministic, idempotent, and persistent across Fusion restart;
- the task detail UI works before a process exists and remains usable at narrow width;
- the bridge agent is project-local, explicit-only, and reused;
- prebound runtime execution never calls Happier session creation;
- focused tests, typechecks, lint, and relevant repository tests pass or unrelated baseline failures are documented exactly;
- the exact target Codex task is visibly opened in Happier;
- only after the native task is idle, the one-message handshake is observed on Fusion, Happier, and Codex;
- no unrelated six-board, provider, generation, matrix, gateway, or sidecar work occurs.
