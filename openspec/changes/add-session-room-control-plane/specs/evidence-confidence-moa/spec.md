## ADDED Requirements

### Requirement: Independent candidate generation
MoA protocols SHALL generate candidate solutions independently before exposing peer outputs, unless the protocol explicitly enters a synthesis phase. The system MUST record model, Session, context version, protocol version, and parent candidate for each result.

#### Scenario: Three models propose a design
- **WHEN** a design node requests three independent candidates
- **THEN** each producer receives the same authoritative brief without other candidates and all three results retain independent provenance

### Requirement: Blind cross-review
The system SHALL support reviews that hide producer identity and provider/model labels while preserving evidence and content needed for evaluation. The unblinded audit record MUST remain available to authorized operators after verdicts are committed.

#### Scenario: Reviewer scores competing candidates
- **WHEN** blind review is enabled for a candidate set
- **THEN** the reviewer sees randomized candidate identifiers and cannot infer the producer from Room metadata supplied in the review pack

### Requirement: Deterministic evidence gates outrank model votes
Tests, schemas, policy rules, source validity, runtime checks, and user-locked constraints SHALL be modeled as hard or advisory gates. A failed hard gate MUST prevent acceptance regardless of vote count or arbiter preference.

#### Scenario: Popular candidate violates a locked constraint
- **WHEN** most models prefer a candidate that violates a user-locked requirement
- **THEN** the candidate remains rejected and the gate failure is linked to the exact constraint

### Requirement: Independent arbitration
An arbiter SHALL evaluate candidates, reviews, gate results, and unresolved dissent, but MUST NOT override hard gates or act as the sole evaluator of a change it produced. High-risk ties or conflicting evidence SHALL trigger an additional independent evaluation or operator decision.

#### Scenario: Two candidates remain tied after review
- **WHEN** evidence-weighted review cannot distinguish two high-risk candidates
- **THEN** the controller adds an independent arbiter or requests an operator decision rather than selecting by arbitrary order

### Requirement: Immutable candidate lineage
Candidates SHALL be immutable records with content/artifact hash, inputs, producing binding, parentage, tests, reviews, and promotion state. Combining candidate ideas MUST create a new candidate that repeats applicable validation.

#### Scenario: Merge strengths from two implementations
- **WHEN** an integrator combines code from two non-promoted candidates
- **THEN** the system creates a new child candidate with both parents and does not inherit either parent's passing verdict without rerunning gates

### Requirement: Dissent remains first-class
Every material critique or challenge SHALL have state, severity, evidence, owner, and resolution. Unresolved critical dissent MUST block ordinary completion; operator-accepted residual dissent MUST remain visible in the terminal record.

#### Scenario: Security reviewer raises a critical objection
- **WHEN** a reviewer records an unresolved critical security critique
- **THEN** the candidate cannot be promoted until the critique is resolved, disproven with evidence, or explicitly handled by the authorized high-risk decision path

### Requirement: Explainable confidence dimensions
Confidence SHALL be calculated from evidence coverage, evidence quality, validation strength, independent agreement, unresolved dissent, historical calibration, and freshness. The system MUST expose each dimension and MUST NOT use a model's self-reported confidence as an authoritative input.

#### Scenario: Strong agreement rests on stale evidence
- **WHEN** multiple models agree but the supporting external facts are stale
- **THEN** the freshness dimension lowers or invalidates the overall confidence band and the UI shows the stale evidence

### Requirement: Calibrated bands instead of false precision
The user-facing summary SHALL use calibrated bands `high`, `medium`, `low`, or `unknown`, optionally with a validated interval. It MUST NOT display an unexplained precise percentage.

#### Scenario: Insufficient historical calibration
- **WHEN** a new protocol has too little outcome history to calibrate its evaluator
- **THEN** the system reports confidence as `unknown` or explicitly low-evidence rather than fabricating a precise score

### Requirement: Domain-specific evaluation
Code, diagnosis, research, documents, creative work, and external automation SHALL use domain-specific gate and quality profiles while preserving the shared evidence/dissent contract.

#### Scenario: Evaluate a research report
- **WHEN** a research artifact is reviewed
- **THEN** source authority, freshness, coverage, and citation validity are evaluated instead of substituting code compilation metrics

### Requirement: Provenance-preserving evidence references
Every decisive evidence item SHALL reference its authoritative source, capture time, version or hash, and collection method. Summaries MAY index evidence but MUST NOT replace the original source record.

#### Scenario: Test result supports promotion
- **WHEN** a passing integration test is used to promote a candidate
- **THEN** the verdict references the exact command, exit status, artifact/log location, code revision, and execution time
