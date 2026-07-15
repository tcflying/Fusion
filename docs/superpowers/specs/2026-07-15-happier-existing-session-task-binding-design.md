# Fusion Task-Bound Happier Direct Session Design

## Decision

Extend the existing Fusion–Happier runtime bridge so a dedicated Fusion task can bind to an already-existing Codex, Claude Code, or OpenCode session through Happier Direct Sessions. The first live target is:

- Codex URI: `codex://threads/019f22f6-6581-7781-bb37-84cf4d63d81d`
- Provider: `codex`
- Current project directory: `G:\zcode-project\s60-Ga-cl-cc-cl-zcode`
- Fusion presentation: one dedicated task
- Happier presentation: the linked session must be visible and opened in Happier Web

This design extends `2026-07-13-happier-runtime-bridge-design.md`. It does not replace the six-board application, the GA control plane, Fusion orchestration, or Happier session ownership.

## User Outcome

The operator pastes a native session URI into a Fusion task and chooses **Connect through Happier**. Fusion then:

1. asks the configured Happier CLI/daemon to find and idempotently link the native session;
2. stores the returned Happier session ID as the canonical native-session identity of that Fusion task's primary executor session;
3. assigns the task to a project-local Happier runtime bridge agent;
4. shows both the native thread ID and Happier session ID in the task detail;
5. opens the exact linked session in Happier Web; and
6. reuses the same Happier session when Fusion later sends task work.

The resulting authority chain is:

`Fusion task -> Fusion CLI-session binding -> Happier Direct Session -> native Codex/Claude/OpenCode session`

## Rejected Alternatives

### One-off database or migration script

Directly inserting the target binding would be fast for one thread but would not provide a reusable operator workflow, validation, conflict handling, or an audit-friendly UI. It is rejected as the product path and may not be used as completion evidence.

### Project-wide session registry

A separate registry for every external session could later support bulk attachment and cross-task routing, but it would create a second control surface before the task-level contract is proven. It is deferred.

## Architecture

### Happier CLI surface

Add a machine-readable Direct Session command to the existing Happier CLI instead of reproducing Happier authentication, encryption, machine RPC, or transcript logic inside Fusion.

Proposed invocation:

```text
happier direct-session ensure --uri <native-session-uri> --json
```

Optional `--machine-id` is accepted only to resolve a genuinely ambiguous candidate. The command must:

- parse supported URI forms without accepting arbitrary protocols;
- list Direct Session candidates through Happier's existing daemon RPC path;
- select a candidate only when provider and remote session ID match exactly;
- call the existing idempotent `daemon.directSessions.link.ensure` path;
- return a versioned JSON envelope containing `sessionId`, `created`, `serverId`, `machineId`, `providerId`, `remoteSessionId`, `title`, `directory`, and `openUrl`;
- return typed errors for invalid URI, no candidate, ambiguous candidate, daemon unavailable, authentication failure, and link failure; and
- never print tokens, encryption material, credentials, transcripts, or unredacted daemon payloads.

The command is a thin CLI projection over Happier's existing Direct Session implementation. It must not add a parallel link database or bypass the daemon's source validation.

### Fusion task binding API

Add an authenticated task-scoped endpoint:

```text
POST /api/tasks/:taskId/happier-direct-session
```

Request body:

```json
{
  "projectId": "<current-project-id>",
  "uri": "codex://threads/<thread-id>",
  "machineId": "<optional-disambiguator>"
}
```

The endpoint must:

1. require the task to belong to the requested project;
2. reject terminal, deleted, archived, or currently executing tasks;
3. invoke the configured Happier CLI through the existing argument-safe JSON process boundary;
4. create or load the deterministic primary executor binding using the existing key `executor:<taskId>:primary`;
5. atomically claim the returned Happier `sessionId` through `createTaskStoreNativeSessionBinding`;
6. preserve an identical existing claim as an idempotent success;
7. return HTTP 409 when the Fusion CLI session already belongs to a different native session;
8. persist only non-secret linkage metadata under the CLI session's forward-compatible posture JSON; and
9. return the normalized binding plus the Happier `openUrl`.

The stored metadata shape is versioned and nested to avoid collisions:

```json
{
  "happierDirectSession": {
    "v": 1,
    "providerId": "codex",
    "remoteSessionId": "019f22f6-6581-7781-bb37-84cf4d63d81d",
    "machineId": "<machine-id>",
    "serverId": "<server-id>",
    "linkedAt": "<ISO-8601>"
  }
}
```

Do not persist `openUrl`; rebuild it from the current configured Happier Web URL, server ID, and canonical Happier session ID so a later URL change does not leave stale links.

### Runtime ownership

The task is assigned to one project-local bridge agent whose runtime configuration contains:

```json
{
  "runtimeHint": "happier",
  "assignmentPolicy": "explicit-only",
  "allowParallelExecution": true
}
```

The bridge agent may serve multiple explicitly assigned tasks because each task receives its own deterministic CLI-session record and native Happier session ID. Automatic backlog claiming remains disabled.

The task remains operator-paused during connection. Linking a session must not automatically start task execution, send a prompt, create a worktree, or resume a provider run. Starting the task is a separate explicit action after the binding is visible.

### Fusion user interface

Add a task-detail connection card that is visible before the terminal has a live process.

Disconnected state:

- native Session URI input;
- optional machine selector shown only after an ambiguous-candidate response;
- **Connect through Happier** action; and
- truthful CLI/daemon/auth health blockers.

Connected state:

- provider;
- native thread/session ID;
- Happier session ID;
- linked machine and server;
- last checked state;
- **Open in Happier** action; and
- a clear notice that starting the Fusion task will continue this exact session.

The connect response is initiated by a user click, so the frontend may open `openUrl` in a new browser tab with `noopener,noreferrer`. The same **Open in Happier** action remains available for later use. The URL format is owned by Happier's command response; Fusion must not guess server query parameters.

Desktop, narrow desktop, and mobile task-detail layouts must keep the two IDs readable without horizontal overflow. Long IDs use wrapping plus a copy action; truncation alone is not sufficient.

## Data and Control Flow

1. The operator creates or opens a dedicated Fusion task and keeps it paused.
2. The operator submits the native Session URI from the task detail.
3. Fusion calls `happier direct-session ensure` with the configured stack environment.
4. Happier resolves the local candidate and ensures a Direct Session link.
5. Happier returns the canonical Happier session ID and exact Web URL.
6. Fusion creates or loads `cli-happier-execute-<sha256(executor:<taskId>:primary)[0:24]>`.
7. Fusion atomically claims the Happier session ID and persists non-secret link metadata.
8. Fusion renders the connected card and opens the Happier page.
9. When the operator later starts the task, the existing runtime adapter refreshes the stored native session ID, reconciles status/history, and sends through that session. Its create-new-session branch must not run.
10. Happier continues the native provider thread, and the resulting history remains available in Happier and the provider's original interface.

## Failure and Recovery Contract

- **Happier link succeeds, Fusion claim fails:** do not detach, archive, or delete the Happier session. Return the session ID and a typed Fusion binding failure so retry is safe.
- **Repeated identical request:** return the same Fusion CLI-session ID and Happier session ID without creating duplicates.
- **Existing different claim:** fail with conflict; never overwrite another native session identity.
- **Daemon/server/auth unavailable:** leave the Fusion task and binding unchanged and show the precise failed layer.
- **Candidate missing:** do not fabricate a new provider session. Report that the requested native session is not discoverable on the selected machine.
- **Candidate ambiguous:** require explicit machine selection; do not choose by recency.
- **Happier Web open fails:** retain the completed binding and expose a copyable URL; browser opening is not part of transactional persistence.
- **Fusion or Happier restart:** re-read the canonical persisted IDs and reconcile; do not create a replacement session.
- **Target provider task currently active:** connection and read-only reconciliation are allowed, but no handshake or business prompt is sent until the native task is idle.

Disconnect/detach is deliberately out of scope for the first slice because it has destructive ownership implications. A later design must define whether detach affects only Fusion, only Happier metadata, or the native provider session.

## Verification Strategy

All behavior changes are implemented test-first.

### Happier RED/GREEN tests

- URI parsing for Codex, Claude Code, and OpenCode; reject unsupported schemes and malformed IDs.
- Exact candidate selection, no candidate, and multi-machine ambiguity.
- Idempotent link ensure returns `created: false` on the second call.
- Versioned JSON output contains the exact open URL and no secret fields.
- Daemon, authentication, and link failures preserve typed errors.

### Fusion RED/GREEN tests

- Task/project scope and non-running-task guard.
- Exact deterministic executor session ID and task ownership.
- First claim, repeated identical claim, and conflicting claim.
- Prebound runtime session reconciles and sends without calling Happier session creation.
- Connection card disconnected/connected/error states.
- Open action uses only the URL returned or rebuilt from persisted trusted fields.
- Desktop/mobile wrapping and copy controls for long IDs.

### Live acceptance

1. Confirm Fusion, Happier server, UI, daemon, authentication, and Codex backend health.
2. Create a paused dedicated Fusion task for `019f22f6-6581-7781-bb37-84cf4d63d81d`.
3. Connect from Fusion and capture the Fusion task ID, Fusion CLI-session ID, Happier session ID, native Codex thread ID, server ID, and machine ID.
4. Verify Happier Web opens the exact returned session and shows the same native thread linkage and current transcript.
5. Repeat connect and prove no second Happier session or Fusion CLI-session record is created.
6. Restart Fusion and re-open the task; prove the same IDs remain visible.
7. After the native Codex task becomes idle, start one explicit handshake turn from Fusion: `只回复 FUSION_HAPPIER_CONNECTED，不执行其他操作。`
8. Verify the exact response is visible in Fusion, Happier, and the original Codex task, then stop. Do not dispatch GA generation, provider work, matrix work, or any unrelated instruction.

The connection is not complete if only Happier can read the thread, only Fusion stores an ID, or the two products show different session identities.

## External Integration Evidence

- Canonical upstream repo URL: https://github.com/happier-dev/happier
- Docs / homepage URL: https://docs.happier.dev/clients/cli
- Release / download URL: https://github.com/happier-dev/happier/releases
- Binary / CLI name: `happier`
- Package: `@happier-dev/cli`
- Checksum: `upstream-pending-verification` until a release artifact is pinned; local development uses the reviewed source checkout at `G:\codex-project\happier`.

## Scope Boundaries

- No Docker or WSL dependency.
- No Kimi/Moonshot route, fallback, configuration, or historical reactivation.
- No credential, encryption-key, or transcript duplication in Fusion.
- No direct writes to Happier databases from Fusion.
- No direct writes to Codex thread storage from Fusion.
- No one-off database insertion accepted as the product implementation.
- No automatic task start or provider prompt during connection.
- No replacement of Fusion orchestration or Happier session ownership.

## Completion Criteria

The slice is complete only when one dedicated Fusion task is visibly bound to the target Codex thread through one Happier session, the corresponding Happier page opens, repeated connection is idempotent, restart preserves the binding, and the post-idle handshake is observed on all three surfaces with exact matching IDs and no unrelated project mutation.
