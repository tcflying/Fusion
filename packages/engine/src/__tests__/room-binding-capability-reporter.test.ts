import { describe, expect, it } from "vitest";

import {
  SESSION_CONNECTOR_CAPABILITIES,
  type RoomBindingRecordV1,
  type SessionConnectorCapabilitiesV1,
  type SessionConnectorCapabilityName,
  type SessionConnectorCapabilityState,
  type SessionConnectorHealthV1,
  type SessionConnectorIdentityV1,
} from "@fusion/core";
import {
  createRoomBindingCapabilityReport,
  type CreateRoomBindingCapabilityReportInputV1,
} from "../room-binding-capability-reporter.js";

const AS_OF = "2026-07-19T10:00:00.000Z";
const OBSERVED_AT = "2026-07-19T09:59:45.000Z";
const CAPTURED_AT = "2026-07-19T09:59:50.000Z";
const EXPIRES_AT = "2026-07-19T10:01:00.000Z";

const IDENTITY = {
  connectorId: "happier",
  providerId: "codex",
  nativeSessionId: "codex-thread-1",
  happierSessionId: "happier-session-1",
  serverProfileId: "server-profile-1",
  machineId: "machine-1",
  hostId: "windows-host-1",
} satisfies SessionConnectorIdentityV1;

function capabilityStates(
  overrides: Partial<Record<SessionConnectorCapabilityName, SessionConnectorCapabilityState>> = {},
): SessionConnectorCapabilitiesV1["capabilities"] {
  return Object.fromEntries(SESSION_CONNECTOR_CAPABILITIES.map((name) => {
    const state = overrides[name] ?? "verified";
    return [name, {
      state,
      evidenceRef: state === "verified" ? "evidence://connector/" + name : null,
      reasonCode: state === "verified" ? null : "runtime_degraded",
      lastVerifiedAt: state === "verified" ? OBSERVED_AT : null,
    }];
  })) as SessionConnectorCapabilitiesV1["capabilities"];
}

function healthCapabilities(
  overrides: Partial<Record<SessionConnectorCapabilityName, SessionConnectorCapabilityState>> = {},
): SessionConnectorHealthV1["capabilities"] {
  return Object.fromEntries(
    SESSION_CONNECTOR_CAPABILITIES.map((name) => [name, overrides[name] ?? "verified"]),
  ) as SessionConnectorHealthV1["capabilities"];
}

function binding(): RoomBindingRecordV1 {
  return {
    contractVersion: 1,
    id: "binding-1",
    roomId: "room-1",
    seatId: "seat-1",
    generation: 2,
    connectorId: IDENTITY.connectorId,
    providerId: IDENTITY.providerId,
    nativeSessionId: IDENTITY.nativeSessionId,
    happierSessionId: IDENTITY.happierSessionId,
    serverProfileId: IDENTITY.serverProfileId,
    machineId: IDENTITY.machineId,
    hostId: IDENTITY.hostId,
    state: "attached",
    attachedAt: OBSERVED_AT,
    detachedAt: null,
    replacedByBindingId: null,
  };
}

function input(): CreateRoomBindingCapabilityReportInputV1 {
  return {
    contractVersion: 1,
    asOf: AS_OF,
    freshness: {
      maxObservationAgeMs: 120_000,
      maxFutureSkewMs: 5_000,
    },
    target: {
      projectId: "project-1",
      roomId: "room-1",
      binding: binding(),
      runtime: {
        source: "trusted_session_connector_binding",
        identity: IDENTITY,
        accountId: "account-1",
        modelId: "gpt-5.6-codex",
        observedAt: OBSERVED_AT,
      },
    },
    observation: {
      source: "trusted_session_connector",
      connectorEvidence: {
        source: "trusted_session_connector",
        availability: "available",
        observedAt: OBSERVED_AT,
      },
      projectId: "project-1",
      roomId: "room-1",
      bindingId: "binding-1",
      snapshotId: "capability-snapshot-1",
      revision: 4,
      capturedAt: CAPTURED_AT,
      expiresAt: EXPIRES_AT,
      identity: IDENTITY,
      capabilities: {
        contractVersion: 1,
        connectorId: IDENTITY.connectorId,
        connectorVersion: "0.2.73",
        sourceRevision: "happier-source-revision-1",
        verifiedAt: OBSERVED_AT,
        capabilities: capabilityStates(),
      },
      health: {
        connectorId: IDENTITY.connectorId,
        hostId: IDENTITY.hostId,
        state: "healthy",
        checkedAt: OBSERVED_AT,
        authentication: "authenticated",
        daemon: "running",
        server: "reachable",
        backend: "ready",
        rateLimit: "clear",
        host: "reachable",
        capabilities: healthCapabilities(),
        reasonCodes: [],
        retryAfterMs: null,
      },
      model: {
        source: "trusted_session_connector",
        providerId: IDENTITY.providerId,
        accountId: "account-1",
        modelId: "gpt-5.6-codex",
        observedAt: OBSERVED_AT,
      },
      tools: [{
        source: "trusted_session_connector",
        name: "terminal",
        state: "verified",
        evidenceRef: "evidence://tool/terminal",
        observedAt: OBSERVED_AT,
      }],
      mcps: [{
        source: "trusted_session_connector",
        name: "filesystem",
        state: "degraded",
        evidenceRef: null,
        observedAt: OBSERVED_AT,
      }],
      skills: [{
        source: "trusted_session_connector",
        name: "typescript",
        state: "verified",
        evidenceRef: "evidence://skill/typescript",
        observedAt: OBSERVED_AT,
      }],
      context: {
        source: "trusted_session_connector",
        contextVersion: "context-v2",
        maximumTokens: 128_000,
        availableTokens: 64_000,
        observedAt: OBSERVED_AT,
      },
      workspaceAuthority: {
        source: "trusted_session_connector",
        workspaceId: "workspace-1",
        scopes: ["read", "write"],
        state: "verified",
        observedAt: OBSERVED_AT,
      },
      latency: {
        source: "trusted_session_connector",
        p50Ms: 250,
        p95Ms: 900,
        sampleCount: 12,
        observedAt: OBSERVED_AT,
      },
      domainQuality: [{
        source: "trusted_room_evidence",
        domain: "code",
        selfReportedScore: null,
        independentEvidence: [{
          sourceId: "gate:build-17",
          kind: "deterministic_gate",
          score: 0.9,
          observedAt: OBSERVED_AT,
        }],
      }],
      calibration: [{
        source: "trusted_room_evidence",
        domain: "code",
        outcomeCount: 20,
        meanAbsoluteError: 0.1,
        observedAt: OBSERVED_AT,
      }],
    },
  };
}

function failed(
  value: ReturnType<typeof createRoomBindingCapabilityReport>,
) {
  if (value.ok) throw new Error("Expected the reporter to fail closed");
  return value.issues;
}

describe("Room binding capability reporter", () => {
  it("creates a Core-validated snapshot while preserving concrete binding, model, tools, workspace authority, and report provenance", () => {
    const result = createRoomBindingCapabilityReport(input());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.observationKind).toBe("caller_provided_connector_observation");
    expect(result.value).toMatchObject({
      projectId: "project-1",
      roomId: "room-1",
      bindingId: "binding-1",
      accountId: "account-1",
      modelId: "gpt-5.6-codex",
      identity: IDENTITY,
      workspaceAuthority: {
        workspaceId: "workspace-1",
        scopes: ["read", "write"],
        state: "verified",
      },
      snapshot: {
        lineage: {
          bindingId: "binding-1",
          bindingGeneration: 2,
          providerId: "codex",
          accountId: "account-1",
          modelId: "gpt-5.6-codex",
          connectorId: "happier",
          nativeSessionId: "codex-thread-1",
          hostId: "windows-host-1",
        },
        context: {
          contextVersion: "context-v2",
          maximumTokens: 128_000,
          availableTokens: 64_000,
        },
        health: {
          connectorState: "healthy",
          hostState: "healthy",
        },
        rateLimit: {
          state: "clear",
          retryAfterMs: null,
        },
      },
    });
    expect(result.value.snapshot.tools).toEqual(expect.arrayContaining([
      { name: "tool:terminal", state: "verified" },
      { name: "mcp:filesystem", state: "degraded" },
      { name: "skill:typescript", state: "verified" },
      { name: "workspace:authority", state: "verified" },
      { name: "workspace-scope:read", state: "verified" },
      { name: "connector:send", state: "verified" },
    ]));
    expect(result.value.snapshot.integrityHash).toEqual(expect.any(String));
    expect(Object.isFrozen(result.value)).toBe(true);
  });

  it("rejects peer/model capability claims and a claimed model that differs from the trusted binding runtime", () => {
    const peerClaim = structuredClone(input()) as any;
    peerClaim.observation.tools[0].source = "peer";
    expect(failed(createRoomBindingCapabilityReport(peerClaim))).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "untrusted_claim", path: "$.observation.tools[0].source" }),
    ]));

    const modelClaim = structuredClone(input()) as any;
    modelClaim.observation.model.modelId = "peer-claimed-model";
    expect(failed(createRoomBindingCapabilityReport(modelClaim))).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "model_claim_mismatch", path: "$.observation.model" }),
    ]));
  });

  it("rejects stale observations instead of allowing a caller-selected report time to revive them", () => {
    const stale = structuredClone(input()) as any;
    stale.observation.health.checkedAt = "2026-07-19T09:00:00.000Z";

    expect(failed(createRoomBindingCapabilityReport(stale))).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "stale_observation", path: "$.observation.health.checkedAt" }),
    ]));
  });

  it.each([
    ["project", (value: any) => { value.observation.projectId = "project-2"; }, "scope_mismatch"],
    ["Room", (value: any) => { value.observation.roomId = "room-2"; }, "scope_mismatch"],
    ["binding", (value: any) => { value.observation.bindingId = "binding-2"; }, "binding_mismatch"],
    ["host", (value: any) => { value.observation.identity.hostId = "windows-host-2"; }, "host_mismatch"],
  ])("rejects a mismatched %s scope or identity", (_label, mutate, code) => {
    const mismatch = structuredClone(input()) as any;
    mutate(mismatch);

    expect(failed(createRoomBindingCapabilityReport(mismatch))).toEqual(expect.arrayContaining([
      expect.objectContaining({ code }),
    ]));
  });

  it("rejects unavailable connector evidence rather than converting it into a capability report", () => {
    const unavailable = structuredClone(input()) as any;
    unavailable.observation.connectorEvidence.availability = "unavailable";

    expect(failed(createRoomBindingCapabilityReport(unavailable))).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: "connector_evidence_unavailable",
        path: "$.observation.connectorEvidence.availability",
      }),
    ]));
  });
});
