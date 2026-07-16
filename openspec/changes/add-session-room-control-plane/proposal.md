## Why

Fusion currently proves one task can bind to one Happier-owned native session, but it does not provide the durable N-participant Room needed to coordinate existing Codex, Claude Code, and OpenCode sessions. Operators still lack one reliable place to converse with several sessions, keep independent work moving after partial failures, understand real utilization and confidence, and improve the orchestration system from measured outcomes.

This change turns the proven one-to-one bridge into a general Windows-native collaboration control plane without replacing Happier's session ownership or creating another competing task board.

## What Changes

- Add a persistent Room domain that can attach, remove, replace, and group any number of existing or newly created provider sessions while preserving native-session identity and lineage.
- Add a provider-neutral Session Connector contract, with Happier as the first official connector, for exact session ensure, bidirectional messaging, event/history reconciliation, idempotent delivery, takeover leases, health, and capability discovery.
- Add dynamic hierarchical task DAGs, protocol state machines, role assignment, non-blocking branch isolation, adaptive full-load scheduling, and explicit completion contracts.
- Add evidence-weighted MoA workflows with independent candidates, blind cross-review, deterministic gates, dissent handling, candidate lineage, and explainable confidence.
- Add a Room cockpit centered on task graph, participant health, utilization, waits, evidence, confidence, alerts, and one-click Happier/native-session navigation; chat remains a routed collaboration surface rather than the sole UI.
- Add durable event-ledger recovery, transactional outbox/inbox semantics, checkpoints, operator/session write leases, multi-project isolation, optional multi-node workers, backup/restore evidence, and failure injection gates.
- Add zero-trust cross-agent messaging, scoped context packs, RBAC, audit, data-retention controls, LAN access, and authenticated HTTPS public access.
- Add an asynchronous Evolution Controller that can propose policy, prompt, protocol, routing, adapter, and source-code improvements, then replay, evaluate, canary, promote, and roll back versioned candidates without self-acceptance.
- Preserve Fusion as the sole control plane and Happier as the official session connection surface; Hermes, OpenHands, ruflo, n8n, and similar systems remain optional workers, strategy providers, or notification integrations.
- Establish hard release evidence: real three-provider same-session round trips, 64 attached seats, 32 active tasks, 72-hour fault-injection soak, zero lost committed messages, no duplicate side effects, and Windows-native operation without Docker or WSL.

## Capabilities

### New Capabilities

- `session-room-lifecycle`: Room identity, participant seats, native-session attachment, membership changes, lineage, targeted/group messaging, and native IDE handoff.
- `session-connector-contract`: Provider-neutral connector capabilities, Happier integration, event-plus-reconciliation transport, idempotent delivery, health, and takeover leases.
- `room-orchestration`: Dynamic task DAGs, protocol state machines, roles, decomposition, non-blocking failure isolation, scheduling, and completion semantics.
- `evidence-confidence-moa`: Independent candidate generation, blind review, deterministic evidence gates, dissent resolution, candidate promotion, and calibrated confidence.
- `room-control-plane-durability`: Durable ledger, transactional state, checkpoints, recovery, event replay, multi-project isolation, backup, and optional multi-node execution.
- `room-operations-cockpit`: Desktop/mobile Room UI, task and participant observability, utilization, waits, alerts, evidence, controls, and deep links.
- `room-security-governance`: Zero-trust messages, tool authority, RBAC, network exposure, authentication boundaries, privacy, retention, and audit.
- `adaptive-capacity-reliability`: Capability-aware routing, quality-first adaptive concurrency, backpressure, provider degradation, soak testing, and recovery objectives.
- `controlled-self-evolution`: Versioned improvement hypotheses, isolated source/policy candidates, replay benchmarks, independent evaluation, canary promotion, and rollback.

### Modified Capabilities

None. This repository does not yet contain published OpenSpec capability specifications; the existing Fusion-Happier bridge remains the implementation baseline consumed by the new capabilities.

## Impact

- Fusion domains: `packages/core`, `packages/engine`, `packages/dashboard`, `packages/cli`, optional desktop/PWA surfaces, plugin SDK, PostgreSQL persistence, run audit, self-healing, scheduler, and multi-project boundaries.
- Existing bridge: `plugins/fusion-plugin-happier-runtime`, task-bound Happier direct-session routes/card, async CLI-session persistence, native-session binding, and the `executor:<taskId>:primary` compatibility path.
- External integration: the reviewed Happier `direct-session ensure`, `session send/status/history`, daemon, transcript-delta, provider catalog, and official auth/session stores. Fusion must not copy credentials or become a second transcript authority.
- Runtime and operations: native Windows services, authenticated LAN/public gateway, browser/PWA clients, optional worker nodes, PostgreSQL backup/recovery, and provider-specific real E2E fixtures.
- Compatibility: existing one-task/one-session bindings continue to work and can be imported as single-participant Rooms; no provider session is silently forked, deleted, or overwritten.
