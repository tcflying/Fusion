import {
  RoomHostCompositionOperatorPolicyAuthorityError,
  type RoomHostCompositionOperatorPolicyAuthorityRecordV1,
  type RoomHostCompositionOperatorPolicyAuthorityScopeV1,
} from "@fusion/core";

import type {
  RoomCapabilityRegistryRefreshVerifiedFactory,
  RoomProviderBackpressureVerifiedFactory,
  RoomTaskDispatchCapacityAdmissionVerifiedFactory,
} from "./project-engine.js";
import type {
  RoomHostCompositionAuthorityGuardResultV1,
  RoomHostCompositionAuthorityGuardV1,
  RoomHostCompositionContextV1,
  RoomHostCompositionProviderV1,
  RoomHostCompositionResolutionV1,
  RoomVerifiedCompositionV1,
} from "./room-host-composition.js";

export interface RoomHostCompositionOperatorPolicyAuthorityReaderV1 {
  readRoomHostCompositionOperatorPolicyAuthorityV1(
    scope: RoomHostCompositionOperatorPolicyAuthorityScopeV1,
  ): Promise<RoomHostCompositionOperatorPolicyAuthorityRecordV1>;
}

/**
 * The adapter registry is a host-owned code boundary, separate from the
 * persisted operator policy. The policy can select only adapter identifiers;
 * it cannot embed runtime provider, account, model, capability, quota, or
 * connector facts that the adapters must independently verify.
 */
export interface RoomHostCompositionOperatorAdapterRegistryV1 {
  resolve(
    input: RoomHostCompositionOperatorAdapterResolutionContextV1,
  ): RoomHostCompositionOperatorAdapterResolutionV1
    | Promise<RoomHostCompositionOperatorAdapterResolutionV1>;
}

export interface RoomHostCompositionOperatorAdapterResolutionContextV1 {
  readonly authorityRecord: RoomHostCompositionOperatorPolicyAuthorityRecordV1;
  readonly roomContext: RoomHostCompositionContextV1;
}

export interface RoomHostCompositionOperatorAdapterDependenciesV1 {
  readonly providerBackpressureVerifiedFactory: RoomProviderBackpressureVerifiedFactory;
  readonly capabilityRegistryRefreshVerifiedFactory: RoomCapabilityRegistryRefreshVerifiedFactory;
  readonly taskDispatchCapacityAdmissionVerifiedFactory: RoomTaskDispatchCapacityAdmissionVerifiedFactory;
}

export type RoomHostCompositionOperatorAdapterResolutionV1 =
  | {
    readonly state: "ready";
    readonly dependencies: RoomHostCompositionOperatorAdapterDependenciesV1;
  }
  | {
    readonly state: "withheld";
    /** A controlled adapter-local code only; arbitrary text is discarded. */
    readonly reason: string;
  };

export interface CreateRoomHostCompositionOperatorPolicyProviderInputV1 {
  readonly authorityReader: RoomHostCompositionOperatorPolicyAuthorityReaderV1;
  readonly adapterRegistry: RoomHostCompositionOperatorAdapterRegistryV1;
  /** Test seam only; production uses the local process clock. */
  readonly nowMs?: () => number;
}

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: UnknownRecord, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const canonicalExpected = [...expected].sort();
  return actual.length === canonicalExpected.length && actual.every((key, index) => key === canonicalExpected[index]);
}

function isCanonicalIdentifier(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value);
}

function isCanonicalTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || value.trim() !== value || value.length === 0) return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function normalizeConnectorIds(value: unknown): readonly string[] | null {
  if (!Array.isArray(value) || value.length === 0 || !value.every(isCanonicalIdentifier)) return null;
  const sorted = [...value].sort();
  if (sorted.some((connectorId, index) => index > 0 && sorted[index - 1] >= connectorId)) {
    return null;
  }
  return Object.freeze(sorted);
}

function sameConnectorIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((connectorId, index) => connectorId === right[index]);
}

function sameAuthorityRecord(
  left: RoomHostCompositionOperatorPolicyAuthorityRecordV1,
  right: RoomHostCompositionOperatorPolicyAuthorityRecordV1,
): boolean {
  return left.policyHash === right.policyHash
    && left.revision === right.revision
    && left.bundleId === right.bundleId
    && left.issuer === right.issuer
    && left.projectId === right.projectId
    && left.hostId === right.hostId
    && left.issuedAt === right.issuedAt
    && left.updatedAt === right.updatedAt
    && left.expiresAt === right.expiresAt;
}

function isOperatorPolicyRecord(
  value: unknown,
): value is RoomHostCompositionOperatorPolicyAuthorityRecordV1 {
  if (!isRecord(value) || value.contractVersion !== 1) return false;
  if (
    !isCanonicalIdentifier(value.projectId)
    || !isCanonicalIdentifier(value.hostId)
    || !isCanonicalIdentifier(value.bundleId)
    || !isCanonicalIdentifier(value.issuer)
    || !isCanonicalIdentifier(value.policyHash)
    || !isPositiveSafeInteger(value.revision)
    || !isCanonicalTimestamp(value.issuedAt)
    || !isCanonicalTimestamp(value.updatedAt)
    || !isCanonicalTimestamp(value.expiresAt)
    || (value.revokedAt !== null && !isCanonicalTimestamp(value.revokedAt))
    || (value.revokedReason !== null && typeof value.revokedReason !== "string")
  ) return false;
  if (!isRecord(value.policy) || !hasExactKeys(value.policy, ["connectorIds", "controllerAdmission", "adapterBindings"])) {
    return false;
  }
  const connectorIds = normalizeConnectorIds(value.policy.connectorIds);
  const admission = value.policy.controllerAdmission;
  const adapters = value.policy.adapterBindings;
  return connectorIds !== null
    && isRecord(admission)
    && hasExactKeys(admission, ["workClass", "slots"])
    && (admission.workClass === "normal" || admission.workClass === "verifier" || admission.workClass === "recovery")
    && isPositiveSafeInteger(admission.slots)
    && isRecord(adapters)
    && hasExactKeys(adapters, [
      "capabilityObservationAdapterId",
      "providerAdmissionSnapshotAdapterId",
      "capacityTelemetryAdapterId",
      "roomWorkerAuthorityAdapterId",
    ])
    && isCanonicalIdentifier(adapters.capabilityObservationAdapterId)
    && isCanonicalIdentifier(adapters.providerAdmissionSnapshotAdapterId)
    && isCanonicalIdentifier(adapters.capacityTelemetryAdapterId)
    && isCanonicalIdentifier(adapters.roomWorkerAuthorityAdapterId);
}

function isAdapterDependencies(
  value: unknown,
): value is RoomHostCompositionOperatorAdapterDependenciesV1 {
  return isRecord(value)
    && hasExactKeys(value, [
      "providerBackpressureVerifiedFactory",
      "capabilityRegistryRefreshVerifiedFactory",
      "taskDispatchCapacityAdmissionVerifiedFactory",
    ])
    && typeof value.providerBackpressureVerifiedFactory === "function"
    && typeof value.capabilityRegistryRefreshVerifiedFactory === "function"
    && typeof value.taskDispatchCapacityAdmissionVerifiedFactory === "function";
}

function isAdapterRegistry(value: unknown): value is RoomHostCompositionOperatorAdapterRegistryV1 {
  return isRecord(value) && typeof value.resolve === "function";
}

function isAuthorityReader(value: unknown): value is RoomHostCompositionOperatorPolicyAuthorityReaderV1 {
  return isRecord(value) && typeof value.readRoomHostCompositionOperatorPolicyAuthorityV1 === "function";
}

function mapAuthorityReadFailure(error: unknown): string {
  if (!(error instanceof RoomHostCompositionOperatorPolicyAuthorityError)) {
    return "operator_policy_read_failed";
  }
  switch (error.message) {
    case "Room host composition authority is not installed":
      return "operator_policy_not_installed";
    case "Room host composition authority is revoked":
      return "operator_policy_revoked";
    case "Room host composition authority is expired":
      return "operator_policy_expired";
    case "Room host composition authority is not yet valid":
      return "operator_policy_not_yet_valid";
    default:
      return "operator_policy_read_failed";
  }
}

function currentNowMs(
  input: CreateRoomHostCompositionOperatorPolicyProviderInputV1,
): number | null {
  try {
    const nowMs = input.nowMs?.() ?? Date.now();
    return Number.isFinite(nowMs) ? nowMs : null;
  } catch {
    return null;
  }
}

function currentPolicyReason(
  record: unknown,
  roomContext: RoomHostCompositionContextV1,
  nowMs: number,
): string | null {
  if (!isOperatorPolicyRecord(record)) return "operator_policy_invalid";
  if (record.projectId !== roomContext.projectId || record.hostId !== roomContext.hostId) {
    return "operator_policy_scope_mismatch";
  }
  if (record.revokedAt !== null || record.revokedReason !== null) {
    return "operator_policy_revoked";
  }
  if (Date.parse(record.issuedAt) >= Date.parse(record.expiresAt)) {
    return "operator_policy_invalid";
  }
  if (nowMs < Date.parse(record.issuedAt)) return "operator_policy_not_yet_valid";
  if (nowMs >= Date.parse(record.expiresAt)) return "operator_policy_expired";
  const initialConnectorIds = normalizeConnectorIds(roomContext.connectorIds);
  let liveConnectorIds: readonly string[] | null;
  try {
    liveConnectorIds = normalizeConnectorIds(roomContext.connectorRegistry.ids());
  } catch {
    return "operator_policy_connector_inventory_unavailable";
  }
  const policyConnectorIds = normalizeConnectorIds(record.policy.connectorIds);
  if (
    initialConnectorIds === null
    || liveConnectorIds === null
    || policyConnectorIds === null
    || !sameConnectorIds(initialConnectorIds, liveConnectorIds)
    || !sameConnectorIds(liveConnectorIds, policyConnectorIds)
  ) {
    return "operator_policy_connector_set_mismatch";
  }
  return null;
}

function createAuthorityGuard(
  input: CreateRoomHostCompositionOperatorPolicyProviderInputV1,
  initialRecord: RoomHostCompositionOperatorPolicyAuthorityRecordV1,
  roomContext: RoomHostCompositionContextV1,
): RoomHostCompositionAuthorityGuardV1 {
  return Object.freeze({
    assertCurrent: async (): Promise<RoomHostCompositionAuthorityGuardResultV1> => {
      if (!isAuthorityReader(input?.authorityReader)) {
        return { state: "withheld", reason: "operator_policy_reader_invalid" };
      }
      const nowMs = currentNowMs(input);
      if (nowMs === null) {
        return { state: "withheld", reason: "operator_policy_clock_invalid" };
      }
      let record: RoomHostCompositionOperatorPolicyAuthorityRecordV1;
      try {
        record = await input.authorityReader.readRoomHostCompositionOperatorPolicyAuthorityV1({
          projectId: roomContext.projectId,
          hostId: roomContext.hostId,
        });
      } catch (error) {
        return { state: "withheld", reason: mapAuthorityReadFailure(error) };
      }
      const reason = currentPolicyReason(record, roomContext, nowMs);
      if (reason !== null) return { state: "withheld", reason };
      if (!sameAuthorityRecord(initialRecord, record)) {
        return { state: "withheld", reason: "operator_policy_changed" };
      }
      return { state: "current" };
    },
  });
}

function buildComposition(
  record: RoomHostCompositionOperatorPolicyAuthorityRecordV1,
  dependencies: RoomHostCompositionOperatorAdapterDependenciesV1,
  guard: RoomHostCompositionAuthorityGuardV1,
): RoomVerifiedCompositionV1 {
  const connectorIds = normalizeConnectorIds(record.policy.connectorIds);
  if (connectorIds === null) {
    throw new Error("operator policy connector ids are invalid");
  }
  return Object.freeze({
    globalConcurrencyVerifiedPolicy: Object.freeze({
      controllerAdmission: Object.freeze({
        workClass: record.policy.controllerAdmission.workClass,
        slots: record.policy.controllerAdmission.slots,
      }),
      verifiedAt: record.updatedAt,
      verificationId: record.policyHash,
    }),
    providerBackpressureVerifiedFactory: dependencies.providerBackpressureVerifiedFactory,
    capabilityRegistryRefreshVerifiedFactory: dependencies.capabilityRegistryRefreshVerifiedFactory,
    taskDispatchCapacityAdmissionVerifiedFactory: dependencies.taskDispatchCapacityAdmissionVerifiedFactory,
    authority: Object.freeze({
      bundleId: record.bundleId,
      issuer: record.issuer,
      revision: record.revision,
      projectId: record.projectId,
      hostId: record.hostId,
      connectorIds,
      issuedAt: record.issuedAt,
      expiresAt: record.expiresAt,
      guard,
    }),
  });
}

/*
FNXC:RoomHostCompositionOperatorProvider 2026-07-20-09:26:
One persisted operator policy selects a finite, exact connector bundle, while a
host-owned adapter registry supplies the live trusted facts required by Room
execution. The provider never turns stored labels into account/model/quota or
capacity evidence; any absent, stale, mismatched, throwing, or partial source
is a visible withheld state before controller creation.
*/
export function createRoomHostCompositionOperatorPolicyProvider(
  input: CreateRoomHostCompositionOperatorPolicyProviderInputV1,
): RoomHostCompositionProviderV1 {
  return Object.freeze({
    resolve: async (roomContext: RoomHostCompositionContextV1): Promise<RoomHostCompositionResolutionV1> => {
      if (
        !isCanonicalIdentifier(roomContext?.projectId)
        || !isCanonicalIdentifier(roomContext?.hostId)
        || normalizeConnectorIds(roomContext?.connectorIds) === null
      ) {
        return { state: "withheld", reason: "operator_policy_context_invalid" };
      }
      if (!isAuthorityReader(input?.authorityReader)) {
        return { state: "withheld", reason: "operator_policy_reader_invalid" };
      }
      if (!isAdapterRegistry(input?.adapterRegistry)) {
        return { state: "withheld", reason: "operator_adapter_registry_invalid" };
      }

      let record: RoomHostCompositionOperatorPolicyAuthorityRecordV1;
      try {
        record = await input.authorityReader.readRoomHostCompositionOperatorPolicyAuthorityV1({
          projectId: roomContext.projectId,
          hostId: roomContext.hostId,
        });
      } catch (error) {
        return { state: "withheld", reason: mapAuthorityReadFailure(error) };
      }
      const nowMs = currentNowMs(input);
      if (nowMs === null) {
        return { state: "withheld", reason: "operator_policy_clock_invalid" };
      }
      const policyReason = currentPolicyReason(record, roomContext, nowMs);
      if (policyReason !== null) return { state: "withheld", reason: policyReason };

      let adapterResolution: unknown;
      try {
        adapterResolution = await input.adapterRegistry.resolve({ authorityRecord: record, roomContext });
      } catch {
        return { state: "withheld", reason: "operator_adapter_resolution_failed" };
      }
      if (!isRecord(adapterResolution)) {
        return { state: "withheld", reason: "operator_adapter_result_invalid" };
      }
      if (adapterResolution.state === "withheld") {
        return { state: "withheld", reason: "operator_adapter_withheld" };
      }
      if (adapterResolution.state !== "ready" || !isAdapterDependencies(adapterResolution.dependencies)) {
        return { state: "withheld", reason: "operator_adapter_dependencies_invalid" };
      }

      try {
        return {
          state: "ready",
          composition: buildComposition(
            record,
            adapterResolution.dependencies,
            createAuthorityGuard(input, record, roomContext),
          ),
        } as RoomHostCompositionResolutionV1;
      } catch {
        return { state: "withheld", reason: "operator_policy_invalid" };
      }
    },
  });
}
