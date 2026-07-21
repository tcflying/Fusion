## ADDED Requirements

### Requirement: Task-first Room cockpit
Fusion SHALL provide a top-level lazy-loaded Room cockpit whose primary information hierarchy is objective, protocol phase, task DAG, critical path, health, confidence, and capacity. Chat SHALL remain available as a routed secondary surface.

#### Scenario: Open a running Room
- **WHEN** an operator opens the Room route
- **THEN** the first useful view shows current task/participant state and does not require opening a chat thread to discover progress

### Requirement: Interactive DAG visibility
The cockpit SHALL visualize task nodes and dependency edges with distinct states for ready, running, waiting dependency, waiting approval, rate-limited, failed, retrying, accepted, cancelled, and blocked. Selecting a node SHALL expose owner, inputs, outputs, gates, progress signature, attempts, and evidence.

#### Scenario: Identify a critical-path wait
- **WHEN** a critical node waits on a failed dependency
- **THEN** the graph highlights the path and explains the exact dependency and recovery action

### Requirement: Participant operations panel
Every seat card SHALL display role, provider, actual model, native Session identity, Happier identity, host, health, heartbeat, current node, context utilization, throughput, rate limit, sender/workspace lease, and wait reason when available.

#### Scenario: Process dies while UI remains open
- **WHEN** one participant heartbeat expires
- **THEN** its card changes to a typed lost/recovering state with last heartbeat and assigned recovery owner instead of remaining generically active

### Requirement: Capacity and utilization observability
The cockpit and global overview SHALL display theoretical capacity, configured limits, active work, queue depth, reserved verifier/recovery slots, actual utilization, throughput, and explicit reasons for idle capacity.

#### Scenario: Available provider slots are idle
- **WHEN** provider capacity is available but no work is dispatched
- **THEN** the UI identifies whether the cause is dependencies, policy, missing capability, approval, backpressure, or scheduler defect

### Requirement: Evidence, candidate, and dissent panels
The cockpit SHALL expose candidate comparisons, artifact differences, gate results, reviews, unresolved dissent, promotion lineage, and confidence dimensions with drill-down to authoritative evidence.

#### Scenario: Inspect a medium-confidence decision
- **WHEN** an operator selects the confidence band
- **THEN** the UI shows which evidence, stale source, unresolved critique, or calibration gap prevented a high-confidence result

### Requirement: Unified routed composer
The cockpit SHALL provide one input surface that can target the controller, all seats, groups, or selected seats. Targeting and message intent MUST be visible before send and recorded after send.

#### Scenario: Broadcast a new locked constraint
- **WHEN** an owner sends a global constraint through the controller target
- **THEN** the UI previews affected nodes, records the contract change, and distributes role-specific updates at a turn boundary

### Requirement: One-step existing-session import
From a Room, an operator SHALL be able to paste or batch-select canonical provider Session URIs, run a read-only identity/health check, assign seats/roles, and attach without navigating through unrelated settings layers.

#### Scenario: Batch attach three old Sessions
- **WHEN** an operator submits one Codex, one Claude Code, and one OpenCode URI
- **THEN** the UI shows exact identities/capabilities, obtains confirmation, and adds all eligible bindings without creating replacement Sessions

### Requirement: Correct identity labels and deep links
UI labels MUST distinguish Room seat, Room binding, native provider Session, Happier Session, server/profile, and Fusion task identifiers. Each certified binding SHALL offer one-click Happier and native IDE links where available.

#### Scenario: Open a Codex binding from Fusion
- **WHEN** an operator selects the native IDE action
- **THEN** Fusion opens the certified Codex task/thread link and does not substitute the Happier internal Session ID

### Requirement: Actionable alerting
Alerts SHALL be severity-classified, deduplicated by root cause, and include impact, evidence, automated recovery already attempted, next retry time, and available operator actions. Recovery SHALL close or downgrade the alert with a recorded resolution time.

#### Scenario: Authentication expiry blocks one critical seat
- **WHEN** reauthentication is required and automatic replacement is disallowed
- **THEN** the cockpit raises a severe actionable alert with reauth, replace, pause, and inspect options while unaffected work continues

### Requirement: Responsive multi-device experience
Desktop SHALL support full graph editing, candidate comparison, protocol configuration, and operations. Mobile SHALL support health, alerts, messaging, approvals, pause/retry/replacement, and readable graph/diff summaries without horizontal overflow.

#### Scenario: Approve a recovery action from a phone
- **WHEN** an authorized user opens a severe Room alert on a mobile viewport
- **THEN** the decision context and approve/deny controls remain visible and usable without requiring desktop layout

### Requirement: Multi-project global overview
Fusion SHALL provide a global view of Rooms by project, priority, active capacity, queue, health, and critical alerts. Selecting a Room SHALL preserve project scope and navigate directly to its cockpit.

#### Scenario: Find why one project is starved
- **WHEN** an operator views multiple active projects
- **THEN** the overview shows which Rooms consume provider/node capacity and why the starved project is queued

### Requirement: Browser-independent state restoration
The UI SHALL reconstruct all views from backend projections and event cursors after reload or reconnect. It MUST NOT require in-memory browser state to determine current ownership or completion.

#### Scenario: Reopen after a day-long unattended run
- **WHEN** the operator returns from a new browser device
- **THEN** the cockpit loads current Room state and can replay intervening events without restarting the Room
