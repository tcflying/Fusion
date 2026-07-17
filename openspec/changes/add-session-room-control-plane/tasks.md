## 1. Baseline, provenance, and implementation seams

- [x] 1.1 Record and verify the exact Fusion bridge and Happier Direct Session base SHAs, worktree status, licenses, public CLI/help surfaces, and existing real E2E evidence without modifying either preserved baseline worktree.
- [x] 1.2 Inventory existing tests and owners for native-session binding, async CLI sessions, Chat Rooms, MessageStore, TaskStore dependencies, scheduler leases, evaluations, dashboard events, and plugin views; classify each baseline as reusable, partial, rejected, or missing.
- [x] 1.3 Run the narrow current bridge/Direct Session test and typecheck lanes and retain exact baseline failures separately from new regressions.
- [x] 1.4 Add a fail-closed Room feature gate and compatibility tests proving legacy `executor:<taskId>:primary` binding, task detail card, and Happier runtime plugin behavior remain unchanged while the gate is off.
- [x] 1.5 Define versioned package/API contracts for Room storage, Session Connector, controller commands/events, protocol definitions, evidence, and UI DTOs before parallel implementation begins.

## 2. Room domain and PostgreSQL persistence

- [x] 2.1 Add RED tests for Room lifecycle states, aggregate versions, participant-seat identity, binding generations, turn-boundary mutations, terminal-state immutability, and invalid transition rejection.
- [x] 2.2 Add canonical async/PostgreSQL schema and migrations for operational Rooms, seats, bindings, turns, events, task nodes/edges, messages, outbox delivery, leases, checkpoints, artifacts/candidates/reviews, confidence snapshots, and alerts without introducing a third persistence path.
- [x] 2.3 Implement typed Room domain records and transition helpers in focused `@fusion/core` modules, including FNXC requirement comments on the user-facing invariants.
- [x] 2.4 Implement `AsyncRoomStore` transactional commands that validate expected aggregate version, append immutable events, update projections, and emit post-commit notifications.
- [x] 2.5 Implement idempotency-key storage, transactional outbox/inbox state, delivery attempts, uncertainty states, and duplicate-command handling with concurrent PostgreSQL tests.
- [x] 2.6 Implement fenced Room, sender, and workspace lease persistence with epoch-based stale-writer rejection and real concurrent-store tests.
- [x] 2.7 Implement turn checkpoints and projection rebuild/replay tests from append-only Room events.
- [x] 2.8 Implement one-way import of an existing task-bound Happier Session as a one-seat Room and prove import failure leaves the legacy binding untouched.
- [x] 2.9 Export Room stores/types through canonical core entrypoints and run scoped core typecheck, lint, migration, and PostgreSQL tests.

## 3. Session Connector and Happier adapter

- [x] 3.1 Add RED contract tests for connector capability states, exact ensure/create, status, history cursors, events, send acknowledgements, interrupt/resume, host affinity, health, and deep links.
- [x] 3.2 Introduce the provider-neutral Session Connector registry in the natural plugin/runtime owner without provider-name branching in Room orchestration.
- [x] 3.3 Adapt the existing Happier runtime plugin's reviewed CLI runner and Direct Session wrapper to implement connector ensure/status/history/send while preserving its current AgentRuntime API.
- [x] 3.4 Add logical/local message IDs to connector sends and persist native acknowledgements/cursors without logging message content or credentials in run audit.
- [x] 3.5 Implement event-first transcript/status ingestion using certified Happier event surfaces, with bounded history polling for startup, reconnect, gap repair, and degraded mode.
- [x] 3.6 Implement ambiguous-send reconciliation and `delivery_uncertain` handling; prove an accepted-before-crash message is not blindly sent twice.
- [x] 3.7 Implement typed authentication, daemon, server, backend, rate-limit, host, and capability health with secret redaction and fail-closed mutating actions.
- [x] 3.8 Correctly expose native Session ID, Happier Session ID, server/profile ID, binding ID, and certified deep links as separate fields.
- [x] 3.9 Build a source-backed Codex/Claude/OpenCode capability matrix and add connector conformance tests that skip or fail explicitly by certified capability rather than claiming parity.

## 4. Durable Room controller vertical spine

- [x] 4.1 Add RED tests for backend-owned Room lifecycle, worker lease acquisition, restart takeover, browser independence, and project-engine startup/shutdown integration.
- [x] 4.2 Implement the supervised `RoomController`/worker lifecycle and wire it into the existing project engine without creating a second scheduler process.
- [ ] 4.3 Implement participant add/remove/pause/replace and role changes at turn boundaries with immutable binding lineage.
- [ ] 4.4 Implement routed operator messages to controller, all, group, or selected seats using structured authority envelopes and durable target records.
- [ ] 4.5 Implement one-sender lease and native IDE takeover reconciliation so observation can be concurrent but provider writes cannot interleave.
- [ ] 4.6 Complete the first real two-plus-existing-Session spine: Room creation, exact Happier attachment, targeted sends, response/event ingestion, persisted history, and same native identities.
- [ ] 4.7 Inject crashes after command commit, after external send, before acknowledgement, and during takeover; prove recovery or visible uncertainty with no silent loss.
- [ ] 4.8 Add Room lifecycle/run-audit events and startup self-healing that preserve human pause, approval, and terminal-state invariants.

## 5. Dynamic DAG and protocol execution

- [x] 5.1 Add RED tests for typed task nodes/edges, dependency readiness, critical paths, accepted-node freeze, and evidence-driven reopen rules.
- [ ] 5.2 Implement dynamic hierarchical DAG commands and projections, including add/split/merge/cancel/reopen with causal evidence.
- [x] 5.3 Define and validate versioned declarative protocol schemas for phases, roles, channels, context packs, transitions, gates, timeouts, recovery, and exit conditions.
- [ ] 5.4 Implement initial analysis, implementation, diagnosis, creative-review, and bounded-discussion protocol definitions with migration/version tests.
- [ ] 5.5 Implement capability-aware role assignment, user locks/forbids, phase changes, and producer/verifier separation.
- [ ] 5.6 Implement structured proposal/question/critique/challenge/verdict/handoff/help-request routing and semantic loop breaking.
- [ ] 5.7 Implement dependency-aware non-blocking dispatch so waits and failures pause only dependent branches.
- [ ] 5.8 Implement progress signatures and the recorded recovery ladder for no-progress nodes.
- [ ] 5.9 Reuse/extend Fusion checkout and branch-group primitives for fenced workspace writes and isolated parallel candidate worktrees.
- [ ] 5.10 Implement contract-driven `completed`, `completed_with_risks`, `partial`, `blocked`, `cancelled`, and `failed` terminalization with independent-verification gates.

## 6. Adaptive capacity and reliability scheduling

- [ ] 6.1 Add a dynamic capability/performance registry for each concrete Session binding with provider/model/tools/context/health/latency/rate-limit/domain-quality/calibration fields.
- [ ] 6.2 Extend global concurrency accounting to include Room work while preserving existing task/triage slot semantics and per-project isolation.
- [ ] 6.3 Implement quality-first adaptive scheduling with critical-path priority, fairness, project/Room priority, minimum reservations, and safe turn-boundary preemption.
- [ ] 6.4 Implement per-provider/account/model/connector/node backpressure, retry-after handling, circuit breakers, bounded retries, and reserved verifier/recovery capacity.
- [ ] 6.5 Implement permitted participant/model rerouting while preserving host-bound native-session identity and explicit replacement lineage.
- [ ] 6.6 Emit capacity, throughput, queue, utilization, idle-reason, wait-reason, saturation, and recovery metrics suitable for the Room and global dashboards.
- [ ] 6.7 Add deterministic load harnesses for 64 seats and 32 active controller tasks, keeping simulated-control-plane proof separate from real-provider proof.

## 7. Evidence, candidates, MoA, and confidence

- [ ] 7.1 Add immutable artifact/candidate/review/dissent/promotion records with provenance, hashes, input/config versions, and parent lineage.
- [ ] 7.2 Implement independent candidate fan-out and blind identity-randomized review packs.
- [ ] 7.3 Integrate deterministic rule/test/source/runtime gates so failed hard gates cannot be overridden by model votes or arbiter output.
- [ ] 7.4 Implement independent arbitration, tie/conflict escalation, and critical-dissent ownership/resolution workflows.
- [ ] 7.5 Implement candidate comparison and synthesis as creation of a new revalidated child candidate, never an overwrite.
- [ ] 7.6 Implement versioned confidence snapshots from evidence coverage/quality, validation strength, independent agreement, dissent, historical calibration, and freshness.
- [ ] 7.7 Add domain-specific evaluation profiles for code, diagnosis, research, documents, creative work, and external automation.
- [ ] 7.8 Integrate Room evidence with existing EvalStore/evidence collectors while preserving deterministic scoring authority and bounded source references.

## 8. Room APIs and operations cockpit

- [ ] 8.1 Add authenticated project-scoped Room CRUD, participant, message, task-node, protocol, candidate, evidence, alert, replay, and operator-action routes with Zod validation and optimistic versions.
- [ ] 8.2 Add an event-cursor/SSE or existing canonical live-event surface for Room projections, reconnect, and bounded replay.
- [ ] 8.3 Add a lazy top-level Room cockpit route/navigation entry without changing existing Chat Room behavior or creating a plugin-owned second control plane.
- [ ] 8.4 Implement objective/phase/health/completion/critical-path/confidence/capacity header and interactive DAG with typed states and node details.
- [ ] 8.5 Implement participant cards with correct IDs, roles, model/provider, host, heartbeats, context, throughput, limits, waits, and sender/workspace leases.
- [ ] 8.6 Implement the routed composer for controller/all/group/multi-select targets with visible intent and contract-change previews.
- [ ] 8.7 Implement candidate, diff, gate, evidence, dissent, decision, and confidence drill-down panels.
- [ ] 8.8 Implement actionable deduplicated alerts with impact, evidence, attempted recovery, next retry, direct controls, and resolution history.
- [ ] 8.9 Implement one-step/batch old-Session import, read-only preflight, automatic/manual role assignment, and one-click Happier/native deep links.
- [ ] 8.10 Implement desktop, narrow desktop, tablet, and mobile behavior; mobile retains monitoring, messaging, approvals, pause/retry/replacement, and readable graph/diff summaries.
- [ ] 8.11 Add a multi-project global Room/capacity/alert overview and prove project selection cannot leak Room state across scopes.

## 9. Security, users, network, and data governance

- [ ] 9.1 Implement signed/validated message authority envelopes and prove peer content cannot grant tool, workspace, credential, or publication authority.
- [ ] 9.2 Implement owner/admin/operator/observer/auditor RBAC, multi-device sessions, optimistic conflicts, and one-human-takeover lease.
- [ ] 9.3 Implement project/Room/role-scoped Context Provider retrieval with provenance, freshness, private-review withholding, secret filtering, and cross-project denial by default.
- [ ] 9.4 Keep provider credentials in official CLI/Happier stores and add boundary redaction tests for errors, events, metrics, exports, and health payloads.
- [ ] 9.5 Add native LAN listener configuration plus authenticated HTTPS public gateway, device pairing/revocation, rate limits, emergency ingress disablement, and private internal service ports.
- [ ] 9.6 Add separate operational-retention, anonymized-evaluation, and evolution-sample authorizations; prove Room deletion cannot delete provider Sessions.
- [ ] 9.7 Add complete operator/device/policy/approval/denial audit events without secret or unrestricted prompt content.
- [ ] 9.8 Add dependency license/source/SHA/NOTICE inventory and automated gates for reused external orchestrator code or strategies.

## 10. Controlled Evolution Controller

- [ ] 10.1 Add RED tests and persistence for hypotheses, experiments, candidate versions, benchmark cases, gate results, canaries, promotion decisions, and rollback lineage.
- [ ] 10.2 Implement authorized outcome-signal collection from failures, corrections, confidence, retries, dissent, quality, stability, utilization, and latency.
- [ ] 10.3 Implement isolated policy/source candidate creation in dedicated branches/worktrees with scope, risk, mechanism, base revision, and rollback target.
- [ ] 10.4 Implement fixed, rolling difficult, adversarial, and authorized historical replay datasets with domain-specific evaluation and privacy controls.
- [ ] 10.5 Implement hard-gate-first independent evaluation and prohibit proposer-only acceptance.
- [ ] 10.6 Implement bounded canary allocation, multi-objective comparison, automatic degradation rollback, and immutable promotion history.
- [ ] 10.7 Implement risk-tiered auto-promotion policy; high-risk source, permission, auth, network, destructive-action, and evaluator changes require stronger gates and configured human approval.
- [ ] 10.8 Pin running Rooms to promoted strategy versions and support only compatible, recorded turn-boundary upgrades.
- [ ] 10.9 Reserve live Room recovery/critical capacity ahead of asynchronous evolution experiments.
- [ ] 10.10 Add Evolution experiment/benchmark/canary/promotion/rollback views to the Fusion cockpit without a separate control product.

## 11. Windows services, backup, and optional multi-node operation

- [ ] 11.1 Package Fusion backend, Room workers, and Happier connector under the repository's supervised native Windows lifecycle with startup, bounded restart backoff, health, logs, and browser-independent operation.
- [ ] 11.2 Add tray/PWA entry points for open cockpit, service health, logs, start/stop/restart, and current LAN/public origins without duplicating frontend logic.
- [ ] 11.3 Extend backup/restore to Room and central state, transaction-log recovery, integrity verification, and scheduled isolated restore drills with visible RPO/RTO evidence.
- [ ] 11.4 Add optional additional Windows worker-node registration, Room lease takeover, project path/capability checks, and host-affined Session handling.
- [ ] 11.5 Add clean install, schema upgrade, service restart, and failed-upgrade rollback tests that preserve Rooms and native-session bindings.

## 12. Real E2E and release gates

- [ ] 12.1 Certify each Codex, Claude Code, and OpenCode connector capability against current official Happier/provider builds and record precise unsupported/live blockers.
- [ ] 12.2 Prove Fusion-to-Happier-to-native-IDE and native-IDE-to-Fusion continuation on the same old Session for each available provider, including alternating takeover and restart.
- [ ] 12.3 Prove one N-participant mixed-provider Room automatically decomposes, runs independent branches, conducts blind review, resolves dissent, and completes only through hard gates.
- [ ] 12.4 Run the 64-seat/32-active load gate, report at least 85 percent eligible-capacity utilization or exact attributable blockers, and prove control/recovery remains responsive at saturation.
- [ ] 12.5 Run the 72-hour fault-injection soak and prove zero lost committed messages, zero duplicate external side effects, non-failing branch continuity, and visible recovery timelines.
- [ ] 12.6 Prove LAN and public HTTPS access, multi-user RBAC, device revoke, mobile intervention, private internal ports, and emergency ingress disablement.
- [ ] 12.7 Run one real controlled self-evolution cycle through hypothesis, source/policy candidate, replay, independent gates, canary, promotion, induced degradation, and automatic rollback.
- [ ] 12.8 Run scoped tests throughout, then required lint, typecheck, build, boot smoke, `test:gate`, migration/restore, CodeGraph sync, and graph update; quarantine only proven flakes under repository policy.
- [ ] 12.9 Add the required labeled changeset for published `@runfusion/fusion` behavior, update operator/architecture/testing docs, and preserve all live evidence with exact commands, IDs, SHAs, PIDs, ports, logs, screenshots, and timestamps.
