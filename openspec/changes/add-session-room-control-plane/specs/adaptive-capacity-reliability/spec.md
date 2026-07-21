## ADDED Requirements

### Requirement: Quality-first adaptive scheduling
The scheduler SHALL optimize quality first and latency second while treating token/call cost as a soft guard against runaway loops. It MUST NOT reduce required independent validation solely to save tokens.

#### Scenario: Critical decision can benefit from more candidates
- **WHEN** confidence remains below the required band and provider capacity is available
- **THEN** the scheduler may add independent candidates or evaluators even when this increases token use

### Requirement: Dynamic capability and performance registry
Each seat/binding SHALL expose provider, actual model, context capacity, tools, MCP/Skill availability, workspace authority, current health, latency, rate limit, historical quality, correction rate, and calibration by task domain. Routing MUST use current values rather than provider labels alone.

#### Scenario: Previously strong Session loses a required tool
- **WHEN** capability refresh shows the tool unavailable
- **THEN** new tasks requiring that tool route elsewhere and the old historical score does not override the missing capability

### Requirement: Full use of safe available capacity
The global scheduler SHALL fill eligible provider/node capacity while reserving configured capacity for verification, recovery, and critical-path work. Any avoidable idle slot MUST have a visible scheduling reason.

#### Scenario: Thirty-two controller slots are configured
- **WHEN** at least thirty-two independent eligible tasks and sufficient provider capacity exist
- **THEN** the controller schedules up to thirty-two active tasks while honoring provider and resource limits

### Requirement: Backpressure and provider-specific limits
The scheduler SHALL maintain separate concurrency, rate-limit, queue, timeout, and circuit-breaker state by provider, account, model, connector, node, and task class. Overload MUST queue or reroute work instead of producing uncontrolled retries.

#### Scenario: One account enters rate-limit pressure
- **WHEN** the connector reports increasing retry-after windows for one account
- **THEN** the scheduler reduces dispatch to that account, preserves queued work, and uses permitted alternatives without flooding retries

### Requirement: Critical-path and fairness policy
Scheduling SHALL consider dependency critical path, Room/project priority, minimum reserved capacity, age, deadline, and fairness. Preemption MUST occur only at a safe turn/checkpoint boundary and MUST preserve resumable state.

#### Scenario: High-priority Room needs a saturated provider
- **WHEN** policy permits preemption of lower-priority work
- **THEN** a safe lower-priority turn checkpoints and yields capacity without losing its task or Session lineage

### Requirement: Failure-aware rerouting
When a provider, connector, model, account, or node degrades, the scheduler SHALL keep independent work running and reassign only tasks whose contracts permit replacement. Host-bound same-session work MUST remain explicit rather than silently rerouted as the same identity.

#### Scenario: Happier daemon restarts
- **WHEN** the Happier connector becomes temporarily unavailable
- **THEN** non-Happier work continues, Happier-bound outbox items remain durable, and dispatch resumes after health and cursor reconciliation

### Requirement: Observable utilization and wait reasons
The system SHALL measure active, queued, reserved, idle, blocked, retrying, and degraded capacity with per-provider/node throughput and latency. It MUST attribute idle time to a machine-readable reason.

#### Scenario: System is below eighty-five percent utilization
- **WHEN** eligible work and capacity appear available during a load run
- **THEN** the report identifies the scheduler, dependency, capability, policy, or provider condition responsible for the shortfall

### Requirement: Scale acceptance baseline
The first formal release SHALL support at least 64 attached seats per Room and 32 simultaneously active controller tasks under controlled load. Real provider tests SHALL run to the current account limits, while a deterministic connector simulator SHALL prove the full controller scale without being presented as real-provider proof.

#### Scenario: Run the scale gate
- **WHEN** the formal load test executes
- **THEN** results separately report real-provider concurrency and 32-active simulated controller concurrency with no conflation of evidence layers

### Requirement: Seventy-two-hour fault-injection soak
The formal release SHALL pass a 72-hour run covering browser closure, worker crash, connector/daemon restart, CLI loss, rate limit, auth expiry, Windows service restart, database connection interruption, participant replacement, and lease takeover.

#### Scenario: Non-failing branches survive injected faults
- **WHEN** faults are injected into selected bindings and workers during the soak
- **THEN** independent branches continue, committed messages are not lost, duplicate side effects remain zero, and each recovery is visible in the event ledger

### Requirement: Recovery and saturation safety
The scheduler SHALL enforce bounded retries, exponential or policy backoff, circuit breaking, memory/process limits, and reserved recovery capacity so full-load operation does not prevent health checks, cancellation, or recovery.

#### Scenario: Provider errors spike at full utilization
- **WHEN** error rate crosses the configured circuit threshold
- **THEN** new dispatch to the failing surface pauses, recovery capacity remains available, and queued work is preserved or rerouted

### Requirement: Optional multi-node capacity pool
Additional Windows nodes SHALL be able to contribute certified worker and provider capacity through the global scheduler. Project path mappings, host affinity, credentials, and node health MUST be validated before dispatch.

#### Scenario: Add a second Windows worker
- **WHEN** the node registers with valid project mapping and connector capabilities
- **THEN** eligible tasks can use its capacity while Sessions bound to the first host remain correctly affined
