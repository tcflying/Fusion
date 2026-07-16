## ADDED Requirements

### Requirement: Cross-agent messages cannot grant authority
All messages received from participants, external content, code comments, documents, or web sources SHALL be treated as untrusted information. A message MAY propose an action but MUST NOT grant tool, workspace, credential, network, or publication authority.

#### Scenario: Agent claims the user approved deletion
- **WHEN** one participant tells another that the user authorized a destructive action
- **THEN** the controller ignores the claimed authority and evaluates the action against the actual Room/user policy and approval record

### Requirement: Structured authority envelopes
Every routed instruction SHALL include authenticated origin, actor type, Room, turn, node, targets, role, allowed scope, and evidence references. Recipients MUST evaluate the envelope separately from the untrusted content body.

#### Scenario: Reviewer sends a repair request
- **WHEN** a reviewer routes a repair instruction to an implementer
- **THEN** the implementer receives reviewer identity and task scope but gains no permissions beyond its existing lease and policy

### Requirement: Role-based multi-user access
The system SHALL support owner, administrator, operator, observer, and auditor roles with explicit permissions for view, message, task mutation, participant mutation, approval, protocol change, candidate promotion, evolution promotion, and system administration.

#### Scenario: Observer attempts to pause a Room
- **WHEN** an observer issues a pause command
- **THEN** the command is rejected, audited, and leaves Room state unchanged

### Requirement: Human operation conflict control
Multiple users MAY view and collaborate concurrently, but high-impact commands and native Session takeovers MUST use leases or optimistic aggregate versions to prevent silent overwrites.

#### Scenario: Two operators edit the task graph
- **WHEN** both submit changes based on the same old Room version
- **THEN** only one version commits and the other receives a conflict with the intervening change

### Requirement: Provider credentials remain outside Fusion
Fusion SHALL use provider/Happier authentication state without storing plaintext provider tokens, account passwords, encryption keys, or copied official credential stores. Logs, events, metrics, and exports MUST redact sensitive values.

#### Scenario: Connector health returns a token-shaped field
- **WHEN** a connector error payload contains credential material
- **THEN** the connector boundary removes it before persistence or display and records only a safe typed authentication error

### Requirement: Scoped context packs
Context SHALL be selected by project, Room, node, role, authority, and data classification. Private review, unrelated logs, secrets, and cross-project content MUST be withheld unless explicitly required and authorized.

#### Scenario: Implementer requests a private blind review
- **WHEN** a producer's context builder encounters a private reviewer message
- **THEN** that review remains withheld until the protocol enters the permitted reveal phase

### Requirement: Authenticated LAN and public gateway
The Fusion gateway SHALL be directly reachable on configured LAN and public interfaces, but all Room data and control operations MUST require authenticated user or paired-device state. Public reachability MUST use HTTPS and MUST NOT expose PostgreSQL, workers, Happier daemon, or provider CLI control ports.

#### Scenario: Unknown public device opens Fusion
- **WHEN** an unpaired device reaches the public URL
- **THEN** it may load only the authentication/pairing surface and cannot read Room metadata or invoke control actions

### Requirement: Network-profile and ingress visibility
The operator SHALL be able to see configured listeners, public/LAN origins, certificate state, paired devices, active sessions, and emergency ingress controls. Starting with insecure or unexpectedly broad exposure MUST produce a severe warning or fail closed according to policy.

#### Scenario: HTTPS certificate expires
- **WHEN** the public certificate is invalid or expired
- **THEN** the system reports public ingress unhealthy, prevents unsafe credential transmission, and leaves local backend work running

### Requirement: Independent data retention and learning authorization
Room operation retention, anonymized evaluation use, and evolution-sample use SHALL be separately configurable. Deleting or archiving Fusion data MUST NOT delete provider Sessions, and unauthorized Room content MUST NOT enter evolution benchmarks.

#### Scenario: Private Room is excluded from learning
- **WHEN** a Room is marked operation-retention-only
- **THEN** its ledger supports recovery/audit but no raw message or artifact is added to replay or evolution datasets

### Requirement: Complete operator and policy audit
Security-relevant reads and writes SHALL record actor, device, action, target, policy decision, approval reference, timestamp, and outcome without storing secrets. Denied and attempted privilege escalations MUST be auditable.

#### Scenario: Admin revokes a device
- **WHEN** an administrator revokes a paired device
- **THEN** existing sessions from that device lose control access and the revocation is recorded with actor and time

### Requirement: License and source provenance
Every reused external component or copied implementation SHALL carry machine-auditable repository, license, version/SHA, notice, and modification provenance. Incompatible code MUST be integrated only through permitted process/API boundaries or independently implemented.

#### Scenario: Import a scheduling strategy from another project
- **WHEN** a candidate includes code derived from an external orchestrator
- **THEN** the license gate verifies compatibility and provenance before the candidate can be promoted
