# Fusion–Happier Runtime Bridge Design

## Objective

Use Fusion as the visual orchestration and supervision control plane while Happier owns durable, bidirectionally accessible Codex, Claude Code, and OpenCode sessions. A session created or continued from Fusion must remain usable from Happier Web and Happier CLI without copying messages between interfaces.

This change has two independently testable parts:

1. Make Happier's repo-local development stack start safely on native Windows.
2. Add a Fusion runtime plugin that controls Happier through its published machine-readable CLI surface.

The integration does not replace Fusion's scheduler, task graph, evaluators, agent supervision, or dashboards. It adds Happier as an execution/session runtime.

## Current Evidence

- Happier commit `212776ed6` builds its server and applies all 38 SQLite migrations on Windows.
- The server listens successfully, but `apps/stack/scripts/utils/net/ports.mjs` returns `unsupported-platform` for `win32`.
- The repo-local launcher then fails closed because it cannot prove that the server listener belongs to the spawned stack process.
- Happier's built CLI exposes JSON commands for session create, send, wait, status, history, stop, resume, review, plan, delegate, run control, and MCP serving.
- Fusion already has a plugin runtime registry, CLI-backed runtime adapters, native session identity handling, task orchestration, monitoring, approvals, and self-healing.

## Selected Architecture

### 1. Happier Windows ownership support

Extend the existing stack ownership boundary instead of bypassing it.

- `listListenPidsWithStatus` gains a Windows implementation backed by `netstat -ano -p tcp` parsing.
- Windows listener discovery returns only numeric PIDs for exact `LISTENING` rows whose local endpoint matches the requested port.
- Process ownership verification uses a Windows process-parent snapshot obtained through PowerShell/CIM and walks from the listener PID to the spawned root PID.
- POSIX process-group verification remains unchanged.
- If listener discovery or ancestry proof is unavailable, startup still fails closed.
- No process is killed merely because it owns the requested port. Existing stack ownership markers and verified process ancestry remain mandatory.

This is a development-stack fix, not a global relaxation of Happier's process safety rules.

### 2. Fusion Happier runtime plugin

Add `plugins/fusion-plugin-happier-runtime`, following the existing Hermes runtime plugin's packaging and registration pattern.

The plugin provides:

- Runtime id: `happier`
- Configurable CLI launch specification:
  - executable path, or Node plus the source-build CLI entrypoint;
  - Happier server/profile selection;
  - backend target: Codex, Claude Code, or OpenCode;
  - permission mode, model override, timeout, and working directory.
- A health probe that distinguishes:
  - binary/source entrypoint discovered;
  - CLI executable;
  - server reachable;
  - authenticated;
  - daemon available;
  - selected backend available.
- A runtime adapter that invokes only documented Happier CLI commands and consumes `--json` output.

No Happier bearer token, encryption key, provider credential, or session transcript is copied into Fusion settings or logs. Happier continues to own authentication and encrypted session storage.

## Session Lifecycle

### Creation

For a new Fusion runtime session:

1. Resolve and probe the configured Happier CLI.
2. Run `happier session create --path <cwd> --backend <backend> --title <title> --json`.
3. Validate the JSON envelope and capture the Happier session id.
4. Persist that id as the runtime-native session identity through Fusion's existing CLI/runtime session persistence path.

### Conversation

For every turn:

1. Run `happier session send <id> <message> --wait --timeout <seconds> --json`.
2. Parse the structured completion result.
3. Fetch `session status` or bounded `session history` only when the send response does not contain the complete assistant result.
4. Stream structured progress into Fusion when Happier's run stream commands are available; otherwise report explicit queued/running/waiting/completed states instead of simulating token streaming.

### Resume and recovery

- Reopening a Fusion chat reuses the persisted Happier session id.
- After Fusion restarts, the adapter checks `session status` before sending.
- An inactive but resumable session uses Happier's resume/session-run surface; it is not silently replaced with a new session.
- If a session is missing, archived, non-resumable, or owned by another unavailable machine, Fusion reports a typed recovery state and does not discard the old identity.
- Happier Web and Happier CLI can attach to or continue the same Happier session at any time.

## Multi-Agent Operations

Fusion remains the primary task orchestrator. Happier's multi-agent features are exposed as runtime operations, not as a second task board.

- `review start`: independent review engines evaluate a session or result.
- `plan start`: multiple backends propose or reconcile a plan.
- `delegate start`: multiple backends execute delegated work.
- Each operation stores its Happier operation/run id alongside the owning Fusion task/run.
- Fusion displays operation state, participants, elapsed time, and failures using its existing run/session monitoring surfaces.
- A failed participant does not block unrelated Fusion tasks. The operation records partial completion and allows explicit retry of the failed participant or run.

## Concurrency and Failure Handling

- Every Fusion task/session has its own Happier session id; concurrent tasks never share a mutable conversation unless explicitly configured.
- CLI invocations use bounded timeouts and cancellation propagation.
- Timeouts do not imply that the remote session stopped; Fusion rechecks status before retrying.
- Retries are idempotent where Happier provides a run or stream id. Plain message sends are not blindly repeated after an ambiguous transport failure.
- Daemon loss, server loss, backend crash, authentication loss, waiting-for-permission, and model/provider failure are separate typed states.
- Fusion's scheduler remains free to run unrelated work while one Happier session is waiting or recovering.

## User Interface

The first implementation reuses Fusion's existing runtime settings, session status, terminal/transcript, and task-run views. It does not create a second dashboard.

Required visible information:

- Happier connection/auth/daemon/backend health;
- backend and model selected for each session;
- Happier session id and resumability;
- running, waiting for input, blocked, recovering, completed, and failed states;
- links or copyable commands to open/attach from Happier when supported;
- multi-agent operation participants and per-participant status.

## Testing Strategy

Behavior changes are implemented test-first.

### Happier tests

- RED tests for Windows `netstat` parsing: IPv4, IPv6, duplicate rows, unrelated ports, malformed output, and no listener.
- RED tests for Windows parent-chain ownership: direct child, descendant, unrelated listener, missing process, and ancestry cycle.
- Existing POSIX ownership tests remain green.
- Native Windows repo-local stack test proves server, UI, and daemon reach readiness without disabling ownership checks.

### Fusion tests

- RED unit tests for CLI resolution, JSON parsing, argument construction, redaction, timeouts, and typed errors.
- Runtime-adapter tests for create, second-turn reuse, restart resume, ambiguous send failure, and missing session.
- Plugin registration and probe tests modelled on existing runtime plugins.
- Package typecheck/build and relevant Fusion plugin/runtime test lanes.

### Real end-to-end proof

1. Start Fusion and Happier development services simultaneously on distinct ports.
2. Open Happier Web and confirm server/UI/daemon health.
3. From Fusion, create one real Codex session, send two turns, and verify the Happier session id is unchanged.
4. Continue that session from Happier CLI or Web, then return to Fusion and verify the new history is visible.
5. Repeat provider availability, creation, continuation, and recovery checks for Claude Code and OpenCode.
6. Restart Fusion and then Happier independently; verify the same session remains resumable.
7. Run one real Happier review, plan, or delegate operation with multiple available backends and verify per-participant status in Fusion.

Any provider that lacks installed CLI credentials is reported as a provider-specific live-test blocker. Local mocks and dry runs cannot satisfy the real end-to-end acceptance items.

## Scope Boundaries

- Do not duplicate Happier's account, encryption, provider, or transcript stores in Fusion.
- Do not replace Fusion's task graph, evaluator, scheduler, approvals, or self-healing.
- Do not add Docker or WSL requirements.
- Do not enable or route to retired Kimi/Moonshot surfaces.
- Do not weaken either project's process ownership, authentication, or permission gates.
- Do not implement arbitrary Happier internal HTTP calls when an official CLI command exists.

## Completion Criteria

The work is complete only when:

- Happier's native Windows development stack reaches server, Web UI, and daemon readiness with ownership checks enabled;
- Fusion loads the Happier runtime plugin and reports truthful health states;
- a real provider session can be created, continued from both products, and recovered after restart;
- multi-agent operation wiring is exercised with real available backends;
- targeted tests, typechecks, builds, and real runtime artifacts are recorded with exact commands, logs, PIDs, ports, and session ids.
