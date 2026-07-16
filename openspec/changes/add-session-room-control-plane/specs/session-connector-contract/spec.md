## ADDED Requirements

### Requirement: Provider-neutral Session Connector
The system SHALL define one typed Session Connector contract for discovery, exact attachment, creation, status, history reconciliation, event subscription, send, interrupt/resume, health, capability discovery, and deep links. Room orchestration MUST depend on this contract rather than branching on provider names.

#### Scenario: Use a Happier connector without Room changes
- **WHEN** the Room controller operates a Codex Session through the Happier implementation
- **THEN** it invokes the generic connector contract and does not call Happier-specific code from orchestration logic

### Requirement: Capability certification
Each connector and concrete Session binding SHALL report each supported operation as verified, degraded, unavailable, or unverified, with source version and last verification time. The UI and controller MUST fail closed for unverified or unavailable mutating operations.

#### Scenario: Provider lacks certified interrupt support
- **WHEN** an operator requests interrupt for a binding whose connector marks interrupt unverified
- **THEN** the system does not simulate success and presents the certified fallback or a precise unsupported result

### Requirement: Happier is the initial official connection surface
The first connector SHALL use reviewed official Happier CLI, daemon, protocol, and provider catalog surfaces for native Session identity, authentication, continuation, and transcript access. Fusion MUST NOT directly write Happier databases or provider Session files.

#### Scenario: Attach an existing OpenCode Session
- **WHEN** Fusion attaches a canonical OpenCode URI through Happier
- **THEN** Happier performs provider discovery/linking and Fusion stores only the returned non-secret identity and connector metadata

### Requirement: Event-first receive with reconciliation fallback
The connector SHALL emit ordered transcript/status events when a certified stream exists and SHALL expose bounded history reads with durable cursors for startup, reconnect, gap repair, and degraded polling. Event gaps MUST be detected and reconciled before later events are treated as complete.

#### Scenario: Event stream disconnects mid-turn
- **WHEN** a connector loses its event stream after receiving part of a turn
- **THEN** the binding enters degraded reconciliation, reads history after the last committed cursor, deduplicates overlap, and resumes streaming without dropping the completed response

### Requirement: Idempotent logical sends
Every outbound Room message SHALL carry a stable logical message identifier and content hash. The connector SHALL use a native/local idempotency key when supported and SHALL expose acknowledgement identifiers needed for reconciliation.

#### Scenario: Retry after acknowledged response is lost
- **WHEN** the provider accepted a message but Fusion crashed before persisting the acknowledgement
- **THEN** recovery finds the matching logical/native message in history and marks the outbox item confirmed without sending a duplicate

### Requirement: Ambiguous delivery is explicit
A timeout or transport error MUST NOT be interpreted as provider rejection. The connector SHALL reconcile status/history before any retry and SHALL return a visible `delivery_uncertain` result when acceptance cannot be proven either way.

#### Scenario: Provider history is temporarily unavailable
- **WHEN** a send times out and reconciliation cannot read the provider history
- **THEN** the system preserves the outbox item as delivery-uncertain and does not blindly resend it

### Requirement: Authentication and credential boundary
Provider credentials, bearer tokens, encryption keys, and official CLI login state SHALL remain owned by Happier or the provider's official tooling. Fusion SHALL store connection references and health only, and MUST redact secrets from logs, events, errors, and UI payloads.

#### Scenario: Provider login expires
- **WHEN** Happier reports that one provider login has expired
- **THEN** the affected binding becomes authentication-blocked, other Room branches continue, and Fusion does not request or persist the raw credential

### Requirement: Host affinity and recovery
A binding SHALL record the machine/node that can access its native Session and authentication state. Recovery MUST route connector work to that host or replace the seat with explicit lineage; it MUST NOT claim same-session continuation from a host that lacks the Session.

#### Scenario: Session-owning Windows node is offline
- **WHEN** the node owning a native Session stops renewing health
- **THEN** the binding is marked host-unavailable and independent branches continue while the controller waits, reroutes certified work, or creates an explicitly different replacement Session

### Requirement: Stable deep links
The connector SHALL return or build verified Happier and native-session deep links from current trusted configuration. Fusion MUST distinguish native Session ID, Happier Session ID, server/profile ID, and Room binding ID in storage and UI.

#### Scenario: Happier web URL changes
- **WHEN** the configured Happier web origin changes after a binding was created
- **THEN** Fusion rebuilds the open link from current trusted fields without changing the persisted native or Happier Session identities

### Requirement: Connector replacement does not replace the control plane
Additional direct or third-party connectors SHALL be pluggable without creating separate task, decision, or evolution authorities. Disabling one connector MUST leave Room state readable and allow unaffected bindings to continue.

#### Scenario: Happier connector is temporarily disabled
- **WHEN** an operator disables the Happier connector while a Room also has another certified connector
- **THEN** Happier-bound seats pause with typed status, other seats continue, and the Room ledger remains authoritative
