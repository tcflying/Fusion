import { describe, expect, it } from "vitest";

import {
  ROOM_LIFECYCLE_STATES,
  type RoomBindingRecordV1,
  type RoomRecordV1,
} from "../room-contracts/storage.js";
import {
  isSessionConnectorMutationCertified,
  type SessionConnectorCapabilitiesV1,
} from "../room-contracts/session-connector.js";
import {
  ROOM_CONTROLLER_COMMAND_TYPES,
  type RoomControllerCommandEnvelopeV1,
} from "../room-contracts/controller.js";
import {
  ROOM_PROTOCOL_FAMILIES,
  type RoomProtocolDefinitionV1,
} from "../room-contracts/protocol.js";
import {
  ROOM_CONFIDENCE_BANDS,
  canCandidatePassHardGates,
  type RoomCandidateRecordV1,
  type RoomConfidenceSnapshotV1,
  type RoomGateResultV1,
} from "../room-contracts/evidence.js";
import {
  ROOM_UI_SEAT_HEALTH_STATES,
  ROOM_UI_TASK_STATES,
  type RoomCockpitDtoV1,
} from "../room-contracts/ui.js";
import { ROOM_CONTRACT_VERSIONS } from "../room-contracts/versions.js";

describe("Session Room versioned contracts", () => {
  it("pins independent v1 versions for every parallel implementation surface", () => {
    expect(ROOM_CONTRACT_VERSIONS).toEqual({
      storage: 1,
      sessionConnector: 1,
      controller: 1,
      protocol: 1,
      evidence: 1,
      ui: 1,
      api: "room.v1",
    });
  });

  it("keeps Room aggregate and provider identities explicit in storage v1", () => {
    const room = {
      contractVersion: 1,
      id: "room-1",
      projectId: "project-1",
      objective: "Coordinate existing Sessions",
      protocolId: "implementation",
      protocolVersion: 1,
      state: "draft",
      aggregateVersion: 0,
      createdAt: "2026-07-17T00:00:00.000Z",
      updatedAt: "2026-07-17T00:00:00.000Z",
    } satisfies RoomRecordV1;
    const binding = {
      contractVersion: 1,
      id: "binding-1",
      roomId: room.id,
      seatId: "seat-1",
      generation: 1,
      connectorId: "happier",
      providerId: "codex",
      nativeSessionId: "thread-1",
      happierSessionId: "happier-1",
      serverProfileId: "server-1",
      machineId: "machine-1",
      hostId: "windows-1",
      state: "attached",
      attachedAt: "2026-07-17T00:00:00.000Z",
      detachedAt: null,
      replacedByBindingId: null,
    } satisfies RoomBindingRecordV1;

    expect(ROOM_LIFECYCLE_STATES).toContain(room.state);
    expect(binding.nativeSessionId).not.toBe(binding.happierSessionId);
    expect(binding.generation).toBe(1);
  });

  it("fails closed for unverified mutating Session Connector capabilities", () => {
    const capabilities = {
      contractVersion: 1,
      connectorId: "happier",
      connectorVersion: "0.2.10",
      sourceRevision: "2bcd6c170",
      verifiedAt: "2026-07-17T00:00:00.000Z",
      capabilities: {
        ensureExisting: { state: "verified", evidenceRef: "evidence://ensure" },
        create: { state: "unverified", evidenceRef: null },
        status: { state: "verified", evidenceRef: "evidence://status" },
        history: { state: "degraded", evidenceRef: "evidence://history-empty" },
        events: { state: "unverified", evidenceRef: null },
        send: { state: "unverified", evidenceRef: null },
        interrupt: { state: "unavailable", evidenceRef: null },
        resume: { state: "unverified", evidenceRef: null },
        takeover: { state: "unverified", evidenceRef: null },
        health: { state: "verified", evidenceRef: "evidence://health" },
        deepLinks: { state: "verified", evidenceRef: "evidence://links" },
      },
    } satisfies SessionConnectorCapabilitiesV1;

    expect(isSessionConnectorMutationCertified(capabilities, "ensureExisting")).toBe(true);
    expect(isSessionConnectorMutationCertified(capabilities, "send")).toBe(false);
    expect(isSessionConnectorMutationCertified(capabilities, "interrupt")).toBe(false);
  });

  it("requires optimistic version, idempotency, authority, and exact targets on controller commands", () => {
    const command = {
      contractVersion: 1,
      apiVersion: "room.v1",
      commandId: "command-1",
      idempotencyKey: "operator:device-1:command-1",
      correlationId: "correlation-1",
      roomId: "room-1",
      projectId: "project-1",
      expectedAggregateVersion: 7,
      issuedAt: "2026-07-17T00:00:00.000Z",
      authority: {
        actorType: "human",
        actorId: "operator-1",
        deviceId: "device-1",
        role: "operator",
        allowedActions: ["room:message"],
        projectId: "project-1",
        roomId: "room-1",
        nodeIds: [],
        seatIds: ["seat-review-a", "seat-review-b"],
        evidenceRefs: [],
      },
      command: {
        type: "route_message",
        intent: "question",
        target: { kind: "seats", seatIds: ["seat-review-a", "seat-review-b"] },
        content: "Which candidate satisfies the hard gate?",
        contentHash: "sha256:message",
        nodeId: "node-review",
      },
    } satisfies RoomControllerCommandEnvelopeV1;

    expect(ROOM_CONTROLLER_COMMAND_TYPES).toContain(command.command.type);
    expect(command.expectedAggregateVersion).toBe(7);
    expect(command.command.target.seatIds).toEqual(["seat-review-a", "seat-review-b"]);
    expect(command.authority.allowedActions).toEqual(["room:message"]);
  });

  it("pins declarative protocol phases, roles, gates, recovery, and exit conditions", () => {
    const protocol = {
      contractVersion: 1,
      id: "implementation",
      version: 1,
      family: "implementation",
      name: "Independent implementation and review",
      phases: [
        { id: "produce", roleIds: ["producer"], entryGateIds: [], exitGateIds: ["candidate_ready"], timeoutMs: 900_000 },
        { id: "verify", roleIds: ["verifier"], entryGateIds: ["candidate_ready"], exitGateIds: ["hard_gates"], timeoutMs: 900_000 },
      ],
      roles: [
        { id: "producer", requiredCapabilities: ["workspace_write"], mayProduce: true, mayVerify: false, mayAccept: false },
        { id: "verifier", requiredCapabilities: ["test"], mayProduce: false, mayVerify: true, mayAccept: true },
      ],
      channels: [{ id: "review", allowedIntents: ["critique", "verdict"], responderRoleIds: ["verifier"] }],
      contextPacks: [{ id: "authoritative", includeKinds: ["contract", "source"], excludeKinds: ["private_review", "secret"] }],
      transitions: [{ fromPhaseId: "produce", toPhaseId: "verify", whenGateId: "candidate_ready" }],
      gates: [
        { id: "candidate_ready", kind: "deterministic", hard: true },
        { id: "hard_gates", kind: "deterministic", hard: true },
      ],
      recoveryActions: [{ id: "replace_producer", trigger: "no_progress", action: "replace_participant", maxAttempts: 1 }],
      exitConditions: [{ outcome: "completed", requiredGateIds: ["hard_gates"], requireIndependentVerifier: true }],
    } satisfies RoomProtocolDefinitionV1;

    expect(ROOM_PROTOCOL_FAMILIES).toContain(protocol.family);
    expect(protocol.roles.find((role) => role.id === "producer")?.mayAccept).toBe(false);
    expect(protocol.exitConditions[0]?.requireIndependentVerifier).toBe(true);
  });

  it("preserves candidate lineage and prevents votes from overriding a failed hard gate", () => {
    const candidate = {
      contractVersion: 1,
      id: "candidate-combined",
      roomId: "room-1",
      nodeId: "node-decision",
      producingBindingId: "binding-producer",
      nativeSessionId: "native-producer-session",
      happierSessionId: "happier-producer-session",
      providerId: "codex",
      modelRef: "provider-owned-model",
      protocolId: "analysis-decision",
      protocolVersion: 3,
      contextVersion: "context-v7",
      inputVersion: "input-v4",
      configVersion: "config-v2",
      contentHash: "sha256:candidate",
      artifactIds: ["artifact-candidate"],
      parentCandidateIds: ["candidate-a", "candidate-b"],
      gateResultIds: ["gate-user-constraint"],
      reviewIds: ["review-blind-a", "review-blind-b"],
      promotionState: "rejected",
      createdAt: "2026-07-17T00:00:00.000Z",
    } satisfies RoomCandidateRecordV1;
    const failedHardGate = {
      contractVersion: 1,
      id: "gate-user-constraint",
      roomId: candidate.roomId,
      nodeId: candidate.nodeId,
      candidateId: candidate.id,
      profileId: "locked-user-constraints",
      kind: "user_constraint",
      hard: true,
      status: "failed",
      evidenceIds: ["evidence-constraint-diff"],
      evaluatorBindingId: "binding-deterministic-gate",
      command: null,
      exitCode: null,
      recordedAt: "2026-07-17T00:01:00.000Z",
    } satisfies RoomGateResultV1;
    const confidence = {
      contractVersion: 1,
      id: "confidence-1",
      roomId: candidate.roomId,
      nodeId: candidate.nodeId,
      candidateId: candidate.id,
      band: "unknown",
      methodologyVersion: "confidence-v1",
      inputEvidenceHash: "sha256:evidence-set",
      dimensions: [
        {
          name: "historical_calibration",
          band: "unknown",
          evidenceIds: [],
          rationale: "No comparable outcomes are available yet.",
        },
      ],
      staleEvidenceIds: [],
      unresolvedDissentIds: [],
      modelSelfReportExcluded: true,
      computedAt: "2026-07-17T00:02:00.000Z",
    } satisfies RoomConfidenceSnapshotV1;

    expect(candidate.parentCandidateIds).toEqual(["candidate-a", "candidate-b"]);
    expect(canCandidatePassHardGates([failedHardGate])).toBe(false);
    expect(ROOM_CONFIDENCE_BANDS).toContain(confidence.band);
    expect(confidence.modelSelfReportExcluded).toBe(true);
  });

  it("exposes task-first cockpit state with explicit provider identities and idle reasons", () => {
    const cockpit = {
      contractVersion: 1,
      apiVersion: "room.v1",
      generatedAt: "2026-07-17T00:03:00.000Z",
      latestEventCursor: "event:42",
      room: {
        id: "room-1",
        projectId: "project-1",
        objective: "Coordinate existing native Sessions",
        lifecycleState: "running",
        aggregateVersion: 42,
        protocolId: "implementation",
        protocolVersion: 3,
        protocolPhaseId: "verify",
      },
      header: {
        health: "degraded",
        completion: { acceptedNodes: 1, totalNodes: 3, blockedNodes: 1 },
        criticalPathNodeIds: ["node-verify"],
        confidence: {
          snapshotId: "confidence-1",
          band: "medium",
          dimensions: [{ name: "freshness", band: "low", rationale: "One source is stale." }],
        },
        capacity: {
          theoreticalSlots: 64,
          configuredSlots: 32,
          activeSlots: 7,
          queueDepth: 4,
          reservedVerifierSlots: 2,
          reservedRecoverySlots: 1,
          utilizationRatio: 0.21875,
          throughputPerMinute: 1.4,
          idleReasons: [{ reason: "waiting_dependency", slots: 9 }],
        },
      },
      seats: [
        {
          id: "seat-reviewer",
          bindingId: "binding-reviewer-generation-2",
          bindingGeneration: 2,
          roleId: "verifier",
          providerId: "claude-code",
          actualModelRef: "provider-owned-model",
          nativeSessionId: "claude-native-session",
          happierSessionId: "happier-session",
          serverProfileId: "server-profile-1",
          hostId: "windows-host-1",
          health: "recovering",
          lastHeartbeatAt: "2026-07-17T00:02:00.000Z",
          currentNodeId: "node-verify",
          contextUtilizationRatio: 0.72,
          throughputPerMinute: 0,
          rateLimitState: "clear",
          senderLeaseId: null,
          workspaceLeaseId: null,
          waitReason: "process_exited",
          recoveryOwnerId: "controller-1",
          happierDeepLink: "http://127.0.0.1:18287/session/happier-session",
          nativeDeepLink: "claude://sessions/claude-native-session",
        },
      ],
      tasks: [
        {
          id: "node-verify",
          parentNodeId: null,
          title: "Independent verification",
          state: "blocked",
          ownerSeatId: "seat-reviewer",
          dependencyNodeIds: ["node-produce"],
          critical: true,
          attempt: 2,
          progressSignature: "sha256:no-progress",
          gateIds: ["hard-gates"],
          evidenceIds: ["evidence-process-exit"],
          waitReason: "assigned participant is recovering",
          nextRecoveryAction: "replace participant",
        },
      ],
      edges: [{ id: "edge-produce-verify", fromNodeId: "node-produce", toNodeId: "node-verify", kind: "depends_on" }],
      alerts: [],
    } satisfies RoomCockpitDtoV1;

    expect(ROOM_UI_TASK_STATES).toContain(cockpit.tasks[0]?.state);
    expect(ROOM_UI_SEAT_HEALTH_STATES).toContain(cockpit.seats[0]?.health);
    expect(cockpit.seats[0]?.nativeSessionId).not.toBe(cockpit.seats[0]?.happierSessionId);
    expect(cockpit.seats[0]?.waitReason).toBe("process_exited");
    expect(cockpit.latestEventCursor).toBe("event:42");
  });
});
