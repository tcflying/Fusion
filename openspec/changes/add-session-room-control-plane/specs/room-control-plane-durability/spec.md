## ADDED Requirements

### Requirement: Backend-owned orchestration lifetime
Room execution SHALL run in durable backend workers and MUST continue when all browser, PWA, or desktop-shell clients are closed. UI processes MUST NOT own protocol loops, participant leases, or authoritative timers.

#### Scenario: Operator closes every browser tab
- **WHEN** a Room is running and all UI clients disconnect
- **THEN** eligible Room work continues and reopening the UI restores the current projection from durable state

### Requirement: Append-only causal Room ledger
Every accepted Room command and externally observed outcome SHALL append a versioned event with aggregate version, actor, causal/correlation identifiers, timestamp, and non-secret payload. Existing events MUST NOT be rewritten to alter history.

#### Scenario: Reassign a participant role
- **WHEN** a role change becomes active at a turn boundary
- **THEN** the system appends requested and activated events and projects the new role without modifying the old role event

### Requirement: Atomic event, projection, and outbox update
Room state transitions that trigger external work SHALL atomically validate expected version, append events, update projections, and enqueue outbox records in one database transaction.

#### Scenario: Worker crashes after accepting a send command
- **WHEN** the transaction commits and the worker crashes before dispatching to Happier
- **THEN** another worker discovers the committed outbox record and dispatches it without losing the command

### Requirement: Idempotent commands and worker takeover
Every Room command and task step SHALL have an idempotency key. Workers SHALL hold renewable leases with fencing epochs so a replacement worker can resume safely and a stale worker cannot commit later output.

#### Scenario: Two workers contend after a heartbeat timeout
- **WHEN** a second worker takes over an expired Room lease
- **THEN** the lease epoch advances, the new worker resumes from the last checkpoint, and writes from the stale epoch are rejected

### Requirement: Consistent checkpoints
The controller SHALL persist a consistency checkpoint at every turn boundary and before/after high-risk side effects. Checkpoints MUST include protocol state, DAG version, participant bindings/cursors, leases, pending outbox items, and authoritative artifact references.

#### Scenario: Windows restarts during a multi-agent turn
- **WHEN** services restart after an unclean shutdown
- **THEN** recovery loads the last checkpoint, reconciles in-flight external states, and resumes or marks uncertainty without recreating accepted work

### Requirement: Time travel and safe replay
Authorized operators SHALL be able to view Room state at any committed event and fork a replay experiment from a checkpoint. Replay MUST simulate or isolate external side effects by default.

#### Scenario: Compare a new protocol against a failed run
- **WHEN** an operator forks a replay from before the failure
- **THEN** the experiment uses the recorded inputs and authority snapshot while writes, publications, notifications, and provider sends remain isolated unless explicitly enabled

### Requirement: Project and Room isolation
Room persistence, context, permissions, artifacts, and events SHALL be project-scoped by default. Cross-project references MUST require explicit authorization and MUST preserve source project identity.

#### Scenario: Agent searches context in another project
- **WHEN** a Room participant requests an unapproved cross-project context source
- **THEN** the request is denied or approval-gated and no foreign content enters the context pack

### Requirement: Optional multi-node execution
The data model and worker protocol SHALL support multiple Windows worker nodes without requiring a second node for normal operation. Node-hosted provider Sessions MUST retain host affinity, and controller failover MUST preserve Room identity.

#### Scenario: Secondary worker continues independent work
- **WHEN** the primary worker node is lost but another node and the authority database remain reachable
- **THEN** the secondary worker claims eligible nodes, leaves host-bound Session work explicit, and keeps the same Room aggregate

### Requirement: Recovery objectives
For process failure, committed Room ledger data SHALL have `RPO=0` and another worker SHALL target takeover within 60 seconds. After Windows restart, services SHALL target usable Room recovery within five minutes. Database disaster recovery SHALL target no more than five minutes of data loss when configured backups and transaction-log archiving are healthy.

#### Scenario: Room worker process terminates unexpectedly
- **WHEN** a worker terminates after committed events exist
- **THEN** another worker resumes within the target window and no committed event is lost or duplicated

### Requirement: Verified backup and restore
The system SHALL back up Room and central state, verify backup integrity, and perform scheduled isolated restore drills. UI health MUST distinguish a present backup file from a proven restorable backup.

#### Scenario: Scheduled restore drill succeeds
- **WHEN** the restore drill completes against an isolated database
- **THEN** the system records recovery point, duration, schema validation, checksum result, and the Rooms whose projections replayed successfully

### Requirement: Compatible import from one-to-one bindings
An existing task-bound Happier binding SHALL be importable as a one-seat Room without changing its native Session, Happier Session, task, or runtime identity. Import failure MUST leave the old bridge fully usable.

#### Scenario: Import existing SGAC-style task binding
- **WHEN** an operator imports a valid `executor:<taskId>:primary` binding
- **THEN** the Room references the same persisted Session IDs and the legacy task route remains functional until explicitly retired
