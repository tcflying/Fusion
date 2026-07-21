import {
  ROOM_PROTOCOL_TERMINALIZATION_ARTIFACT_REQUIREMENT_PREFIX_V1,
  ROOM_PROTOCOL_TERMINALIZATION_DELIVERY_REQUIREMENT_PREFIX_V1,
  validateRoomProtocolNoProgressRecoveryPolicy,
  type RoomProtocolDefinitionV1,
  type RoomProtocolNoProgressRecoveryPolicyV1,
} from "./room-contracts/protocol.js";
import { validateRoomProtocolDefinition } from "./room-protocol-schema.js";

/*
FNXC:RoomTerminalization 2026-07-18-00:25:
Built-in Protocol-v1 definitions make terminal artifact and delivery proof
explicit with schema-compatible evidence requirement markers. The pure policy
uses these markers to fail closed until the Room ledger provides matching proof.
*/
function terminalArtifactRequirement(artifactId: string): string {
  return ROOM_PROTOCOL_TERMINALIZATION_ARTIFACT_REQUIREMENT_PREFIX_V1 + artifactId;
}

function terminalDeliveryRequirement(deliveryId: string): string {
  return ROOM_PROTOCOL_TERMINALIZATION_DELIVERY_REQUIREMENT_PREFIX_V1 + deliveryId;
}

const RAW_ROOM_PROTOCOL_DEFINITIONS = [
  /*
  FNXC:SessionRoomProtocolDefinitions 2026-07-17-23:58:
  Analysis and diagnosis must keep candidate/hypothesis provenance blind to the
  producing binding while still requiring multiple distinct producer bindings.
  This is declarative protocol policy, not runtime seat allocation.
  */
  {
    contractVersion: 1,
    id: "analysis-decision",
    version: 1,
    family: "analysis_decision",
    name: "Independent analysis and decision",
    phases: [
      {
        id: "propose",
        roleIds: ["analyst"],
        entryGateIds: [],
        exitGateIds: ["proposals_ready", "analysis_blocked"],
        timeoutMs: 600_000,
        channelIds: ["proposals"],
        contextPackIds: ["decision_brief"],
      },
      {
        id: "challenge",
        roleIds: ["analyst", "decision_verifier"],
        entryGateIds: ["proposals_ready"],
        exitGateIds: ["challenge_resolved", "analysis_blocked"],
        timeoutMs: 600_000,
        channelIds: ["challenge"],
        contextPackIds: ["decision_evidence"],
      },
      {
        id: "decide",
        roleIds: ["decision_verifier"],
        entryGateIds: ["challenge_resolved"],
        exitGateIds: [
          "decision_accepted",
          "decision_accepted_with_risks",
          "analysis_partial_accepted",
          "analysis_blocked",
          "analysis_cancelled",
          "analysis_failed",
        ],
        timeoutMs: 300_000,
        channelIds: ["decision"],
        contextPackIds: ["decision_evidence"],
      },
    ],
    roles: [
      {
        id: "analyst",
        requiredCapabilities: ["analysis", "source_read"],
        mayProduce: true,
        mayVerify: false,
        mayAccept: false,
      },
      {
        id: "decision_verifier",
        requiredCapabilities: ["evidence_review", "source_read"],
        mayProduce: false,
        mayVerify: true,
        mayAccept: true,
      },
    ],
    channels: [
      {
        id: "proposals",
        allowedIntents: ["proposal", "question", "handoff"],
        responderRoleIds: ["analyst"],
        broadcastRequiresResponse: false,
      },
      {
        id: "challenge",
        allowedIntents: ["critique", "challenge", "question"],
        responderRoleIds: ["analyst", "decision_verifier"],
        broadcastRequiresResponse: false,
      },
      {
        id: "decision",
        allowedIntents: ["challenge", "verdict", "handoff"],
        responderRoleIds: ["decision_verifier"],
        broadcastRequiresResponse: false,
      },
    ],
    contextPacks: [
      {
        id: "decision_brief",
        includeKinds: ["contract", "source"],
        excludeKinds: ["secret", "private_review", "producer_identity", "provider_identity"],
        maxItems: 128,
      },
      {
        id: "decision_evidence",
        includeKinds: ["proposal", "evidence", "dissent"],
        excludeKinds: ["secret", "producer_identity", "provider_identity"],
        maxItems: 128,
      },
    ],
    transitions: [
      { fromPhaseId: "propose", toPhaseId: "challenge", whenGateId: "proposals_ready" },
      { fromPhaseId: "challenge", toPhaseId: "decide", whenGateId: "challenge_resolved" },
    ],
    gates: [
      {
        id: "proposals_ready",
        kind: "evidence",
        hard: true,
        provenanceKind: "candidate",
        minimumDistinctProducerBindings: 2,
      },
      { id: "analysis_blocked", kind: "evidence", hard: true },
      { id: "challenge_resolved", kind: "evidence", hard: true },
      {
        id: "decision_accepted",
        kind: "evidence",
        hard: true,
        evaluatorRoleIds: ["decision_verifier"],
        evidenceRequirements: [
          "proposal",
          "source",
          "resolved_dissent",
          terminalArtifactRequirement("decision"),
          terminalDeliveryRequirement("decision"),
        ],
      },
      {
        id: "decision_accepted_with_risks",
        kind: "evidence",
        hard: true,
        evaluatorRoleIds: ["decision_verifier"],
        evidenceRequirements: [
          "proposal",
          "source",
          "accepted_residual_risk",
          terminalArtifactRequirement("decision"),
          terminalDeliveryRequirement("decision"),
        ],
      },
      {
        id: "analysis_partial_accepted",
        kind: "evidence",
        hard: true,
        evaluatorRoleIds: ["decision_verifier"],
        evidenceRequirements: [
          "proposal",
          "source",
          terminalArtifactRequirement("partial_decision"),
          terminalDeliveryRequirement("partial_decision"),
        ],
      },
      {
        id: "analysis_cancelled",
        kind: "operator_approval",
        hard: true,
        evidenceRequirements: [terminalArtifactRequirement("cancellation")],
      },
      {
        id: "analysis_failed",
        kind: "evidence",
        hard: true,
        evidenceRequirements: [terminalArtifactRequirement("failure")],
      },
    ],
    recoveryActions: [
      {
        id: "retry_timed_out_analysis",
        trigger: "timeout",
        action: "retry",
        maxAttempts: 2,
        phaseIds: ["propose", "challenge", "decide"],
        exhaustedGateId: "analysis_blocked",
      },
      {
        id: "challenge_stalled_analysis",
        trigger: "no_progress",
        action: "add_challenger",
        maxAttempts: 1,
        phaseIds: ["propose", "challenge", "decide"],
        exhaustedGateId: "analysis_blocked",
      },
      {
        id: "escalate_failed_analysis_gate",
        trigger: "hard_gate_failed",
        action: "request_operator",
        maxAttempts: 1,
        phaseIds: ["propose", "challenge", "decide"],
        exhaustedGateId: "analysis_blocked",
      },
    ],
    exitConditions: [
      {
        outcome: "completed",
        requiredGateIds: ["decision_accepted"],
        requireIndependentVerifier: true,
      },
      {
        outcome: "completed_with_risks",
        requiredGateIds: ["decision_accepted_with_risks"],
        requireIndependentVerifier: true,
        allowUnresolvedRiskSeverities: ["low", "medium"],
      },
      {
        outcome: "partial",
        requiredGateIds: ["analysis_partial_accepted"],
        requireIndependentVerifier: true,
        allowUnresolvedRiskSeverities: ["low", "medium"],
      },
      {
        outcome: "blocked",
        requiredGateIds: ["analysis_blocked"],
        requireIndependentVerifier: false,
      },
      {
        outcome: "cancelled",
        requiredGateIds: ["analysis_cancelled"],
        requireIndependentVerifier: false,
      },
      {
        outcome: "failed",
        requiredGateIds: ["analysis_failed"],
        requireIndependentVerifier: false,
      },
    ],
  },
  {
    contractVersion: 1,
    id: "implementation",
    version: 1,
    family: "implementation",
    name: "Fenced implementation and independent verification",
    phases: [
      {
        id: "plan",
        roleIds: ["implementer"],
        entryGateIds: [],
        exitGateIds: ["plan_ready", "implementation_blocked"],
        timeoutMs: 300_000,
        channelIds: ["planning"],
        contextPackIds: ["implementation_brief"],
      },
      {
        id: "implement",
        roleIds: ["implementer"],
        entryGateIds: ["plan_ready"],
        exitGateIds: ["candidate_ready", "implementation_blocked"],
        timeoutMs: 1_800_000,
        channelIds: ["implementation_work"],
        contextPackIds: ["workspace_context"],
      },
      {
        id: "verify",
        roleIds: ["implementation_verifier"],
        entryGateIds: ["candidate_ready"],
        exitGateIds: [
          "hard_gates_passed",
          "implementation_accepted_with_risks",
          "implementation_partial_accepted",
          "implementation_blocked",
          "implementation_cancelled",
          "implementation_failed",
        ],
        timeoutMs: 900_000,
        channelIds: ["implementation_review"],
        contextPackIds: ["implementation_evidence"],
      },
    ],
    roles: [
      {
        id: "implementer",
        requiredCapabilities: ["workspace_write", "source_read"],
        mayProduce: true,
        mayVerify: false,
        mayAccept: false,
      },
      {
        id: "implementation_verifier",
        requiredCapabilities: ["test", "source_read"],
        mayProduce: false,
        mayVerify: true,
        mayAccept: true,
      },
    ],
    channels: [
      {
        id: "planning",
        allowedIntents: ["proposal", "question"],
        responderRoleIds: ["implementer"],
        broadcastRequiresResponse: false,
      },
      {
        id: "implementation_work",
        allowedIntents: ["instruction", "question", "handoff", "help_request"],
        responderRoleIds: ["implementer"],
        broadcastRequiresResponse: false,
      },
      {
        id: "implementation_review",
        allowedIntents: ["critique", "challenge", "verdict"],
        responderRoleIds: ["implementation_verifier"],
        broadcastRequiresResponse: false,
      },
    ],
    contextPacks: [
      {
        id: "implementation_brief",
        includeKinds: ["contract", "source"],
        excludeKinds: ["secret", "private_review"],
        maxItems: 128,
      },
      {
        id: "workspace_context",
        includeKinds: ["source", "test", "workspace_lease"],
        excludeKinds: ["secret", "private_review"],
        maxItems: 256,
      },
      {
        id: "implementation_evidence",
        includeKinds: ["candidate", "diff", "test", "evidence"],
        excludeKinds: ["secret"],
        maxItems: 128,
      },
    ],
    transitions: [
      { fromPhaseId: "plan", toPhaseId: "implement", whenGateId: "plan_ready" },
      { fromPhaseId: "implement", toPhaseId: "verify", whenGateId: "candidate_ready" },
    ],
    gates: [
      { id: "plan_ready", kind: "evidence", hard: true },
      { id: "implementation_blocked", kind: "evidence", hard: true },
      { id: "candidate_ready", kind: "evidence", hard: true },
      {
        id: "hard_gates_passed",
        kind: "deterministic",
        hard: true,
        evaluatorRoleIds: ["implementation_verifier"],
        evidenceRequirements: [
          "test",
          "source",
          terminalArtifactRequirement("implementation"),
          terminalDeliveryRequirement("implementation"),
        ],
      },
      {
        id: "implementation_accepted_with_risks",
        kind: "deterministic",
        hard: true,
        evaluatorRoleIds: ["implementation_verifier"],
        evidenceRequirements: [
          "test",
          "source",
          "accepted_residual_risk",
          terminalArtifactRequirement("implementation"),
          terminalDeliveryRequirement("implementation"),
        ],
      },
      {
        id: "implementation_partial_accepted",
        kind: "deterministic",
        hard: true,
        evaluatorRoleIds: ["implementation_verifier"],
        evidenceRequirements: [
          "test",
          "source",
          terminalArtifactRequirement("partial_implementation"),
          terminalDeliveryRequirement("partial_implementation"),
        ],
      },
      {
        id: "implementation_cancelled",
        kind: "operator_approval",
        hard: true,
        evidenceRequirements: [terminalArtifactRequirement("cancellation")],
      },
      {
        id: "implementation_failed",
        kind: "deterministic",
        hard: true,
        evidenceRequirements: [terminalArtifactRequirement("failure")],
      },
    ],
    recoveryActions: [
      {
        id: "retry_timed_out_implementation",
        trigger: "timeout",
        action: "retry",
        maxAttempts: 2,
        phaseIds: ["plan", "implement", "verify"],
        exhaustedGateId: "implementation_blocked",
      },
      {
        id: "repair_failed_gate",
        trigger: "hard_gate_failed",
        action: "shrink_scope",
        maxAttempts: 1,
        phaseIds: ["plan", "implement", "verify"],
        exhaustedGateId: "implementation_blocked",
      },
      {
        id: "replace_stalled_implementer",
        trigger: "no_progress",
        action: "replace_participant",
        maxAttempts: 1,
        phaseIds: ["plan", "implement", "verify"],
        exhaustedGateId: "implementation_blocked",
      },
    ],
    exitConditions: [
      {
        outcome: "completed",
        requiredGateIds: ["hard_gates_passed"],
        requireIndependentVerifier: true,
      },
      {
        outcome: "completed_with_risks",
        requiredGateIds: ["implementation_accepted_with_risks"],
        requireIndependentVerifier: true,
        allowUnresolvedRiskSeverities: ["low", "medium"],
      },
      {
        outcome: "partial",
        requiredGateIds: ["implementation_partial_accepted"],
        requireIndependentVerifier: true,
        allowUnresolvedRiskSeverities: ["low", "medium"],
      },
      {
        outcome: "blocked",
        requiredGateIds: ["implementation_blocked"],
        requireIndependentVerifier: false,
      },
      {
        outcome: "cancelled",
        requiredGateIds: ["implementation_cancelled"],
        requireIndependentVerifier: false,
      },
      {
        outcome: "failed",
        requiredGateIds: ["implementation_failed"],
        requireIndependentVerifier: false,
      },
    ],
  },
  {
    contractVersion: 1,
    id: "diagnosis",
    version: 1,
    family: "diagnosis",
    name: "Parallel hypotheses and root-cause confirmation",
    phases: [
      {
        id: "hypothesize",
        roleIds: ["investigator"],
        entryGateIds: [],
        exitGateIds: ["hypotheses_ready", "diagnosis_blocked"],
        timeoutMs: 300_000,
        channelIds: ["hypotheses"],
        contextPackIds: ["symptom_context"],
      },
      {
        id: "gather_evidence",
        roleIds: ["investigator", "evidence_collector"],
        entryGateIds: ["hypotheses_ready"],
        exitGateIds: ["evidence_ready", "diagnosis_blocked"],
        timeoutMs: 900_000,
        channelIds: ["evidence_gathering"],
        contextPackIds: ["diagnostic_evidence"],
      },
      {
        id: "falsify",
        roleIds: ["investigator", "root_cause_verifier"],
        entryGateIds: ["evidence_ready"],
        exitGateIds: ["falsification_complete", "diagnosis_blocked"],
        timeoutMs: 600_000,
        channelIds: ["falsification"],
        contextPackIds: ["diagnostic_evidence"],
      },
      {
        id: "confirm_root_cause",
        roleIds: ["root_cause_verifier"],
        entryGateIds: ["falsification_complete"],
        exitGateIds: [
          "root_cause_confirmed",
          "diagnosis_accepted_with_risks",
          "diagnosis_partial_accepted",
          "diagnosis_blocked",
          "diagnosis_cancelled",
          "diagnosis_failed",
        ],
        timeoutMs: 300_000,
        channelIds: ["diagnostic_verdict"],
        contextPackIds: ["diagnostic_evidence"],
      },
    ],
    roles: [
      {
        id: "investigator",
        requiredCapabilities: ["diagnosis", "source_read"],
        mayProduce: true,
        mayVerify: false,
        mayAccept: false,
      },
      {
        id: "evidence_collector",
        requiredCapabilities: ["test", "runtime_observation"],
        mayProduce: true,
        mayVerify: false,
        mayAccept: false,
      },
      {
        id: "root_cause_verifier",
        requiredCapabilities: ["evidence_review", "falsification"],
        mayProduce: false,
        mayVerify: true,
        mayAccept: true,
      },
    ],
    channels: [
      {
        id: "hypotheses",
        allowedIntents: ["proposal", "question"],
        responderRoleIds: ["investigator"],
        broadcastRequiresResponse: false,
      },
      {
        id: "evidence_gathering",
        allowedIntents: ["question", "handoff", "help_request"],
        responderRoleIds: ["investigator", "evidence_collector"],
        broadcastRequiresResponse: false,
      },
      {
        id: "falsification",
        allowedIntents: ["critique", "challenge", "question"],
        responderRoleIds: ["investigator", "root_cause_verifier"],
        broadcastRequiresResponse: false,
      },
      {
        id: "diagnostic_verdict",
        allowedIntents: ["challenge", "verdict", "handoff"],
        responderRoleIds: ["root_cause_verifier"],
        broadcastRequiresResponse: false,
      },
    ],
    contextPacks: [
      {
        id: "symptom_context",
        includeKinds: ["contract", "symptom", "source"],
        excludeKinds: ["secret", "peer_hypothesis", "producer_identity", "provider_identity"],
        maxItems: 128,
      },
      {
        id: "diagnostic_evidence",
        includeKinds: ["hypothesis", "test", "runtime", "evidence"],
        excludeKinds: ["secret", "producer_identity", "provider_identity"],
        maxItems: 256,
      },
    ],
    transitions: [
      {
        fromPhaseId: "hypothesize",
        toPhaseId: "gather_evidence",
        whenGateId: "hypotheses_ready",
      },
      {
        fromPhaseId: "gather_evidence",
        toPhaseId: "falsify",
        whenGateId: "evidence_ready",
      },
      {
        fromPhaseId: "falsify",
        toPhaseId: "confirm_root_cause",
        whenGateId: "falsification_complete",
      },
    ],
    gates: [
      {
        id: "hypotheses_ready",
        kind: "evidence",
        hard: true,
        provenanceKind: "hypothesis",
        minimumDistinctProducerBindings: 2,
      },
      { id: "diagnosis_blocked", kind: "evidence", hard: true },
      { id: "evidence_ready", kind: "evidence", hard: true },
      { id: "falsification_complete", kind: "evidence", hard: true },
      {
        id: "root_cause_confirmed",
        kind: "evidence",
        hard: true,
        evaluatorRoleIds: ["root_cause_verifier"],
        evidenceRequirements: [
          "hypothesis",
          "falsification",
          "runtime",
          terminalArtifactRequirement("diagnosis"),
          terminalDeliveryRequirement("diagnosis"),
        ],
      },
      {
        id: "diagnosis_accepted_with_risks",
        kind: "evidence",
        hard: true,
        evaluatorRoleIds: ["root_cause_verifier"],
        evidenceRequirements: [
          "hypothesis",
          "falsification",
          "runtime",
          "accepted_residual_risk",
          terminalArtifactRequirement("diagnosis"),
          terminalDeliveryRequirement("diagnosis"),
        ],
      },
      {
        id: "diagnosis_partial_accepted",
        kind: "evidence",
        hard: true,
        evaluatorRoleIds: ["root_cause_verifier"],
        evidenceRequirements: [
          "hypothesis",
          "runtime",
          terminalArtifactRequirement("partial_diagnosis"),
          terminalDeliveryRequirement("partial_diagnosis"),
        ],
      },
      {
        id: "diagnosis_cancelled",
        kind: "operator_approval",
        hard: true,
        evidenceRequirements: [terminalArtifactRequirement("cancellation")],
      },
      {
        id: "diagnosis_failed",
        kind: "evidence",
        hard: true,
        evidenceRequirements: [terminalArtifactRequirement("failure")],
      },
    ],
    recoveryActions: [
      {
        id: "retry_timed_out_diagnosis",
        trigger: "timeout",
        action: "retry",
        maxAttempts: 2,
        phaseIds: ["hypothesize", "gather_evidence", "falsify", "confirm_root_cause"],
        exhaustedGateId: "diagnosis_blocked",
      },
      {
        id: "challenge_conflicting_evidence",
        trigger: "conflicting_evidence",
        action: "add_challenger",
        maxAttempts: 1,
        phaseIds: ["hypothesize", "gather_evidence", "falsify", "confirm_root_cause"],
        exhaustedGateId: "diagnosis_blocked",
      },
      {
        id: "redecompose_stalled_diagnosis",
        trigger: "no_progress",
        action: "redecompose",
        maxAttempts: 1,
        phaseIds: ["hypothesize", "gather_evidence", "falsify", "confirm_root_cause"],
        exhaustedGateId: "diagnosis_blocked",
      },
      {
        id: "escalate_failed_diagnosis_gate",
        trigger: "hard_gate_failed",
        action: "request_operator",
        maxAttempts: 1,
        phaseIds: ["hypothesize", "gather_evidence", "falsify", "confirm_root_cause"],
        exhaustedGateId: "diagnosis_blocked",
      },
    ],
    exitConditions: [
      {
        outcome: "completed",
        requiredGateIds: ["root_cause_confirmed"],
        requireIndependentVerifier: true,
      },
      {
        outcome: "completed_with_risks",
        requiredGateIds: ["diagnosis_accepted_with_risks"],
        requireIndependentVerifier: true,
        allowUnresolvedRiskSeverities: ["low", "medium"],
      },
      {
        outcome: "partial",
        requiredGateIds: ["diagnosis_partial_accepted"],
        requireIndependentVerifier: true,
        allowUnresolvedRiskSeverities: ["low", "medium"],
      },
      {
        outcome: "blocked",
        requiredGateIds: ["diagnosis_blocked"],
        requireIndependentVerifier: false,
      },
      {
        outcome: "cancelled",
        requiredGateIds: ["diagnosis_cancelled"],
        requireIndependentVerifier: false,
      },
      {
        outcome: "failed",
        requiredGateIds: ["diagnosis_failed"],
        requireIndependentVerifier: false,
      },
    ],
  },
  {
    contractVersion: 1,
    id: "creative-review",
    version: 1,
    family: "creative_review",
    name: "Blind creative review and independent arbitration",
    phases: [
      {
        id: "create",
        roleIds: ["creator"],
        entryGateIds: [],
        exitGateIds: ["draft_ready", "creative_review_blocked"],
        timeoutMs: 900_000,
        channelIds: ["creative_proposal"],
        contextPackIds: ["creative_brief"],
      },
      {
        id: "blind_review",
        roleIds: ["blind_reviewer"],
        entryGateIds: ["draft_ready"],
        exitGateIds: ["blind_review_complete", "creative_review_blocked"],
        timeoutMs: 600_000,
        channelIds: ["blind_critique"],
        contextPackIds: ["blind_candidate"],
      },
      {
        id: "revise",
        roleIds: ["creator"],
        entryGateIds: ["blind_review_complete"],
        exitGateIds: ["revision_ready", "creative_review_blocked"],
        timeoutMs: 900_000,
        channelIds: ["creative_revision"],
        contextPackIds: ["creative_feedback"],
      },
      {
        id: "arbitrate",
        roleIds: ["creative_arbiter"],
        entryGateIds: ["revision_ready"],
        exitGateIds: [
          "creative_accepted",
          "creative_accepted_with_risks",
          "creative_partial_accepted",
          "creative_review_blocked",
          "creative_cancelled",
          "creative_failed",
        ],
        timeoutMs: 300_000,
        channelIds: ["creative_verdict"],
        contextPackIds: ["creative_evidence"],
      },
    ],
    roles: [
      {
        id: "creator",
        requiredCapabilities: ["creative_production"],
        mayProduce: true,
        mayVerify: false,
        mayAccept: false,
      },
      {
        id: "blind_reviewer",
        requiredCapabilities: ["creative_review"],
        mayProduce: false,
        mayVerify: true,
        mayAccept: false,
      },
      {
        id: "creative_arbiter",
        requiredCapabilities: ["creative_review", "evidence_review"],
        mayProduce: false,
        mayVerify: true,
        mayAccept: true,
      },
    ],
    channels: [
      {
        id: "creative_proposal",
        allowedIntents: ["proposal", "question", "handoff"],
        responderRoleIds: ["creator"],
        broadcastRequiresResponse: false,
      },
      {
        id: "blind_critique",
        allowedIntents: ["critique", "challenge"],
        responderRoleIds: ["blind_reviewer"],
        broadcastRequiresResponse: false,
      },
      {
        id: "creative_revision",
        allowedIntents: ["proposal", "question", "handoff"],
        responderRoleIds: ["creator"],
        broadcastRequiresResponse: false,
      },
      {
        id: "creative_verdict",
        allowedIntents: ["critique", "challenge", "verdict"],
        responderRoleIds: ["creative_arbiter"],
        broadcastRequiresResponse: false,
      },
    ],
    contextPacks: [
      {
        id: "creative_brief",
        includeKinds: ["contract", "reference"],
        excludeKinds: ["secret", "private_review"],
        maxItems: 128,
      },
      {
        id: "blind_candidate",
        includeKinds: ["candidate", "criteria"],
        excludeKinds: ["producer_identity", "provider_identity", "secret"],
        maxItems: 64,
      },
      {
        id: "creative_feedback",
        includeKinds: ["candidate", "critique"],
        excludeKinds: ["reviewer_identity", "secret"],
        maxItems: 128,
      },
      {
        id: "creative_evidence",
        includeKinds: ["candidate", "critique", "revision", "evidence"],
        excludeKinds: ["secret"],
        maxItems: 128,
      },
    ],
    transitions: [
      { fromPhaseId: "create", toPhaseId: "blind_review", whenGateId: "draft_ready" },
      {
        fromPhaseId: "blind_review",
        toPhaseId: "revise",
        whenGateId: "blind_review_complete",
      },
      { fromPhaseId: "revise", toPhaseId: "arbitrate", whenGateId: "revision_ready" },
    ],
    gates: [
      { id: "draft_ready", kind: "evidence", hard: true },
      { id: "creative_review_blocked", kind: "evidence", hard: true },
      {
        id: "blind_review_complete",
        kind: "model_review",
        hard: true,
        evaluatorRoleIds: ["blind_reviewer"],
      },
      { id: "revision_ready", kind: "evidence", hard: true },
      {
        id: "creative_accepted",
        kind: "model_review",
        hard: true,
        evaluatorRoleIds: ["creative_arbiter"],
        evidenceRequirements: [
          "candidate",
          "critique",
          "revision",
          terminalArtifactRequirement("creative_result"),
          terminalDeliveryRequirement("creative_result"),
        ],
      },
      {
        id: "creative_accepted_with_risks",
        kind: "model_review",
        hard: true,
        evaluatorRoleIds: ["creative_arbiter"],
        evidenceRequirements: [
          "candidate",
          "critique",
          "revision",
          "accepted_residual_risk",
          terminalArtifactRequirement("creative_result"),
          terminalDeliveryRequirement("creative_result"),
        ],
      },
      {
        id: "creative_partial_accepted",
        kind: "model_review",
        hard: true,
        evaluatorRoleIds: ["creative_arbiter"],
        evidenceRequirements: [
          "candidate",
          "critique",
          terminalArtifactRequirement("partial_creative_result"),
          terminalDeliveryRequirement("partial_creative_result"),
        ],
      },
      {
        id: "creative_cancelled",
        kind: "operator_approval",
        hard: true,
        evidenceRequirements: [terminalArtifactRequirement("cancellation")],
      },
      {
        id: "creative_failed",
        kind: "evidence",
        hard: true,
        evidenceRequirements: [terminalArtifactRequirement("failure")],
      },
    ],
    recoveryActions: [
      {
        id: "retry_timed_out_creative_phase",
        trigger: "timeout",
        action: "retry",
        maxAttempts: 2,
        phaseIds: ["create", "blind_review", "revise", "arbitrate"],
        exhaustedGateId: "creative_review_blocked",
      },
      {
        id: "challenge_conflicting_creative_review",
        trigger: "conflicting_evidence",
        action: "add_challenger",
        maxAttempts: 1,
        phaseIds: ["create", "blind_review", "revise", "arbitrate"],
        exhaustedGateId: "creative_review_blocked",
      },
      {
        id: "shrink_stalled_creative_scope",
        trigger: "no_progress",
        action: "shrink_scope",
        maxAttempts: 1,
        phaseIds: ["create", "blind_review", "revise", "arbitrate"],
        exhaustedGateId: "creative_review_blocked",
      },
      {
        id: "escalate_failed_creative_gate",
        trigger: "hard_gate_failed",
        action: "request_operator",
        maxAttempts: 1,
        phaseIds: ["create", "blind_review", "revise", "arbitrate"],
        exhaustedGateId: "creative_review_blocked",
      },
    ],
    exitConditions: [
      {
        outcome: "completed",
        requiredGateIds: ["creative_accepted"],
        requireIndependentVerifier: true,
      },
      {
        outcome: "completed_with_risks",
        requiredGateIds: ["creative_accepted_with_risks"],
        requireIndependentVerifier: true,
        allowUnresolvedRiskSeverities: ["low", "medium"],
      },
      {
        outcome: "partial",
        requiredGateIds: ["creative_partial_accepted"],
        requireIndependentVerifier: true,
        allowUnresolvedRiskSeverities: ["low", "medium"],
      },
      {
        outcome: "blocked",
        requiredGateIds: ["creative_review_blocked"],
        requireIndependentVerifier: false,
      },
      {
        outcome: "cancelled",
        requiredGateIds: ["creative_cancelled"],
        requireIndependentVerifier: false,
      },
      {
        outcome: "failed",
        requiredGateIds: ["creative_failed"],
        requireIndependentVerifier: false,
      },
    ],
  },
  {
    contractVersion: 1,
    id: "bounded-discussion",
    version: 1,
    family: "bounded_discussion",
    name: "Bounded discussion and verified synthesis",
    phases: [
      {
        id: "open_discussion",
        roleIds: ["contributor"],
        entryGateIds: [],
        exitGateIds: ["contributions_ready", "discussion_blocked"],
        timeoutMs: 600_000,
        channelIds: ["discussion"],
        contextPackIds: ["discussion_brief"],
      },
      {
        id: "deliberate",
        roleIds: ["contributor", "synthesizer"],
        entryGateIds: ["contributions_ready"],
        exitGateIds: ["deliberation_complete", "discussion_blocked"],
        timeoutMs: 900_000,
        channelIds: ["deliberation"],
        contextPackIds: ["discussion_context"],
      },
      {
        id: "synthesize",
        roleIds: ["synthesizer", "discussion_verifier"],
        entryGateIds: ["deliberation_complete"],
        exitGateIds: [
          "synthesis_accepted",
          "synthesis_accepted_with_risks",
          "discussion_partial_accepted",
          "discussion_blocked",
          "discussion_cancelled",
          "discussion_failed",
        ],
        timeoutMs: 600_000,
        channelIds: ["synthesis"],
        contextPackIds: ["discussion_context"],
      },
    ],
    roles: [
      {
        id: "contributor",
        requiredCapabilities: ["discussion"],
        mayProduce: true,
        mayVerify: false,
        mayAccept: false,
      },
      {
        id: "synthesizer",
        requiredCapabilities: ["synthesis"],
        mayProduce: true,
        mayVerify: false,
        mayAccept: false,
      },
      {
        id: "discussion_verifier",
        requiredCapabilities: ["evidence_review"],
        mayProduce: false,
        mayVerify: true,
        mayAccept: true,
      },
    ],
    channels: [
      {
        id: "discussion",
        allowedIntents: ["question", "proposal", "help_request"],
        responderRoleIds: ["contributor"],
        broadcastRequiresResponse: false,
      },
      {
        id: "deliberation",
        allowedIntents: ["proposal", "critique", "challenge", "question"],
        responderRoleIds: ["contributor", "synthesizer"],
        broadcastRequiresResponse: false,
      },
      {
        id: "synthesis",
        allowedIntents: ["proposal", "critique", "verdict", "handoff"],
        responderRoleIds: ["synthesizer", "discussion_verifier"],
        broadcastRequiresResponse: false,
      },
    ],
    contextPacks: [
      {
        id: "discussion_brief",
        includeKinds: ["contract", "question"],
        excludeKinds: ["secret", "private_review"],
        maxItems: 64,
      },
      {
        id: "discussion_context",
        includeKinds: ["proposal", "critique", "evidence", "dissent"],
        excludeKinds: ["secret"],
        maxItems: 128,
      },
    ],
    transitions: [
      {
        fromPhaseId: "open_discussion",
        toPhaseId: "deliberate",
        whenGateId: "contributions_ready",
      },
      {
        fromPhaseId: "deliberate",
        toPhaseId: "synthesize",
        whenGateId: "deliberation_complete",
      },
    ],
    gates: [
      { id: "contributions_ready", kind: "evidence", hard: true },
      { id: "discussion_blocked", kind: "operator_approval", hard: true },
      { id: "deliberation_complete", kind: "evidence", hard: true },
      {
        id: "synthesis_accepted",
        kind: "evidence",
        hard: true,
        evaluatorRoleIds: ["discussion_verifier"],
        evidenceRequirements: [
          "proposal",
          "resolved_dissent",
          "synthesis",
          terminalArtifactRequirement("synthesis"),
          terminalDeliveryRequirement("synthesis"),
        ],
      },
      {
        id: "synthesis_accepted_with_risks",
        kind: "evidence",
        hard: true,
        evaluatorRoleIds: ["discussion_verifier"],
        evidenceRequirements: [
          "proposal",
          "accepted_residual_risk",
          "synthesis",
          terminalArtifactRequirement("synthesis"),
          terminalDeliveryRequirement("synthesis"),
        ],
      },
      {
        id: "discussion_partial_accepted",
        kind: "evidence",
        hard: true,
        evaluatorRoleIds: ["discussion_verifier"],
        evidenceRequirements: [
          "proposal",
          terminalArtifactRequirement("partial_synthesis"),
          terminalDeliveryRequirement("partial_synthesis"),
        ],
      },
      {
        id: "discussion_cancelled",
        kind: "operator_approval",
        hard: true,
        evidenceRequirements: [terminalArtifactRequirement("cancellation")],
      },
      {
        id: "discussion_failed",
        kind: "evidence",
        hard: true,
        evidenceRequirements: [terminalArtifactRequirement("failure")],
      },
    ],
    recoveryActions: [
      {
        id: "shrink_timed_out_discussion",
        trigger: "timeout",
        action: "shrink_scope",
        maxAttempts: 1,
        phaseIds: ["open_discussion", "deliberate", "synthesize"],
        exhaustedGateId: "discussion_blocked",
      },
      {
        id: "escalate_stalled_discussion",
        trigger: "no_progress",
        action: "request_operator",
        maxAttempts: 1,
        phaseIds: ["open_discussion", "deliberate", "synthesize"],
        exhaustedGateId: "discussion_blocked",
      },
      {
        id: "escalate_failed_discussion_gate",
        trigger: "hard_gate_failed",
        action: "request_operator",
        maxAttempts: 1,
        phaseIds: ["open_discussion", "deliberate", "synthesize"],
        exhaustedGateId: "discussion_blocked",
      },
    ],
    exitConditions: [
      {
        outcome: "completed",
        requiredGateIds: ["synthesis_accepted"],
        requireIndependentVerifier: true,
      },
      {
        outcome: "completed_with_risks",
        requiredGateIds: ["synthesis_accepted_with_risks"],
        requireIndependentVerifier: true,
        allowUnresolvedRiskSeverities: ["low", "medium"],
      },
      {
        outcome: "partial",
        requiredGateIds: ["discussion_partial_accepted"],
        requireIndependentVerifier: true,
        allowUnresolvedRiskSeverities: ["low", "medium"],
      },
      {
        outcome: "blocked",
        requiredGateIds: ["discussion_blocked"],
        requireIndependentVerifier: false,
      },
      {
        outcome: "cancelled",
        requiredGateIds: ["discussion_cancelled"],
        requireIndependentVerifier: false,
      },
      {
        outcome: "failed",
        requiredGateIds: ["discussion_failed"],
        requireIndependentVerifier: false,
      },
    ],
  },
] as const satisfies readonly RoomProtocolDefinitionV1[];

/*
FNXC:SessionRoomNoProgressRecoveryDefinitions 2026-07-19:
Protocol-v1 JSON remains schema-compatible while no-progress ladders are a
versioned companion policy. This prevents an unversioned field addition from
invalidating persisted protocol migration, while keeping every decision
explicit, immutable, and tied to one protocol id/version.
*/
const RAW_ROOM_PROTOCOL_NO_PROGRESS_RECOVERY_POLICIES = [
  {
    protocolId: "analysis-decision",
    protocolVersion: 1,
    actions: [
      {
        recoveryActionId: "challenge_stalled_analysis",
        ladderOrder: 1,
        minimumConsecutiveUnchangedRounds: 2,
      },
    ],
  },
  {
    protocolId: "implementation",
    protocolVersion: 1,
    actions: [
      {
        recoveryActionId: "replace_stalled_implementer",
        ladderOrder: 1,
        minimumConsecutiveUnchangedRounds: 2,
      },
    ],
  },
  {
    protocolId: "diagnosis",
    protocolVersion: 1,
    actions: [
      {
        recoveryActionId: "redecompose_stalled_diagnosis",
        ladderOrder: 1,
        minimumConsecutiveUnchangedRounds: 2,
      },
    ],
  },
  {
    protocolId: "creative-review",
    protocolVersion: 1,
    actions: [
      {
        recoveryActionId: "shrink_stalled_creative_scope",
        ladderOrder: 1,
        minimumConsecutiveUnchangedRounds: 2,
      },
    ],
  },
  {
    protocolId: "bounded-discussion",
    protocolVersion: 1,
    actions: [
      {
        recoveryActionId: "escalate_stalled_discussion",
        ladderOrder: 1,
        minimumConsecutiveUnchangedRounds: 2,
      },
    ],
  },
] as const satisfies readonly RoomProtocolNoProgressRecoveryPolicyV1[];

function protocolIdentity(protocolId: string, version: number): string {
  return `${protocolId}\u0000${version}`;
}

function freezeNoProgressRecoveryPolicy(
  policy: RoomProtocolNoProgressRecoveryPolicyV1,
): RoomProtocolNoProgressRecoveryPolicyV1 {
  return Object.freeze({
    ...policy,
    actions: Object.freeze(policy.actions.map((action) => Object.freeze({ ...action }))),
  });
}

function validateBuiltInProtocol(
  definition: RoomProtocolDefinitionV1,
  policy: RoomProtocolNoProgressRecoveryPolicyV1,
): RoomProtocolDefinitionV1 {
  const result = validateRoomProtocolDefinition(definition);
  if (!result.ok) {
    const details = result.issues
      .map((issue) => `${issue.path}:${issue.code}`)
      .join(", ");
    throw new Error(`Invalid built-in Room protocol '${definition.id}': ${details}`);
  }
  const recoveryPolicy = validateRoomProtocolNoProgressRecoveryPolicy({
    protocol: result.value,
    policy,
  });
  if (!recoveryPolicy.ok) {
    const details = recoveryPolicy.issues
      .map((issue) => `${issue.path}:${issue.code}`)
      .join(", ");
    throw new Error(`Invalid built-in Room recovery policy '${definition.id}': ${details}`);
  }
  return result.value;
}

function validateBuiltInProtocolRegistry(
  definitions: readonly RoomProtocolDefinitionV1[],
  policies: readonly RoomProtocolNoProgressRecoveryPolicyV1[],
): {
  readonly definitions: readonly RoomProtocolDefinitionV1[];
  readonly policies: readonly RoomProtocolNoProgressRecoveryPolicyV1[];
} {
  const definitionsByIdentity = new Map<string, RoomProtocolDefinitionV1>();
  for (const definition of definitions) {
    const identity = protocolIdentity(definition.id, definition.version);
    if (definitionsByIdentity.has(identity)) {
      throw new Error(
        `Duplicate protocol identity '${definition.id}' at version ${definition.version}`,
      );
    }
    definitionsByIdentity.set(identity, definition);
  }

  const policiesByIdentity = new Map<string, RoomProtocolNoProgressRecoveryPolicyV1>();
  for (const policy of policies) {
    const identity = protocolIdentity(policy.protocolId, policy.protocolVersion);
    if (policiesByIdentity.has(identity)) {
      throw new Error(
        `Duplicate no-progress recovery policy '${policy.protocolId}' at version ${policy.protocolVersion}`,
      );
    }
    if (!definitionsByIdentity.has(identity)) {
      throw new Error(
        `No Room protocol exists for recovery policy '${policy.protocolId}' at version ${policy.protocolVersion}`,
      );
    }
    policiesByIdentity.set(identity, policy);
  }

  const validatedDefinitions = definitions.map((definition) => {
    const policy = policiesByIdentity.get(protocolIdentity(definition.id, definition.version));
    if (!policy) {
      throw new Error(
        `Missing no-progress recovery policy for '${definition.id}' at version ${definition.version}`,
      );
    }
    return validateBuiltInProtocol(definition, policy);
  });
  return {
    definitions: Object.freeze(validatedDefinitions),
    policies: Object.freeze(policies.map(freezeNoProgressRecoveryPolicy)),
  };
}

export function validateRoomProtocolDefinitionRegistry(
  definitions: readonly RoomProtocolDefinitionV1[],
): readonly RoomProtocolDefinitionV1[] {
  const requestedIdentities = new Set(
    definitions.map((definition) => protocolIdentity(definition.id, definition.version)),
  );
  return validateBuiltInProtocolRegistry(
    definitions,
    RAW_ROOM_PROTOCOL_NO_PROGRESS_RECOVERY_POLICIES.filter((policy) =>
      requestedIdentities.has(protocolIdentity(policy.protocolId, policy.protocolVersion)),
    ),
  ).definitions;
}

/*
FNXC:SessionRoomProtocolDefinitions 2026-07-17-23:47:
Built-in Room protocols are executable persisted contracts, not compile-time fixtures. Validate and freeze every definition at module load so invalid phase graphs, producer-verifier overlap, unbounded recovery, or unsupported versions fail before a Room can select them.
*/
const VALIDATED_ROOM_PROTOCOL_CATALOG = validateBuiltInProtocolRegistry(
  RAW_ROOM_PROTOCOL_DEFINITIONS,
  RAW_ROOM_PROTOCOL_NO_PROGRESS_RECOVERY_POLICIES,
);

export const ROOM_PROTOCOL_DEFINITIONS: readonly RoomProtocolDefinitionV1[] =
  VALIDATED_ROOM_PROTOCOL_CATALOG.definitions;

export const ROOM_PROTOCOL_NO_PROGRESS_RECOVERY_POLICIES: readonly RoomProtocolNoProgressRecoveryPolicyV1[] =
  VALIDATED_ROOM_PROTOCOL_CATALOG.policies;

export function getRoomProtocolDefinition(
  protocolId: string,
  version: number,
): RoomProtocolDefinitionV1 | undefined {
  if (!Number.isSafeInteger(version) || version <= 0) {
    throw new TypeError("getRoomProtocolDefinition requires an explicit positive integer protocol version");
  }
  return ROOM_PROTOCOL_DEFINITIONS.find(
    (definition) => definition.id === protocolId && definition.version === version,
  );
}

export function getLatestRoomProtocolDefinition(
  protocolId: string,
): RoomProtocolDefinitionV1 | undefined {
  let latest: RoomProtocolDefinitionV1 | undefined;
  for (const definition of ROOM_PROTOCOL_DEFINITIONS) {
    if (definition.id !== protocolId) continue;
    if (!latest || definition.version > latest.version) latest = definition;
  }
  return latest;
}

export function getRoomProtocolNoProgressRecoveryPolicy(
  protocolId: string,
  version: number,
): RoomProtocolNoProgressRecoveryPolicyV1 | undefined {
  if (!Number.isSafeInteger(version) || version <= 0) {
    throw new TypeError(
      "getRoomProtocolNoProgressRecoveryPolicy requires an explicit positive integer protocol version",
    );
  }
  return ROOM_PROTOCOL_NO_PROGRESS_RECOVERY_POLICIES.find(
    (policy) => policy.protocolId === protocolId && policy.protocolVersion === version,
  );
}
