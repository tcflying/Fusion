## ADDED Requirements

### Requirement: Project-scoped operational Rooms
The system SHALL create a durable operational Room with a stable identity, owning project, objective, current protocol version, lifecycle state, and aggregate version. Operational Rooms MUST remain distinct from existing conversational Chat Rooms while allowing links to Fusion Tasks, Missions, Goals, and artifacts.

#### Scenario: Create a Room without creating a chat-only room
- **WHEN** an authorized operator creates an operational Room for a registered project
- **THEN** the system persists the Room in the operational Room domain and does not create or overwrite a `/api/chat/rooms` record

### Requirement: Arbitrary participant seats
The system SHALL support any number of participant seats subject only to configured capacity and policy. A seat MUST have stable Room identity, role history, permission scope, status, and binding history independent of any one provider Session.

#### Scenario: Add more than two mixed-provider participants
- **WHEN** an operator adds Codex, Claude Code, and OpenCode Sessions to an active Room
- **THEN** each appears as a separate stable seat and the Room remains valid without a two-participant special case

### Requirement: Turn-boundary membership changes
The system SHALL allow seats to be added, removed, paused, or replaced while a Room is running. Membership and role changes MUST take effect only at a recorded turn boundary, and in-flight work MUST finish, cancel, or enter a visible uncertain state before the new membership version is active.

#### Scenario: Replace a participant during execution
- **WHEN** an operator replaces a seat while that seat has an active turn
- **THEN** the system records the requested change, resolves the active turn according to policy, and activates the new binding at the next turn boundary without silently interleaving senders

### Requirement: Exact existing-session attachment
The system SHALL accept canonical Codex, Claude Code, and OpenCode native Session URIs and attach only an exact provider/session identity proven by the connector. Repeating the same attachment MUST be idempotent and MUST NOT send a prompt, create a replacement native Session, or mutate provider history.

#### Scenario: Ensure the same Codex thread twice
- **WHEN** the same canonical Codex thread URI is attached to the same eligible seat twice
- **THEN** both operations resolve to the same native and Happier Session identities and no provider turn is started

### Requirement: Policy-controlled new-session creation
The system SHALL be able to create a new provider Session when existing context is unsuitable or additional independent capacity is required, but only when the Room policy permits that provider, model, account, host, and creation count.

#### Scenario: Add an independent blind reviewer
- **WHEN** a protocol requires an independent reviewer and no eligible existing Session is available
- **THEN** the controller creates or requests one permitted new Session, records why it was created, and exposes its provider, model, role, host, and parent task

### Requirement: Stable seat and immutable binding lineage
Replacing a Session SHALL create a new binding generation while preserving every previous binding, contribution, failure, and reason for replacement. A new Session MUST NOT impersonate the old Session or inherit its provider identity.

#### Scenario: Failed Session is replaced
- **WHEN** a lost Session is replaced after recovery attempts are exhausted
- **THEN** the seat continues with a new binding generation and the UI can trace both the old and new Session identities and their handoff context

### Requirement: Routed operator messaging
The Room composer SHALL support messages to the controller, all seats, a selected group, or one or more explicit seats. Global objective or constraint changes MUST be recorded as Room contract changes; local questions MUST NOT silently rewrite the global objective.

#### Scenario: Address two reviewers only
- **WHEN** an operator selects two reviewer seats and sends a question
- **THEN** only those seats receive role-tailored envelopes and the Room ledger records the exact targets

### Requirement: Bidirectional native-session continuation
Messages sent by Fusion through a certified connector SHALL be appended to the same native Session. Messages subsequently added from the native IDE SHALL be ingested into the Room with origin metadata and reconciled before automated sending resumes.

#### Scenario: Alternate between Fusion and native IDE
- **WHEN** Fusion sends to an attached Session, the operator replies from the native IDE, and Fusion resumes afterward
- **THEN** all three surfaces show one continuous native identity and the Room records the writer handoffs without creating an unapproved fork

### Requirement: Single sender lease per native Session
The system MUST enforce one active sender lease for each native Session across automated Room workers and human takeovers. Multiple surfaces MAY observe concurrently, but a competing writer MUST pause, queue, or fail with an explicit lease conflict.

#### Scenario: Human takes over an automated participant
- **WHEN** a native IDE write is detected while Fusion owns the sender lease
- **THEN** Fusion pauses automated sends for that binding, reconciles the external input, transfers or releases the lease, and displays the takeover state

### Requirement: Historical context does not override current contract
An attached old Session SHALL retain its history, but the current user-approved Room objective, constraints, and authority references MUST govern new work. Detected conflicts MUST be surfaced and resolved before affected work continues.

#### Scenario: Old Session contains an obsolete instruction
- **WHEN** the attached history requires behavior that conflicts with the current Room contract
- **THEN** the controller marks the conflict, withholds affected dispatch, and sends a versioned handoff after the current contract is confirmed

### Requirement: Independent deletion boundaries
Deleting or archiving a Fusion Room MUST NOT delete, detach, archive, or rewrite a native provider Session. Native Session deletion MUST be a separate explicit operation that displays all impacted Room bindings.

#### Scenario: Archive a completed Room
- **WHEN** an operator archives a Room that references three native Sessions
- **THEN** the Room becomes archived while all three provider Sessions remain unchanged and discoverable through their native owners
