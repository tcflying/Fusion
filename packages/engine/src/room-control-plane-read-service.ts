import type {
  AsyncRoomStore,
  RoomAggregateV1,
  RoomBindingRecordV1,
  RoomSeatRecordV1,
  RoomSummaryV1,
  RoomTaskGraphProjectionV1,
  RoomTaskNodeProjectionV1,
  SessionConnectorDeepLinksV1,
  SessionConnectorHealthReasonCode,
  SessionConnectorHealthV1,
  SessionConnectorIdentityV1,
  SessionConnectorV1,
} from "@fusion/core";
import type { SessionConnectorRegistry } from "./session-connector-registry.js";

export type RoomControlPlaneReadServiceErrorCode =
  | "room_control_plane_invalid_project_id"
  | "room_control_plane_project_scope_mismatch"
  | "room_control_plane_invalid_cursor"
  | "room_control_plane_invalid_limit"
  | "room_control_plane_invalid_room_id"
  | "room_control_plane_invalid_store_response"
  | "room_control_plane_projection_scope_violation"
  | "room_control_plane_projection_version_conflict";

export class RoomControlPlaneReadServiceError extends Error {
  constructor(
    readonly code: RoomControlPlaneReadServiceErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "RoomControlPlaneReadServiceError";
  }
}

export interface RoomControlPlaneReadServiceOptionsV1 {
  readonly projectId: string;
  readonly roomStore: AsyncRoomStore;
  /** Optional because projection reads remain available while connector runtime is withheld. */
  readonly connectorRegistry?: Pick<SessionConnectorRegistry, "tryGet">;
}

export interface RoomControlPlaneListRoomsInputV1 {
  readonly projectId: string;
  readonly cursor: string | null;
  readonly limit: number | null;
}

export interface RoomControlPlaneRoomProjectionInputV1 {
  readonly projectId: string;
  readonly roomId: string;
}

export interface RoomControlPlanePageV1<T> {
  readonly items: readonly T[];
  readonly nextCursor: string | null;
}

export type RoomCockpitTaskStateV1 =
  | "ready"
  | "running"
  | "waiting_dependency"
  | "waiting_approval"
  | "rate_limited"
  | "failed"
  | "retrying"
  | "accepted"
  | "cancelled"
  | "blocked";

export type RoomCockpitHealthStateV1 = "healthy" | "degraded" | "critical" | "paused" | "unknown";
export type RoomCockpitConfidenceBandV1 = "high" | "medium" | "low" | "unknown";

export type RoomCockpitCapacityStructuralFieldV1 =
  | "theoreticalSlots"
  | "configuredSlots"
  | "activeSlots"
  | "queueDepth"
  | "utilizationRatio";

export type RoomCockpitCapacityObservedFieldV1 =
  | "reservedVerifierSlots"
  | "reservedRecoverySlots"
  | "throughputPerMinute"
  | "idleReasons";

export interface RoomCockpitCapacityTelemetryUnavailableV1 {
  readonly availability: "unavailable";
  readonly detail: string;
  readonly structuralFields: readonly RoomCockpitCapacityStructuralFieldV1[];
  readonly observedFields: readonly RoomCockpitCapacityObservedFieldV1[];
}

export interface RoomCockpitCapacityTelemetryAvailableV1 {
  readonly availability: "available";
  readonly detail: string;
  readonly source: "persistent_runtime_telemetry";
  readonly observedAt: string;
  readonly structuralFields: readonly RoomCockpitCapacityStructuralFieldV1[];
  readonly observedFields: readonly RoomCockpitCapacityObservedFieldV1[];
}

export type RoomCockpitCapacityTelemetryV1 =
  | RoomCockpitCapacityTelemetryUnavailableV1
  | RoomCockpitCapacityTelemetryAvailableV1;

interface RoomCockpitCapacityStructuralV1 {
  readonly theoreticalSlots: number;
  readonly configuredSlots: number;
  readonly activeSlots: number;
  readonly queueDepth: number;
  readonly utilizationRatio: number;
}

interface RoomCockpitIdleReasonV1 {
  readonly reason: string;
  readonly slots: number;
}

export interface RoomCockpitCapacityWithoutRuntimeTelemetryV1 extends RoomCockpitCapacityStructuralV1 {
  readonly telemetry: RoomCockpitCapacityTelemetryUnavailableV1;
  readonly reservedVerifierSlots: null;
  readonly reservedRecoverySlots: null;
  readonly throughputPerMinute: null;
  readonly idleReasons: null;
}

export interface RoomCockpitCapacityWithRuntimeTelemetryV1 extends RoomCockpitCapacityStructuralV1 {
  readonly telemetry: RoomCockpitCapacityTelemetryAvailableV1;
  readonly reservedVerifierSlots: number;
  readonly reservedRecoverySlots: number;
  readonly throughputPerMinute: number;
  readonly idleReasons: readonly RoomCockpitIdleReasonV1[];
}

/**
 * The discriminator prevents absent runtime observations from being represented
 * as numeric or empty values while retaining the legacy capacity field names.
 */
export type RoomCockpitCapacityV1 =
  | RoomCockpitCapacityWithoutRuntimeTelemetryV1
  | RoomCockpitCapacityWithRuntimeTelemetryV1;

/**
 * Session links are convenience navigation only. The structural seat and
 * binding record remains the source of truth; unavailable runtime evidence is
 * represented with null rather than inferred from a provider/session string.
 */
export interface RoomCockpitParticipantProjectionV1 {
  readonly seatId: string;
  readonly bindingId: string | null;
  readonly nativeSessionId: string | null;
  readonly happierSessionId: string | null;
  readonly happierUrl: string | null;
  readonly nativeSessionUrl: string | null;
  /** Connector-certified runtime reachability only; never a provider capacity or quality grant. */
  readonly connectorHealth: RoomCockpitConnectorHealthProjectionV1;
  readonly role: string;
  readonly provider: string | null;
  readonly model: null;
  readonly host: string | null;
  readonly heartbeat: {
    readonly freshness: "unknown";
    readonly lastObservedAt: null;
    readonly recoveryOwner: null;
  };
  readonly context: {
    readonly usedTokens: null;
    readonly limitTokens: null;
  };
  readonly throughput: {
    readonly eventsPerMinute: null;
  };
  readonly limits: {
    readonly configuredConcurrent: null;
    readonly effectiveConcurrent: null;
  };
  readonly wait: {
    readonly reason: null;
    readonly retryAt: null;
  };
  readonly leases: {
    readonly sender: {
      readonly state: "unknown";
      readonly holderId: null;
      readonly expiresAt: null;
    };
    readonly workspace: {
      readonly state: "unknown";
      readonly holderId: null;
      readonly expiresAt: null;
    };
  };
}

export interface RoomCockpitConnectorHealthProjectionV1 {
  readonly state: SessionConnectorHealthV1["state"] | "unknown";
  readonly checkedAt: string | null;
  readonly authentication: "authenticated" | "required" | "unknown";
  readonly rateLimit: "clear" | "limited" | "unknown";
  readonly reasonCodes: readonly SessionConnectorHealthReasonCode[];
  readonly retryAfterMs: number | null;
}

export interface RoomCockpitProjectionV1 {
  readonly roomId: string;
  readonly objective: string;
  readonly phase: string;
  readonly health: {
    readonly state: RoomCockpitHealthStateV1;
    readonly detail: string;
  };
  readonly completion: {
    readonly acceptedNodes: number;
    readonly total: number;
    readonly blockedNodes: number;
  };
  readonly criticalPathNodeIds: readonly string[];
  readonly confidence: {
    readonly band: RoomCockpitConfidenceBandV1;
    readonly snapshotId: string;
    readonly dimensions: readonly {
      readonly name: string;
      readonly band: RoomCockpitConfidenceBandV1;
      readonly rationale: string;
    }[];
  };
  readonly capacity: RoomCockpitCapacityV1;
  readonly tasks: readonly {
    readonly id: string;
    readonly title: string;
    readonly state: RoomCockpitTaskStateV1;
    readonly ownerSeatId: string | null;
    readonly dependencyNodeIds: readonly string[];
    readonly critical: boolean;
    readonly attempt: number;
    readonly progressSignature: string | null;
    readonly inputs: readonly string[];
    readonly outputs: readonly string[];
    readonly gateIds: readonly string[];
    readonly evidenceIds: readonly string[];
    readonly waitReason: string | null;
    readonly nextRecoveryAction: string | null;
  }[];
  readonly edges: readonly {
    readonly id: string;
    readonly fromNodeId: string;
    readonly toNodeId: string;
    readonly kind: "depends_on" | "blocks" | "informs" | "invalidates";
  }[];
  readonly alerts: readonly {
    readonly id: string;
    readonly severity: "info" | "warning" | "severe" | "critical";
    readonly state: "open" | "acknowledged" | "resolved";
    readonly rootCause: string;
    readonly impact: string;
    readonly evidenceIds: readonly string[];
    readonly attemptedRecovery: readonly string[];
    readonly nextRetryAt: string | null;
    readonly actions: readonly {
      readonly id: string;
      readonly label: string;
      readonly requiresConfirmation: boolean;
    }[];
  }[];
  readonly participants: readonly RoomCockpitParticipantProjectionV1[];
}

const MAX_IDENTIFIER_LENGTH = 256;
const MAX_CURSOR_LENGTH = 512;
export const ROOM_COCKPIT_DEEP_LINK_LOOKUP_TIMEOUT_MS = 1_000;
const CAPACITY_STRUCTURAL_FIELDS = [
  "theoreticalSlots",
  "configuredSlots",
  "activeSlots",
  "queueDepth",
  "utilizationRatio",
] as const satisfies readonly RoomCockpitCapacityStructuralFieldV1[];
const CAPACITY_OBSERVED_FIELDS = [
  "reservedVerifierSlots",
  "reservedRecoverySlots",
  "throughputPerMinute",
  "idleReasons",
] as const satisfies readonly RoomCockpitCapacityObservedFieldV1[];
const SAFE_NATIVE_SESSION_PROTOCOLS = new Set(["codex:", "claude:", "opencode:"]);
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;
const CONNECTOR_HEALTH_STATES = new Set<string>([
  "healthy",
  "degraded",
  "authentication_required",
  "rate_limited",
  "host_unavailable",
  "unavailable",
  "unknown",
]);
const CONNECTOR_HEALTH_AUTHENTICATION_STATES = new Set<string>([
  "authenticated",
  "required",
  "unknown",
]);
const CONNECTOR_HEALTH_RATE_LIMIT_STATES = new Set<string>([
  "clear",
  "limited",
  "unknown",
]);
const CONNECTOR_HEALTH_REASON_CODES = new Set<SessionConnectorHealthReasonCode>([
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
const UNAVAILABLE_SESSION_LINKS = { happierUrl: null, nativeSessionUrl: null } as const;
const UNAVAILABLE_CONNECTOR_HEALTH: RoomCockpitConnectorHealthProjectionV1 = {
  state: "unknown",
  checkedAt: null,
  authentication: "unknown",
  rateLimit: "unknown",
  reasonCodes: [],
  retryAfterMs: null,
};

const cockpitTaskStateByCanonicalState: Readonly<Record<RoomTaskNodeProjectionV1["state"], RoomCockpitTaskStateV1>> = {
  pending: "waiting_dependency",
  ready: "ready",
  running: "running",
  waiting_dependency: "waiting_dependency",
  waiting_approval: "waiting_approval",
  rate_limited: "rate_limited",
  retrying: "retrying",
  accepted: "accepted",
  blocked: "blocked",
  failed: "failed",
  cancelled: "cancelled",
};

function isTrimmedIdentifier(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= MAX_IDENTIFIER_LENGTH
    && value === value.trim();
}

function freezeDeep<T>(value: T): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) freezeDeep(child);
  return Object.freeze(value);
}

function cloneSummary(summary: RoomSummaryV1): RoomSummaryV1 {
  return freezeDeep({ ...summary });
}

function assertCanonicalSummary(summary: RoomSummaryV1, projectId: string): void {
  if (
    summary.contractVersion !== 1
    || !isTrimmedIdentifier(summary.id)
    || summary.projectId !== projectId
    || !isTrimmedIdentifier(summary.projectId)
    || typeof summary.objective !== "string"
    || typeof summary.protocolId !== "string"
    || !Number.isSafeInteger(summary.protocolVersion)
    || !Number.isSafeInteger(summary.aggregateVersion)
    || !Number.isSafeInteger(summary.membershipVersion)
    || !Number.isSafeInteger(summary.seatCount)
    || (summary.activeTurnId !== null && !isTrimmedIdentifier(summary.activeTurnId))
    || typeof summary.createdAt !== "string"
    || typeof summary.updatedAt !== "string"
  ) {
    throw new RoomControlPlaneReadServiceError(
      "room_control_plane_invalid_store_response",
      "AsyncRoomStore returned an invalid project-scoped Room summary",
    );
  }
}

function assertNextCursor(value: unknown): asserts value is string | null {
  if (value === null) return;
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_CURSOR_LENGTH) {
    throw new RoomControlPlaneReadServiceError(
      "room_control_plane_invalid_store_response",
      "AsyncRoomStore returned an invalid Room summary cursor",
    );
  }
}

function findPhase(aggregate: RoomAggregateV1): string {
  const active = aggregate.activeTurnId === null
    ? undefined
    : aggregate.turns.find((turn) => turn.id === aggregate.activeTurnId);
  if (active) return active.protocolPhaseId;
  const latest = aggregate.turns.at(-1);
  return latest?.protocolPhaseId ?? "unstarted";
}

function deriveHealth(aggregate: RoomAggregateV1): RoomCockpitProjectionV1["health"] {
  if (aggregate.room.state === "paused") {
    return { state: "paused", detail: "The canonical Room lifecycle is paused." };
  }
  if (aggregate.room.state === "blocked" || aggregate.room.state === "failed") {
    return { state: "critical", detail: `The canonical Room lifecycle is ${aggregate.room.state}.` };
  }
  if (aggregate.room.state === "partial" || aggregate.room.state === "completed_with_risks") {
    return { state: "degraded", detail: `The canonical Room lifecycle is ${aggregate.room.state}.` };
  }
  if (aggregate.bindings.some((binding) => binding.state === "failed")) {
    return { state: "critical", detail: "At least one canonical Room binding is failed." };
  }
  if (aggregate.bindings.some((binding) => (
    binding.state === "authentication_blocked"
    || binding.state === "host_unavailable"
    || binding.state === "delivery_uncertain"
  ))) {
    return { state: "degraded", detail: "At least one canonical Room binding requires recovery." };
  }
  return {
    state: "unknown",
    detail: "No independent live-health observation is available from the canonical Room aggregate.",
  };
}

function unavailableCapacityTelemetry(): RoomCockpitCapacityTelemetryUnavailableV1 {
  return {
    availability: "unavailable",
    detail: "No persistent runtime telemetry is available from the canonical Room aggregate.",
    structuralFields: [...CAPACITY_STRUCTURAL_FIELDS],
    observedFields: [...CAPACITY_OBSERVED_FIELDS],
  };
}

function mapTask(
  node: RoomTaskNodeProjectionV1,
  criticalNodeIds: ReadonlySet<string>,
  dependencyNodeIdsByTarget: ReadonlyMap<string, readonly string[]>,
): RoomCockpitProjectionV1["tasks"][number] {
  const ownerSeatId = node.assignedSeatIds?.length === 1 ? node.assignedSeatIds[0] ?? null : null;
  return {
    id: node.id,
    title: node.objective,
    state: cockpitTaskStateByCanonicalState[node.state],
    ownerSeatId,
    dependencyNodeIds: dependencyNodeIdsByTarget.get(node.id) ?? [],
    critical: criticalNodeIds.has(node.id),
    attempt: 0,
    progressSignature: node.progressSignature || null,
    inputs: [...node.inputRefs],
    outputs: [...node.outputRefs],
    gateIds: [...node.acceptanceGateIds],
    evidenceIds: [...node.acceptanceEvidenceIds],
    waitReason: node.state === "pending" ? "Awaiting a canonical task-graph transition." : null,
    nextRecoveryAction: null,
  };
}

function identityFromBinding(binding: RoomBindingRecordV1): SessionConnectorIdentityV1 {
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

function activeBindingForProjection(
  aggregate: RoomAggregateV1,
  seat: RoomSeatRecordV1,
): RoomBindingRecordV1 | null {
  if (!seat.activeBindingId) return null;
  const binding = aggregate.bindings.find((candidate) => candidate.id === seat.activeBindingId);
  return binding
    && binding.roomId === aggregate.room.id
    && binding.seatId === seat.id
    && binding.state === "attached"
    ? binding
    : null;
}

function matchesBindingIdentity(
  candidate: SessionConnectorDeepLinksV1,
  binding: RoomBindingRecordV1,
): boolean {
  return candidate.contractVersion === 1
    && candidate.bindingId === binding.id
    && candidate.connectorId === binding.connectorId
    && candidate.providerId === binding.providerId
    && candidate.nativeSessionId === binding.nativeSessionId
    && candidate.happierSessionId === binding.happierSessionId
    && candidate.serverProfileId === binding.serverProfileId
    && candidate.machineId === binding.machineId
    && candidate.hostId === binding.hostId;
}

function safeHappierUrl(value: unknown, binding: RoomBindingRecordV1): string | null {
  if (typeof value !== "string" || value.trim().length === 0) return null;
  if (!binding.happierSessionId || !binding.serverProfileId) return null;
  try {
    const parsed = new URL(value);
    const query = [...parsed.searchParams.entries()];
    const expectedPathSuffix = `/session/${encodeURIComponent(binding.happierSessionId)}`;
    return (parsed.protocol === "http:" || parsed.protocol === "https:")
      && parsed.username.length === 0
      && parsed.password.length === 0
      && parsed.hash.length === 0
      && parsed.pathname.endsWith(expectedPathSuffix)
      && query.length === 1
      && query[0]?.[0] === "serverId"
      && query[0]?.[1] === binding.serverProfileId
      ? parsed.toString()
      : null;
  } catch {
    return null;
  }
}

function safeNativeSessionUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.trim().length === 0) return null;
  try {
    const parsed = new URL(value);
    return SAFE_NATIVE_SESSION_PROTOCOLS.has(parsed.protocol)
      && parsed.username.length === 0
      && parsed.password.length === 0
      && parsed.hash.length === 0
      ? parsed.toString()
      : null;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeIsoTimestamp(value: unknown): string | null {
  return typeof value === "string"
    && ISO_TIMESTAMP.test(value)
    && Number.isFinite(Date.parse(value))
    ? value
    : null;
}

function normalizeConnectorHealth(
  value: unknown,
  binding: RoomBindingRecordV1,
): RoomCockpitConnectorHealthProjectionV1 {
  if (!isRecord(value) || value.connectorId !== binding.connectorId || value.hostId !== binding.hostId) {
    return UNAVAILABLE_CONNECTOR_HEALTH;
  }

  const state = typeof value.state === "string" && CONNECTOR_HEALTH_STATES.has(value.state)
    ? value.state as RoomCockpitConnectorHealthProjectionV1["state"]
    : null;
  const authentication = typeof value.authentication === "string"
    && CONNECTOR_HEALTH_AUTHENTICATION_STATES.has(value.authentication)
    ? value.authentication as RoomCockpitConnectorHealthProjectionV1["authentication"]
    : null;
  const rateLimit = typeof value.rateLimit === "string" && CONNECTOR_HEALTH_RATE_LIMIT_STATES.has(value.rateLimit)
    ? value.rateLimit as RoomCockpitConnectorHealthProjectionV1["rateLimit"]
    : null;
  const checkedAt = safeIsoTimestamp(value.checkedAt);
  const reasonCodes = Array.isArray(value.reasonCodes)
    && value.reasonCodes.every((reason) => typeof reason === "string" && CONNECTOR_HEALTH_REASON_CODES.has(reason as SessionConnectorHealthReasonCode))
    ? value.reasonCodes as readonly SessionConnectorHealthReasonCode[]
    : null;
  const retryAfterMs = value.retryAfterMs === null
    ? null
    : typeof value.retryAfterMs === "number" && Number.isFinite(value.retryAfterMs) && value.retryAfterMs >= 0
      ? value.retryAfterMs
      : null;

  if (!state || !authentication || !rateLimit || !checkedAt || !reasonCodes || (value.retryAfterMs !== null && retryAfterMs === null)) {
    return UNAVAILABLE_CONNECTOR_HEALTH;
  }

  return { state, checkedAt, authentication, rateLimit, reasonCodes, retryAfterMs };
}

function settleDeepLinkLookup<T>(operation: Promise<T>): Promise<T | null> {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => resolve(null), ROOM_COCKPIT_DEEP_LINK_LOOKUP_TIMEOUT_MS);
    operation.then(
      (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      () => {
        clearTimeout(timeout);
        resolve(null);
      },
    );
  });
}

type RoomCockpitSessionConnectorV1 = Pick<SessionConnectorV1, "getDeepLinks" | "getHealth">;

function connectorForBinding(
  binding: RoomBindingRecordV1,
  connectorRegistry: Pick<SessionConnectorRegistry, "tryGet"> | undefined,
): RoomCockpitSessionConnectorV1 | undefined {
  if (!connectorRegistry) return undefined;
  try {
    return connectorRegistry.tryGet(binding.connectorId);
  } catch {
    return undefined;
  }
}

async function resolveConnectorDeepLinks(
  binding: RoomBindingRecordV1,
  connector: RoomCockpitSessionConnectorV1 | undefined,
): Promise<Pick<RoomCockpitParticipantProjectionV1, "happierUrl" | "nativeSessionUrl">> {
  if (!connector || typeof connector.getDeepLinks !== "function") return UNAVAILABLE_SESSION_LINKS;
  try {
    const result = await settleDeepLinkLookup(connector.getDeepLinks({
      contractVersion: 1,
      bindingId: binding.id,
      identity: identityFromBinding(binding),
    }));
    if (result === null) return UNAVAILABLE_SESSION_LINKS;
    if (!result.ok || !matchesBindingIdentity(result.value, binding)) return UNAVAILABLE_SESSION_LINKS;
    return {
      happierUrl: safeHappierUrl(result.value.happierUrl, binding),
      nativeSessionUrl: safeNativeSessionUrl(result.value.nativeSessionUrl),
    };
  } catch {
    return UNAVAILABLE_SESSION_LINKS;
  }
}

async function resolveConnectorHealth(
  binding: RoomBindingRecordV1,
  connector: RoomCockpitSessionConnectorV1 | undefined,
): Promise<RoomCockpitConnectorHealthProjectionV1> {
  if (!connector || typeof connector.getHealth !== "function") return UNAVAILABLE_CONNECTOR_HEALTH;
  try {
    const result = await settleDeepLinkLookup(connector.getHealth(binding.hostId));
    return result === null ? UNAVAILABLE_CONNECTOR_HEALTH : normalizeConnectorHealth(result, binding);
  } catch {
    return UNAVAILABLE_CONNECTOR_HEALTH;
  }
}

/**
 * FNXC:RoomCockpitSessionLinks 2026-07-19-23:55:
 * Operators need one-click navigation from each Room seat into its existing
 * Happier or provider-native session without copying IDs between IDEs. Only a
 * connector response whose immutable identity exactly matches the active durable
 * binding is exposed; missing telemetry and every unverified link stay null.
 *
 * FNXC:RoomCockpitConnectorHealth 2026-07-19-23:59:
 * A Session link alone does not tell the operator whether its connector can
 * currently reach Happier. The cockpit therefore shows only an identity-bound,
 * bounded connector health probe. It deliberately retains unknown provider
 * account, quota, latency, context, tool, and quality facts as unavailable and
 * never upgrades this display-only result into admission authority.
 */
async function mapParticipant(
  aggregate: RoomAggregateV1,
  seat: RoomSeatRecordV1,
  connectorRegistry: Pick<SessionConnectorRegistry, "tryGet"> | undefined,
): Promise<RoomCockpitParticipantProjectionV1> {
  const binding = activeBindingForProjection(aggregate, seat);
  const connector = binding ? connectorForBinding(binding, connectorRegistry) : undefined;
  const [links, connectorHealth] = binding
    ? await Promise.all([
      resolveConnectorDeepLinks(binding, connector),
      resolveConnectorHealth(binding, connector),
    ])
    : [UNAVAILABLE_SESSION_LINKS, UNAVAILABLE_CONNECTOR_HEALTH] as const;
  return {
    seatId: seat.id,
    bindingId: binding?.id ?? null,
    nativeSessionId: binding?.nativeSessionId ?? null,
    happierSessionId: binding?.happierSessionId ?? null,
    ...links,
    connectorHealth,
    role: seat.role,
    provider: binding?.providerId ?? null,
    model: null,
    host: binding?.hostId ?? null,
    heartbeat: { freshness: "unknown", lastObservedAt: null, recoveryOwner: null },
    context: { usedTokens: null, limitTokens: null },
    throughput: { eventsPerMinute: null },
    limits: { configuredConcurrent: null, effectiveConcurrent: null },
    wait: { reason: null, retryAt: null },
    leases: {
      sender: { state: "unknown", holderId: null, expiresAt: null },
      workspace: { state: "unknown", holderId: null, expiresAt: null },
    },
  };
}

function toCockpitProjection(
  aggregate: RoomAggregateV1,
  graph: RoomTaskGraphProjectionV1,
): RoomCockpitProjectionV1 {
  const dependencyNodeIdsByTarget = new Map<string, readonly string[]>();
  for (const edge of graph.edges) {
    if (edge.kind !== "requires") continue;
    const existing = dependencyNodeIdsByTarget.get(edge.toNodeId) ?? [];
    dependencyNodeIdsByTarget.set(edge.toNodeId, [...existing, edge.fromNodeId]);
  }
  const criticalNodeIds = new Set(graph.criticalPathNodeIds);
  const runningNodes = graph.nodes.filter((node) => node.state === "running").length;
  const configuredSlots = aggregate.bindings.filter((binding) => binding.state === "attached").length;

  return {
    roomId: aggregate.room.id,
    objective: aggregate.room.objective,
    phase: findPhase(aggregate),
    health: deriveHealth(aggregate),
    completion: {
      acceptedNodes: graph.nodes.filter((node) => node.state === "accepted").length,
      total: graph.nodes.length,
      blockedNodes: graph.nodes.filter((node) => node.state === "blocked").length,
    },
    criticalPathNodeIds: [...graph.criticalPathNodeIds],
    confidence: {
      band: "unknown",
      snapshotId: "unavailable",
      dimensions: [],
    },
    capacity: {
      telemetry: unavailableCapacityTelemetry(),
      theoreticalSlots: aggregate.seats.length,
      configuredSlots,
      activeSlots: runningNodes,
      queueDepth: graph.readyNodeIds.length,
      reservedVerifierSlots: null,
      reservedRecoverySlots: null,
      utilizationRatio: configuredSlots === 0 ? 0 : runningNodes / configuredSlots,
      throughputPerMinute: null,
      idleReasons: null,
    },
    tasks: graph.nodes.map((node) => mapTask(node, criticalNodeIds, dependencyNodeIdsByTarget)),
    edges: graph.edges.map((edge) => ({
      id: edge.id,
      fromNodeId: edge.fromNodeId,
      toNodeId: edge.toNodeId,
      kind: edge.kind === "requires" ? "depends_on" : edge.kind,
    })),
    alerts: [],
    participants: [],
  };
}

/**
 * FNXC:RoomControlPlaneReadService 2026-07-19-16:05:
 * The Dashboard cockpit may consume only a project-bound, immutable projection
 * rebuilt from AsyncRoomStore. Opaque pagination remains Core-owned, and this
 * Engine seam rejects scope or version drift instead of manufacturing Rooms,
 * task telemetry, confidence, capacity, or alert records from browser state.
 *
 * FNXC:RoomControlPlaneReadService 2026-07-19-16:49:
 * Seats, bindings, and task-graph values are structural derivations, not live
 * observations. Until persistent runtime telemetry supplies provenance, capacity
 * reservations, throughput, and idle reasons remain explicitly unavailable and
 * null rather than being forged as zero or an empty collection.
 */
export class RoomControlPlaneReadService {
  private readonly projectId: string;
  private readonly roomStore: AsyncRoomStore;
  private readonly connectorRegistry: Pick<SessionConnectorRegistry, "tryGet"> | undefined;

  constructor(options: RoomControlPlaneReadServiceOptionsV1) {
    if (!isTrimmedIdentifier(options.projectId)) {
      throw new RoomControlPlaneReadServiceError(
        "room_control_plane_invalid_project_id",
        "Room control-plane reads require a bounded project identifier",
      );
    }
    this.projectId = options.projectId;
    this.roomStore = options.roomStore;
    this.connectorRegistry = options.connectorRegistry;
  }

  async listRooms(
    input: RoomControlPlaneListRoomsInputV1,
  ): Promise<RoomControlPlanePageV1<RoomSummaryV1>> {
    this.assertProjectScope(input.projectId);
    this.assertListInput(input);
    const page = await this.roomStore.listRoomSummaries({
      cursor: input.cursor ?? undefined,
      limit: input.limit ?? undefined,
    });
    assertNextCursor(page.nextCursor);
    const summaries = page.rooms.map((summary) => {
      assertCanonicalSummary(summary, this.projectId);
      return cloneSummary(summary);
    });
    return freezeDeep({ items: summaries, nextCursor: page.nextCursor });
  }

  async getRoomProjection(
    input: RoomControlPlaneRoomProjectionInputV1,
  ): Promise<RoomCockpitProjectionV1 | null> {
    this.assertProjectScope(input.projectId);
    if (!isTrimmedIdentifier(input.roomId)) {
      throw new RoomControlPlaneReadServiceError(
        "room_control_plane_invalid_room_id",
        "Room control-plane projections require a bounded Room identifier",
      );
    }
    const aggregate = await this.roomStore.getRoom(input.roomId);
    if (!aggregate) return null;
    if (aggregate.room.id !== input.roomId || aggregate.room.projectId !== this.projectId) {
      throw new RoomControlPlaneReadServiceError(
        "room_control_plane_projection_scope_violation",
        "AsyncRoomStore returned a Room outside the requested project scope",
      );
    }
    const graph = await this.roomStore.getTaskGraph(input.roomId);
    if (!graph) return null;
    if (
      graph.roomId !== input.roomId
      || graph.aggregateVersion !== aggregate.room.aggregateVersion
    ) {
      throw new RoomControlPlaneReadServiceError(
        "room_control_plane_projection_version_conflict",
        "Canonical Room and task-graph projections do not share an aggregate version",
      );
    }
    const structuralProjection = toCockpitProjection(aggregate, graph);
    const participants = await Promise.all(
      aggregate.seats
        .filter((seat) => seat.state !== "removed")
        .map((seat) => mapParticipant(aggregate, seat, this.connectorRegistry)),
    );
    return freezeDeep({ ...structuralProjection, participants });
  }

  private assertProjectScope(projectId: string): void {
    if (!isTrimmedIdentifier(projectId) || projectId !== this.projectId) {
      throw new RoomControlPlaneReadServiceError(
        "room_control_plane_project_scope_mismatch",
        "Room control-plane reads cannot cross project scope",
      );
    }
  }

  private assertListInput(input: RoomControlPlaneListRoomsInputV1): void {
    if (
      input.cursor !== null
      && (typeof input.cursor !== "string" || input.cursor.length === 0 || input.cursor.length > MAX_CURSOR_LENGTH || input.cursor !== input.cursor.trim())
    ) {
      throw new RoomControlPlaneReadServiceError(
        "room_control_plane_invalid_cursor",
        "Room control-plane cursors must be bounded opaque strings",
      );
    }
    if (
      input.limit !== null
      && (!Number.isSafeInteger(input.limit) || input.limit < 1)
    ) {
      throw new RoomControlPlaneReadServiceError(
        "room_control_plane_invalid_limit",
        "Room control-plane list limits must be positive safe integers",
      );
    }
  }
}
