import {
  SESSION_CONNECTOR_CAPABILITIES,
  type RoomBindingRecordV1,
  type SessionConnectorCapabilitiesV1,
  type SessionConnectorCapabilityState,
  type SessionConnectorHealthV1,
  type SessionConnectorIdentityV1,
  type SessionConnectorRuntimeSnapshotSourceV1,
  type SessionConnectorRuntimeSnapshotV1,
} from "@fusion/core";

import {
  ROOM_CONNECTOR_RUNTIME_OBSERVATION_REPORTER_CONTRACT_VERSION,
  type ControlledRoomConnectorRuntimeObservationPortV1,
  type ControlledRoomConnectorRuntimeObservationRequestV1,
  type RoomConnectorRuntimeFieldV1,
  type RoomConnectorRuntimeObservationV1,
  type RoomConnectorRuntimeUnknownReasonV1,
} from "./room-connector-runtime-observation-reporter.js";
import { SessionConnectorRegistry } from "./session-connector-registry.js";

export const SESSION_CONNECTOR_RUNTIME_OBSERVATION_PORT_CONTRACT_VERSION = 1 as const;

const CONTROLLED_RUNTIME_OBSERVATION_SOURCE = "controlled_connector_runtime_observation_port" as const;
const CAPABILITY_STATES = new Set<SessionConnectorCapabilityState>([
  "verified",
  "degraded",
  "unavailable",
  "unverified",
]);
const HEALTH_STATES = new Set<SessionConnectorHealthV1["state"]>([
  "healthy",
  "degraded",
  "authentication_required",
  "rate_limited",
  "host_unavailable",
  "unavailable",
]);
const RATE_LIMIT_STATES = new Set<SessionConnectorHealthV1["rateLimit"]>([
  "clear",
  "limited",
  "unknown",
]);

export interface SessionConnectorRuntimeObservationPortOptionsV1 {
  readonly registry: SessionConnectorRegistry;
}

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCanonicalTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function isCanonicalIdentifier(value: unknown): value is string {
  return typeof value === "string" && value.trim() === value && value.length > 0;
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function identityForBinding(binding: RoomBindingRecordV1): SessionConnectorIdentityV1 {
  return {
    connectorId: binding.connectorId,
    providerId: binding.providerId,
    nativeSessionId: binding.nativeSessionId,
    happierSessionId: binding.happierSessionId,
    serverProfileId: binding.serverProfileId,
    machineId: binding.machineId,
    hostId: binding.hostId,
  };
}

function known<T>(value: T, observedAt: string): RoomConnectorRuntimeFieldV1<T> {
  return {
    state: "known",
    source: CONTROLLED_RUNTIME_OBSERVATION_SOURCE,
    observedAt,
    value,
  };
}

function unknown<T>(reason: RoomConnectorRuntimeUnknownReasonV1, observedAt: string): RoomConnectorRuntimeFieldV1<T> {
  return {
    state: "unknown",
    source: CONTROLLED_RUNTIME_OBSERVATION_SOURCE,
    observedAt,
    reason,
  };
}

function readCapabilityMatrix(
  value: unknown,
  connectorId: string,
  connectorVersion: string,
): SessionConnectorCapabilitiesV1 | null {
  if (!isRecord(value)
    || value.contractVersion !== 1
    || value.connectorId !== connectorId
    || value.connectorVersion !== connectorVersion
    || !isCanonicalIdentifier(value.sourceRevision)
    || !isCanonicalTimestamp(value.verifiedAt)
    || !isRecord(value.capabilities)) {
    return null;
  }
  for (const name of SESSION_CONNECTOR_CAPABILITIES) {
    const certification = value.capabilities[name];
    if (!isRecord(certification) || !CAPABILITY_STATES.has(certification.state as SessionConnectorCapabilityState)) {
      return null;
    }
    if (certification.state === "verified" && !isCanonicalIdentifier(certification.evidenceRef)) {
      return null;
    }
    if (certification.evidenceRef !== null && !isCanonicalIdentifier(certification.evidenceRef)) return null;
    if (certification.lastVerifiedAt !== null && !isCanonicalTimestamp(certification.lastVerifiedAt)) return null;
  }
  return value as unknown as SessionConnectorCapabilitiesV1;
}

function readHealth(
  value: unknown,
  connectorId: string,
  hostId: string,
): SessionConnectorHealthV1 | null {
  if (!isRecord(value)
    || value.connectorId !== connectorId
    || value.hostId !== hostId
    || !HEALTH_STATES.has(value.state as SessionConnectorHealthV1["state"])
    || !isCanonicalTimestamp(value.checkedAt)
    || !RATE_LIMIT_STATES.has(value.rateLimit as SessionConnectorHealthV1["rateLimit"])
    || !isRecord(value.capabilities)
    || !Array.isArray(value.reasonCodes)) {
    return null;
  }
  const retryAfterMs = value.retryAfterMs;
  if (retryAfterMs !== null && (typeof retryAfterMs !== "number" || !Number.isSafeInteger(retryAfterMs) || retryAfterMs < 0)) {
    return null;
  }
  for (const name of SESSION_CONNECTOR_CAPABILITIES) {
    if (!CAPABILITY_STATES.has(value.capabilities[name] as SessionConnectorCapabilityState)) return null;
  }
  return value as unknown as SessionConnectorHealthV1;
}

function earliestObservedAt(first: string, ...rest: readonly string[]): string {
  return rest.reduce(
    (earliest, candidate) => Date.parse(candidate) < Date.parse(earliest) ? candidate : earliest,
    first,
  );
}

function capabilityObservedAt(capabilities: SessionConnectorCapabilitiesV1): string {
  const certificationTimes = SESSION_CONNECTOR_CAPABILITIES
    .map((name) => capabilities.capabilities[name].lastVerifiedAt)
    .filter((value): value is string => value !== null);
  return earliestObservedAt(capabilities.verifiedAt, ...certificationTimes);
}

function sameIdentity(left: unknown, right: SessionConnectorIdentityV1): boolean {
  return isRecord(left)
    && left.connectorId === right.connectorId
    && left.providerId === right.providerId
    && left.nativeSessionId === right.nativeSessionId
    && left.happierSessionId === right.happierSessionId
    && left.serverProfileId === right.serverProfileId
    && left.machineId === right.machineId
    && left.hostId === right.hostId;
}

function hasExactKeys(value: UnknownRecord, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const canonicalExpected = [...expected].sort();
  return actual.length === canonicalExpected.length && actual.every((key, index) => key === canonicalExpected[index]);
}

function isRuntimeSnapshotSource(value: unknown): value is SessionConnectorRuntimeSnapshotSourceV1 {
  return isRecord(value) && typeof value.getRuntimeSnapshot === "function";
}

function readRuntimeSnapshot(
  value: unknown,
  identity: SessionConnectorIdentityV1,
  asOf: string,
): SessionConnectorRuntimeSnapshotV1 | null {
  if (!isRecord(value)
    || value.contractVersion !== 1
    || (value.source !== "connector_native_snapshot" && value.source !== "connector_local_extension")
    || !sameIdentity(value.identity, identity)
    || !isCanonicalIdentifier(value.snapshotId)
    || !isPositiveSafeInteger(value.revision)
    || !isCanonicalTimestamp(value.capturedAt)
    || !isCanonicalTimestamp(value.expiresAt)
    || !isCanonicalIdentifier(value.providerId)
    || value.providerId !== identity.providerId
    || !isCanonicalIdentifier(value.modelId)
    || !isCanonicalTimestamp(value.modelObservedAt)
    || value.accountId !== null
    || !isRecord(value.coverage)
    || !hasExactKeys(value.coverage, [
      "providerModel",
      "providerAccount",
      "providerQuota",
      "latency",
      "context",
      "tools",
      "quality",
    ])
    || value.coverage.providerModel !== "observed"
    || value.coverage.providerAccount !== "not_reported"
    || value.coverage.providerQuota !== "not_reported"
    || value.coverage.latency !== "not_reported"
    || value.coverage.context !== "not_reported"
    || value.coverage.tools !== "not_reported"
    || value.coverage.quality !== "not_reported") {
    return null;
  }
  const capturedAtMs = Date.parse(value.capturedAt);
  const expiresAtMs = Date.parse(value.expiresAt);
  const modelObservedAtMs = Date.parse(value.modelObservedAt);
  if (
    capturedAtMs > expiresAtMs
    || modelObservedAtMs > expiresAtMs
    || Date.parse(asOf) > expiresAtMs
  ) return null;
  return value as unknown as SessionConnectorRuntimeSnapshotV1;
}

function assertOptions(options: SessionConnectorRuntimeObservationPortOptionsV1): void {
  if (!(options.registry instanceof SessionConnectorRegistry)) {
    throw new Error("Session connector runtime observation port requires a SessionConnectorRegistry");
  }
}

function validateRequest(request: ControlledRoomConnectorRuntimeObservationRequestV1): void {
  if (request.contractVersion !== ROOM_CONNECTOR_RUNTIME_OBSERVATION_REPORTER_CONTRACT_VERSION
    || !isCanonicalIdentifier(request.projectId)
    || !isCanonicalIdentifier(request.roomId)
    || !isCanonicalTimestamp(request.asOf)
    || !isCanonicalIdentifier(request.binding.id)
    || !isCanonicalIdentifier(request.binding.connectorId)
    || !isCanonicalIdentifier(request.binding.hostId)) {
    throw new Error("Session connector runtime observation request is invalid");
  }
}

/**
 * FNXC:SessionConnectorRuntimeObservation 2026-07-20-20:46:
 * This is the only default bridge from a live SessionConnectorRegistry into a
 * controller capability refresh. It reports the exact capability and health
 * probes that the connector can prove, and marks every absent model/context/
 * quality field explicitly unknown. It also never turns two independent
 * probes plus the controller clock into a host-issued snapshot/revision: only
 * a source that can prove one atomic, fenced runtime inventory may populate
 * that field. The caller therefore sees a real reason for withholding dispatch
 * instead of a fabricated all-green profile. Known capability and health fields
 * retain the source probe time, so a controller sampling time cannot launder an
 * old or future connector observation through downstream freshness checks.
 */
export function createSessionConnectorRuntimeObservationPort(
  options: SessionConnectorRuntimeObservationPortOptionsV1,
): ControlledRoomConnectorRuntimeObservationPortV1 {
  assertOptions(options);

  return {
    async observe(request): Promise<RoomConnectorRuntimeObservationV1> {
      validateRequest(request);
      const observedAt = request.asOf;
      const identity = identityForBinding(request.binding);
      let connector: ReturnType<SessionConnectorRegistry["tryGet"]>;
      try {
        connector = options.registry.tryGet(request.binding.connectorId);
      } catch {
        connector = undefined;
      }
      if (!connector) {
        const unavailable = unknown<never>("unavailable", observedAt);
        return {
          contractVersion: ROOM_CONNECTOR_RUNTIME_OBSERVATION_REPORTER_CONTRACT_VERSION,
          source: CONTROLLED_RUNTIME_OBSERVATION_SOURCE,
          projectId: request.projectId,
          roomId: request.roomId,
          bindingId: request.binding.id,
          identity,
          snapshot: unavailable,
          connectorEvidence: known({ availability: "unavailable" }, observedAt),
          capabilities: unavailable,
          health: unavailable,
          model: unavailable,
          tools: unavailable,
          mcps: unavailable,
          skills: unavailable,
          context: unavailable,
          workspaceAuthority: unavailable,
          latency: unavailable,
          rateLimit: unavailable,
          domainQuality: unavailable,
          calibration: unavailable,
        };
      }

      const snapshotSource = isRuntimeSnapshotSource(connector) ? connector : null;
      const [capabilitiesResult, healthResult, runtimeSnapshotResult] = await Promise.allSettled([
        connector.getCapabilities(identity),
        connector.getHealth(request.binding.hostId),
        snapshotSource ? snapshotSource.getRuntimeSnapshot(identity) : Promise.resolve(null),
      ]);
      const capabilities = capabilitiesResult.status === "fulfilled"
        ? readCapabilityMatrix(capabilitiesResult.value, connector.id, connector.version)
        : null;
      const health = healthResult.status === "fulfilled"
        ? readHealth(healthResult.value, connector.id, request.binding.hostId)
        : null;
      const capabilitiesObservedAt = capabilities ? capabilityObservedAt(capabilities) : observedAt;
      const healthObservedAt = health?.checkedAt ?? observedAt;
      const connectorEvidenceObservedAt = capabilities && health
        ? earliestObservedAt(capabilitiesObservedAt, healthObservedAt)
        : observedAt;
      const runtimeSnapshot = runtimeSnapshotResult.status === "fulfilled"
        && runtimeSnapshotResult.value !== null
        && runtimeSnapshotResult.value.ok
        ? readRuntimeSnapshot(runtimeSnapshotResult.value.value, identity, observedAt)
        : null;
      const sourceError = unknown<never>("source_error", observedAt);
      const unsupported = unknown<never>("not_supported", observedAt);
      const runtimeSnapshotUnknown = snapshotSource ? sourceError : unsupported;

      return {
        contractVersion: ROOM_CONNECTOR_RUNTIME_OBSERVATION_REPORTER_CONTRACT_VERSION,
        source: CONTROLLED_RUNTIME_OBSERVATION_SOURCE,
        projectId: request.projectId,
        roomId: request.roomId,
        bindingId: request.binding.id,
        identity,
        snapshot: runtimeSnapshot
          ? known({
            snapshotId: runtimeSnapshot.snapshotId,
            revision: runtimeSnapshot.revision,
            capturedAt: runtimeSnapshot.capturedAt,
            expiresAt: runtimeSnapshot.expiresAt,
          }, runtimeSnapshot.capturedAt)
          : capabilities && health ? runtimeSnapshotUnknown : sourceError,
        connectorEvidence: capabilities && health
          ? known({ availability: "available" }, connectorEvidenceObservedAt)
          : sourceError,
        capabilities: capabilities ? known(capabilities, capabilitiesObservedAt) : sourceError,
        health: health ? known(health, healthObservedAt) : sourceError,
        model: unsupported,
        tools: unsupported,
        mcps: unsupported,
        skills: unsupported,
        context: unsupported,
        workspaceAuthority: unsupported,
        latency: unsupported,
        rateLimit: health
          ? known({ state: health.rateLimit, retryAfterMs: health.retryAfterMs }, healthObservedAt)
          : sourceError,
        domainQuality: unsupported,
        calibration: unsupported,
      };
    },
  };
}
