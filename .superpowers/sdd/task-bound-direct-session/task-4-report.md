# Fusion Task 4 Report

Status: DONE

## Scope

- Added authenticated project-scoped GET/POST task routes at `/api/tasks/:taskId/happier-direct-session`.
- Reused Task 3's real read/bind/conflict/integrity helpers and the Happier plugin's real URL builder.
- Resolved only persisted project plugin settings; no environment variable or localhost default was added.
- Added the exact four-key `Happier Session Bridge` runtime contract, durable project-local find/create/reuse, explicit assignment, incompatible-config conflict, and bound-but-unassigned partial failure.
- Preserved task workflow column/status, pause state, prompt, and worktree while connecting.
- Did not modify Task 3 engine files or any file outside Task 4 ownership.

## TDD evidence

### RED

The brief's literal command was attempted first:

```text
rtk corepack pnpm --filter @fusion/dashboard exec vitest run --project dashboard-api src/routes/__tests__/register-happier-direct-session-routes.test.ts
```

It exited 1 before collection because the current dashboard config intentionally empties deep lanes unless `FUSION_DASHBOARD_DEEP=1` is set. The repository's `test:api` script was also unusable on Windows because its POSIX environment-variable prefix produced `'FUSION_DASHBOARD_DEEP' is not recognized`. Neither failure was counted as the TDD RED.

A temporary untracked PowerShell runner set only `FUSION_DASHBOARD_DEEP=1`; it was removed after verification. The genuine RED command was:

```text
rtk powershell -NoProfile -File .task4-vitest.ps1 run --project dashboard-api src/routes/__tests__/register-happier-direct-session-routes.test.ts
```

Result: exit 1; 1 failed suite, 0 tests; exact expected failure:

```text
Error: Cannot find module '../register-happier-direct-session-routes.js'
```

### GREEN

Focused route command:

```text
rtk powershell -NoProfile -File .task4-vitest.ps1 run --project dashboard-api src/routes/__tests__/register-happier-direct-session-routes.test.ts
```

Result: exit 0; 1 test file passed; 18/18 tests passed.

Focused plus adjacent route command:

```text
rtk powershell -NoProfile -File .task4-vitest.ps1 run --project dashboard-api src/routes/__tests__/register-happier-direct-session-routes.test.ts src/routes/__tests__/register-task-workflow-routes.unpause.test.ts src/routes/__tests__/register-task-workflow-routes.runtime-fallback.test.ts
```

Result: exit 0; 3 test files passed; 26/26 tests passed.

Final fresh re-run after the last route refinement: exit 0; 3 test files passed; 26/26 tests passed.

The route suite uses stateful in-memory task, persisted-plugin, agent, and CLI-session stores while executing the real Task 3 read/bind helpers and real Happier URL builder. This avoids both mock-only assertions and the removed SQLite runtime.

## Verification

```text
rtk corepack pnpm --filter @fusion/dashboard typecheck
```

Result: exit 0; both `tsc --noEmit` and `tsc --noEmit -p tsconfig.app.json` passed.

Final fresh re-run after the last route refinement: exit 0 with the same two TypeScript checks passing.

```text
rtk git diff --check
```

Result before report creation: exit 0. Re-run after the final report/diff audit is required before commit.

## Owned changed files

- `packages/dashboard/src/routes/register-happier-direct-session-routes.ts`
- `packages/dashboard/src/routes/__tests__/register-happier-direct-session-routes.test.ts`
- `packages/dashboard/src/routes.ts`
- `.superpowers/sdd/task-bound-direct-session/task-4-report.md`

## Concerns

- Concurrent Task 5 work appeared during Task 4 in dashboard app files, and `.superpowers/sdd/progress.md` remains dirty. Those files are not owned by Task 4 and must not be staged or altered.
- No Task 4 product blocker is known.

## Independent review correction (2026-07-16)

The first independent review rejected the initial implementation for five substantive reasons:

- a same-name durable agent with the wrong role could fall through to a partial `500` instead of returning a deterministic `409` conflict;
- agent creation followed by runtime-config replacement was not atomic and could expose intermediate defaults;
- route tests used fake task/agent stores instead of the repository's real PostgreSQL stores;
- the remote-session idempotency assertion was not stateful enough to prove that only one Happier session was created;
- plugin lookup mapped every storage exception to `HAPPIER_PLUGIN_NOT_CONFIGURED`, hiding non-`ENOENT` failures.

The correction adds an exact-runtime-config AgentStore creation path guarded by a PostgreSQL transaction and transaction-scoped advisory lock, checks both bridge role and runtime compatibility, re-reads after creation races, and maps only storage `ENOENT` to the not-configured response. The route suite now uses the shared real PostgreSQL TaskStore and AgentStore harness; only the external Happier CLI boundary remains a stateful fake that counts concrete remote sessions.

### Correction RED

Before the route correction, the real PostgreSQL route suite collected 24 tests and produced 5 expected failures / 19 passes:

- wrong-role bridge agent: expected `409`, received `500`;
- four non-`ENOENT` plugin-store failures: expected `500`, received `409`.

### Correction GREEN

- real PostgreSQL route suite: 24/24 passed;
- route suite plus two adjacent workflow suites: 32/32 passed;
- concurrent exact AgentStore creation test on the shared PostgreSQL harness: 1/1 passed, with one durable winner and the exact four-key runtime config persisted;
- `@fusion/core` typecheck: passed;
- `@fusion/dashboard` typecheck: passed;
- scoped ESLint for the AgentStore and route source: passed;
- `git diff --check`: passed.

The correction owns these additional files:

- `packages/core/src/agent-store.ts`
- `packages/core/src/__tests__/postgres/agent-store-exact-create.pg.test.ts`

No temporary test runner is included in the commit. The removed SQLite runtime was not reintroduced.
