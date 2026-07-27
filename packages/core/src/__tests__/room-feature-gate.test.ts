import { describe, expect, it } from "vitest";

import {
  evaluateSessionRoomControlPlaneProductionGate,
  isSessionRoomControlPlaneEnabled,
  SESSION_ROOM_CONTROL_PLANE_FLAG,
  SESSION_ROOM_REQUIRED_PRODUCTION_CONTROLS,
  type SessionRoomControlPlaneProductionReadinessProofV1,
} from "../room-feature-gate.js";

const NOW = "2026-07-27T08:10:00.000Z";
const PROJECT_ID = "project-room-production-gate";
const CONNECTOR_IDS = ["happier"] as const;

function productionReadinessProof(): SessionRoomControlPlaneProductionReadinessProofV1 {
  return {
    contractVersion: 1,
    proofId: "proof-room-production-gate-r1",
    issuer: "trusted-room-host",
    projectId: PROJECT_ID,
    connectorIds: CONNECTOR_IDS,
    issuedAt: "2026-07-27T08:09:00.000Z",
    expiresAt: "2026-07-27T08:20:00.000Z",
    controls: SESSION_ROOM_REQUIRED_PRODUCTION_CONTROLS.map((control) => ({
      control,
      state: "verified",
      evidenceRef: `sha256:${control}:${"a".repeat(64)}`,
      sourceRevision: "happier-runtime-0.3.0",
      verifiedAt: "2026-07-27T08:09:00.000Z",
    })),
  };
}

describe("Session Room control-plane feature gate", () => {
  it("requires current per-control production proof in addition to the explicit setting", () => {
    expect(SESSION_ROOM_CONTROL_PLANE_FLAG).toBe("sessionRoomControlPlane");
    const settings = {
      experimentalFeatures: { [SESSION_ROOM_CONTROL_PLANE_FLAG]: true },
    };
    expect(isSessionRoomControlPlaneEnabled(settings)).toBe(false);
    expect(evaluateSessionRoomControlPlaneProductionGate(
      settings,
      undefined,
      { projectId: PROJECT_ID, connectorIds: CONNECTOR_IDS, now: NOW },
    )).toEqual({
      enabled: false,
      reasonCodes: ["production_readiness_proof_missing"],
    });
    expect(isSessionRoomControlPlaneEnabled(
      {
        experimentalFeatures: { [SESSION_ROOM_CONTROL_PLANE_FLAG]: true },
      },
      productionReadinessProof(),
      { projectId: PROJECT_ID, connectorIds: CONNECTOR_IDS, now: NOW },
    )).toBe(true);
  });

  it.each(SESSION_ROOM_REQUIRED_PRODUCTION_CONTROLS)(
    "withholds execution when %s proof is missing",
    (missingControl) => {
      const proof = productionReadinessProof();
      expect(evaluateSessionRoomControlPlaneProductionGate(
        {
          experimentalFeatures: { [SESSION_ROOM_CONTROL_PLANE_FLAG]: true },
        },
        {
          ...proof,
          controls: proof.controls.filter(
            (control) => control.control !== missingControl,
          ),
        },
        { projectId: PROJECT_ID, connectorIds: CONNECTOR_IDS, now: NOW },
      )).toEqual({
        enabled: false,
        reasonCodes: [`production_control_${missingControl}_missing`],
      });
    },
  );

  it("binds production proof to the exact project and connector inventory", () => {
    const settings = {
      experimentalFeatures: { [SESSION_ROOM_CONTROL_PLANE_FLAG]: true },
    };
    expect(evaluateSessionRoomControlPlaneProductionGate(
      settings,
      productionReadinessProof(),
      {
        projectId: "different-project",
        connectorIds: CONNECTOR_IDS,
        now: NOW,
      },
    )).toEqual({
      enabled: false,
      reasonCodes: ["production_readiness_project_mismatch"],
    });
    expect(evaluateSessionRoomControlPlaneProductionGate(
      settings,
      productionReadinessProof(),
      {
        projectId: PROJECT_ID,
        connectorIds: ["different-connector"],
        now: NOW,
      },
    )).toEqual({
      enabled: false,
      reasonCodes: ["production_readiness_connector_inventory_mismatch"],
    });
  });

  it("rejects expired production proof", () => {
    const proof = productionReadinessProof();
    expect(evaluateSessionRoomControlPlaneProductionGate(
      {
        experimentalFeatures: { [SESSION_ROOM_CONTROL_PLANE_FLAG]: true },
      },
      { ...proof, expiresAt: "2026-07-27T08:09:59.999Z" },
      { projectId: PROJECT_ID, connectorIds: CONNECTOR_IDS, now: NOW },
    )).toEqual({
      enabled: false,
      reasonCodes: ["production_readiness_proof_expired"],
    });
  });

  it("rejects a control proof whose evidence timestamp is in the future", () => {
    const proof = productionReadinessProof();
    expect(evaluateSessionRoomControlPlaneProductionGate(
      {
        experimentalFeatures: { [SESSION_ROOM_CONTROL_PLANE_FLAG]: true },
      },
      {
        ...proof,
        controls: proof.controls.map((control) => control.control === "approval"
          ? { ...control, verifiedAt: "2026-07-27T08:10:00.001Z" }
          : control),
      },
      { projectId: PROJECT_ID, connectorIds: CONNECTOR_IDS, now: NOW },
    )).toEqual({
      enabled: false,
      reasonCodes: ["production_control_approval_evidence_invalid"],
    });
  });

  it("rejects duplicate evidence for a required control", () => {
    const proof = productionReadinessProof();
    expect(evaluateSessionRoomControlPlaneProductionGate(
      {
        experimentalFeatures: { [SESSION_ROOM_CONTROL_PLANE_FLAG]: true },
      },
      {
        ...proof,
        controls: [...proof.controls, proof.controls[0]!],
      },
      { projectId: PROJECT_ID, connectorIds: CONNECTOR_IDS, now: NOW },
    )).toEqual({
      enabled: false,
      reasonCodes: ["production_control_cancellation_duplicate"],
    });
  });

  it("rejects an unknown production-readiness proof contract", () => {
    const proof = {
      ...productionReadinessProof(),
      contractVersion: 2,
    } as unknown as SessionRoomControlPlaneProductionReadinessProofV1;
    expect(evaluateSessionRoomControlPlaneProductionGate(
      {
        experimentalFeatures: { [SESSION_ROOM_CONTROL_PLANE_FLAG]: true },
      },
      proof,
      { projectId: PROJECT_ID, connectorIds: CONNECTOR_IDS, now: NOW },
    )).toEqual({
      enabled: false,
      reasonCodes: ["production_readiness_proof_invalid"],
    });
  });

  it("rejects production proof before its issuance boundary", () => {
    const proof = productionReadinessProof();
    expect(evaluateSessionRoomControlPlaneProductionGate(
      {
        experimentalFeatures: { [SESSION_ROOM_CONTROL_PLANE_FLAG]: true },
      },
      { ...proof, issuedAt: "2026-07-27T08:10:00.001Z" },
      { projectId: PROJECT_ID, connectorIds: CONNECTOR_IDS, now: NOW },
    )).toEqual({
      enabled: false,
      reasonCodes: ["production_readiness_proof_not_yet_valid"],
    });
  });

  it("rejects evidence without a source revision", () => {
    const proof = productionReadinessProof();
    expect(evaluateSessionRoomControlPlaneProductionGate(
      {
        experimentalFeatures: { [SESSION_ROOM_CONTROL_PLANE_FLAG]: true },
      },
      {
        ...proof,
        controls: proof.controls.map((control) => control.control === "receipt"
          ? { ...control, sourceRevision: " " }
          : control),
      },
      { projectId: PROJECT_ID, connectorIds: CONNECTOR_IDS, now: NOW },
    )).toEqual({
      enabled: false,
      reasonCodes: ["production_control_receipt_evidence_invalid"],
    });
  });

  it("fails closed instead of throwing when runtime proof structure is malformed", () => {
    const malformed = {
      ...productionReadinessProof(),
      controls: undefined,
    } as unknown as SessionRoomControlPlaneProductionReadinessProofV1;
    expect(() => evaluateSessionRoomControlPlaneProductionGate(
      {
        experimentalFeatures: { [SESSION_ROOM_CONTROL_PLANE_FLAG]: true },
      },
      malformed,
      { projectId: PROJECT_ID, connectorIds: CONNECTOR_IDS, now: NOW },
    )).not.toThrow();
    expect(evaluateSessionRoomControlPlaneProductionGate(
      {
        experimentalFeatures: { [SESSION_ROOM_CONTROL_PLANE_FLAG]: true },
      },
      malformed,
      { projectId: PROJECT_ID, connectorIds: CONNECTOR_IDS, now: NOW },
    )).toEqual({
      enabled: false,
      reasonCodes: ["production_readiness_proof_invalid"],
    });
  });

  it("rejects non-canonical proof identity and duplicate connector claims", () => {
    const settings = {
      experimentalFeatures: { [SESSION_ROOM_CONTROL_PLANE_FLAG]: true },
    };
    expect(evaluateSessionRoomControlPlaneProductionGate(
      settings,
      { ...productionReadinessProof(), issuer: " " },
      { projectId: PROJECT_ID, connectorIds: CONNECTOR_IDS, now: NOW },
    )).toEqual({
      enabled: false,
      reasonCodes: ["production_readiness_proof_invalid"],
    });
    expect(evaluateSessionRoomControlPlaneProductionGate(
      settings,
      {
        ...productionReadinessProof(),
        connectorIds: ["happier", "happier"],
      },
      { projectId: PROJECT_ID, connectorIds: CONNECTOR_IDS, now: NOW },
    )).toEqual({
      enabled: false,
      reasonCodes: ["production_readiness_proof_invalid"],
    });
  });

  it("rejects control evidence created after the proof was issued", () => {
    const proof = productionReadinessProof();
    expect(evaluateSessionRoomControlPlaneProductionGate(
      {
        experimentalFeatures: { [SESSION_ROOM_CONTROL_PLANE_FLAG]: true },
      },
      {
        ...proof,
        controls: proof.controls.map((control) => control.control === "strict_resume"
          ? { ...control, verifiedAt: "2026-07-27T08:09:30.000Z" }
          : control),
      },
      { projectId: PROJECT_ID, connectorIds: CONNECTOR_IDS, now: NOW },
    )).toEqual({
      enabled: false,
      reasonCodes: ["production_control_strict_resume_evidence_invalid"],
    });
  });
});
