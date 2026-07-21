import {
  SESSION_CONNECTOR_CAPABILITIES,
  SESSION_CONNECTOR_HEALTH_REASON_CODES,
  SESSION_CONNECTOR_PROVIDER_TELEMETRY_CONTRACT_VERSION,
  SESSION_CONNECTOR_PROVIDER_TELEMETRY_WITHHELD_REASONS,
  type SessionConnectorCapabilityName,
  type SessionConnectorCapabilityState,
  type SessionConnectorHealthReasonCode,
  type SessionConnectorHealthV1,
  type SessionConnectorIdentityV1,
  type SessionConnectorPreflightExistingResultV1,
  type SessionConnectorProviderTelemetrySourceV1,
  type SessionConnectorProviderTelemetryV1,
  type SessionConnectorProviderTelemetryWithheldReasonV1,
  type SessionConnectorResultV1,
  type SessionConnectorV1,
} from "@fusion/core";

import type { SessionConnectorRegistry } from "./session-connector-registry.js";

export const ROOM_EXISTING_SESSION_PREFLIGHT_CONTRACT_VERSION = 1 as const;

export interface RoomExistingSessionPreflightRequestV1 {
  readonly connectorId: string;
  readonly canonicalSessionUri: string;
  readonly requiredHostId: string;
  readonly requiredMachineId?: string;
}

export interface RoomExistingSessionPreflightCapabilityV1 {
  readonly name: SessionConnectorCapabilityName;
  readonly state: SessionConnectorCapabilityState;
}

export interface RoomExistingSessionPreflightHealthV1 {
  readonly state:
    | "healthy"
    | "degraded"
    | "authentication_required"
    | "rate_limited"
    | "host_unavailable"
    | "unavailable"
    | "unknown";
  readonly checkedAt: string | null;
  readonly authentication: "authenticated" | "required" | "unknown";
  readonly rateLimit: "clear" | "limited" | "unknown";
  readonly reasonCodes: readonly SessionConnectorHealthReasonCode[];
  readonly retryAfterMs: number | null;
}

export type RoomExistingSessionPreflightProviderTelemetryV1 = SessionConnectorProviderTelemetryV1;

export type RoomExistingSessionPreflightWithheldReasonV1 =
  | "invalid_request"
  | "connector_unavailable"
  | "read_only_preflight_unsupported"
  | "read_only_preflight_timeout"
  | "session_not_found"
  | "session_ambiguous"
  | "authentication_required"
  | "host_unavailable"
  | "rate_limited"
  | "identity_mismatch"
  | "preflight_contract_invalid"
  | "preflight_unavailable";

interface RoomExistingSessionPreflightResultBaseV1 {
  readonly contractVersion: typeof ROOM_EXISTING_SESSION_PREFLIGHT_CONTRACT_VERSION;
  readonly request: Readonly<RoomExistingSessionPreflightRequestV1>;
}

export type RoomExistingSessionPreflightResultV1 =
  | (RoomExistingSessionPreflightResultBaseV1 & {
      readonly state: "identity_verified";
      readonly identity: SessionConnectorIdentityV1;
      readonly checkedAt: string;
      readonly providerTurnStarted: false;
      readonly capabilities: readonly RoomExistingSessionPreflightCapabilityV1[];
      readonly health: RoomExistingSessionPreflightHealthV1;
      readonly providerTelemetry: RoomExistingSessionPreflightProviderTelemetryV1;
    })
  | (RoomExistingSessionPreflightResultBaseV1 & {
      readonly state: "withheld";
      readonly reason: RoomExistingSessionPreflightWithheldReasonV1;
      readonly retryAfterMs: number | null;
    });

export interface RoomExistingSessionPreflightServiceOptionsV1 {
  readonly connectorRegistry: Pick<SessionConnectorRegistry, "tryGet">;
  /** Bound every connector read so Cockpit preflight cannot hang its command route. */
  readonly timeoutMs?: number;
  readonly now?: () => number;
}

type UnknownRecord = Record<string, unknown>;

const DEFAULT_PREFLIGHT_TIMEOUT_MS = 1_000;
const MAX_PREFLIGHT_TIMEOUT_MS = 10_000;
const MAX_SESSION_URI_LENGTH = 2_048;
const MAX_IDENTIFIER_LENGTH = 256;
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
const AUTHENTICATION_STATES = new Set<SessionConnectorHealthV1["authentication"]>([
  "authenticated",
  "required",
  "unknown",
]);
const RATE_LIMIT_STATES = new Set<SessionConnectorHealthV1["rateLimit"]>([
  "clear",
  "limited",
  "unknown",
]);
const HEALTH_REASON_CODES = new Set<SessionConnectorHealthReasonCode>(
  SESSION_CONNECTOR_HEALTH_REASON_CODES,
);
const PROVIDER_TELEMETRY_WITHHELD_REASONS = new Set<SessionConnectorProviderTelemetryWithheldReasonV1>(
  SESSION_CONNECTOR_PROVIDER_TELEMETRY_WITHHELD_REASONS,
);
const SESSION_CONNECTOR_IDENTITY_KEYS = [
  "connectorId",
  "providerId",
  "nativeSessionId",
  "happierSessionId",
  "serverProfileId",
  "machineId",
  "hostId",
] as const;
const PROVIDER_TELEMETRY_REPORTED_KEYS = [
  "contractVersion",
  "state",
  "identity",
  "providerId",
  "source",
  "observedAt",
  "expiresAt",
  "freshness",
  "limitations",
] as const;
const PROVIDER_TELEMETRY_WITHHELD_KEYS = ["contractVersion", "state", "identity", "reason"] as const;
const PROVIDER_TELEMETRY_LIMITATION_KEYS = [
  "providerAvailability",
  "capacity",
  "onDemandProviderRefresh",
  "accountIdentity",
  "rawSnapshot",
] as const;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactOwnKeys(value: UnknownRecord, expected: readonly string[]): boolean {
  const actual = Reflect.ownKeys(value);
  return actual.length === expected.length
    && expected.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}

function isCanonicalTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || value.trim() !== value || !value) return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

function isIdentifier(value: unknown): value is string {
  return typeof value === "string"
    && value.trim() === value
    && value.length > 0
    && value.length <= MAX_IDENTIFIER_LENGTH;
}

function isSessionUri(value: unknown): value is string {
  return typeof value === "string"
    && value.trim() === value
    && value.length > 0
    && value.length <= MAX_SESSION_URI_LENGTH;
}

function isBoundedRetryAfterMs(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0 && (value as number) <= 604_800_000;
}

function cloneRequest(input: RoomExistingSessionPreflightRequestV1): Readonly<RoomExistingSessionPreflightRequestV1> {
  return Object.freeze({
    connectorId: input.connectorId,
    canonicalSessionUri: input.canonicalSessionUri,
    requiredHostId: input.requiredHostId,
    ...(input.requiredMachineId === undefined ? {} : { requiredMachineId: input.requiredMachineId }),
  });
}

function requestIsValid(input: unknown): input is RoomExistingSessionPreflightRequestV1 {
  if (!isRecord(input)) return false;
  return isIdentifier(input.connectorId)
    && isSessionUri(input.canonicalSessionUri)
    && isIdentifier(input.requiredHostId)
    && (input.requiredMachineId === undefined || isIdentifier(input.requiredMachineId));
}

function withheld(
  request: Readonly<RoomExistingSessionPreflightRequestV1>,
  reason: RoomExistingSessionPreflightWithheldReasonV1,
  retryAfterMs: number | null = null,
): RoomExistingSessionPreflightResultV1 {
  return Object.freeze({
    contractVersion: ROOM_EXISTING_SESSION_PREFLIGHT_CONTRACT_VERSION,
    state: "withheld" as const,
    request,
    reason,
    retryAfterMs,
  });
}

function healthUnknown(): RoomExistingSessionPreflightHealthV1 {
  return Object.freeze({
    state: "unknown" as const,
    checkedAt: null,
    authentication: "unknown" as const,
    rateLimit: "unknown" as const,
    reasonCodes: Object.freeze([]),
    retryAfterMs: null,
  });
}

function hasExactIdentity(value: unknown, expected: SessionConnectorIdentityV1): boolean {
  return isRecord(value)
    && hasExactOwnKeys(value, SESSION_CONNECTOR_IDENTITY_KEYS)
    && value.connectorId === expected.connectorId
    && value.providerId === expected.providerId
    && value.nativeSessionId === expected.nativeSessionId
    && value.happierSessionId === expected.happierSessionId
    && value.serverProfileId === expected.serverProfileId
    && value.machineId === expected.machineId
    && value.hostId === expected.hostId;
}

function hasSafeProviderTelemetryLimitations(value: unknown): boolean {
  return isRecord(value)
    && hasExactOwnKeys(value, PROVIDER_TELEMETRY_LIMITATION_KEYS)
    && value.providerAvailability === "not_inferred"
    && value.capacity === "not_reported"
    && value.onDemandProviderRefresh === "not_attempted"
    && value.accountIdentity === "not_reported"
    && value.rawSnapshot === "not_reported";
}

function providerTelemetryWithheld(
  identity: SessionConnectorIdentityV1,
  reason: SessionConnectorProviderTelemetryWithheldReasonV1,
): SessionConnectorProviderTelemetryV1 {
  return Object.freeze({
    contractVersion: SESSION_CONNECTOR_PROVIDER_TELEMETRY_CONTRACT_VERSION,
    state: "withheld" as const,
    identity,
    reason,
  });
}

function normalizeProviderTelemetry(
  value: unknown,
  identity: SessionConnectorIdentityV1,
  nowMs: number,
): SessionConnectorProviderTelemetryV1 {
  try {
    if (!isRecord(value)) return providerTelemetryWithheld(identity, "telemetry_contract_invalid");
    if (value.state === "withheld") {
      if (
        !hasExactOwnKeys(value, PROVIDER_TELEMETRY_WITHHELD_KEYS)
        || value.contractVersion !== SESSION_CONNECTOR_PROVIDER_TELEMETRY_CONTRACT_VERSION
        || !hasExactIdentity(value.identity, identity)
        || !PROVIDER_TELEMETRY_WITHHELD_REASONS.has(
          value.reason as SessionConnectorProviderTelemetryWithheldReasonV1,
        )
      ) {
        return providerTelemetryWithheld(identity, "telemetry_contract_invalid");
      }
      return providerTelemetryWithheld(
        identity,
        value.reason as SessionConnectorProviderTelemetryWithheldReasonV1,
      );
    }
    if (value.state !== "reported") return providerTelemetryWithheld(identity, "telemetry_contract_invalid");

    const observedAt = value.observedAt;
    const expiresAt = value.expiresAt;
    if (
      !hasExactOwnKeys(value, PROVIDER_TELEMETRY_REPORTED_KEYS)
      || value.contractVersion !== SESSION_CONNECTOR_PROVIDER_TELEMETRY_CONTRACT_VERSION
      || !hasExactIdentity(value.identity, identity)
      || identity.providerId !== "codex"
      || value.providerId !== "codex"
      || value.source !== "happier_persisted_in_band_provider_snapshot"
      || !isCanonicalTimestamp(observedAt)
      || !isCanonicalTimestamp(expiresAt)
      || value.freshness !== "fresh"
      || !hasSafeProviderTelemetryLimitations(value.limitations)
    ) {
      return providerTelemetryWithheld(identity, "telemetry_contract_invalid");
    }
    const observedAtMs = Date.parse(observedAt);
    const expiresAtMs = Date.parse(expiresAt);
    if (!Number.isFinite(nowMs) || observedAtMs >= expiresAtMs) {
      return providerTelemetryWithheld(identity, "telemetry_contract_invalid");
    }
    if (nowMs >= expiresAtMs) return providerTelemetryWithheld(identity, "telemetry_stale");

    return Object.freeze({
      contractVersion: SESSION_CONNECTOR_PROVIDER_TELEMETRY_CONTRACT_VERSION,
      state: "reported" as const,
      identity,
      providerId: "codex" as const,
      source: "happier_persisted_in_band_provider_snapshot" as const,
      observedAt,
      expiresAt,
      freshness: "fresh" as const,
      limitations: Object.freeze({
        providerAvailability: "not_inferred" as const,
        capacity: "not_reported" as const,
        onDemandProviderRefresh: "not_attempted" as const,
        accountIdentity: "not_reported" as const,
        rawSnapshot: "not_reported" as const,
      }),
    });
  } catch {
    return providerTelemetryWithheld(identity, "telemetry_contract_invalid");
  }
}

function normalizeProviderTelemetryResult(
  value: unknown,
  identity: SessionConnectorIdentityV1,
  nowMs: number,
): SessionConnectorProviderTelemetryV1 {
  try {
    if (!isRecord(value) || !hasExactOwnKeys(value, ["ok", "value"]) && !hasExactOwnKeys(value, ["ok", "error"])) {
      return providerTelemetryWithheld(identity, "telemetry_contract_invalid");
    }
    if (value.ok === false) {
      return hasExactOwnKeys(value, ["ok", "error"])
        ? providerTelemetryWithheld(identity, "telemetry_unavailable")
        : providerTelemetryWithheld(identity, "telemetry_contract_invalid");
    }
    if (value.ok !== true || !hasExactOwnKeys(value, ["ok", "value"])) {
      return providerTelemetryWithheld(identity, "telemetry_contract_invalid");
    }
    return normalizeProviderTelemetry(value.value, identity, nowMs);
  } catch {
    return providerTelemetryWithheld(identity, "telemetry_contract_invalid");
  }
}

function getProviderTelemetrySource(value: unknown): SessionConnectorProviderTelemetrySourceV1 | null {
  try {
    return isRecord(value) && typeof value.getProviderTelemetry === "function"
      ? value as unknown as SessionConnectorProviderTelemetrySourceV1
      : null;
  } catch {
    return null;
  }
}

function normalizeHealth(value: unknown, connectorId: string, hostId: string): RoomExistingSessionPreflightHealthV1 {
  if (!isRecord(value)
    || value.connectorId !== connectorId
    || value.hostId !== hostId
    || !HEALTH_STATES.has(value.state as SessionConnectorHealthV1["state"])
    || !isCanonicalTimestamp(value.checkedAt)
    || !AUTHENTICATION_STATES.has(value.authentication as SessionConnectorHealthV1["authentication"])
    || !RATE_LIMIT_STATES.has(value.rateLimit as SessionConnectorHealthV1["rateLimit"])
    || !Array.isArray(value.reasonCodes)
    || value.reasonCodes.length > 18
    || value.reasonCodes.some((reason) => !HEALTH_REASON_CODES.has(reason as SessionConnectorHealthReasonCode))
    || (value.retryAfterMs !== null && !isBoundedRetryAfterMs(value.retryAfterMs))) {
    return healthUnknown();
  }
  return Object.freeze({
    state: value.state as RoomExistingSessionPreflightHealthV1["state"],
    checkedAt: value.checkedAt,
    authentication: value.authentication as RoomExistingSessionPreflightHealthV1["authentication"],
    rateLimit: value.rateLimit as RoomExistingSessionPreflightHealthV1["rateLimit"],
    reasonCodes: Object.freeze([...value.reasonCodes] as SessionConnectorHealthReasonCode[]),
    retryAfterMs: value.retryAfterMs as number | null,
  });
}

function normalizeIdentityAndCapabilities(
  value: unknown,
  request: Readonly<RoomExistingSessionPreflightRequestV1>,
): Readonly<{
  readonly identity: SessionConnectorIdentityV1;
  readonly checkedAt: string;
  readonly capabilities: readonly RoomExistingSessionPreflightCapabilityV1[];
}> | null {
  if (!isRecord(value) || value.providerTurnStarted !== false || !isRecord(value.identity)) return null;
  const identity = value.identity;
  if (
    identity.connectorId !== request.connectorId
    || identity.hostId !== request.requiredHostId
    || !isIdentifier(identity.providerId)
    || !isIdentifier(identity.nativeSessionId)
    || (identity.machineId !== null && !isIdentifier(identity.machineId))
    || (identity.happierSessionId !== null && !isIdentifier(identity.happierSessionId))
    || (identity.serverProfileId !== null && !isIdentifier(identity.serverProfileId))
    || (request.requiredMachineId !== undefined && identity.machineId !== request.requiredMachineId)
    || !isCanonicalTimestamp(value.checkedAt)
    || !isRecord(value.capabilities)
    || value.capabilities.connectorId !== request.connectorId
    || !isRecord(value.capabilities.capabilities)
  ) {
    return null;
  }
  const certifiedIdentity: SessionConnectorIdentityV1 = Object.freeze({
    connectorId: identity.connectorId,
    providerId: identity.providerId,
    nativeSessionId: identity.nativeSessionId,
    happierSessionId: identity.happierSessionId,
    serverProfileId: identity.serverProfileId,
    machineId: identity.machineId,
    hostId: identity.hostId,
  });
  const capabilityMap = value.capabilities.capabilities as UnknownRecord;
  const capabilities: RoomExistingSessionPreflightCapabilityV1[] = [];
  for (const name of SESSION_CONNECTOR_CAPABILITIES) {
    const capability = capabilityMap[name];
    if (!isRecord(capability) || !CAPABILITY_STATES.has(capability.state as SessionConnectorCapabilityState)) {
      return null;
    }
    capabilities.push(Object.freeze({
      name,
      state: capability.state as SessionConnectorCapabilityState,
    }));
  }
  return Object.freeze({
    identity: certifiedIdentity,
    checkedAt: value.checkedAt,
    capabilities: Object.freeze(capabilities),
  });
}

function mapConnectorFailure(value: SessionConnectorResultV1<SessionConnectorPreflightExistingResultV1>): {
  readonly reason: RoomExistingSessionPreflightWithheldReasonV1;
  readonly retryAfterMs: number | null;
} {
  if (value.ok) return { reason: "preflight_contract_invalid", retryAfterMs: null };
  const retryAfterMs = isBoundedRetryAfterMs(value.error.retryAfterMs) ? value.error.retryAfterMs : null;
  switch (value.error.code) {
    case "authentication_required":
      return { reason: "authentication_required", retryAfterMs };
    case "not_found":
      return { reason: "session_not_found", retryAfterMs };
    case "ambiguous":
      return { reason: "session_ambiguous", retryAfterMs };
    case "host_unavailable":
      return { reason: "host_unavailable", retryAfterMs };
    case "rate_limited":
      return { reason: "rate_limited", retryAfterMs };
    case "conflict":
      return { reason: "identity_mismatch", retryAfterMs };
    default:
      return { reason: "preflight_unavailable", retryAfterMs };
  }
}

type Settled<T> =
  | { readonly state: "resolved"; readonly value: T }
  | { readonly state: "rejected" }
  | { readonly state: "timeout" };

type ProviderTelemetrySettled =
  | Settled<SessionConnectorResultV1<SessionConnectorProviderTelemetryV1>>
  | { readonly state: "unsupported" };

async function settleBounded<T>(promise: Promise<T>, timeoutMs: number): Promise<Settled<T>> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.then(
        (value): Settled<T> => ({ state: "resolved", value }),
        (): Settled<T> => ({ state: "rejected" }),
      ),
      new Promise<Settled<T>>((resolve) => {
        timeout = setTimeout(() => resolve({ state: "timeout" }), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

/**
 * FNXC:RoomExistingSessionPreflightTelemetry 2026-07-21-02:57:
 * A verified identity may carry only a bounded, read-only telemetry projection.
 * Health and telemetry run in parallel after identity validation; any telemetry
 * absence, error, malformed shape, or expiration becomes a safe withheld value
 * and never changes the primary existing-Session preflight result.
 *
 * FNXC:RoomExistingSessionPreflightTelemetry 2026-07-21-03:00:
 * A reported sample must span a non-zero interval, and expiry is exclusive:
 * `observedAt < expiresAt` while `now >= expiresAt` is stale. The injectable
 * clock keeps this safety boundary deterministic without changing Room flow.
 */
function providerTelemetryFromSettled(
  telemetry: ProviderTelemetrySettled,
  identity: SessionConnectorIdentityV1,
  now: () => number,
): SessionConnectorProviderTelemetryV1 {
  if (telemetry.state === "unsupported") {
    return providerTelemetryWithheld(identity, "connector_telemetry_unsupported");
  }
  if (telemetry.state === "timeout") return providerTelemetryWithheld(identity, "telemetry_timeout");
  if (telemetry.state === "rejected") return providerTelemetryWithheld(identity, "telemetry_unavailable");
  try {
    return normalizeProviderTelemetryResult(telemetry.value, identity, now());
  } catch {
    return providerTelemetryWithheld(identity, "telemetry_contract_invalid");
  }
}

/**
 * FNXC:RoomExistingSessionPreflight 2026-07-20-14:02:
 * This service is intentionally read-only and usable while Room execution is
 * withheld. It invokes only a connector's explicit `preflightExisting` port;
 * it neither falls back to `ensureExisting` nor derives an identity from a
 * pasted URI. Connector timeouts and malformed results remain visible as
 * withheld/unknown rather than blocking a Cockpit request or creating state.
 */
export class RoomExistingSessionPreflightService {
  private readonly timeoutMs: number;
  private readonly now: () => number;

  constructor(private readonly options: RoomExistingSessionPreflightServiceOptionsV1) {
    const configured = options.timeoutMs ?? DEFAULT_PREFLIGHT_TIMEOUT_MS;
    if (!Number.isSafeInteger(configured) || configured < 1 || configured > MAX_PREFLIGHT_TIMEOUT_MS) {
      throw new Error("RoomExistingSessionPreflightService timeoutMs must be a positive safe integer no greater than 10000");
    }
    this.timeoutMs = configured;
    if (options.now !== undefined && typeof options.now !== "function") {
      throw new Error("RoomExistingSessionPreflightService now must be a function when provided");
    }
    this.now = options.now ?? Date.now;
  }

  async preflight(
    input: unknown,
  ): Promise<RoomExistingSessionPreflightResultV1> {
    const inputRecord = isRecord(input) ? input : null;
    const request = requestIsValid(input)
      ? cloneRequest(input)
      : Object.freeze({
        connectorId: typeof inputRecord?.connectorId === "string" ? inputRecord.connectorId : "",
        canonicalSessionUri: typeof inputRecord?.canonicalSessionUri === "string" ? inputRecord.canonicalSessionUri : "",
        requiredHostId: typeof inputRecord?.requiredHostId === "string" ? inputRecord.requiredHostId : "",
        ...(typeof inputRecord?.requiredMachineId === "string" ? { requiredMachineId: inputRecord.requiredMachineId } : {}),
      });
    if (!requestIsValid(request)) return withheld(request, "invalid_request");

    const connector = this.options.connectorRegistry.tryGet(request.connectorId);
    if (!connector) return withheld(request, "connector_unavailable");
    const preflightExisting = connector.preflightExisting;
    if (typeof preflightExisting !== "function") {
      return withheld(request, "read_only_preflight_unsupported");
    }

    const preflight = await settleBounded(
      Promise.resolve().then(() => preflightExisting({
        contractVersion: 1,
        canonicalSessionUri: request.canonicalSessionUri,
        requiredHostId: request.requiredHostId,
        ...(request.requiredMachineId === undefined ? {} : { requiredMachineId: request.requiredMachineId }),
      })),
      this.timeoutMs,
    );
    if (preflight.state === "timeout") return withheld(request, "read_only_preflight_timeout");
    if (preflight.state === "rejected") return withheld(request, "preflight_unavailable");
    if (!preflight.value.ok) {
      const failure = mapConnectorFailure(preflight.value);
      return withheld(request, failure.reason, failure.retryAfterMs);
    }

    const normalized = normalizeIdentityAndCapabilities(preflight.value.value, request);
    if (!normalized) return withheld(request, "preflight_contract_invalid");
    const providerTelemetrySource = getProviderTelemetrySource(connector);
    const healthPromise = settleBounded(
      Promise.resolve().then(() => connector.getHealth(normalized.identity.hostId)),
      this.timeoutMs,
    );
    const telemetryPromise: Promise<ProviderTelemetrySettled> = providerTelemetrySource
      ? settleBounded(
        Promise.resolve().then(() => providerTelemetrySource.getProviderTelemetry(normalized.identity)),
        this.timeoutMs,
      )
      : Promise.resolve({ state: "unsupported" as const });
    const [health, telemetry] = await Promise.all([healthPromise, telemetryPromise]);
    return Object.freeze({
      contractVersion: ROOM_EXISTING_SESSION_PREFLIGHT_CONTRACT_VERSION,
      state: "identity_verified" as const,
      request,
      identity: normalized.identity,
      checkedAt: normalized.checkedAt,
      providerTurnStarted: false as const,
      capabilities: normalized.capabilities,
      health: health.state === "resolved"
        ? normalizeHealth(health.value, normalized.identity.connectorId, normalized.identity.hostId)
        : healthUnknown(),
      providerTelemetry: providerTelemetryFromSettled(telemetry, normalized.identity, this.now),
    });
  }
}
