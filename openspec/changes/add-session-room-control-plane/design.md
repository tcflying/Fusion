## Context

The implementation baseline is not the Fusion or Happier primary checkout. The reviewed Fusion bridge lives at commit `21191c4cb` on `codex/happier-runtime-bridge`; the reviewed Happier Direct Session command lives at commit `2bcd6c170` on `codex/direct-session-cli`. That baseline already provides a bundled Happier runtime plugin, argument-safe JSON CLI invocation, native-session identity persistence, a task-scoped `executor:<taskId>:primary` binding, a dashboard connection card, and a real Windows proof that one Codex URI idempotently maps to one Happier session.

Fusion also already owns tasks and dependencies, missions, agents, scheduler/self-healing, approvals, messages, chat rooms, evaluations, multi-project registration, node placement, run audit, and dashboard event delivery. Those components are useful infrastructure, but none is the complete requested Room:

- task-bound Happier linkage assumes one task and one primary external session;
- dashboard Chat Rooms orchestrate conversational agent replies and do not own task DAGs, leases, evidence, candidate promotion, or crash recovery;
- Missions are planning/progress hierarchies, not a live message router or provider-session authority;
- Happier owns provider authentication, native-session discovery, transcripts, and provider-specific continuation, and must remain that authority.

The design therefore adds an operational Room bounded context to Fusion while reusing the existing stores, scheduler, event bus, approval system, evaluator, plugin SDK, and Happier bridge at their natural boundaries.

## Goals / Non-Goals

**Goals:**

- Coordinate an arbitrary number of existing or new Codex, Claude Code, and OpenCode sessions from one durable Fusion Room.
- Preserve exact native-session identity and bidirectional continuation through Happier and the original IDE.
- Keep unrelated branches running when one participant, provider, worker, or approval is blocked.
- Provide dynamic task decomposition, protocol-driven collaboration, evidence-weighted MoA, independent acceptance, and explainable confidence.
- Make utilization, waits, failures, recovery, leases, decisions, dissent, artifacts, and lineage visible in one Room cockpit.
- Support Windows-native unattended execution, LAN and authenticated public access, multi-project isolation, and optional multi-node workers.
- Allow controlled self-evolution of prompts, protocols, routing, adapters, and source code through replay, independent evaluation, canary, promotion, and rollback.
- Preserve existing one-to-one bridge behavior and import it without silent provider-session creation or transcript duplication.

**Non-Goals:**

- Replacing Happier's authentication, encrypted/plain transcript storage, provider catalog, daemon, or Direct Session ownership.
- Turning Hermes, OpenHands, ruflo, n8n, or another orchestrator into a second authoritative control plane.
- Reusing conversational Chat Rooms as the authoritative execution model.
- Allowing peer messages to grant tool or workspace authority.
- Claiming physical exactly-once delivery across external providers; the contract is at-least-once transport with business idempotency and reconciliation.
- Requiring Docker or WSL.
- Releasing or publishing Fusion/Happier packages automatically.
- Silently deleting, detaching, archiving, forking, or replacing a native provider session.

## Decisions

### 1. Add an operational Room bounded context

Create a core `RoomStore`/`AsyncRoomStore` and engine `RoomController`. A Room references a project and may reference Missions, Fusion Tasks, Goals, or artifacts, but it is not encoded as one giant Task, Mission, or Chat Room.

The user-facing term remains **Room**. Internal persistence and route names use an unambiguous operational namespace (for example `operation_rooms` and `/api/rooms`) so existing `/api/chat/rooms` behavior stays compatible.

Alternatives rejected:

- Extending Chat Rooms would couple durable orchestration to a sequential responder loop and conversational message schema.
- Extending Missions would overload a planning hierarchy with transport, lease, and delivery state.
- Encoding the Room in task posture JSON would hide relational invariants and make recovery/querying unsafe.

### 2. Preserve three explicit authorities

- Native Codex/Claude/OpenCode Session and Happier own provider history, provider authentication, and continuation.
- Fusion Room ledger owns membership, roles, routing, task graph, protocol state, leases, decisions, recovery cursors, and operator actions.
- Git/workspaces/artifact stores and deterministic tests own deliverable truth.

Fusion stores routed-message envelopes and evidence references needed for orchestration, but it does not copy provider credentials or declare its projection to be the provider transcript authority.

### 3. Use append-only events plus transactional projections

Room writes use PostgreSQL transactions through Fusion's canonical async data layer. `room_events` is the immutable causal ledger. Query-oriented tables project current Rooms, seats, bindings, task nodes/edges, turns, messages, leases, outbox delivery, artifacts/candidates/reviews, checkpoints, alerts, and confidence snapshots.

Every command carries an idempotency key and expected aggregate version. A transaction appends the event, updates projections, and enqueues any external side effect. UI and workers consume committed events; they never infer completion from an in-memory browser state.

This is event-sourced where replay and audit are material, not a requirement to rebuild every existing Fusion store around event sourcing.

### 4. Promote the Happier bridge to a provider-neutral Session Connector

Define a connector contract with capability discovery rather than assuming all providers are identical. The initial Happier connector wraps reviewed official surfaces for:

- exact existing-session ensure and optional session creation;
- status, bounded history/delta reconciliation, and health;
- send with logical/local idempotency keys;
- event or transcript-delta subscription when available;
- stop/interrupt/resume/takeover operations when certified;
- Happier/native deep links and immutable identity metadata.

The adapter reports each capability as verified, unavailable, degraded, or unverified. Fusion hides or degrades unsupported actions instead of fabricating parity. Future direct Codex/Claude/OpenCode connectors can implement the same interface without changing Room orchestration.

Alternatives rejected:

- Browser automation is not a production transport.
- Undocumented Happier database or HTTP writes would create an unmaintainable second integration path.
- Making the custom UI plugin the transport owner would stop Rooms when the plugin/UI is absent.

### 5. Event-first delivery with durable reconciliation

The primary receive path is a connector event stream. Each binding persists provider/Happier cursors and the last confirmed native message identity. Status/history polling is used for startup, reconnect, detected gaps, and degraded connectors.

The send path is a transactional outbox:

1. persist logical message id, target binding, payload hash, authority envelope, and dispatch state;
2. dispatch through the connector;
3. persist provider acknowledgement and cursor;
4. after ambiguous failure, reconcile provider history before retrying;
5. deduplicate by logical/local id or safe content fingerprint;
6. expose unresolved delivery as `delivery_uncertain`, never as success.

External tool and artifact operations use the same idempotency discipline. This produces recoverable business semantics without making an impossible cross-provider exactly-once claim.

### 6. Model participants as stable seats with replaceable session bindings

A Room participant seat has stable identity, role history, permissions, task assignments, and performance data. A seat binds to one concrete provider session for a bounded interval. Replacement creates a new binding version and preserves the old lineage; it never impersonates the prior Session.

Membership changes and role changes take effect at turn boundaries. A session may be observed from multiple surfaces, but only one sender lease may be active. Native IDE takeover pauses the automated sender, reconciles history, and transfers the lease explicitly.

### 7. Use dynamic DAGs and versioned protocol state machines

`RoomController` executes typed task nodes with inputs, outputs, dependencies, role requirements, resource hints, write scopes, acceptance gates, retry policy, and progress signatures. It may add, split, merge, cancel, or reopen nodes when new evidence changes the plan; accepted nodes stay frozen unless upstream evidence is invalidated.

Collaboration behavior is a versioned declarative protocol containing phases, roles, message channels, context-pack rules, transitions, gates, timeouts, recovery actions, and termination conditions. Code executors are optional hooks for behavior that cannot be expressed declaratively.

Initial protocol families are analysis/decision, implementation, diagnosis, creative review, and bounded free discussion. Messages use typed intents such as proposal, question, critique, challenge, verdict, handoff, and help request.

### 8. Isolate failure and workspace mutation

One failed or waiting branch does not stop independent branches. No-progress is detected from unchanged progress signatures, repeated semantic content, missing evidence/artifact change, or exhausted recovery actions. Recovery can replan, replace/add a participant, change model, shrink the node, or request an operator decision.

Workspace writes require a fenced lease. Concurrent implementations use isolated worktrees or artifact spaces. Only a gate-passing candidate is promoted to the authority branch. The existing Fusion checkout/node lease primitives are reused where their task scope matches; Room-level message/session leases are separate typed leases rather than overloaded checkout fields.

### 9. Treat consensus as evidence, not acceptance

MoA runs begin with independent candidates, followed by blind cross-review, deterministic gates, and an independent arbiter. A producer cannot be the sole validator of its own candidate. Hard test/rule failures cannot be overridden by model votes.

Confidence is a versioned snapshot derived from evidence coverage and quality, validation strength, independent agreement, unresolved dissent, historical calibration, and freshness. The UI presents dimensions and calibrated bands (`high`, `medium`, `low`, `unknown`) rather than an unexplained model-authored percentage.

Candidate artifacts are immutable and keep parentage, producing session, input/config version, content hash, tests, reviews, and promotion decision. A combined candidate is a new candidate and must be revalidated.

### 10. Integrate with existing Fusion control-plane services

- CentralCore/global concurrency contributes project capacity and node placement.
- AgentStore supplies durable agents, health, role permissions, and history where applicable.
- TaskStore/MissionStore remain deliverable and planning systems; Room task nodes can link to them.
- ApprovalRequestStore gates privileged actions without stopping unrelated branches.
- EvalStore and deterministic signal/evidence collectors seed Room evaluation and Evolution experiments.
- MessageStore patterns inform envelopes and inbox/outbox behavior, but Room messages use Room-owned persistence and typed channels.
- Self-healing and run-audit receive Room-specific events and recovery controllers.
- Existing Chat UI components may be reused for the composer/transcript, while `/api/chat/rooms` and `ChatManager.sendRoomMessage` remain unchanged.

### 11. Build a Room cockpit as a core lazy dashboard view

Add a lazy top-level Room view rather than embedding the entire experience in Task Detail or Chat. The main surface contains:

- Room objective, protocol phase, health, completion contract, critical path, confidence, and capacity;
- interactive DAG and task-node detail;
- participant seats with provider/model/session, role, lease, heartbeat, context, utilization, rate limit, and wait reason;
- candidate/evidence/dissent/decision panels;
- filterable event/message timeline and alerts;
- add/replace/pause/retry/replan/takeover actions and one-click Happier/native links.

Desktop provides full operation. Responsive mobile prioritizes monitoring, messaging, approvals, pause/retry/replacement, and alert handling while keeping large graph/diff editing read-only or simplified.

### 12. Keep browser lifetime independent from orchestration

Room workers run in the Fusion backend under the repository's supervised-process/runtime conventions. Browser/PWA clients are projections and command senders. Production packaging uses native Windows services with supervised restart and bounded backoff; only the authenticated Fusion gateway is exposed to LAN/public clients. PostgreSQL, Happier daemon, workers, and provider CLIs remain private to trusted nodes.

Public reachability means the login/pairing page is reachable automatically, not that anonymous devices receive control authority. HTTPS, RBAC, device revocation, rate limits, audit, and emergency ingress disablement are mandatory.

### 13. Separate live orchestration from controlled evolution

The Evolution Controller is an asynchronous Fusion backend module, not a second product. It consumes authorized Room outcomes and can generate changes to prompts, skills, protocol definitions, routing, context selection, adapters, or source code in isolated branches.

A candidate must pass fixed and rolling replay sets, deterministic gates, independent evaluation, regression/non-inferiority checks, and a bounded canary before promotion. Low-risk changes may auto-promote only under pre-authorized policy; high-risk code/permission/network changes require stronger gates. Degradation triggers automatic rollback. The proposer cannot be the sole evaluator.

### 14. Implement one real vertical spine, then expand in parallel

The first integrated spine is:

`Room -> two or more existing session seats -> Happier ensure -> bidirectional send/event reconciliation -> durable ledger -> crash recovery -> cockpit state`

After this spine is real, independent worktrees can advance connector breadth, DAG/protocols, cockpit, evaluation/confidence, security/operations, and evolution concurrently against versioned contracts. This preserves the complete target while preventing late integration of incompatible subsystems.

## Risks / Trade-offs

- **[Baseline branches are not yet upstream/default]** → Pin both reviewed SHAs, audit divergence before each integration, keep changes in a child worktree, and never claim default-branch support until merged and retested.
- **[Existing Chat Room terminology collides with operational Rooms]** → Keep APIs, tables, types, and navigation namespaces explicit; provide migration-free coexistence.
- **[Provider capabilities differ or drift]** → Maintain a runtime capability matrix backed by real E2E certification; feature gates fail closed.
- **[Event sourcing and projections increase implementation cost]** → Limit event sourcing to the Room bounded context and derive only operationally required projections.
- **[External send can be acknowledged ambiguously]** → Durable outbox, logical ids, transcript reconciliation, and visible `delivery_uncertain` states; never blind retry.
- **[High concurrency can amplify provider throttling and local resource pressure]** → Adaptive provider/node limits, backpressure, reserved verifier/recovery capacity, and explicit utilization/wait metrics.
- **[Session is host-affined]** → Persist node ownership and capability; fail over independent branches or replace the seat while preserving identity lineage.
- **[Public gateway increases attack surface]** → HTTPS, authenticated device/user sessions, RBAC, zero-trust message envelopes, rate limits, audit, and private internal services.
- **[Self-evolution optimizes proxies or regresses quality]** → Hard gates, domain-specific multi-objective benchmarks, blind independent evaluation, canary, and rollback.
- **[Large scope can produce many disconnected partial systems]** → Vertical-spine integration gate, narrow contracts, disjoint worktrees, daily integration, and no mock-only completion claims.
- **[Fusion persistence architecture is transitioning]** → Implement Room persistence only through the canonical async/PostgreSQL data layer confirmed in the target branch; do not introduce a third database path.

## Migration Plan

1. Pin and verify the existing Fusion/Happier bridge SHAs; retain current one-to-one APIs and UI.
2. Add Room schema, events, projections, stores, feature gate, and read-only APIs with no external sends.
3. Add Session Connector capability registry and adapt the existing Happier plugin without removing runtime compatibility.
4. Import an existing task-bound binding as a one-seat Room projection; verify identity and idempotency.
5. Complete the two-plus-session vertical spine with durable delivery, event/history reconciliation, lease handoff, and restart recovery.
6. Add dynamic DAG/protocol execution, non-blocking scheduling, candidates/evidence/confidence, and the cockpit.
7. Add Evolution Controller experiments, replay, canary, promotion, and rollback.
8. Run clean Windows install/upgrade/rollback, three-provider round trips, 64-seat/32-active load, 72-hour fault injection, LAN/public security, and backup restore drills.
9. Keep the feature gate off by default until the real E2E gates pass. Rollback disables Room dispatch while retaining append-only data and the existing one-to-one bridge.

## Open Questions

The product decisions are closed. The following are implementation evidence items and must be resolved from current source/runtime before their owning task begins:

- Which current Fusion async/PostgreSQL migration owner is canonical for new Room tables on the pinned branch?
- Which Happier event/transcript-delta and takeover operations are exposed by stable public CLI/daemon contracts for each provider, versus requiring a minimal upstream addition?
- Which current Fusion dashboard graph component and plugin/core view boundary minimizes duplicate UI code?
- What concurrency the installed provider accounts and local hardware permit during real-provider E2E beyond the controller's 32-active synthetic gate?
- Which native Windows service wrapper and TLS ingress mechanism fit Fusion's current release packaging without introducing an unsupported runtime dependency?
