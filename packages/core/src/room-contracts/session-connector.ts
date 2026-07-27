import type {
  ContentHash,
  EventCursor,
  IsoTimestamp,
  RoomBindingId,
  RoomMessageId,
  SessionConnectorId,
} from "./ids.js";
import type { SessionConnectorContractVersion } from "./versions.js";

export const SESSION_CONNECTOR_CAPABILITIES = [
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
] as const;

/** Cross-connector upper bound for one reconciliation read. */
export const SESSION_CONNECTOR_HISTORY_PAGE_LIMIT = 250;

/** Default freshness window for a health sample that can authorize mutation. */
export const SESSION_CONNECTOR_HEALTH_MAX_AGE_MS = 30_000;

/** Maximum accepted forward clock skew for connector health samples. */
export const SESSION_CONNECTOR_HEALTH_MAX_FUTURE_SKEW_MS = 5_000;

/** One-week hard bound for a connector-provided retry delay. */
export const SESSION_CONNECTOR_HEALTH_MAX_RETRY_AFTER_MS = 604_800_000;

export type SessionConnectorCapabilityName = (typeof SESSION_CONNECTOR_CAPABILITIES)[number];
export const SESSION_CONNECTOR_MUTATING_CAPABILITIES = [
  "ensureExisting",
  "create",
  "send",
  "interrupt",
  "resume",
  "takeover",
] as const satisfies readonly SessionConnectorCapabilityName[];
export type SessionConnectorMutatingCapabilityName =
  (typeof SESSION_CONNECTOR_MUTATING_CAPABILITIES)[number];
export type SessionConnectorCapabilityState = "verified" | "degraded" | "unavailable" | "unverified";

export const SESSION_CONNECTOR_CAPABILITY_REASON_CODES = [
  "pending_provider_certification",
  "operation_unavailable",
  "server_profile_mismatch",
  "runtime_degraded",
  "source_unverified",
] as const;
export type SessionConnectorCapabilityReasonCode =
  (typeof SESSION_CONNECTOR_CAPABILITY_REASON_CODES)[number];

export interface SessionConnectorCapabilityCertificationV1 {
  readonly state: SessionConnectorCapabilityState;
  readonly evidenceRef: string | null;
  readonly reasonCode: SessionConnectorCapabilityReasonCode | null;
  readonly lastVerifiedAt: IsoTimestamp | null;
}

export interface SessionConnectorCapabilitiesV1 {
  readonly contractVersion: SessionConnectorContractVersion;
  readonly connectorId: SessionConnectorId;
  readonly connectorVersion: string;
  readonly sourceRevision: string;
  readonly verifiedAt: IsoTimestamp;
  readonly capabilities: Readonly<Record<SessionConnectorCapabilityName, SessionConnectorCapabilityCertificationV1>>;
}

/*
FNXC:SessionConnectorContract 2026-07-17-02:55:
Room orchestration never assumes provider parity. Mutating actions fail closed
unless the concrete connector operation is currently certified as verified;
degraded, unavailable, and unverified are observable states, not success.
*/
export function isSessionConnectorMutationCertified(
  certification: SessionConnectorCapabilitiesV1,
  capability: SessionConnectorMutatingCapabilityName,
): boolean {
  return certification.capabilities[capability].state === "verified";
}

export interface SessionConnectorIdentityV1 {
  readonly connectorId: SessionConnectorId;
  readonly providerId: string;
  readonly nativeSessionId: string;
  readonly happierSessionId: string | null;
  readonly serverProfileId: string | null;
  readonly machineId: string | null;
  readonly hostId: string;
}

/**
 * FNXC:SessionConnectorWriteAuthorization 2026-07-20-11:46:
 * A connector-side external send may be authorized only from an already-claimed
 * durable Room outbox item and the exact active sender fence. This is optional
 * on the generic send contract because legacy connectors do not implement the
 * host-authorizer seam; connectors that do implement it must fail closed when
 * it is absent or malformed.
 */
export interface SessionConnectorDeliveryAuthorizationV1 {
  readonly outboxId: string;
  readonly senderFence: {
    readonly leaseId: string;
    readonly roomId: string;
    readonly kind: "sender";
    readonly resourceId: string;
    readonly holderId: string;
    readonly hostId: string;
    readonly expectedEpoch: number;
  };
}

export interface SessionConnectorWriteAuthorizationRequestV1 {
  readonly contractVersion: 1;
  readonly connectorId: SessionConnectorId;
  readonly operation: "send" | "interrupt";
  readonly identity: SessionConnectorIdentityV1;
  /**
   * FNXC:SessionConnectorWriteScope 2026-07-20-22:05:
   * The host authorizer must certify the same immutable target and durable
   * message scope that the connector will use before it opens provider I/O.
   * `canonicalSessionUri` and `scopeFingerprint` remain optional only during
   * adapter migration; scope-certifying implementations deny their absence or
   * a malformed value.
   */
  readonly canonicalSessionUri?: string;
  readonly bindingId: RoomBindingId | null;
  readonly logicalMessageId: RoomMessageId | null;
  readonly localMessageId: string | null;
  readonly idempotencyKey: string;
  readonly contentHash: ContentHash | null;
  /** Exact reason for an interrupt; null for a content-addressed send. */
  readonly reason: string | null;
  readonly deliveryAuthorization: SessionConnectorDeliveryAuthorizationV1 | null;
  /**
   * Connector-generated digest over the immutable target, binding, durable
   * delivery, and message scope. Optional during adapter migration; a
   * scope-certifying authorizer MUST deny absence or a digest mismatch.
   */
  readonly scopeFingerprint?: string;
}

export type SessionConnectorWriteAuthorizationDecisionV1 =
  | Readonly<{
    readonly authorized: true;
    readonly authorizationId: string;
    /** Exact scope digest certified by the host-owned authorizer. */
    readonly scopeFingerprint: string;
  }>
  | Readonly<{ readonly authorized: false }>;

/** Host-owned verifier injected only while constructing a Session Connector. */
export interface SessionConnectorWriteAuthorizerV1 {
  authorize(
    request: SessionConnectorWriteAuthorizationRequestV1,
  ): Promise<SessionConnectorWriteAuthorizationDecisionV1>;
}

export interface SessionConnectorErrorV1 {
  readonly code:
    | "unavailable"
    | "unverified"
    | "degraded"
    | "invalid_request"
    | "authentication_required"
    | "not_found"
    | "ambiguous"
    | "host_unavailable"
    | "rate_limited"
    | "conflict"
    | "transport"
    | "delivery_uncertain"
    | "internal";
  readonly message: string;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;
  readonly safeDetails?: Readonly<Record<string, unknown>>;
}

export type SessionConnectorResultV1<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: SessionConnectorErrorV1 };

export interface SessionConnectorEnsureExistingRequestV1 {
  readonly contractVersion: SessionConnectorContractVersion;
  readonly canonicalSessionUri: string;
  readonly requiredHostId?: string;
  readonly requiredMachineId?: string;
  readonly idempotencyKey: string;
}

export interface SessionConnectorEnsureExistingResultV1 {
  readonly identity: SessionConnectorIdentityV1;
  readonly createdLink: boolean;
  readonly providerTurnStarted: false;
  readonly attachedAt: IsoTimestamp;
  readonly capabilities: SessionConnectorCapabilitiesV1;
}

/**
 * A read-only identity probe for an already-known native Session. Unlike
 * `ensureExisting`, this operation MUST NOT create a local link, mutate
 * provider history, acquire a sender lease, or start a provider turn.
 */
export interface SessionConnectorPreflightExistingRequestV1 {
  readonly contractVersion: SessionConnectorContractVersion;
  readonly canonicalSessionUri: string;
  readonly requiredHostId: string;
  readonly requiredMachineId?: string;
}

/**
 * The connector-certified result of a read-only existing-Session probe. It
 * deliberately contains no inferred account, quota, context, latency, tool,
 * or quality facts; callers must obtain those through their dedicated
 * authority boundaries.
 */
export interface SessionConnectorPreflightExistingResultV1 {
  readonly identity: SessionConnectorIdentityV1;
  readonly providerTurnStarted: false;
  readonly checkedAt: IsoTimestamp;
  readonly capabilities: SessionConnectorCapabilitiesV1;
}

export interface SessionConnectorCreateRequestV1 {
  readonly contractVersion: SessionConnectorContractVersion;
  readonly providerId: string;
  readonly modelId?: string;
  readonly accountId?: string;
  readonly hostId: string;
  readonly workingDirectory: string;
  readonly idempotencyKey: string;
}

export interface SessionConnectorStatusV1 {
  readonly identity: SessionConnectorIdentityV1;
  readonly state: "idle" | "running" | "waiting_input" | "paused" | "lost" | "unknown";
  readonly lastActivityAt: IsoTimestamp | null;
  readonly connectorCursor: EventCursor | null;
  readonly nativeWriterDetected: boolean;
}

export interface SessionConnectorHistoryRequestV1 {
  readonly contractVersion: SessionConnectorContractVersion;
  readonly identity: SessionConnectorIdentityV1;
  readonly afterCursor: EventCursor | null;
  readonly limit: number;
}

export interface SessionConnectorHistoryItemV1 {
  readonly nativeMessageId: string;
  readonly logicalMessageId: RoomMessageId | null;
  readonly role: "user" | "assistant" | "tool" | "system" | "unknown";
  readonly contentHash: ContentHash;
  readonly occurredAt: IsoTimestamp;
  readonly cursor: EventCursor;
}

export interface SessionConnectorHistoryPageV1 {
  readonly items: readonly SessionConnectorHistoryItemV1[];
  readonly nextCursor: EventCursor | null;
  readonly completeThroughCursor: EventCursor | null;
  /** True when an official provider byte/item bound indicates more history remains. */
  readonly truncated?: boolean;
}

export interface SessionConnectorEventV1 {
  readonly connectorEventId: string;
  readonly identity: SessionConnectorIdentityV1;
  readonly eventType: "message" | "status" | "writer_takeover" | "gap" | "health";
  readonly cursor: EventCursor;
  readonly occurredAt: IsoTimestamp;
  readonly payload: Readonly<Record<string, unknown>>;
}

export interface SessionConnectorSendRequestV1 {
  readonly contractVersion: SessionConnectorContractVersion;
  readonly bindingId: RoomBindingId;
  readonly identity: SessionConnectorIdentityV1;
  readonly logicalMessageId: RoomMessageId;
  readonly localMessageId: string;
  readonly idempotencyKey: string;
  readonly content: string;
  readonly contentHash: ContentHash;
  /** Exact durable outbox and sender-fence proof when a connector requires host authorization. */
  readonly deliveryAuthorization?: SessionConnectorDeliveryAuthorizationV1;
}

export interface SessionConnectorSendReceiptV1 {
  readonly outcome: "accepted" | "confirmed" | "delivery_uncertain" | "rejected";
  readonly connectorAcknowledgementId: string | null;
  readonly nativeMessageId: string | null;
  readonly cursor: EventCursor | null;
  readonly acceptedAt: IsoTimestamp | null;
}

export interface SessionConnectorControlRequestV1 {
  readonly contractVersion: SessionConnectorContractVersion;
  readonly identity: SessionConnectorIdentityV1;
  readonly idempotencyKey: string;
  readonly reason: string;
}

export interface SessionConnectorControlResultV1 {
  readonly state: "accepted" | "completed" | "unavailable" | "failed";
  readonly connectorAcknowledgementId: string | null;
}

export interface SessionConnectorHealthV1 {
  readonly connectorId: SessionConnectorId;
  readonly hostId: string;
  readonly state:
    | "healthy"
    | "degraded"
    | "authentication_required"
    | "rate_limited"
    | "host_unavailable"
    | "unavailable";
  readonly checkedAt: IsoTimestamp;
  readonly authentication: "authenticated" | "required" | "unknown";
  readonly daemon: "running" | "stopped" | "not_applicable" | "unknown";
  readonly server: "reachable" | "unreachable" | "not_applicable" | "unknown";
  readonly backend: "ready" | "unavailable" | "not_applicable" | "unknown";
  readonly rateLimit: "clear" | "limited" | "unknown";
  readonly host: "reachable" | "unavailable" | "mismatch" | "unknown";
  readonly capabilities: Readonly<Record<SessionConnectorCapabilityName, SessionConnectorCapabilityState>>;
  readonly reasonCodes: readonly SessionConnectorHealthReasonCode[];
  readonly retryAfterMs: number | null;
}

export const SESSION_CONNECTOR_RUNTIME_SNAPSHOT_CONTRACT_VERSION = 1 as const;

/**
 * A connector may expose this separately from SessionConnectorV1 when it can
 * read one atomic runtime snapshot. The snapshot is deliberately not an
 * account, quota, performance, or quality grant: consumers must honor the
 * declared coverage before using any field for admission.
 */
export interface SessionConnectorRuntimeSnapshotV1 {
  readonly contractVersion: typeof SESSION_CONNECTOR_RUNTIME_SNAPSHOT_CONTRACT_VERSION;
  readonly source: "connector_native_snapshot" | "connector_local_extension";
  readonly identity: SessionConnectorIdentityV1;
  readonly snapshotId: string;
  readonly revision: number;
  readonly capturedAt: IsoTimestamp;
  readonly expiresAt: IsoTimestamp;
  readonly providerId: string;
  readonly modelId: string;
  readonly modelObservedAt: IsoTimestamp;
  readonly accountId: null;
  readonly coverage: Readonly<{
    readonly providerModel: "observed";
    readonly providerAccount: "not_reported";
    readonly providerQuota: "not_reported";
    readonly latency: "not_reported";
    readonly context: "not_reported";
    readonly tools: "not_reported";
    readonly quality: "not_reported";
  }>;
}

/** Optional capability so pre-existing connector implementations remain valid. */
export interface SessionConnectorRuntimeSnapshotSourceV1 {
  getRuntimeSnapshot(
    identity: SessionConnectorIdentityV1,
  ): Promise<SessionConnectorResultV1<SessionConnectorRuntimeSnapshotV1>>;
}

export const SESSION_CONNECTOR_PROVIDER_TELEMETRY_CONTRACT_VERSION = 1 as const;

export const SESSION_CONNECTOR_PROVIDER_TELEMETRY_WITHHELD_REASONS = [
  "connector_telemetry_unsupported",
  "telemetry_timeout",
  "telemetry_unavailable",
  "telemetry_contract_invalid",
  "telemetry_stale",
] as const;
export type SessionConnectorProviderTelemetryWithheldReasonV1 =
  (typeof SESSION_CONNECTOR_PROVIDER_TELEMETRY_WITHHELD_REASONS)[number];

/**
 * FNXC:SessionConnectorProviderTelemetry 2026-07-21-02:57:
 * Existing-Session preflight may expose only an expiring, persisted in-band
 * Codex provider observation. This optional read-only mixin never permits
 * Room creation, dispatch, send, or admission, and it withholds account,
 * capacity, raw snapshot, and on-demand refresh data.
 */
export interface SessionConnectorProviderTelemetryReportedV1 {
  readonly contractVersion: typeof SESSION_CONNECTOR_PROVIDER_TELEMETRY_CONTRACT_VERSION;
  readonly state: "reported";
  readonly identity: SessionConnectorIdentityV1;
  readonly providerId: "codex";
  readonly source: "happier_persisted_in_band_provider_snapshot";
  readonly observedAt: IsoTimestamp;
  readonly expiresAt: IsoTimestamp;
  readonly freshness: "fresh";
  readonly limitations: Readonly<{
    readonly providerAvailability: "not_inferred";
    readonly capacity: "not_reported";
    readonly onDemandProviderRefresh: "not_attempted";
    readonly accountIdentity: "not_reported";
    readonly rawSnapshot: "not_reported";
  }>;
}

export interface SessionConnectorProviderTelemetryWithheldV1 {
  readonly contractVersion: typeof SESSION_CONNECTOR_PROVIDER_TELEMETRY_CONTRACT_VERSION;
  readonly state: "withheld";
  readonly identity: SessionConnectorIdentityV1;
  readonly reason: SessionConnectorProviderTelemetryWithheldReasonV1;
}

export type SessionConnectorProviderTelemetryV1 =
  | SessionConnectorProviderTelemetryReportedV1
  | SessionConnectorProviderTelemetryWithheldV1;

export interface SessionConnectorProviderTelemetrySourceV1 {
  getProviderTelemetry(
    identity: SessionConnectorIdentityV1,
  ): Promise<SessionConnectorResultV1<SessionConnectorProviderTelemetryV1>>;
}

export const SESSION_CONNECTOR_HEALTH_REASON_CODES = [
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
  "backend_machine_availability_unverified",
  "cli_attestation_failed",
  "rate_limited",
  "host_unavailable",
  "capability_not_verified",
  "probe_failed",
] as const;
export type SessionConnectorHealthReasonCode =
  (typeof SESSION_CONNECTOR_HEALTH_REASON_CODES)[number];

export interface SessionConnectorDeepLinksRequestV1 {
  readonly contractVersion: SessionConnectorContractVersion;
  readonly bindingId: RoomBindingId;
  readonly identity: SessionConnectorIdentityV1;
}

export interface SessionConnectorDeepLinksV1 {
  readonly contractVersion: SessionConnectorContractVersion;
  readonly bindingId: RoomBindingId;
  readonly connectorId: SessionConnectorId;
  readonly providerId: string;
  readonly nativeSessionId: string;
  readonly happierSessionId: string | null;
  readonly serverProfileId: string | null;
  readonly machineId: string | null;
  readonly hostId: string;
  readonly happierUrl: string | null;
  readonly nativeSessionUrl: string | null;
}

export interface SessionConnectorV1 {
  readonly contractVersion: SessionConnectorContractVersion;
  readonly id: SessionConnectorId;
  readonly version: string;
  getCapabilities(identity?: SessionConnectorIdentityV1): Promise<SessionConnectorCapabilitiesV1>;
  /**
   * Optional while adapters migrate. When present it is a strictly read-only
   * companion to `ensureExisting`, intended for Cockpit import preflight.
   */
  preflightExisting?(
    input: SessionConnectorPreflightExistingRequestV1,
  ): Promise<SessionConnectorResultV1<SessionConnectorPreflightExistingResultV1>>;
  ensureExisting(input: SessionConnectorEnsureExistingRequestV1): Promise<SessionConnectorResultV1<SessionConnectorEnsureExistingResultV1>>;
  create(input: SessionConnectorCreateRequestV1): Promise<SessionConnectorResultV1<SessionConnectorIdentityV1>>;
  getStatus(identity: SessionConnectorIdentityV1): Promise<SessionConnectorResultV1<SessionConnectorStatusV1>>;
  readHistory(input: SessionConnectorHistoryRequestV1): Promise<SessionConnectorResultV1<SessionConnectorHistoryPageV1>>;
  subscribeEvents(identity: SessionConnectorIdentityV1): Promise<SessionConnectorResultV1<AsyncIterable<SessionConnectorEventV1>>>;
  send(input: SessionConnectorSendRequestV1): Promise<SessionConnectorResultV1<SessionConnectorSendReceiptV1>>;
  interrupt(input: SessionConnectorControlRequestV1): Promise<SessionConnectorResultV1<SessionConnectorControlResultV1>>;
  resume(input: SessionConnectorControlRequestV1): Promise<SessionConnectorResultV1<SessionConnectorControlResultV1>>;
  takeover(input: SessionConnectorControlRequestV1): Promise<SessionConnectorResultV1<SessionConnectorControlResultV1>>;
  getHealth(hostId: string): Promise<SessionConnectorHealthV1>;
  getDeepLinks(input: SessionConnectorDeepLinksRequestV1): Promise<SessionConnectorResultV1<SessionConnectorDeepLinksV1>>;
}
