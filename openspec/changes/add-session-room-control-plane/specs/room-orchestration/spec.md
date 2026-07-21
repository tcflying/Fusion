## ADDED Requirements

### Requirement: Dynamic hierarchical task DAG
The system SHALL represent Room work as typed task nodes and dependency edges. Each node MUST declare objective, inputs, outputs, dependencies, role/capability needs, resource hints, authority scope, acceptance gates, retry policy, and progress signature.

#### Scenario: Decompose a cross-cutting implementation
- **WHEN** the controller receives a goal requiring independent backend, connector, UI, and verification work
- **THEN** it creates dependent and independent nodes, schedules independent nodes concurrently, and records the decomposition version

### Requirement: Evidence-driven DAG revision
The controller SHALL be able to add, split, merge, cancel, or reopen nodes when new evidence changes the plan. Accepted nodes MUST remain frozen unless an upstream fact or acceptance result is explicitly invalidated.

#### Scenario: A discovered provider limitation changes the plan
- **WHEN** connector certification proves a required operation unavailable
- **THEN** the controller revises only affected unaccepted nodes, records the causal evidence, and leaves unrelated accepted work unchanged

### Requirement: Versioned protocol state machines
Every active Room SHALL execute a versioned protocol defining phases, roles, channels, context packs, transitions, gates, timeouts, recovery actions, and exit conditions. A running Room MUST NOT silently change protocol versions mid-turn.

#### Scenario: Upgrade a protocol during a Room
- **WHEN** an operator selects a newer compatible protocol version
- **THEN** the controller completes or checkpoints the current turn, validates migration, records the version transition, and then uses the new protocol

### Requirement: Multiple collaboration protocols
The system SHALL provide protocol families for analysis/decision, implementation, diagnosis, creative review, and bounded free discussion. The controller MAY select a protocol automatically, and an authorized operator SHALL be able to lock or change it.

#### Scenario: Diagnose a failing integration
- **WHEN** the Room objective is classified as diagnosis
- **THEN** the selected protocol requires parallel hypotheses, evidence gathering, falsification, and root-cause confirmation rather than generic round-robin chat

### Requirement: Dynamic roles with separation of duties
Roles SHALL be assigned from task phase, capabilities, context, health, cost, and operator constraints. A seat MAY change roles between phases, but a producer MUST NOT be the sole validator or accepter of its own candidate.

#### Scenario: Implementer becomes advisor in a later phase
- **WHEN** implementation finishes and independent review begins
- **THEN** the original implementer may answer questions but cannot occupy the sole independent-verifier role

### Requirement: Structured inter-agent communication
Cross-agent messages SHALL carry typed intent, origin, targets, Room/turn/node identity, role, authority envelope, and evidence references. Broadcasts MUST NOT require every participant to respond unless the protocol explicitly assigns that response.

#### Scenario: Reviewer challenges one assumption
- **WHEN** a reviewer sends a `challenge` to the responsible implementer
- **THEN** only the assigned target or protocol-defined responders act and the challenge remains linked to its evidence and resolution state

### Requirement: Non-blocking branch isolation
Failure, timeout, rate limit, authentication wait, approval wait, or human input on one node SHALL pause only that node and its dependents. The controller MUST continue every eligible independent node.

#### Scenario: One provider is rate-limited
- **WHEN** a Claude-bound branch enters a provider rate-limit wait while Codex-bound branches have no dependency on it
- **THEN** the Codex branches continue and the Room reports the exact blocked dependency rather than a global processing state

### Requirement: No-progress detection and recovery ladder
The controller SHALL detect no progress from repeated semantic output, unchanged evidence/artifacts/tests, unchanged progress signatures, or exhausted retries. It SHALL apply a recorded recovery ladder of re-decomposition, participant/model replacement, additional challenge, scope reduction, and operator escalation.

#### Scenario: Two consecutive rounds add no evidence
- **WHEN** a node completes two configured rounds without new evidence, artifact change, test-state change, or resolved dissent
- **THEN** the node is marked no-progress and the next permitted recovery action is executed instead of continuing an unbounded conversation

### Requirement: Fenced workspace mutation
Every mutable workspace or file scope SHALL have one fenced writer lease. Parallel implementations MUST use isolated worktrees or artifact spaces, and stale lease holders MUST be unable to publish after lease epoch changes.

#### Scenario: Two candidates modify the same repository
- **WHEN** two implementers are asked for alternative solutions
- **THEN** each writes in an isolated worktree and only the gate-promoted candidate is integrated into the authority branch

### Requirement: Explicit autonomy levels
Each Room SHALL operate at one of the authorized observation, collaboration, execution, or evolution levels, with narrower overrides per node, participant, and tool. A waiting high-risk approval MUST block only affected operations.

#### Scenario: Execution Room requests an external publish
- **WHEN** an execution-level Room reaches an unapproved publish action
- **THEN** that action waits for approval while permitted local analysis, tests, and independent branches continue

### Requirement: Contract-driven completion
Only the Room controller SHALL transition the Room to a terminal result, based on the accepted contract, critical-node state, hard gates, independent validation, dissent resolution, artifact persistence, and delivery certainty. Model consensus, timeout, or budget exhaustion MUST NOT be recorded as successful completion.

#### Scenario: All agents agree but a hard test fails
- **WHEN** every responding model recommends acceptance while a mandatory deterministic test is red
- **THEN** the Room remains non-complete and records the failing gate and responsible repair node

### Requirement: Distinct terminal outcomes
Room lifecycle SHALL distinguish `completed`, `completed_with_risks`, `partial`, `blocked`, `cancelled`, and `failed`, with machine-readable reasons and unresolved responsibilities.

#### Scenario: Operator accepts a documented residual risk
- **WHEN** all mandatory gates pass and the operator explicitly accepts one recorded non-critical risk
- **THEN** the Room may finish as `completed_with_risks` and retains the accepted risk and actor in the ledger
