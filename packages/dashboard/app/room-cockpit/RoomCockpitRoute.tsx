import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { Workflow } from "lucide-react";
import type { RoomCockpitProjectionV1 as EngineRoomCockpitProjectionV1 } from "@fusion/engine";
import { withTokenHeader } from "../auth";
import { ViewHeader } from "../components/ViewHeader";
import {
  RoomCockpitView,
  type RoomCockpitAlertV1,
  type RoomCockpitConfidenceBandV1,
  type RoomCockpitExecutionStateV1,
  type RoomCockpitExecutionStatusV1,
  type RoomCockpitExecutionSurfaceV1,
  type RoomCockpitHealthStateV1,
  type RoomCockpitTaskEdgeV1,
  type RoomCockpitTaskNodeV1,
  type RoomCockpitTaskStateV1,
  type RoomCockpitViewStateV1,
} from "./RoomCockpitView";
import {
  RoomCockpitExistingSessionPreflightPanel,
  type RoomCockpitExistingSessionPreflightCapabilityV1,
  type RoomCockpitExistingSessionPreflightCommandResultV1,
  type RoomCockpitExistingSessionPreflightHealthV1,
  type RoomCockpitExistingSessionPreflightIdentityV1,
  type RoomCockpitExistingSessionProviderTelemetryV1,
  type RoomCockpitExistingSessionProviderTelemetryWithheldReasonV1,
  type RoomCockpitExistingSessionPreflightRequestV1,
  type RoomCockpitExistingSessionPreflightResultV1,
  type RoomCockpitExistingSessionPreflightSubmissionV1,
} from "./RoomCockpitExistingSessionPreflightPanel";
import {
  connectRoomCockpitLiveEvents,
  getRoomCockpitBrowserEventSourceFactory,
  type RoomCockpitEventSourceFactory,
  type RoomCockpitLiveAlertV1,
  type RoomCockpitLiveEventProvenanceV1,
} from "./roomCockpitLiveEvents";

export type RoomCockpitProjectionV1 = EngineRoomCockpitProjectionV1;

export type RoomCockpitProjectionFetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface RoomCockpitRouteProps {
  readonly projectId?: string;
  readonly initialRoomId?: string;
  readonly onClose: () => void;
  readonly fetchProjection?: RoomCockpitProjectionFetcher;
  readonly eventSourceFactory?: RoomCockpitEventSourceFactory;
}

interface RoomCockpitRouteSnapshot {
  readonly state: RoomCockpitViewStateV1;
  readonly projection?: RoomCockpitProjectionV1;
  readonly detail: string;
}

interface RoomCockpitLiveStreamState {
  readonly projectId: string;
  readonly roomId: string;
  readonly state: "connecting" | "connected" | "unavailable";
  readonly unavailableDetail?: string;
  readonly unavailableSource?: "server_health" | "transport";
}

const ROOM_TASK_STATES = new Set<RoomCockpitTaskStateV1>([
  "ready",
  "running",
  "waiting_dependency",
  "waiting_approval",
  "rate_limited",
  "failed",
  "retrying",
  "accepted",
  "cancelled",
  "blocked",
]);

const ROOM_HEALTH_STATES = new Set<RoomCockpitHealthStateV1>([
  "healthy",
  "degraded",
  "critical",
  "paused",
  "unknown",
]);

const ROOM_CONFIDENCE_BANDS = new Set<RoomCockpitConfidenceBandV1>([
  "high",
  "medium",
  "low",
  "unknown",
]);

const ROOM_EXECUTION_STATES = new Set<RoomCockpitExecutionStateV1>([
  "not_started",
  "starting",
  "not_enabled",
  "read_only_withheld",
  "execution_started",
  "stopping",
  "stopped",
  "startup_failed",
]);
const EXISTING_SESSION_PREFLIGHT_CAPABILITIES = new Set([
  "ensureExisting",
  "create",
  "status",
  "history",
  "events",
  "send",
  "interrupt",
  "resume",
  "takeover",
  "health",
  "deepLinks",
]);
const EXISTING_SESSION_PREFLIGHT_CAPABILITY_STATES = new Set<RoomCockpitExistingSessionPreflightCapabilityV1["state"]>([
  "verified",
  "degraded",
  "unavailable",
  "unverified",
]);
const EXISTING_SESSION_PREFLIGHT_HEALTH_STATES = new Set<RoomCockpitExistingSessionPreflightHealthV1["state"]>([
  "healthy",
  "degraded",
  "authentication_required",
  "rate_limited",
  "host_unavailable",
  "unavailable",
  "unknown",
]);
const EXISTING_SESSION_PREFLIGHT_AUTHENTICATION_STATES = new Set<RoomCockpitExistingSessionPreflightHealthV1["authentication"]>([
  "authenticated",
  "required",
  "unknown",
]);
const EXISTING_SESSION_PREFLIGHT_RATE_LIMIT_STATES = new Set<RoomCockpitExistingSessionPreflightHealthV1["rateLimit"]>([
  "clear",
  "limited",
  "unknown",
]);
const EXISTING_SESSION_PREFLIGHT_HEALTH_REASONS = new Set([
  "executable_unavailable",
  "executable_timeout",
  "executable_not_found",
  "authentication_required",
  "authentication_timeout",
  "authentication_invalid",
  "server_unreachable",
  "server_not_probed",
  "daemon_stopped",
  "status_timeout",
  "status_invalid",
  "backend_unavailable",
  "backend_timeout",
  "backend_invalid",
  "rate_limited",
  "host_unavailable",
  "capability_not_verified",
  "probe_failed",
]);
const EXISTING_SESSION_PREFLIGHT_WITHHELD_REASONS = new Set([
  "invalid_request",
  "connector_unavailable",
  "read_only_preflight_unsupported",
  "read_only_preflight_timeout",
  "session_not_found",
  "session_ambiguous",
  "authentication_required",
  "host_unavailable",
  "rate_limited",
  "identity_mismatch",
  "preflight_contract_invalid",
  "preflight_unavailable",
]);
const EXISTING_SESSION_PROVIDER_TELEMETRY_WITHHELD_REASONS = new Set<RoomCockpitExistingSessionProviderTelemetryWithheldReasonV1>([
  "connector_telemetry_unsupported",
  "telemetry_timeout",
  "telemetry_unavailable",
  "telemetry_contract_invalid",
  "telemetry_stale",
]);

const CAPACITY_STRUCTURAL_FIELDS = [
  "theoreticalSlots",
  "configuredSlots",
  "activeSlots",
  "queueDepth",
  "utilizationRatio",
] as const;

const CAPACITY_OBSERVED_FIELDS = [
  "reservedVerifierSlots",
  "reservedRecoverySlots",
  "throughputPerMinute",
  "idleReasons",
] as const;

type RoomCockpitCapacityTelemetryV1 = RoomCockpitProjectionV1["capacity"]["telemetry"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isStringOrNull(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isNonNegativeNumber(value: unknown): value is number {
  return isFiniteNumber(value) && value >= 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isInteger(value) && isNonNegativeNumber(value);
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const canonicalExpected = [...expected].sort();
  return actual.length === canonicalExpected.length && actual.every((key, index) => key === canonicalExpected[index]);
}

function isCanonicalUtcTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || value.trim() !== value || value.length === 0) return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

function isExecutionReasonCode(value: unknown): value is string {
  return typeof value === "string" && /^[a-z][a-z0-9_:-]{0,127}$/u.test(value);
}

/**
 * FNXC:RoomCockpitExecutionPayload 2026-07-20-10:23:
 * The browser revalidates the lifecycle-only status response before it reaches
 * the Cockpit. A malformed or contradictory snapshot is shown as unavailable;
 * it must never be used to imply provider, model, quota, or session health.
 */
export function isRoomCockpitExecutionStatus(
  value: unknown,
  projectId: string,
): value is RoomCockpitExecutionStatusV1 {
  if (
    !isRecord(value)
    || !hasExactKeys(value, [
      "contractVersion",
      "projectId",
      "state",
      "reasonCodes",
      "changedAt",
      "readServiceAvailable",
      "liveEventServiceAvailable",
      "controllerStarted",
    ])
    || value.contractVersion !== 1
    || value.projectId !== projectId
    || !ROOM_EXECUTION_STATES.has(value.state as RoomCockpitExecutionStateV1)
    || !Array.isArray(value.reasonCodes)
    || value.reasonCodes.length > 32
    || !value.reasonCodes.every(isExecutionReasonCode)
    || new Set(value.reasonCodes).size !== value.reasonCodes.length
    || !isCanonicalUtcTimestamp(value.changedAt)
    || typeof value.readServiceAvailable !== "boolean"
    || typeof value.liveEventServiceAvailable !== "boolean"
    || typeof value.controllerStarted !== "boolean"
  ) {
    return false;
  }

  const state = value.state as RoomCockpitExecutionStateV1;
  if (
    (state === "execution_started" && (
      value.reasonCodes.length > 0
      || value.readServiceAvailable !== true
      || value.liveEventServiceAvailable !== true
      || value.controllerStarted !== true
    ))
    || (state === "read_only_withheld" && (
      value.reasonCodes.length === 0
      || value.liveEventServiceAvailable !== false
      || value.controllerStarted !== false
    ))
    || (state === "not_enabled" && (
      value.reasonCodes.length !== 1
      || value.reasonCodes[0] !== "feature_disabled"
      || value.liveEventServiceAvailable !== false
      || value.controllerStarted !== false
    ))
    || (state === "stopped" && (
      value.reasonCodes.length > 0
      || value.readServiceAvailable !== false
      || value.liveEventServiceAvailable !== false
      || value.controllerStarted !== false
    ))
  ) {
    return false;
  }

  return true;
}

function isExpectedFieldList(value: unknown, expected: readonly string[]): value is readonly string[] {
  return Array.isArray(value)
    && value.length === expected.length
    && value.every((field, index) => field === expected[index]);
}

function isRoomCockpitCapacityTelemetry(value: unknown): value is RoomCockpitCapacityTelemetryV1 {
  if (!isRecord(value)
    || !isNonEmptyString(value.detail)
    || !isExpectedFieldList(value.structuralFields, CAPACITY_STRUCTURAL_FIELDS)
    || !isExpectedFieldList(value.observedFields, CAPACITY_OBSERVED_FIELDS)) {
    return false;
  }

  if (value.availability === "unavailable") {
    return value.source === undefined && value.observedAt === undefined;
  }

  return value.availability === "available"
    && value.source === "persistent_runtime_telemetry"
    && isNonEmptyString(value.observedAt);
}

/**
 * FNXC:RoomCockpitRoute 2026-07-19-16:56:
 * Capacity structural values are always derivable, but reservations, throughput,
 * and idle reasons are real only when persistent runtime telemetry says available.
 * Require the Engine discriminator and retain unavailable observations as null so
 * the route never fabricates zero capacity or an empty idle-reason collection.
 */
function isRoomCockpitCapacity(value: unknown): boolean {
  if (!isRecord(value)
    || !isNonNegativeNumber(value.theoreticalSlots)
    || !isNonNegativeNumber(value.configuredSlots)
    || !isNonNegativeNumber(value.activeSlots)
    || !isNonNegativeNumber(value.queueDepth)
    || !isNonNegativeNumber(value.utilizationRatio)) {
    return false;
  }

  const telemetry = value.telemetry;
  if (!isRoomCockpitCapacityTelemetry(telemetry)) return false;

  if (telemetry.availability === "unavailable") {
    return value.reservedVerifierSlots === null
      && value.reservedRecoverySlots === null
      && value.throughputPerMinute === null
      && value.idleReasons === null;
  }

  return isNonNegativeNumber(value.reservedVerifierSlots)
    && isNonNegativeNumber(value.reservedRecoverySlots)
    && isNonNegativeNumber(value.throughputPerMinute)
    && Array.isArray(value.idleReasons)
    && value.idleReasons.every((reason) => isRecord(reason)
      && isNonEmptyString(reason.reason)
      && isNonNegativeNumber(reason.slots));
}

function isRoomCockpitTask(value: unknown): value is RoomCockpitTaskNodeV1 {
  if (!isRecord(value) || !ROOM_TASK_STATES.has(value.state as RoomCockpitTaskStateV1)) return false;
  return isNonEmptyString(value.id)
    && isNonEmptyString(value.title)
    && isStringOrNull(value.ownerSeatId)
    && isStringArray(value.dependencyNodeIds)
    && typeof value.critical === "boolean"
    && isNonNegativeInteger(value.attempt)
    && isStringOrNull(value.progressSignature)
    && isStringArray(value.inputs)
    && isStringArray(value.outputs)
    && isStringArray(value.gateIds)
    && isStringArray(value.evidenceIds)
    && isStringOrNull(value.waitReason)
    && isStringOrNull(value.nextRecoveryAction);
}

function isRoomCockpitEdge(value: unknown): value is RoomCockpitTaskEdgeV1 {
  if (!isRecord(value)) return false;
  return isNonEmptyString(value.id)
    && isNonEmptyString(value.fromNodeId)
    && isNonEmptyString(value.toNodeId)
    && (value.kind === "depends_on" || value.kind === "blocks" || value.kind === "informs" || value.kind === "invalidates");
}

function isRoomCockpitAlert(value: unknown): value is RoomCockpitAlertV1 {
  if (!isRecord(value)) return false;
  if (value.severity !== "info" && value.severity !== "warning" && value.severity !== "severe" && value.severity !== "critical") return false;
  if (value.state !== "open" && value.state !== "acknowledged" && value.state !== "resolved") return false;
  return isNonEmptyString(value.id)
    && isNonEmptyString(value.rootCause)
    && isNonEmptyString(value.impact)
    && isStringArray(value.evidenceIds)
    && isStringArray(value.attemptedRecovery)
    && isStringOrNull(value.nextRetryAt)
    && Array.isArray(value.actions)
    && value.actions.every((action) => isRecord(action)
      && isNonEmptyString(action.id)
      && isNonEmptyString(action.label)
      && typeof action.requiresConfirmation === "boolean");
}

export function isRoomCockpitProjection(value: unknown): value is RoomCockpitProjectionV1 {
  if (!isRecord(value)
    || !isNonEmptyString(value.roomId)
    || !isNonEmptyString(value.objective)
    || !isNonEmptyString(value.phase)
    || !isRecord(value.health)
    || !ROOM_HEALTH_STATES.has(value.health.state as RoomCockpitHealthStateV1)
    || !isNonEmptyString(value.health.detail)
    || !isRecord(value.completion)
    || !isNonNegativeNumber(value.completion.acceptedNodes)
    || !isNonNegativeNumber(value.completion.total)
    || !isNonNegativeNumber(value.completion.blockedNodes)
    || !isStringArray(value.criticalPathNodeIds)
    || !isRecord(value.confidence)
    || !ROOM_CONFIDENCE_BANDS.has(value.confidence.band as RoomCockpitConfidenceBandV1)
    || !isNonEmptyString(value.confidence.snapshotId)
    || !Array.isArray(value.confidence.dimensions)
    || !value.confidence.dimensions.every((dimension) => isRecord(dimension)
      && isNonEmptyString(dimension.name)
      && ROOM_CONFIDENCE_BANDS.has(dimension.band as RoomCockpitConfidenceBandV1)
      && isNonEmptyString(dimension.rationale))
    || !isRoomCockpitCapacity(value.capacity)
    || !Array.isArray(value.tasks)
    || !value.tasks.every(isRoomCockpitTask)
    || !Array.isArray(value.edges)
    || !value.edges.every(isRoomCockpitEdge)
    || !Array.isArray(value.alerts)
    || !value.alerts.every(isRoomCockpitAlert)) {
    return false;
  }
  return true;
}

function getResponseDetail(_payload: unknown, fallback: string): string {
  /*
   * FNXC:RoomCockpitSafeResponseDetails 2026-07-20-21:49:
   * The Cockpit does not surface arbitrary REST error strings. They can contain
   * provider diagnostics, authorization material, or implementation detail;
   * fixed local fallbacks keep the UI actionable without expanding that boundary.
   */
  return fallback;
}

function getResponseCode(payload: unknown): string | null {
  if (!isRecord(payload)) return null;
  const error = isRecord(payload.error) ? payload.error : payload;
  return typeof error.code === "string" ? error.code : null;
}

function isBoundedCanonicalText(value: unknown, maximum = 256): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maximum && value.trim() === value;
}

function hasExpectedExistingSessionPreflightRequest(
  value: unknown,
  expected: RoomCockpitExistingSessionPreflightRequestV1,
): boolean {
  const expectedKeys = expected.requiredMachineId === undefined
    ? ["connectorId", "canonicalSessionUri", "requiredHostId"]
    : ["connectorId", "canonicalSessionUri", "requiredHostId", "requiredMachineId"];
  return isRecord(value)
    && hasExactKeys(value, expectedKeys)
    && value.connectorId === expected.connectorId
    && value.canonicalSessionUri === expected.canonicalSessionUri
    && value.requiredHostId === expected.requiredHostId
    && (expected.requiredMachineId === undefined || value.requiredMachineId === expected.requiredMachineId);
}

function cloneExistingSessionPreflightRequest(
  request: RoomCockpitExistingSessionPreflightRequestV1,
): RoomCockpitExistingSessionPreflightRequestV1 {
  return {
    connectorId: request.connectorId,
    canonicalSessionUri: request.canonicalSessionUri,
    requiredHostId: request.requiredHostId,
    ...(request.requiredMachineId === undefined ? {} : { requiredMachineId: request.requiredMachineId }),
  };
}

function normalizeExistingSessionPreflightCapabilities(
  value: unknown,
): readonly RoomCockpitExistingSessionPreflightCapabilityV1[] | null {
  if (!Array.isArray(value) || value.length > EXISTING_SESSION_PREFLIGHT_CAPABILITIES.size) return null;
  const seen = new Set<string>();
  const capabilities: RoomCockpitExistingSessionPreflightCapabilityV1[] = [];
  for (const capability of value) {
    if (
      !isRecord(capability)
      || !hasExactKeys(capability, ["name", "state"])
      || typeof capability.name !== "string"
      || !EXISTING_SESSION_PREFLIGHT_CAPABILITIES.has(capability.name)
      || typeof capability.state !== "string"
      || !EXISTING_SESSION_PREFLIGHT_CAPABILITY_STATES.has(
        capability.state as RoomCockpitExistingSessionPreflightCapabilityV1["state"],
      )
      || seen.has(capability.name)
    ) return null;
    seen.add(capability.name);
    capabilities.push({
      name: capability.name,
      state: capability.state as RoomCockpitExistingSessionPreflightCapabilityV1["state"],
    });
  }
  return capabilities;
}

function normalizeExistingSessionPreflightHealth(
  value: unknown,
): RoomCockpitExistingSessionPreflightHealthV1 | null {
  if (
    !isRecord(value)
    || !hasExactKeys(value, ["state", "checkedAt", "authentication", "rateLimit", "reasonCodes", "retryAfterMs"])
    || typeof value.state !== "string"
    || !EXISTING_SESSION_PREFLIGHT_HEALTH_STATES.has(value.state as RoomCockpitExistingSessionPreflightHealthV1["state"])
    || (value.checkedAt !== null && !isCanonicalUtcTimestamp(value.checkedAt))
    || typeof value.authentication !== "string"
    || !EXISTING_SESSION_PREFLIGHT_AUTHENTICATION_STATES.has(
      value.authentication as RoomCockpitExistingSessionPreflightHealthV1["authentication"],
    )
    || typeof value.rateLimit !== "string"
    || !EXISTING_SESSION_PREFLIGHT_RATE_LIMIT_STATES.has(
      value.rateLimit as RoomCockpitExistingSessionPreflightHealthV1["rateLimit"],
    )
    || !Array.isArray(value.reasonCodes)
    || value.reasonCodes.length > EXISTING_SESSION_PREFLIGHT_HEALTH_REASONS.size
  ) return null;
  const retryAfterMs = value.retryAfterMs;
  if (
    retryAfterMs !== null
    && (typeof retryAfterMs !== "number" || !Number.isSafeInteger(retryAfterMs) || retryAfterMs < 0 || retryAfterMs > 604_800_000)
  ) return null;
  const seenReasons = new Set<string>();
  const reasonCodes: string[] = [];
  for (const reason of value.reasonCodes) {
    if (
      typeof reason !== "string"
      || !EXISTING_SESSION_PREFLIGHT_HEALTH_REASONS.has(reason)
      || seenReasons.has(reason)
    ) return null;
    seenReasons.add(reason);
    reasonCodes.push(reason);
  }
  return {
    state: value.state as RoomCockpitExistingSessionPreflightHealthV1["state"],
    checkedAt: value.checkedAt as string | null,
    authentication: value.authentication as RoomCockpitExistingSessionPreflightHealthV1["authentication"],
    rateLimit: value.rateLimit as RoomCockpitExistingSessionPreflightHealthV1["rateLimit"],
    reasonCodes,
    retryAfterMs: retryAfterMs as number | null,
  };
}

function existingSessionProviderTelemetryWithheld(
  reason: RoomCockpitExistingSessionProviderTelemetryWithheldReasonV1,
): RoomCockpitExistingSessionProviderTelemetryV1 {
  return { contractVersion: 1, state: "withheld", reason };
}

function hasExpectedExistingSessionPreflightIdentity(
  value: unknown,
  expected: RoomCockpitExistingSessionPreflightIdentityV1,
): boolean {
  return isRecord(value)
    && hasExactKeys(value, [
      "connectorId",
      "providerId",
      "nativeSessionId",
      "happierSessionId",
      "serverProfileId",
      "machineId",
      "hostId",
    ])
    && value.connectorId === expected.connectorId
    && value.providerId === expected.providerId
    && value.nativeSessionId === expected.nativeSessionId
    && value.happierSessionId === expected.happierSessionId
    && value.serverProfileId === expected.serverProfileId
    && value.machineId === expected.machineId
    && value.hostId === expected.hostId;
}

/**
 * FNXC:RoomCockpitProviderTelemetry 2026-07-21-03:08:
 * The Cockpit treats provider telemetry as a narrow persisted-snapshot display
 * contract, not an authorization or readiness signal. Every canonical Core
 * variant must carry the exact same SessionConnector identity as its outer
 * preflight result; unknown, extra, stale, or potentially sensitive fields
 * fail closed while the independently verified Session result remains usable.
 * A fresh snapshot has a strictly positive lifetime (`observedAt < expiresAt`).
 */
function normalizeExistingSessionProviderTelemetry(
  value: unknown,
  identity: RoomCockpitExistingSessionPreflightIdentityV1,
): RoomCockpitExistingSessionProviderTelemetryV1 {
  if (!isRecord(value) || value.contractVersion !== 1 || typeof value.state !== "string") {
    return existingSessionProviderTelemetryWithheld("telemetry_contract_invalid");
  }
  if (value.state === "withheld") {
    if (
      !hasExactKeys(value, ["contractVersion", "state", "identity", "reason"])
      || !hasExpectedExistingSessionPreflightIdentity(value.identity, identity)
      || typeof value.reason !== "string"
      || !EXISTING_SESSION_PROVIDER_TELEMETRY_WITHHELD_REASONS.has(
        value.reason as RoomCockpitExistingSessionProviderTelemetryWithheldReasonV1,
      )
    ) return existingSessionProviderTelemetryWithheld("telemetry_contract_invalid");
    return existingSessionProviderTelemetryWithheld(
      value.reason as RoomCockpitExistingSessionProviderTelemetryWithheldReasonV1,
    );
  }
  if (
    value.state !== "reported"
    || !hasExactKeys(value, [
      "contractVersion",
      "state",
      "identity",
      "providerId",
      "source",
      "observedAt",
      "expiresAt",
      "freshness",
      "limitations",
    ])
    || !hasExpectedExistingSessionPreflightIdentity(value.identity, identity)
    || value.providerId !== "codex"
    || value.source !== "happier_persisted_in_band_provider_snapshot"
    || value.freshness !== "fresh"
    || !isCanonicalUtcTimestamp(value.observedAt)
    || !isCanonicalUtcTimestamp(value.expiresAt)
    || Date.parse(value.observedAt) >= Date.parse(value.expiresAt)
    || !isRecord(value.limitations)
    || !hasExactKeys(value.limitations, [
      "providerAvailability",
      "capacity",
      "onDemandProviderRefresh",
      "accountIdentity",
      "rawSnapshot",
    ])
    || value.limitations.providerAvailability !== "not_inferred"
    || value.limitations.capacity !== "not_reported"
    || value.limitations.onDemandProviderRefresh !== "not_attempted"
    || value.limitations.accountIdentity !== "not_reported"
    || value.limitations.rawSnapshot !== "not_reported"
  ) return existingSessionProviderTelemetryWithheld("telemetry_contract_invalid");
  return {
    contractVersion: 1,
    state: "reported",
    providerId: "codex",
    source: "happier_persisted_in_band_provider_snapshot",
    observedAt: value.observedAt,
    expiresAt: value.expiresAt,
    freshness: "fresh",
    limitations: {
      providerAvailability: "not_inferred",
      capacity: "not_reported",
      onDemandProviderRefresh: "not_attempted",
      accountIdentity: "not_reported",
      rawSnapshot: "not_reported",
    },
  };
}

function normalizeExistingSessionPreflightResult(
  value: unknown,
  expected: RoomCockpitExistingSessionPreflightRequestV1,
): RoomCockpitExistingSessionPreflightResultV1 | null {
  if (
    !isRecord(value)
    || value.contractVersion !== 1
    || !hasExpectedExistingSessionPreflightRequest(value.request, expected)
    || typeof value.state !== "string"
  ) return null;
  const request = cloneExistingSessionPreflightRequest(expected);
  if (value.state === "withheld") {
    const retryAfterMs = value.retryAfterMs;
    if (
      !hasExactKeys(value, ["contractVersion", "state", "request", "reason", "retryAfterMs"])
      || typeof value.reason !== "string"
      || !EXISTING_SESSION_PREFLIGHT_WITHHELD_REASONS.has(value.reason)
      || (retryAfterMs !== null
        && (typeof retryAfterMs !== "number" || !Number.isSafeInteger(retryAfterMs) || retryAfterMs < 0 || retryAfterMs > 604_800_000))
    ) return null;
    return {
      contractVersion: 1,
      state: "withheld",
      request,
      reason: value.reason,
      retryAfterMs: retryAfterMs as number | null,
    };
  }
  const hasProviderTelemetry = Object.prototype.hasOwnProperty.call(value, "providerTelemetry");
  if (
    value.state !== "identity_verified"
    || !hasExactKeys(value, [
      "contractVersion",
      "state",
      "request",
      "identity",
      "checkedAt",
      "providerTurnStarted",
      "capabilities",
      "health",
      ...(hasProviderTelemetry ? ["providerTelemetry"] : []),
    ])
    || value.providerTurnStarted !== false
    || !isCanonicalUtcTimestamp(value.checkedAt)
    || !isRecord(value.identity)
    || !hasExactKeys(value.identity, [
      "connectorId",
      "providerId",
      "nativeSessionId",
      "happierSessionId",
      "serverProfileId",
      "machineId",
      "hostId",
    ])
    || value.identity.connectorId !== expected.connectorId
    || value.identity.hostId !== expected.requiredHostId
    || !isBoundedCanonicalText(value.identity.providerId)
    || !isBoundedCanonicalText(value.identity.nativeSessionId, 2_048)
    || (value.identity.happierSessionId !== null && !isBoundedCanonicalText(value.identity.happierSessionId))
    || (value.identity.serverProfileId !== null && !isBoundedCanonicalText(value.identity.serverProfileId))
    || (value.identity.machineId !== null && !isBoundedCanonicalText(value.identity.machineId))
    || (expected.requiredMachineId !== undefined && value.identity.machineId !== expected.requiredMachineId)
  ) return null;
  const capabilities = normalizeExistingSessionPreflightCapabilities(value.capabilities);
  const health = normalizeExistingSessionPreflightHealth(value.health);
  if (capabilities === null || health === null) return null;
  const identity = {
    connectorId: expected.connectorId,
    providerId: value.identity.providerId as string,
    nativeSessionId: value.identity.nativeSessionId as string,
    happierSessionId: value.identity.happierSessionId as string | null,
    serverProfileId: value.identity.serverProfileId as string | null,
    machineId: value.identity.machineId as string | null,
    hostId: expected.requiredHostId,
  };
  const providerTelemetry = hasProviderTelemetry
    ? normalizeExistingSessionProviderTelemetry(value.providerTelemetry, identity)
    : existingSessionProviderTelemetryWithheld("connector_telemetry_unsupported");
  return {
    contractVersion: 1,
    state: "identity_verified",
    request,
    identity,
    checkedAt: value.checkedAt,
    providerTurnStarted: false,
    capabilities,
    health,
    providerTelemetry,
  };
}

function parseExistingSessionPreflightResponse(
  value: unknown,
  expectedRequests: readonly RoomCockpitExistingSessionPreflightRequestV1[],
): readonly RoomCockpitExistingSessionPreflightCommandResultV1[] | null {
  if (!isRecord(value) || !hasExactKeys(value, ["results"]) || !Array.isArray(value.results) || value.results.length !== expectedRequests.length) {
    return null;
  }
  const seenCommandIds = new Set<string>();
  const results: RoomCockpitExistingSessionPreflightCommandResultV1[] = [];
  for (const [index, entry] of value.results.entries()) {
    const expected = expectedRequests[index];
    if (
      expected === undefined
      || !isRecord(entry)
      || !hasExactKeys(entry, ["commandId", "result"])
      || !isBoundedCanonicalText(entry.commandId, 192)
      || seenCommandIds.has(entry.commandId)
    ) return null;
    const result = normalizeExistingSessionPreflightResult(entry.result, expected);
    if (result === null) return null;
    seenCommandIds.add(entry.commandId);
    results.push({ commandId: entry.commandId, result });
  }
  return results;
}

async function readResponsePayload(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function normalizeRoomId(value: string | undefined): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

function initialSnapshot(projectId: string | undefined, roomId: string | null): RoomCockpitRouteSnapshot {
  if (!projectId) {
    return {
      state: "empty",
      detail: "Select a Fusion project before requesting a verified Room projection.",
    };
  }
  if (!roomId) {
    return {
      state: "empty",
      detail: "Enter a Room ID to load a verified control-plane projection. No demo telemetry is shown here.",
    };
  }
  return {
    state: "loading",
    detail: "Loading the verified Room projection.",
  };
}

function getServerConnectionUnavailableDetail(state: string, cursor: string | null): string {
  const cursorDetail = cursor === null ? "before a canonical cursor was established" : `at canonical cursor ${cursor}`;
  return `Room live-event server reports live-event state ${state} ${cursorDetail}. Health and capacity remain withheld until a scoped connected report and fresh durable projection reconcile.`;
}

function getServerAlertUnavailableDetail(alert: RoomCockpitLiveAlertV1): string {
  const cursorDetail = alert.cursor === null ? "without a canonical cursor" : `at canonical cursor ${alert.cursor}`;
  return `Room live-event alert ${alert.code} was reported ${cursorDetail}. Health and capacity remain withheld until a scoped connected report and fresh durable projection reconcile.`;
}

/**
 * FNXC:RoomCockpitRoute 2026-07-19-23:32:
 * The first cockpit entry is deliberately projection-only. It accepts only a
 * schema-validated response from the optional Room control-plane API and makes
 * an absent, unavailable, or malformed backend explicit instead of synthesizing
 * tasks, capacity, confidence, or operator actions from dashboard state.
 */
export function RoomCockpitRoute({
  projectId,
  initialRoomId,
  onClose,
  fetchProjection = globalThis.fetch,
  eventSourceFactory,
}: RoomCockpitRouteProps) {
  const normalizedInitialRoomId = normalizeRoomId(initialRoomId);
  const [draftRoomId, setDraftRoomId] = useState(normalizedInitialRoomId ?? "");
  const [selectedRoomId, setSelectedRoomId] = useState<string | null>(normalizedInitialRoomId);
  const [snapshot, setSnapshot] = useState<RoomCockpitRouteSnapshot>(() => initialSnapshot(projectId, normalizedInitialRoomId));
  const [execution, setExecution] = useState<RoomCockpitExecutionSurfaceV1 | undefined>(undefined);
  const [liveEventProvenance, setLiveEventProvenance] = useState<RoomCockpitLiveEventProvenanceV1 | null>(null);
  const requestEpochRef = useRef(0);
  const executionEpochRef = useRef(0);
  const liveStreamEpochRef = useRef(0);
  const liveStreamStateRef = useRef<RoomCockpitLiveStreamState | null>(null);

  const loadRoom = useCallback(async (roomId: string | null, loadingDetail = "Loading the verified Room projection.") => {
    const requestEpoch = ++requestEpochRef.current;
    if (!projectId || !roomId) {
      setSnapshot(initialSnapshot(projectId, roomId));
      return;
    }

    setSnapshot({ state: "loading", detail: loadingDetail });
    const query = new URLSearchParams({ projectId });
    const path = `/api/rooms/${encodeURIComponent(roomId)}?${query.toString()}`;

    try {
      const response = await fetchProjection(path, { headers: withTokenHeader({ accept: "application/json" }) });
      const payload = await readResponsePayload(response);
      if (requestEpoch !== requestEpochRef.current) return;

      if (!response.ok) {
        if (response.status === 401 || response.status === 403) {
          setSnapshot({
            state: "permission-denied",
            detail: getResponseDetail(payload, "This project does not grant access to the requested Room projection."),
          });
          return;
        }
        if (response.status === 404 && getResponseCode(payload) === "ROOM_NOT_FOUND") {
          setSnapshot({
            state: "empty",
            detail: getResponseDetail(payload, `Room ${roomId} was not found in this project.`),
          });
          return;
        }
        setSnapshot({
          state: "degraded",
          detail: getResponseDetail(payload, "The Room control-plane projection endpoint is unavailable. Retry after it is connected."),
        });
        return;
      }

      const candidate = isRecord(payload) ? payload.room : undefined;
      if (!isRoomCockpitProjection(candidate)) {
        setSnapshot({
          state: "degraded",
          detail: "The Room endpoint returned data that does not satisfy the verified cockpit projection contract.",
        });
        return;
      }
      if (candidate.roomId !== roomId) {
        setSnapshot({
          state: "degraded",
          detail: "The Room endpoint returned a projection for a different Room ID, so it was withheld from the cockpit.",
        });
        return;
      }
      const liveStreamState = liveStreamStateRef.current;
      if (
        liveStreamState?.projectId === projectId
        && liveStreamState.roomId === roomId
        && liveStreamState.state === "unavailable"
      ) {
        setSnapshot({
          state: "degraded",
          detail: liveStreamState.unavailableDetail
            ?? "Room live-event delivery is unavailable. The canonical projection is withheld until the cursor reconnects and is reconciled.",
        });
        return;
      }
      setSnapshot({ state: "ready", projection: candidate, detail: "Verified Room projection loaded." });
    } catch {
      if (requestEpoch !== requestEpochRef.current) return;
      setSnapshot({
        state: "degraded",
        detail: "Unable to contact the Room control-plane endpoint. Retry after it is connected.",
      });
    }
  }, [fetchProjection, projectId]);

  const loadExecutionStatus = useCallback(async (roomId: string | null) => {
    const requestEpoch = ++executionEpochRef.current;
    if (!projectId || !roomId) {
      setExecution(undefined);
      return;
    }

    setExecution({
      state: "loading",
      detail: "Loading the authorized Room execution lifecycle snapshot.",
    });
    const query = new URLSearchParams({ projectId });
    const path = `/api/room-control-plane/status?${query.toString()}`;

    try {
      const response = await fetchProjection(path, { headers: withTokenHeader({ accept: "application/json" }) });
      const payload = await readResponsePayload(response);
      if (requestEpoch !== executionEpochRef.current) return;

      if (!response.ok) {
        setExecution({
          state: response.status === 401 || response.status === 403 ? "permission-denied" : "unavailable",
          detail: getResponseDetail(payload, "The authorized Room execution lifecycle endpoint is unavailable."),
        });
        return;
      }

      const candidate = isRecord(payload) ? payload.status : undefined;
      if (!isRoomCockpitExecutionStatus(candidate, projectId)) {
        setExecution({
          state: "unavailable",
          detail: "The execution endpoint returned a lifecycle snapshot that does not satisfy the Cockpit contract.",
        });
        return;
      }

      setExecution({
        state: "available",
        detail: "Authorized controller lifecycle snapshot. It does not certify provider, model, account, quota, or session health.",
        status: candidate,
      });
    } catch {
      if (requestEpoch !== executionEpochRef.current) return;
      setExecution({
        state: "unavailable",
        detail: "Unable to contact the authorized Room execution lifecycle endpoint.",
      });
    }
  }, [fetchProjection, projectId]);

  const preflightExistingSessions = useCallback(async (
    requests: readonly RoomCockpitExistingSessionPreflightRequestV1[],
  ): Promise<RoomCockpitExistingSessionPreflightSubmissionV1> => {
    if (!projectId) {
      return { state: "failed", detail: "Select a project before running an authorized existing-Session preflight." };
    }
    if (requests.length < 1 || requests.length > 64) {
      return { state: "failed", detail: "Existing-Session preflight accepts between one and 64 bounded Session inputs." };
    }
    const expectedRequests = requests.map(cloneExistingSessionPreflightRequest);
    const query = new URLSearchParams({ projectId });
    const path = `/api/rooms/session-preflight?${query.toString()}`;
    try {
      const response = await fetchProjection(path, {
        method: "POST",
        headers: withTokenHeader({
          accept: "application/json",
          "content-type": "application/json",
        }),
        body: JSON.stringify({ sessions: expectedRequests }),
      });
      const payload = await readResponsePayload(response);
      if (!response.ok) {
        return {
          state: "failed",
          detail: getResponseDetail(payload, "The authorized existing-Session preflight endpoint is unavailable."),
        };
      }
      const results = parseExistingSessionPreflightResponse(payload, expectedRequests);
      if (results === null) {
        return {
          state: "failed",
          detail: "The existing-Session preflight endpoint returned data that does not satisfy the Cockpit contract.",
        };
      }
      return { state: "succeeded", results };
    } catch {
      return {
        state: "failed",
        detail: "Unable to contact the authorized existing-Session preflight endpoint.",
      };
    }
  }, [fetchProjection, projectId]);

  useEffect(() => {
    void loadRoom(selectedRoomId);
    return () => {
      requestEpochRef.current += 1;
    };
  }, [loadRoom, selectedRoomId]);

  useEffect(() => {
    void loadExecutionStatus(selectedRoomId);
    return () => {
      executionEpochRef.current += 1;
    };
  }, [loadExecutionStatus, selectedRoomId]);

  useEffect(() => {
    /*
     * FNXC:RoomCockpitEventProvenance 2026-07-20-21:49:
     * Retain only the last scope-bound canonical event pointer. Clear it before
     * a new project or Room stream begins so a prior Session's causal metadata
     * can never be presented as evidence for the selected Room.
     */
    setLiveEventProvenance(null);
  }, [projectId, selectedRoomId]);

  useEffect(() => {
    const roomId = selectedRoomId;
    const streamEpoch = ++liveStreamEpochRef.current;
    if (!projectId || !roomId) {
      liveStreamStateRef.current = null;
      return () => {
        if (liveStreamEpochRef.current === streamEpoch) liveStreamEpochRef.current += 1;
      };
    }

    const isCurrentStream = () => liveStreamEpochRef.current === streamEpoch;
    const markLiveStreamUnavailable = (
      unavailableDetail: string,
      unavailableSource: "server_health" | "transport",
    ): void => {
      liveStreamStateRef.current = {
        projectId,
        roomId,
        state: "unavailable",
        unavailableDetail,
        unavailableSource,
      };
      requestEpochRef.current += 1;
      setSnapshot({
        state: "degraded",
        detail: unavailableDetail,
      });
    };
    liveStreamStateRef.current = { projectId, roomId, state: "connecting" };
    const sourceFactory = eventSourceFactory ?? getRoomCockpitBrowserEventSourceFactory();
    if (!sourceFactory) {
      const unavailableDetail = "This browser cannot open the authenticated Room live-event stream. The cockpit withholds stale health and capacity until a canonical projection can be reconciled.";
      markLiveStreamUnavailable(unavailableDetail, "transport");
      return () => {
        if (liveStreamEpochRef.current === streamEpoch) {
          liveStreamEpochRef.current += 1;
          liveStreamStateRef.current = null;
        }
      };
    }

    const connection = connectRoomCockpitLiveEvents({
      scope: { projectId, roomId },
      eventSourceFactory: sourceFactory,
      onReconnecting: ({ attempt, cursor }) => {
        if (!isCurrentStream()) return;
        const currentState = liveStreamStateRef.current;
        /*
        FNXC:RoomCockpitLiveHealth 2026-07-19-20:00:
        A transport close after a scoped server health failure is not new health
        evidence. Keep the server's degraded/disconnected/alert receipt visible
        until the replacement stream reports connected and a durable projection
        refresh completes; otherwise a generic reconnect message can hide why
        progress is frozen.
        */
        if (
          currentState?.projectId === projectId
          && currentState.roomId === roomId
          && currentState.state === "unavailable"
          && currentState.unavailableSource === "server_health"
        ) return;
        const unavailableDetail = `Room live-event stream is unavailable or reconnecting (attempt ${attempt}, cursor ${cursor ?? "not established"}). It may be disconnected, disabled, or returning HTTP 503. The last projection is withheld until canonical cursor reconciliation succeeds.`;
        markLiveStreamUnavailable(unavailableDetail, "transport");
      },
      /*
      FNXC:RoomCockpitLiveHealth 2026-07-19-19:36:
      `onopen` establishes only SSE transport and must never erase a server
      degraded, disconnected, unknown, or alert state. Restore the Cockpit only
      after the scoped server contract says connected and a durable read succeeds.
      */
      onConnection: ({ cursor, connection: serverConnection, alerts }) => {
        if (!isCurrentStream()) return;
        if (serverConnection.state !== "connected") {
          markLiveStreamUnavailable(getServerConnectionUnavailableDetail(serverConnection.state, cursor), "server_health");
          return;
        }
        const alert = alerts[0];
        if (alert) {
          markLiveStreamUnavailable(getServerAlertUnavailableDetail(alert), "server_health");
          return;
        }
        liveStreamStateRef.current = { projectId, roomId, state: "connected" };
        void loadRoom(roomId, `Reconciling canonical Room event cursor ${cursor ?? "from the durable ledger"}.`);
      },
      onAlert: ({ alerts }) => {
        if (!isCurrentStream()) return;
        const alert = alerts[0];
        if (!alert) return;
        markLiveStreamUnavailable(getServerAlertUnavailableDetail(alert), "server_health");
      },
      onEvent: ({ cursor, provenance, reconciliationRequired }) => {
        if (!isCurrentStream()) return;
        setLiveEventProvenance(provenance);
        if (reconciliationRequired) {
          markLiveStreamUnavailable(
            `Room event cursor ${cursor} requires durable reconciliation. Health and capacity remain withheld until a fresh canonical projection is read.`,
            "server_health",
          );
        }
        void loadRoom(roomId, `Reconciling canonical Room event cursor ${cursor}.`);
      },
    });

    return () => {
      if (liveStreamEpochRef.current === streamEpoch) {
        liveStreamEpochRef.current += 1;
        liveStreamStateRef.current = null;
      }
      connection.close();
    };
  }, [eventSourceFactory, loadRoom, projectId, selectedRoomId]);

  const handleSubmit = useCallback((event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const nextRoomId = normalizeRoomId(draftRoomId);
    if (nextRoomId === selectedRoomId) {
      void loadRoom(nextRoomId);
      return;
    }
    setSelectedRoomId(nextRoomId);
  }, [draftRoomId, loadRoom, selectedRoomId]);

  return (
    <section data-testid="room-cockpit-route" aria-label="Room control-plane cockpit">
      <ViewHeader
        icon={Workflow}
        title="Room cockpit"
        actions={(
          <form onSubmit={handleSubmit} className="view-header__actions" aria-label="Load Room cockpit">
            <input
              id="room-cockpit-room-id"
              className="form-input"
              type="text"
              value={draftRoomId}
              onChange={(event) => setDraftRoomId(event.target.value)}
              placeholder="Room ID"
              aria-label="Room ID"
              disabled={!projectId}
            />
            <button type="submit" className="btn btn-sm btn-secondary" disabled={!projectId}>
              Load verified Room
            </button>
            <button type="button" className="btn btn-sm btn-secondary" onClick={onClose}>
              Back to workspace
            </button>
          </form>
        )}
      />
      <RoomCockpitExistingSessionPreflightPanel
        disabled={!projectId}
        onPreflight={preflightExistingSessions}
      />
      <RoomCockpitView
        state={snapshot.state}
        projection={snapshot.projection}
        stateDetail={snapshot.detail}
        execution={execution}
        liveEventProvenance={liveEventProvenance}
        callbacks={{
          onRefresh: () => {
            void loadRoom(selectedRoomId);
            void loadExecutionStatus(selectedRoomId);
          },
        }}
      />
    </section>
  );
}
