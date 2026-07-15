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
