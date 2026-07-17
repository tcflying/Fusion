import type { RoomProtocolDefinitionV1 } from "./room-contracts/protocol.js";
import { validateRoomProtocolDefinition } from "./room-protocol-schema.js";

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
        exitGateIds: ["decision_accepted", "analysis_blocked"],
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
        evidenceRequirements: ["proposal", "source", "resolved_dissent"],
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
        outcome: "blocked",
        requiredGateIds: ["analysis_blocked"],
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
        exitGateIds: ["hard_gates_passed", "implementation_blocked"],
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
        evidenceRequirements: ["test", "source"],
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
        outcome: "blocked",
        requiredGateIds: ["implementation_blocked"],
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
        exitGateIds: ["root_cause_confirmed", "diagnosis_blocked"],
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
        evidenceRequirements: ["hypothesis", "falsification", "runtime"],
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
        outcome: "blocked",
        requiredGateIds: ["diagnosis_blocked"],
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
        exitGateIds: ["creative_accepted", "creative_review_blocked"],
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
        evidenceRequirements: ["candidate", "critique", "revision"],
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
        outcome: "blocked",
        requiredGateIds: ["creative_review_blocked"],
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
        exitGateIds: ["synthesis_accepted", "discussion_blocked"],
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
        evidenceRequirements: ["proposal", "resolved_dissent", "synthesis"],
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
        outcome: "blocked",
        requiredGateIds: ["discussion_blocked"],
        requireIndependentVerifier: false,
      },
    ],
  },
] as const satisfies readonly RoomProtocolDefinitionV1[];

function validateBuiltInProtocol(
  definition: RoomProtocolDefinitionV1,
): RoomProtocolDefinitionV1 {
  const result = validateRoomProtocolDefinition(definition);
  if (!result.ok) {
    const details = result.issues
      .map((issue) => `${issue.path}:${issue.code}`)
      .join(", ");
    throw new Error(`Invalid built-in Room protocol '${definition.id}': ${details}`);
  }
  return result.value;
}

export function validateRoomProtocolDefinitionRegistry(
  definitions: readonly RoomProtocolDefinitionV1[],
): readonly RoomProtocolDefinitionV1[] {
  const validated = definitions.map(validateBuiltInProtocol);
  const identities = new Set<string>();
  for (const definition of validated) {
    const identity = `${definition.id}\u0000${definition.version}`;
    if (identities.has(identity)) {
      throw new Error(
        `Duplicate protocol identity '${definition.id}' at version ${definition.version}`,
      );
    }
    identities.add(identity);
  }
  return Object.freeze(validated);
}

/*
FNXC:SessionRoomProtocolDefinitions 2026-07-17-23:47:
Built-in Room protocols are executable persisted contracts, not compile-time fixtures. Validate and freeze every definition at module load so invalid phase graphs, producer-verifier overlap, unbounded recovery, or unsupported versions fail before a Room can select them.
*/
export const ROOM_PROTOCOL_DEFINITIONS: readonly RoomProtocolDefinitionV1[] =
  validateRoomProtocolDefinitionRegistry(RAW_ROOM_PROTOCOL_DEFINITIONS);

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
