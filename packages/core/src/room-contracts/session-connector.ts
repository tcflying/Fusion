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

export type SessionConnectorCapabilityName = (typeof SESSION_CONNECTOR_CAPABILITIES)[number];
export type SessionConnectorMutatingCapabilityName =
  | "ensureExisting"
  | "create"
  | "send"
  | "interrupt"
  | "resume"
  | "takeover";
export type SessionConnectorCapabilityState = "verified" | "degraded" | "unavailable" | "unverified";

export interface SessionConnectorCapabilityCertificationV1 {
  readonly state: SessionConnectorCapabilityState;
  readonly evidenceRef: string | null;
  readonly reason?: string;
  readonly lastVerifiedAt?: IsoTimestamp;
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
  readonly idempotencyKey: string;
  readonly content: string;
  readonly contentHash: ContentHash;
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
  readonly state: "healthy" | "degraded" | "authentication_required" | "unavailable";
  readonly checkedAt: IsoTimestamp;
  readonly safeReason: string | null;
  readonly retryAfterMs: number | null;
}

export interface SessionConnectorDeepLinksV1 {
  readonly happierUrl: string | null;
  readonly nativeSessionUrl: string | null;
}

export interface SessionConnectorV1 {
  readonly contractVersion: SessionConnectorContractVersion;
  readonly id: SessionConnectorId;
  readonly version: string;
  getCapabilities(identity?: SessionConnectorIdentityV1): Promise<SessionConnectorCapabilitiesV1>;
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
  getDeepLinks(identity: SessionConnectorIdentityV1): Promise<SessionConnectorResultV1<SessionConnectorDeepLinksV1>>;
}
