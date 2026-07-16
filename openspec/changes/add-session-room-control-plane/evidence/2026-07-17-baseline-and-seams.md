# Session Room control-plane baseline and seams — 2026-07-17

## Evidence boundary

- Captured at `2026-07-17 02:42:59 CST (UTC+8)` (`2026-07-16T18:42:59.512Z`).
- Target worktree: `G:\codex-project\fusion\.worktrees\session-room-control-plane`.
- Target branch: `codex/session-room-control-plane`.
- This pass modified neither preserved baseline worktree. Their pre-existing dirty files are listed below and remained unchanged after the verification commands.
- Commands were native Windows commands. No Docker or WSL was used.

## Pinned source baselines

| Surface | Repository / branch | Verified commit | License evidence | Worktree boundary |
|---|---|---|---|---|
| Fusion bridge | `https://github.com/Runfusion/Fusion.git`, `codex/happier-runtime-bridge` | `21191c4cb4f894094dfdeb8152ebeaf35079d9af` | Root `LICENSE` and workspace package metadata declare MIT | Preserved worktree already had modified `.superpowers/sdd/progress.md` and six untracked `.e2e-*` artifacts; none was changed or removed |
| Happier Direct Session | `https://github.com/happier-dev/happier.git`, `codex/direct-session-cli` | `2bcd6c170669b623086c84da218ac753b63c4fbf` | `apps/cli/package.json` declares MIT; `apps/ui/LICENSE` is MIT. The checked-out repository has no root `LICENSE`, so package-level evidence is retained instead of claiming a root license file | Preserved worktree already had modified `.superpowers/sdd/progress.md` and untracked `.codegraph/` plus `.superpowers/sdd/direct-session-cli/`; none was changed or removed |
| Room child worktree | parent of specification commit `fb9f0ba` | `21191c4cb4f894094dfdeb8152ebeaf35079d9af` | Inherits Fusion MIT repository | Clean before this evidence artifact |

## Public Happier CLI surface

The repository-local official entrypoint is available through `yarn happier`; a global `happier` executable is not on this machine's `PATH`.

```text
rtk yarn happier --version
=> 0.2.10

rtk yarn happier direct-session --help
rtk yarn happier direct-session ensure --help
=> Usage: happier direct-session ensure --uri <uri> [--machine-id <id>] [--json]
=> Ensure that an existing Codex, Claude, or OpenCode session is linked in Happier.
```

The help probes exited `0`. They also exposed existing Node `DEP0169` and child-process shell deprecation warnings; neither warning altered the command result.

## Existing real E2E proof and its limit

Authoritative artifact: `G:\codex-project\happier\.worktrees\direct-session-cli\docs\superpowers\evidence\2026-07-15-direct-session-cli-ensure.md`.

- Native URI: `codex://threads/019f22f6-6581-7781-bb37-84cf4d63d81d`.
- Native Session ID: `019f22f6-6581-7781-bb37-84cf4d63d81d`.
- Happier Session ID: `cmrlz93zb002jg1888442usqo`.
- Two authenticated ensure calls returned the same provider, native ID, machine, server, Happier Session, deterministic tag, and open URL; `created` changed from `true` to `false`.
- The provider process survived the Happier daemon restart.
- No prompt, `session send`, provider generation, or transcript mutation was performed.
- History returned an empty message list at capture time. Therefore this is real exact-identity/idempotent-link proof, but **not** Fusion↔Happier↔native message-round-trip proof and **not** transcript-import proof.

## Implementation seam inventory

| Seam | Current owner and focused tests | Classification | Room decision |
|---|---|---|---|
| Exact native-session binding | `packages/engine/src/happier-direct-session-binding.ts`; `happier-direct-session-binding.test.ts`, `agent-runtime-postgres-native-session.test.ts`, `agent-runtime-layers.test.ts` | `partial` | Reuse exact identity, deterministic `executor:<taskId>:primary`, and integrity checks. Add stable Room seats and immutable binding generations instead of widening the one-primary-task record. |
| Async CLI Session persistence | `packages/core/src/async-cli-session-store.ts`, `cli-session-types.ts`; `async-cli-session-store.test.ts` | `partial` | Reuse async/PostgreSQL session metadata and native-ID claim semantics. Do not encode N-seat Room state into CLI-session posture JSON. |
| Happier runtime plugin | `plugins/fusion-plugin-happier-runtime`; five focused test files | `reusable` for CLI runner, typed errors, status/history/send wrappers; `partial` as a connector | Preserve `AgentRuntime`. Add a provider-neutral Session Connector adapter around reviewed invocation paths; do not make the plugin UI the transport owner. |
| Conversational Chat Rooms | `packages/core/src/chat-store.ts`, `async-chat-store.ts`, `packages/dashboard/src/chat.ts`, `register-chat-room-routes.ts`; chat-manager/room/API/UI tests | `rejected` as operational authority; `reusable` UI patterns | Keep `/api/chat/rooms` and sequential responder behavior unchanged. Reuse composer/timeline patterns only. |
| MessageStore | `packages/core/src/message-store.ts`, `async-message-store.ts`; `postgres/message-store.pg.test.ts` | `partial` | Reuse envelope and inbox/outbox patterns where compatible. Operational Room messages need Room-scoped targets, aggregate versions, authority envelopes, delivery uncertainty, and immutable events. |
| TaskStore dependencies | `packages/core/src/store.ts`, `packages/core/src/task-store/*`; dependency-cycle/mutation/lifecycle PostgreSQL tests | `reusable` as linked deliverable state; `rejected` as the Room aggregate | Room DAG nodes may link to Fusion Tasks, but Room membership, protocol, turns, and native Session leases remain a separate bounded context. |
| Scheduler and leases | `packages/engine/src/scheduler.ts`, `mesh-lease-manager.ts`, checkout/worktree lease modules; scheduler, mesh, executor-renewal, workspace-merger, and double-lease tests | `partial` | Reuse global capacity, node placement, and workspace fencing. Add typed Room-worker and sender leases rather than overloading checkout fields. |
| Evaluations/evidence | `packages/core/src/eval-store.ts`, `async-eval-store.ts`, `eval-scoring.ts`, `eval-signal-collector.ts`; `packages/engine/src/evaluator*.ts`; focused unit and PostgreSQL eval tests | `partial` | Reuse deterministic signals and evidence collection. Add immutable candidates, blind reviews, dissent, lineage, and calibrated confidence; model votes cannot override hard gates. |
| Dashboard live events | `packages/dashboard/src/sse.ts`, `sse-buffer.ts`, `packages/dashboard/app/sse-bus.ts`; focused SSE tests | `reusable` transport pattern; `partial` durability | Extend the canonical event surface with Room cursors/replay. UI remains a projection and never owns Room timers or leases. |
| Plugin/core dashboard views | `pluginViewRegistry.tsx`, `HappierRuntimeCard.tsx`, `HappierDirectSessionCard.tsx`; registry/card tests | `partial`; plugin-owned second control plane is `rejected` | Keep current cards and deep links. Add the operational cockpit as a lazy core top-level view, not another plugin control plane. |
| Durable operational Room aggregate | No existing store/controller/API/cockpit owns all required invariants | `missing` | Add canonical async/PostgreSQL Room events, projections, commands, worker, connector registry, and cockpit under the feature gate. |

## Narrow baseline verification

### Fusion passing lanes

| Lane | Final result |
|---|---:|
| Happier runtime plugin focused suite | 5 files, 85/85 tests passed |
| Core async CLI Session store | 1 file, 6/6 tests passed |
| Engine binding/runtime layers | 3 files, 17/17 tests passed |
| Dashboard API direct-session routes, isolated embedded PostgreSQL | 1 file, 24/24 tests passed |
| Dashboard Direct Session card + Task Detail compatibility | 2 files, 28/28 tests passed |
| `@fusion/core` typecheck | exit 0 |
| `@fusion/engine` typecheck | exit 0 |
| `@fusion/dashboard` server + app typecheck | exit 0 |
| Happier runtime plugin typecheck | exit 0 |

The API lane used Fusion's own `EmbeddedPostgresLifecycle` on a random free port. The helper stopped PostgreSQL and removed its temporary data directory in `finally`; the helper and temporary env file were deleted after the run.

### Happier passing lanes

| Lane | Final result |
|---|---:|
| Direct Session current focused surface, including exact service/linking adjacency | 9 files, 111/111 tests passed |
| CLI import-cycle guard | 0 baseline SCCs, 0 new SCCs |
| Full CLI typecheck (`build:shared` + `tsc --noEmit`) | exit 0 in 91.2 seconds; existing `DEP0169` warnings only |

### Baseline/tooling failures kept separate from product regressions

1. A fresh Fusion worktree initially had no `node_modules`, so all five first probes failed before collection with `vitest` not found. `rtk corepack pnpm install --frozen-lockfile` reused the lockfile/store, downloaded zero packages, and changed no tracked file.
2. The plugin suite initially could not resolve `@fusion/plugin-sdk` because its `dist` did not exist. Building `@fusion/core` then `@fusion/plugin-sdk` made the unchanged suite pass 85/85.
3. Fusion Dashboard package scripts use POSIX inline environment assignment (`FUSION_DASHBOARD_DEEP=1 ...`) and fail under native Windows cmd. Direct Vitest invocation with the same required environment passed.
4. The machine's existing PostgreSQL listener on port 5432 rejected both implicit Windows-user and Fusion default credentials. It was not modified; an isolated embedded PostgreSQL instance was used instead.
5. Happier's `vitest` package script expands `$npm_execpath`, which native Windows cmd does not recognize. The project's already-documented direct Node/Vitest command passed the current 9-file surface 111/111.
6. The historical Happier full CLI suite remains `DONE_WITH_BASELINE_FAILURES` in `task-5-report.md`; it was intentionally not rerun because its retained report documents unrelated Windows/runtime failures and prior machine saturation. No full-suite green claim is made here.
7. The first worktree-local CodeGraph build exceeded the 120-second wrapper timeout and emitted `EPIPE`, but the completed database was then verified `up to date`: 4,326 files, 63,937 nodes, 258,405 edges. It is scoped to this worktree, not the Fusion main checkout.

## Baseline conclusion

The pinned one-to-one bridge and Happier exact-link command are healthy on their focused current lanes. They are a valid implementation base, but they do not yet supply N-seat operational Rooms, same-session message round trips, durable delivery/reconciliation, non-blocking DAG orchestration, evidence-weighted MoA, the Room cockpit, or controlled evolution. Those remain new work behind a fail-closed feature gate.

## Task 1.4 fail-closed gate evidence

- RED: `room-feature-gate.test.ts` failed before collection with the expected missing `../room-feature-gate.js` module.
- GREEN: the new `sessionRoomControlPlane` gate passed 1/1. It returns true only for an explicit project `experimentalFeatures.sessionRoomControlPlane === true`; missing, empty, and false settings remain disabled.
- Legacy primary binding compatibility passed 15/15 with an explicit gate-off fixture. The real persisted binding key remains the Fusion directory plus deterministic hashed CLI Session ID; `executor:<taskId>:primary` is the canonical input key and is not falsely asserted as plaintext storage.
- Task Detail Happier Direct Session card compatibility passed 22/22 independently and 29/29 with its existing terminal-tab regression while the gate-off fixture remained false.
- Happier runtime plugin registration remained available under a gate-off settings payload; the focused plugin suite passed 86/86.
- Final `@fusion/core`, `@fusion/engine`, `@fusion/dashboard`, and Happier runtime plugin typechecks all exited `0`.
- No legacy binding, route, card production component, or Happier `AgentRuntime` implementation was modified. The gate is exported for new Room entrypoints and remains off by default.

## Task 1.5 versioned contract evidence

- Added independent v1 contract versions for storage, Session Connector, controller, protocol, evidence, UI, and the `room.v1` API rather than coupling parallel worktrees to one unversioned shape.
- Storage contracts keep Room/seat/binding/turn/event/task/message/outbox/lease/checkpoint identities explicit. Binding generation and native Session, Happier Session, server profile, host, and provider identities are separate fields.
- The provider-neutral Session Connector contract publishes a capability matrix for ensure/create/status/history/events/send/interrupt/resume/takeover/health/deep links. Mutating capabilities fail closed unless their exact capability state is `verified`.
- Controller command/event contracts require expected aggregate version, idempotency key, authority envelope, exact target, correlation, and project/Room identity. A type-only controller import initially made one probe falsely green; a runtime command-type assertion was added and the missing-module RED was recaptured before implementation.
- Declarative protocol contracts pin phases, roles, targeted channels, context packs, transitions, hard/advisory gates, recovery actions, and exit conditions including independent verification.
- Evidence contracts preserve immutable artifacts and candidates, parent lineage, producer Session provenance, blind-review audit identities, first-class dissent, deterministic gate results, promotion decisions, and seven explainable confidence dimensions. `canCandidatePassHardGates` requires at least one hard gate and every hard gate to pass, so votes cannot bypass a failure.
- UI DTOs put objective/protocol phase, DAG/critical path, participant health, capacity/idle reasons, confidence dimensions, and alerts in one backend-reconstructable cockpit projection. Seat, binding, native Session, Happier Session, server profile, host, leases, and deep links remain independently labeled.
- TDD RED evidence was retained for each absent contract surface. The final focused run passed 3 files and 9/9 tests, including root-package exports; `@fusion/core` typecheck exited `0`; `git diff --check` exited `0`.
- Compatibility reruns after the contract exports passed the legacy binding file 15/15, Direct Session card file 22/22, and Happier runtime plugin entry file 4/4.
- Scoped ESLint reported zero errors. Five test files were explicitly ignored by the repository lint policy and reported as warnings, so this is not presented as proof that those ignored tests were linted; they are instead covered by the passing Vitest runs above.
- Worktree-local CodeGraph sync added/updated the contract surfaces and finished `up to date` at 4,339 files, 64,133 nodes, and 259,088 edges.

## Task 2.1 Room-domain RED evidence

- Added five behavior tests covering project-scoped draft creation, optimistic aggregate versions, invalid lifecycle transitions, terminal-outcome immutability with archive-only closure, arbitrary stable participant seats, duplicate-seat rejection, immutable binding generations, and deferred replacement at a settled turn boundary.
- RED is real: the focused Vitest run failed before collection because `../room-domain.js` does not yet exist. No placeholder implementation, skip, mock, or weakened assertion was added.

## Task 2.2 canonical PostgreSQL schema and migration evidence

- Added 24 operational Room tables to Fusion's existing `project` PostgreSQL schema and Drizzle namespace: aggregate, seats, binding lineage, turns, deferred membership, immutable events, task DAG, messages, durable outbox/attempts/inbox, idempotency keys, fenced leases, checkpoints, artifacts/evidence/candidates/reviews/dissent/gates/promotions/confidence, and alerts. No SQLite fallback, plugin-owned database, or third persistence path was introduced.
- Preserved the immutable `0000` baseline and added ordered `0001_session_rooms.sql`. The schema applier now serializes migrators with a PostgreSQL advisory transaction lock and records each version atomically; new and existing databases use the same ledger.
- Fixed a packaging edge: operational scripts now refresh all migration assets instead of treating the presence of `0000_initial.sql` as proof that later migrations were staged. The CLI build already refreshes the complete migration directory and its documentation now states that explicitly.
- Static schema/migration tests passed 2/2 and `@fusion/core` typecheck exited `0`.
- Real native-Windows embedded PostgreSQL tests passed 2/2: a fresh database applied `[0000, 0001]`, an existing ledger containing only `0000` applied only `[0001]`, a second apply was a no-op, all 24 tables existed, duplicate `(room_id, aggregate_version)` events were rejected, and a child row carrying the wrong `project_id` was rejected by the composite foreign key.

## Task 2.3 Room-domain GREEN evidence

- Implemented immutable optimistic-versioned Room aggregate helpers for creation, lifecycle transitions, stable seat provisioning, exact binding attachment, turn begin/settle, deferred binding replacement, and boundary activation.
- Terminal outcomes can only move to `archived`; they cannot reopen or change outcome. Active turns fence direct membership changes, and replacement activation requires the referenced turn to be visibly `completed`, `cancelled`, or `uncertain`.
- Replacement creates the next binding generation, marks the former binding `replaced`, preserves both native identities, and updates the stable seat without mutating the input aggregate.
- The original RED suite now passes 5/5; `@fusion/core` typecheck, scoped production ESLint, and `git diff --check` all exit `0`.

## Task 2.4 transactional AsyncRoomStore evidence

- Added a project-bound `AsyncRoomStore` on the canonical `AsyncDataLayer`, with create/get/lifecycle/list-events operations, optimistic conditional updates, immutable event append, durable identity cursor, and project scoping.
- Projection and event writes share one `transactionImmediate`. A forced duplicate event ID rejected the command and the Room projection remained at its prior state/version, proving rollback rather than partial success.
- Two concurrent lifecycle commands with the same expected aggregate version produced exactly one success, one rejection, and one version-1 event; no last-writer-wins overwrite occurred.
- Committed-event listeners are queued only after the transaction returns. Listener work and diagnostics failures are isolated from command success so slow UI/notification consumers cannot hold the Room worker or turn a committed command into a blind retry.
- Real native-Windows embedded PostgreSQL store test passed 1/1. The focused pure suite passed 5 files and 16/16 tests; core typecheck, production ESLint, and diff check all exited `0`.

## Task 2.5 idempotent delivery persistence evidence

- The first focused RED run retained the expected failure: the real PostgreSQL test reached the new concurrent scenario and failed because `AsyncRoomStore.enqueueMessage` did not exist. This was an absent production capability, not a mock or environment failure.
- `enqueueMessage` now reserves the Room-scoped idempotency key, conditionally advances the aggregate version, stores message content/hash and exact seat targets, creates one outbox row per active binding, appends the causal event, and links the result event to the reservation in one transaction. The event payload stores IDs rather than message content.
- Two real concurrent commands using the same idempotency key and canonical command hash produce one committed message, one event, one outbox row, and one idempotency row. One caller receives the original result and the other receives a replay of that same event. Reusing the key for different content fails as an idempotency conflict.
- Delivery attempts use conditional `pending -> dispatching` claims and immutable attempt numbers. A timeout classified as `delivery_uncertain` clears automatic retry scheduling; a later dispatch attempt is rejected until native-session reconciliation resolves whether the external side effect happened.
- Inbox receipts deduplicate by binding plus native cursor. An identical replay returns the first receipt; the same cursor with a different payload hash fails closed.
- The final native-Windows embedded PostgreSQL store run passed 2/2. The latest schema/upgrade run passed 2/2, including fresh, incremental, and idempotent migration paths. The focused pure suite passed 5 files and 16/16 tests; core typecheck, production ESLint, and `git diff --check` all exited `0`.
- An additional probe of the older `schema-applier.test.ts` plus `sqlite-migrator.test.ts` surface reported 34/34 setup failures before product assertions because both harnesses shell out to `psql`, which is not installed or on `PATH` on this Windows host. The bundled `embedded-postgres` package does not provide `psql.exe`. These are retained as infrastructure blockers, not counted as passing tests and not treated as Room regressions; the new embedded-process tests exercise the changed ordered applier directly without Docker, WSL, or the missing client binary.

## Task 2.6 fenced Room lease evidence

- The retained RED run failed before test collection because `async-room-lease-store.js` did not exist. The production implementation was added only after that missing-capability failure was captured.
- Added project-scoped append-by-epoch persistence for `room_worker`, `sender`, `workspace`, and `human_takeover` leases. Same-resource operations take a PostgreSQL transaction-level advisory lock, while the existing partial unique index remains the database backstop against two active rows.
- First acquisition creates epoch 1. An unexpired owner cannot be displaced; expired takeover requires the caller's observed epoch, releases the prior history row, and appends epoch 2. Renewal, release, and the transaction-composable fence assertion require exact lease ID, Room, kind, resource, holder, host, and epoch.
- The stale epoch-1 worker was proven unable to renew, release, or pass the write fence after epoch-2 takeover. Lease history retained both epochs and the exact takeover release time instead of deleting the former authority record.
- Two real concurrent stores contending for one sender binding produced one winner and one visible conflict. The same was proven for a project-wide workspace resource across two Rooms. Sender acquisition also rejects a host that differs from the attached native Session binding's host affinity.
- The first GREEN attempt completed product assertions but hit a Windows `EPERM` while deleting the just-stopped embedded PostgreSQL directory. The new test cleanup now uses Node's bounded native retry options; no product assertion was weakened. The final native-Windows embedded PostgreSQL run passed 2/2; core typecheck, production ESLint, and `git diff --check` all exited `0`.

## Task 2.7 turn checkpoint and event replay evidence

- The retained RED run failed before collection because the checkpoint store module did not exist. No placeholder checkpoint, skipped test, or projection-table-only reconstruction was accepted.
- Room creation, lifecycle, and queued-message events now carry versioned projection payloads with the exact immutable facts needed by replay. The canonical message/idempotency and checkpoint paths share one locale-independent canonical SHA-256 implementation.
- Full replay starts from `room_created` version 0 and requires strictly increasing durable cursors, one Room/project identity, contiguous aggregate versions, supported payload version, valid lifecycle transitions, and known event types. A stream missing version 1 was proven to fail instead of silently jumping to version 2.
- Turn checkpoint creation runs in one PostgreSQL transaction, pins the current aggregate version and final event ID/cursor, stores a canonical projection hash, protocol state, DAG version, binding cursors, unresolved outbox IDs, and artifact references, and rejects unknown turns/bindings or a missing event anchor.
- Recovery uses a repeatable-read database snapshot. It verifies the raw checkpoint hash before parsing, validates checkpoint identity/version and its immutable event anchor, replays every later event, then hashes the result against the mutable projection. Unknown/tampered/drifted state fails visibly.
- The first implementation run passed full event replay and normal checkpoint recovery but the tamper case surfaced a projection-shape error before the expected hash error. Read order was corrected so raw hash mismatch is authoritative; the test assertion was unchanged. The final checkpoint PostgreSQL run passed 2/2, the adjacent message/store PostgreSQL run passed 2/2, and the focused pure suite passed 5 files and 16/16 tests. Core typecheck, production ESLint, and `git diff --check` all exited `0`.

## Task 2.8 one-way legacy Happier Session import evidence

- The retained RED run started a real native-Windows embedded PostgreSQL instance, created a task-bound `project.cli_sessions` row through `AsyncCliSessionStore`, and reached both import scenarios. It failed 2/2 with `TypeError: store.importLegacyHappierBinding is not a function`; no placeholder importer or mocked persistence was present.
- Added a one-way import command that treats the existing Happier direct-session binding as an immutable source snapshot. It verifies the project, task, execute purpose, Happier adapter, provider-native Session, CLI row revision, and every persisted `happierDirectSession` identity field inside the same transaction without updating the source row.
- The importer serializes ownership by provider-native Session with a PostgreSQL transaction advisory lock, rejects an already active native/Happier owner, and creates exactly one draft Room, one ready seat, one generation-1 attached binding, and one replayable creation event atomically. `membershipVersion=1` records that the imported Room begins with one established membership snapshot while aggregate event version remains `0`.
- Added migration `0002_room_binding_ownership.sql` and matching Drizzle indexes. Active provider-native and Happier Session identities are unique per project across pending/attached/degraded active states; detached/replaced/failed history remains reusable. The database indexes are the concurrency backstop even if command preflight races.
- Fresh `[0000, 0001, 0002]`, existing-`0000`, existing-`0001`, no-op reapply, duplicate-active rejection, and detached-identity reuse all passed against real embedded PostgreSQL in 3/3 migration tests.
- The successful import test proved the loaded `cli_sessions` row remained exactly equal before and after, produced one Room/seat/binding/event, and rebuilt the complete one-seat aggregate from immutable events alone. A second Room import of the same native Session was rejected while leaving both the new Room ID and legacy row untouched.
- A forced collision on the final Room event ID rejected the transaction and left no imported Room or binding row; the legacy CLI Session still compared exactly equal to its pre-command row. This proves failure rollback rather than compensating mutation of the old binding.
- Final native-Windows embedded PostgreSQL results: import 2/2 and adjacent schema/store/checkpoint 7/7. The focused pure Room suite passed 5 files and 16/16 tests. Core typecheck, scoped production ESLint, and `git diff --check` all exited `0`.

## Task 2.9 canonical core exports and phase-2 verification evidence

- The retained export RED loaded `@fusion/core` successfully and kept the existing contract assertion green, but the new runtime assertion failed because `AsyncRoomStore` was `undefined`. This isolated the missing package boundary rather than inventing a second subpath or testing implementation modules directly.
- The canonical `@fusion/core` root now exports the Room domain, canonical hashing, immutable event replay, transactional Room store, fenced lease store, and checkpoint/recovery store together with all of their public input/result/error types. The package remains on its existing single `.` export; no new alternate database or Room entrypoint was added.
- The export GREEN run passed the Room package export checks and the repository duplicate-export guard in 2 files and 3/3 tests. A broader final pure run passed 6 files and 18/18 tests, including feature gating, contracts, domain behavior, root exports, duplicate-export detection, and static migration checks.
- The first publishable `@fusion/core` build exposed a TypeScript control-flow issue in checkpoint recovery: a mutable nullable checkpoint variable was referenced inside `events.find`. Runtime tests already passed, but emitted compilation correctly failed with TS18047. The block now uses a stable non-null `storedCheckpoint` constant; no behavior or assertion changed. The publishable build, explicit `tsc --noEmit -p tsconfig.json`, and checkpoint PostgreSQL test 2/2 then passed.
- The complete Room native-Windows embedded PostgreSQL gate passed 5 files and 11/11 tests: ordered migrations/ownership indexes, transactional projection/event/outbox/inbox behavior, fenced leases, checkpoint replay/recovery, and one-way legacy Happier import/rollback.
- Scoped production ESLint, strict OpenSpec validation, and `git diff --check` all exited `0`. The previously documented legacy psql-shell harness blocker remains separate; no passing claim is made for the unavailable `psql.exe` suites.

## Task 3.1 Session Connector registry contract RED evidence

- Added an engine/runtime-layer conformance suite for the provider-neutral connector boundary rather than placing provider-name branches in Room core. Its recording connector implements all eleven v1 capability surfaces and keeps native Session, Happier Session, server profile, machine, host, connector, and binding identities separate.
- The suite specifies duplicate/unknown registration behavior; verified/degraded/unavailable/unverified certification; exact canonical-URI ensure and explicit create requests; status and bounded history cursors; ordered event streams; logical message/idempotency/hash sends with native acknowledgement evidence; interrupt/resume/takeover; host-affinity and connector-identity rejection; host-scoped health; and rebuildable Happier/native deep links.
- The retained RED run selected only `engine-default` and reached the new file, then failed before collecting tests because `../session-connector-registry.js` did not exist. Result: one failed suite, zero collected tests, exact missing-module error. No fake registry, skip, todo, or weakened expectation was used.

## Task 3.2 provider-neutral Session Connector Registry evidence

- Added an instance-scoped `SessionConnectorRegistry` to `@fusion/engine`, the plugin/runtime assembly owner, and exported it through the canonical engine root. It deliberately has no process-global default, so project/plugin settings and authentication health cannot leak across project runtimes.
- Registration validates the dynamic v1 connector surface and all twelve required methods, rejects duplicate/unknown connector IDs with typed errors, supports explicit unregister/lookup/enumeration, and accepts no provider-specific branches. A case-insensitive source scan for `codex|claude|opencode|happier` returned zero matches (ripgrep exit 1 for no matches).
- `requireVerified` resolves only connector ID, capability name, optional connector identity, and required host. It rejects connector-identity mismatch and host-affinity mismatch before native work, validates the returned connector/version/source/timestamp/full capability matrix, requires evidence for a verified capability, and rejects degraded/unavailable/unverified states with their exact state and safe reason.
- The original RED suite turned GREEN at 7/7. Runtime-shape and public engine-root export coverage then expanded the final focused run to 2 files and 13/13 tests; malformed dynamic methods and a mismatched capability connector ID produce typed contract failures rather than raw property errors.
- Explicit engine `tsc --noEmit`, scoped production ESLint, publishable engine `tsc` build, strict OpenSpec validation, and `git diff --check` all exited `0`.
