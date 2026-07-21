## ADDED Requirements

### Requirement: Outcome-driven improvement hypotheses
The Evolution Controller SHALL derive versioned improvement hypotheses from verified failures, low confidence, retries, human corrections, performance data, unresolved dissent, and successful patterns. It MUST preserve the evidence linking an observed outcome to the proposed change.

#### Scenario: Repeated decomposition failure is detected
- **WHEN** several authorized Rooms show the same no-progress pattern for one protocol step
- **THEN** the controller creates a scoped decomposition-policy hypothesis with linked cases rather than mutating production immediately

### Requirement: Broad but explicit evolution scope
Evolution candidates MAY change prompts, Skills, context selection, memory retrieval, task-decomposition templates, protocol definitions, role assignment, model routing, retry/concurrency policies, connector adapters, evaluation rules, and Fusion source code. Each candidate MUST declare scope, risk, expected mechanism, and affected task domains.

#### Scenario: Candidate modifies connector source code
- **WHEN** the hypothesis requires a Happier adapter correction
- **THEN** the experiment declares the source files, connector capabilities, risk class, expected behavior, and rollback target

### Requirement: Isolated candidate production
Source and executable policy candidates SHALL be created in isolated branches/worktrees or versioned policy stores. An experiment MUST NOT edit the online promoted version in place.

#### Scenario: Agent proposes a scheduler change
- **WHEN** the Evolution Controller authorizes source generation
- **THEN** the code is produced on an isolated candidate branch with immutable input and base revision metadata

### Requirement: Domain-specific replay benchmarks
Candidates SHALL be evaluated against fixed golden cases, rolling authorized difficult cases, adversarial cases, and relevant historical replays for each task domain. Raw private Room data MUST NOT enter the benchmark without the configured authorization.

#### Scenario: Evaluate a creative-review protocol change
- **WHEN** a creative protocol candidate is tested
- **THEN** it runs creative-domain quality/consistency cases and is not promoted from code-test scores alone

### Requirement: Hard gates before optimization metrics
Correctness, security, user constraints, evidence integrity, and regression tests SHALL be hard promotion gates. Only candidates that pass all hard gates MAY be compared on quality, confidence calibration, stability, latency, utilization, token use, correction rate, and rework.

#### Scenario: Faster candidate weakens evidence integrity
- **WHEN** a candidate improves latency but loses required provenance
- **THEN** it fails the hard gate and cannot be promoted regardless of efficiency gain

### Requirement: Independent evaluation and no self-acceptance
The participant or policy that produced an evolution candidate MUST NOT be its sole evaluator, arbiter, or promotion authority. Evaluation SHALL combine deterministic gates with independent reviewers and the configured risk policy.

#### Scenario: Source-modifying Agent marks its own tests green
- **WHEN** the proposing Agent submits a candidate and self-reported result
- **THEN** the system treats that report as evidence input only and runs independent verification before any canary

### Requirement: Canary promotion and automatic rollback
A gate-passing candidate SHALL enter a bounded canary with versioned traffic/task allocation and success/failure criteria. Regression beyond thresholds MUST automatically stop the canary and restore the prior promoted version.

#### Scenario: Canary increases correction rate
- **WHEN** the new routing policy causes statistically or operationally significant extra human corrections
- **THEN** the controller rolls back allocation, records the failed hypothesis, and preserves all canary evidence

### Requirement: Risk-tiered promotion authority
Low-risk policy changes MAY auto-promote only under explicit pre-authorization and passing gates. Source code, permission, authentication, network exposure, destructive action, and high-impact evaluation changes MUST require stronger independent gates and configured human approval.

#### Scenario: Candidate changes public authentication policy
- **WHEN** an experiment proposes a public-gateway permission change
- **THEN** automatic promotion is prohibited and the owner receives the full evidence and rollback plan for decision

### Requirement: Versioned strategy packages
The Room Orchestrator SHALL consume only promoted, immutable strategy/package versions. Running Rooms MUST stay pinned unless a compatible turn-boundary upgrade is explicitly authorized and recorded.

#### Scenario: New protocol version is promoted
- **WHEN** a Room is in the middle of a turn on the previous protocol
- **THEN** the current turn completes under the pinned version and any upgrade follows the normal protocol migration gate

### Requirement: Evolution does not starve user work
Evolution experiments SHALL run asynchronously in a separate or lower-priority capacity pool and MUST NOT consume reserved capacity required for active user Room recovery, validation, or critical paths.

#### Scenario: User Room reaches full provider pressure
- **WHEN** an evolution replay and a high-priority live Room compete for the same provider
- **THEN** the replay yields or pauses according to policy and the live Room retains its reserved capacity

### Requirement: Explainable promotion history
Every promoted, rejected, rolled-back, or inconclusive candidate SHALL retain hypothesis, evidence set, evaluator identities, metrics, gate results, canary allocation, decision actor, version, and rollback target.

#### Scenario: Operator inspects current scheduler strategy
- **WHEN** the operator opens its evolution history
- **THEN** the UI shows why this version was promoted, what it beat, its known domain limits, and how to roll back
