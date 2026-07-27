import type { Settings } from "./types.js";

export const SESSION_ROOM_CONTROL_PLANE_FLAG = "sessionRoomControlPlane" as const;
export const SESSION_ROOM_PRODUCTION_READINESS_PROOF_CONTRACT_VERSION = 1 as const;
export const SESSION_ROOM_REQUIRED_PRODUCTION_CONTROLS = Object.freeze([
  "cancellation",
  "approval",
  "permission",
  "strict_resume",
  "receipt",
  "attestation",
] as const);

export type SessionRoomProductionControlV1 =
  (typeof SESSION_ROOM_REQUIRED_PRODUCTION_CONTROLS)[number];

export interface SessionRoomProductionControlProofV1 {
  readonly control: SessionRoomProductionControlV1;
  readonly state: "verified";
  readonly evidenceRef: string;
  readonly sourceRevision: string;
  readonly verifiedAt: string;
}

export interface SessionRoomControlPlaneProductionReadinessProofV1 {
  readonly contractVersion:
    typeof SESSION_ROOM_PRODUCTION_READINESS_PROOF_CONTRACT_VERSION;
  readonly proofId: string;
  readonly issuer: string;
  readonly projectId: string;
  readonly connectorIds: readonly string[];
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly controls: readonly SessionRoomProductionControlProofV1[];
}

export interface SessionRoomControlPlaneProductionGateContextV1 {
  readonly projectId: string;
  readonly connectorIds: readonly string[];
  readonly now?: string;
}

export interface SessionRoomControlPlaneProductionGateEvaluationV1 {
  readonly enabled: boolean;
  readonly reasonCodes: readonly string[];
}

function normalizedConnectorIds(connectorIds: readonly string[]): readonly string[] {
  return [...new Set(connectorIds)].sort();
}

function isCanonicalNonEmpty(value: unknown, maximum = 1_024): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= maximum
    && value.trim() === value
    && !/[\u0000-\u001f\u007f]/u.test(value);
}

function isUniqueCanonicalConnectorInventory(
  value: unknown,
): value is readonly string[] {
  return Array.isArray(value)
    && value.every((connectorId) => isCanonicalNonEmpty(connectorId, 256))
    && new Set(value).size === value.length;
}

function hasControlProofRuntimeShape(
  value: unknown,
): value is SessionRoomProductionControlProofV1 {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<SessionRoomProductionControlProofV1>;
  return SESSION_ROOM_REQUIRED_PRODUCTION_CONTROLS.includes(
    candidate.control as SessionRoomProductionControlV1,
  )
    && candidate.state === "verified"
    && typeof candidate.evidenceRef === "string"
    && typeof candidate.sourceRevision === "string"
    && typeof candidate.verifiedAt === "string";
}

function sameConnectorInventory(
  left: readonly string[],
  right: readonly string[],
): boolean {
  const normalizedLeft = normalizedConnectorIds(left);
  const normalizedRight = normalizedConnectorIds(right);
  return normalizedLeft.length === normalizedRight.length
    && normalizedLeft.every((connectorId, index) => connectorId === normalizedRight[index]);
}

/*
FNXC:SessionRoomControlPlane 2026-07-27-16:10:
The experimental setting requests read-only Room discovery; it cannot authorize
provider-capable execution by itself. Production execution additionally needs
separate current evidence for cancellation, approval handling, permission
enforcement, strict same-session resume, content-addressed receipts, and build
attestation. Missing proof keeps the worker path closed.
*/
export function isSessionRoomControlPlaneRequested(
  settings: Pick<Settings, "experimentalFeatures"> | undefined,
): boolean {
  return settings?.experimentalFeatures?.[SESSION_ROOM_CONTROL_PLANE_FLAG] === true;
}

export function evaluateSessionRoomControlPlaneProductionGate(
  settings: Pick<Settings, "experimentalFeatures"> | undefined,
  proof: SessionRoomControlPlaneProductionReadinessProofV1 | undefined,
  context: SessionRoomControlPlaneProductionGateContextV1 | undefined,
): SessionRoomControlPlaneProductionGateEvaluationV1 {
  if (!isSessionRoomControlPlaneRequested(settings)) {
    return { enabled: false, reasonCodes: ["feature_not_requested"] };
  }
  if (!proof) {
    return { enabled: false, reasonCodes: ["production_readiness_proof_missing"] };
  }
  if (!context) {
    return { enabled: false, reasonCodes: ["production_readiness_context_missing"] };
  }
  if (proof.contractVersion !== SESSION_ROOM_PRODUCTION_READINESS_PROOF_CONTRACT_VERSION) {
    return { enabled: false, reasonCodes: ["production_readiness_proof_invalid"] };
  }
  if (
    !isCanonicalNonEmpty(proof.proofId, 256)
    || !isCanonicalNonEmpty(proof.issuer, 256)
    || !isCanonicalNonEmpty(proof.projectId, 256)
    || !isUniqueCanonicalConnectorInventory(proof.connectorIds)
    || !isCanonicalNonEmpty(proof.issuedAt, 64)
    || !isCanonicalNonEmpty(proof.expiresAt, 64)
    || !Array.isArray(proof.controls)
    || !proof.controls.every(hasControlProofRuntimeShape)
  ) {
    return { enabled: false, reasonCodes: ["production_readiness_proof_invalid"] };
  }
  if (proof.projectId !== context.projectId) {
    return { enabled: false, reasonCodes: ["production_readiness_project_mismatch"] };
  }
  if (!sameConnectorInventory(proof.connectorIds, context.connectorIds)) {
    return {
      enabled: false,
      reasonCodes: ["production_readiness_connector_inventory_mismatch"],
    };
  }
  const nowMs = Date.parse(context.now ?? new Date().toISOString());
  const issuedAtMs = Date.parse(proof.issuedAt);
  const expiresAtMs = Date.parse(proof.expiresAt);
  if (
    !Number.isFinite(issuedAtMs)
    || !Number.isFinite(expiresAtMs)
    || !Number.isFinite(nowMs)
    || issuedAtMs >= expiresAtMs
  ) {
    return { enabled: false, reasonCodes: ["production_readiness_proof_invalid"] };
  }
  if (nowMs < issuedAtMs) {
    return { enabled: false, reasonCodes: ["production_readiness_proof_not_yet_valid"] };
  }
  if (nowMs >= expiresAtMs) {
    return { enabled: false, reasonCodes: ["production_readiness_proof_expired"] };
  }

  const verifiedControls = new Set(
    proof.controls
      .filter((control) => control.state === "verified" && control.evidenceRef.length > 0)
      .map((control) => control.control),
  );
  const missingControls = SESSION_ROOM_REQUIRED_PRODUCTION_CONTROLS.filter(
    (control) => !verifiedControls.has(control),
  );
  if (missingControls.length > 0) {
    return {
      enabled: false,
      reasonCodes: missingControls.map((control) => `production_control_${control}_missing`),
    };
  }
  for (const requiredControl of SESSION_ROOM_REQUIRED_PRODUCTION_CONTROLS) {
    const matchingControls = proof.controls.filter(
      (candidate) => candidate.control === requiredControl,
    );
    if (matchingControls.length > 1) {
      return {
        enabled: false,
        reasonCodes: [`production_control_${requiredControl}_duplicate`],
      };
    }
    const control = matchingControls[0]!;
    const verifiedAtMs = Date.parse(control.verifiedAt);
    if (
      !isCanonicalNonEmpty(control.evidenceRef)
      || !isCanonicalNonEmpty(control.sourceRevision)
      || !Number.isFinite(verifiedAtMs)
      || verifiedAtMs > nowMs
      || verifiedAtMs > issuedAtMs
    ) {
      return {
        enabled: false,
        reasonCodes: [`production_control_${requiredControl}_evidence_invalid`],
      };
    }
  }
  return { enabled: true, reasonCodes: [] };
}

export function isSessionRoomControlPlaneEnabled(
  settings: Pick<Settings, "experimentalFeatures"> | undefined,
  proof?: SessionRoomControlPlaneProductionReadinessProofV1,
  context?: SessionRoomControlPlaneProductionGateContextV1,
): boolean {
  return evaluateSessionRoomControlPlaneProductionGate(settings, proof, context).enabled;
}
