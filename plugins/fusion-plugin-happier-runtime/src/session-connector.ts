import {
  hashRoomValue,
  type SessionConnectorCapabilitiesV1,
  type SessionConnectorControlRequestV1,
  type SessionConnectorControlResultV1,
  type SessionConnectorCreateRequestV1,
  type SessionConnectorDeepLinksV1,
  type SessionConnectorEnsureExistingRequestV1,
  type SessionConnectorEnsureExistingResultV1,
  type SessionConnectorEventV1,
  type SessionConnectorHealthV1,
  type SessionConnectorHistoryItemV1,
  type SessionConnectorHistoryPageV1,
  type SessionConnectorHistoryRequestV1,
  type SessionConnectorIdentityV1,
  type SessionConnectorResultV1,
  type SessionConnectorSendReceiptV1,
  type SessionConnectorSendRequestV1,
  type SessionConnectorStatusV1,
  type SessionConnectorV1,
} from "@fusion/core";

import {
  ensureHappierDirectSession,
  getHappierSessionHistory,
  getHappierSessionStatus,
  sendHappierMessage,
} from "./cli-spawn.js";
import { probeHappierRuntime } from "./probe.js";
import {
  HappierCliError,
  type HappierCliSettings,
  type HappierRawHistoryRow,
  type HappierSessionStatusResult,
} from "./types.js";

export const HAPPIER_SESSION_CONNECTOR_ID = "happier";
export const HAPPIER_SESSION_CONNECTOR_VERSION = "0.2.73";
export const HAPPIER_DIRECT_SESSION_SOURCE_REVISION = "2bcd6c170669b623086c84da218ac753b63c4fbf";

const HISTORY_CURSOR_PREFIX = "happier-history-v1:";
const HISTORY_RECONCILIATION_LIMIT = 250;
const DEFAULT_SEND_TIMEOUT_SECONDS = 300;

export interface HappierSessionConnectorDependencies {
  readonly ensureDirectSession: typeof ensureHappierDirectSession;
  readonly getSessionStatus: typeof getHappierSessionStatus;
  readonly getSessionHistory: typeof getHappierSessionHistory;
  readonly sendMessage: typeof sendHappierMessage;
  readonly probeRuntime: typeof probeHappierRuntime;
}

export interface HappierSessionConnectorOptions {
  readonly settings?: HappierCliSettings;
  readonly version?: string;
  readonly sourceRevision?: string;
  readonly sendTimeoutSeconds?: number;
  readonly now?: () => string;
  readonly dependencies?: Partial<HappierSessionConnectorDependencies>;
}

const defaultDependencies: HappierSessionConnectorDependencies = {
  ensureDirectSession: ensureHappierDirectSession,
  getSessionStatus: getHappierSessionStatus,
  getSessionHistory: getHappierSessionHistory,
  sendMessage: sendHappierMessage,
  probeRuntime: probeHappierRuntime,
};

function unavailableCertification(reason: string) {
  return { state: "unavailable" as const, evidenceRef: null, reason };
}

function unverifiedCertification(reason: string) {
  return { state: "unverified" as const, evidenceRef: null, reason };
}

function failure<T>(
  code: Parameters<typeof connectorError>[0],
  message: string,
  retryable: boolean,
  safeDetails?: Readonly<Record<string, unknown>>,
): SessionConnectorResultV1<T> {
  return { ok: false, error: connectorError(code, message, retryable, safeDetails) };
}

function connectorError(
  code: "unavailable" | "unverified" | "degraded" | "invalid_request" | "authentication_required" | "not_found" | "ambiguous" | "host_unavailable" | "rate_limited" | "conflict" | "transport" | "delivery_uncertain" | "internal",
  message: string,
  retryable: boolean,
  safeDetails?: Readonly<Record<string, unknown>>,
) {
  return { code, message, retryable, ...(safeDetails ? { safeDetails } : {}) } as const;
}

function safeCliDetails(error: HappierCliError): Readonly<Record<string, unknown>> {
  const officialCode = typeof error.officialCode === "string"
    && /^[A-Za-z0-9_-]{1,64}$/u.test(error.officialCode)
    ? error.officialCode
    : undefined;
  return {
    source: "happier_cli",
    category: error.code,
    ...(officialCode ? { officialCode } : {}),
  };
}

function mapReadFailure<T>(error: unknown): SessionConnectorResultV1<T> {
  if (!(error instanceof HappierCliError)) {
    return failure("internal", "Happier connector operation failed", false);
  }
  const details = safeCliDetails(error);
  if (error.code === "authentication") {
    return failure("authentication_required", "Happier authentication is required", false, details);
  }
  if (error.officialCode === "session_not_found" || error.officialCode === "candidate_not_found") {
    return failure("not_found", "The requested native Session was not found", false, details);
  }
  if (error.officialCode === "candidate_ambiguous") {
    return failure("ambiguous", "The requested native Session was ambiguous", false, details);
  }
  if (error.officialCode === "machine_mismatch") {
    return failure("conflict", "The requested Session belongs to another machine", false, details);
  }
  if (error.officialCode === "invalid_uri") {
    return failure("invalid_request", "The native Session URI is invalid", false, details);
  }
  if (error.officialCode && /rate|quota|too_many_requests/iu.test(error.officialCode)) {
    return failure("rate_limited", "Happier rate limited the connector operation", true, details);
  }
  if (error.code === "daemon" || error.code === "backend") {
    return failure("unavailable", "The Happier daemon or provider backend is unavailable", true, details);
  }
  if (error.code === "timeout" || error.code === "server" || error.code === "process") {
    return failure("transport", "Happier connector transport failed", true, details);
  }
  if (error.code === "session") {
    return failure("not_found", "The Happier Session is unavailable", false, details);
  }
  return failure("degraded", "Happier returned an invalid connector response", false, details);
}

function validateIdentity(
  identity: SessionConnectorIdentityV1,
): SessionConnectorResultV1<string> {
  if (identity.connectorId !== HAPPIER_SESSION_CONNECTOR_ID) {
    return failure("conflict", "Session identity belongs to a different connector", false);
  }
  if (!identity.happierSessionId?.trim()) {
    return failure("invalid_request", "A Happier Session identity is required", false);
  }
  return { ok: true, value: identity.happierSessionId };
}

function readStatusValue(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  for (const key of ["status", "state"] as const) {
    const candidate = record[key];
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
  }
  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function statusState(result: HappierSessionStatusResult): SessionConnectorStatusV1["state"] {
  const session = result.session;
  const agentState = asRecord(result.agentState);
  const raw = (readStatusValue(agentState) ?? readStatusValue(session))?.toLowerCase();
  if (raw === "waiting" || raw === "waitingoninput" || raw === "awaiting_input" || raw === "waiting_input") {
    return "waiting_input";
  }
  if (raw === "running" || raw === "active" || raw === "busy" || raw === "starting" || raw === "recovering") {
    return "running";
  }
  if (raw === "paused" || raw === "blocked") return "paused";
  if (raw === "failed" || raw === "error" || raw === "lost" || raw === "unavailable") return "lost";
  if (agentState?.controlledByUser === true) return "waiting_input";
  if (typeof agentState?.pendingRequestsCount === "number" && agentState.pendingRequestsCount > 0) return "running";
  if (session.active === false) return "lost";
  if (session.active === true) return "idle";
  return "unknown";
}

function isoTimestamp(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? date.toISOString() : null;
  }
  if (typeof value === "string" && value.trim()) {
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? date.toISOString() : null;
  }
  return null;
}

function statusLastActivity(result: HappierSessionStatusResult): string | null {
  const agentState = asRecord(result.agentState);
  for (const value of [
    result.session.lastActivityAt,
    result.session.updatedAt,
    agentState?.lastActivityAt,
    agentState?.updatedAt,
    result.lastActivityAt,
    result.updatedAt,
  ]) {
    const parsed = isoTimestamp(value);
    if (parsed) return parsed;
  }
  return null;
}

function historyRole(role: string): SessionConnectorHistoryItemV1["role"] {
  const normalized = role.trim().toLowerCase();
  if (normalized === "user" || normalized === "human") return "user";
  if (normalized === "assistant" || normalized === "agent" || normalized === "ai") return "assistant";
  if (normalized === "tool" || normalized === "function") return "tool";
  if (normalized === "system") return "system";
  return "unknown";
}

function historyCursor(nativeMessageId: string): string {
  return `${HISTORY_CURSOR_PREFIX}${Buffer.from(nativeMessageId, "utf8").toString("base64url")}`;
}

function mapHistoryRow(row: HappierRawHistoryRow): SessionConnectorHistoryItemV1 | null {
  if (
    typeof row.id !== "string"
    || row.id.trim().length === 0
    || typeof row.role !== "string"
    || !Number.isFinite(row.createdAt)
    || !asRecord(row.raw)
  ) {
    return null;
  }
  const occurredAt = isoTimestamp(row.createdAt);
  if (!occurredAt) return null;
  return {
    nativeMessageId: row.id,
    logicalMessageId: typeof row.localId === "string" && row.localId.trim() ? row.localId : null,
    role: historyRole(row.role),
    contentHash: hashRoomValue(row.raw),
    occurredAt,
    cursor: historyCursor(row.id),
  };
}

function unavailableResult<T>(operation: string): SessionConnectorResultV1<T> {
  return failure(
    "unavailable",
    `Happier connector ${operation} is not available on a reviewed public surface`,
    false,
  );
}

/**
 * Provider-neutral adapter over the reviewed, shell-free Happier JSON CLI.
 *
 * FNXC:HappierSessionConnector 2026-07-17-05:12:
 * The provider's `remoteSessionId`, Happier's linked `sessionId`, server,
 * machine, and Fusion host are distinct immutable identities. Content crosses
 * only the send boundary; history projections retain hashes and cursors, and
 * capability states remain fail-closed until provider-specific certification.
 */
export class HappierSessionConnector implements SessionConnectorV1 {
  readonly contractVersion = 1 as const;
  readonly id = HAPPIER_SESSION_CONNECTOR_ID;
  readonly version: string;

  private readonly settings: HappierCliSettings;
  private readonly sourceRevision: string;
  private readonly sendTimeoutSeconds: number;
  private readonly now: () => string;
  private readonly dependencies: HappierSessionConnectorDependencies;

  constructor(options: HappierSessionConnectorOptions = {}) {
    this.settings = { ...(options.settings ?? {}) };
    this.version = options.version?.trim() || HAPPIER_SESSION_CONNECTOR_VERSION;
    this.sourceRevision = options.sourceRevision?.trim() || HAPPIER_DIRECT_SESSION_SOURCE_REVISION;
    this.sendTimeoutSeconds = options.sendTimeoutSeconds ?? DEFAULT_SEND_TIMEOUT_SECONDS;
    if (!Number.isInteger(this.sendTimeoutSeconds) || this.sendTimeoutSeconds <= 0) {
      throw new Error("Happier Session Connector sendTimeoutSeconds must be a positive integer");
    }
    this.now = options.now ?? (() => new Date().toISOString());
    this.dependencies = { ...defaultDependencies, ...(options.dependencies ?? {}) };
  }

  async getCapabilities(_identity?: SessionConnectorIdentityV1): Promise<SessionConnectorCapabilitiesV1> {
    const pendingCertification = "Pending provider-specific source and runtime certification";
    return {
      contractVersion: 1,
      connectorId: this.id,
      connectorVersion: this.version,
      sourceRevision: this.sourceRevision,
      verifiedAt: this.now(),
      capabilities: {
        ensureExisting: unverifiedCertification(pendingCertification),
        create: unavailableCertification("Creation does not yet return both provider-native and Happier identities"),
        status: unverifiedCertification(pendingCertification),
        history: unverifiedCertification(pendingCertification),
        events: unavailableCertification("Event subscription is implemented in a later connector phase"),
        send: unverifiedCertification(pendingCertification),
        interrupt: unavailableCertification("No reviewed interrupt surface is wired"),
        resume: unavailableCertification("No reviewed resume surface is wired"),
        takeover: unavailableCertification("No reviewed takeover surface is wired"),
        health: unverifiedCertification(pendingCertification),
        deepLinks: unavailableCertification("Verified deep-link construction is implemented in a later connector phase"),
      },
    };
  }

  async ensureExisting(
    input: SessionConnectorEnsureExistingRequestV1,
  ): Promise<SessionConnectorResultV1<SessionConnectorEnsureExistingResultV1>> {
    if (
      input.contractVersion !== 1
      || !input.canonicalSessionUri.trim()
      || !input.idempotencyKey.trim()
    ) {
      return failure("invalid_request", "A canonical Session URI and idempotency key are required", false);
    }
    let requestedProviderId: string;
    let requestedNativeSessionId: string;
    try {
      const uri = new URL(input.canonicalSessionUri);
      requestedProviderId = uri.protocol.slice(0, -1);
      requestedNativeSessionId = decodeURIComponent(uri.pathname.slice(1));
      if (!requestedProviderId || !requestedNativeSessionId) throw new Error("invalid URI identity");
    } catch {
      return failure("invalid_request", "The canonical native Session URI is invalid", false);
    }

    try {
      const ensured = await this.dependencies.ensureDirectSession({
        uri: input.canonicalSessionUri,
        ...(input.requiredMachineId ? { machineId: input.requiredMachineId } : {}),
        settings: this.settings,
      });
      if (
        ensured.providerId !== requestedProviderId
        || ensured.remoteSessionId !== requestedNativeSessionId
      ) {
        return failure("conflict", "Happier returned a different provider-native Session identity", false);
      }
      if (input.requiredMachineId && ensured.machineId !== input.requiredMachineId) {
        return failure("conflict", "Happier linked the Session on a different machine", false);
      }
      const identity: SessionConnectorIdentityV1 = {
        connectorId: this.id,
        providerId: ensured.providerId,
        nativeSessionId: ensured.remoteSessionId,
        happierSessionId: ensured.sessionId,
        serverProfileId: ensured.serverId,
        machineId: ensured.machineId,
        hostId: input.requiredHostId?.trim() || ensured.machineId,
      };
      return {
        ok: true,
        value: {
          identity,
          createdLink: ensured.created,
          providerTurnStarted: false,
          attachedAt: this.now(),
          capabilities: await this.getCapabilities(identity),
        },
      };
    } catch (error) {
      return mapReadFailure(error);
    }
  }

  async create(
    _input: SessionConnectorCreateRequestV1,
  ): Promise<SessionConnectorResultV1<SessionConnectorIdentityV1>> {
    return unavailableResult("create");
  }

  async getStatus(
    identity: SessionConnectorIdentityV1,
  ): Promise<SessionConnectorResultV1<SessionConnectorStatusV1>> {
    const target = validateIdentity(identity);
    if (!target.ok) return target;
    try {
      const result = await this.dependencies.getSessionStatus(target.value, this.settings, undefined);
      const agentState = asRecord(result.agentState);
      const cursor = typeof result.cursor === "string" && result.cursor.trim()
        ? result.cursor
        : typeof agentState?.cursor === "string" && agentState.cursor.trim()
          ? agentState.cursor
          : null;
      return {
        ok: true,
        value: {
          identity,
          state: statusState(result),
          lastActivityAt: statusLastActivity(result),
          connectorCursor: cursor,
          nativeWriterDetected: agentState?.controlledByUser === true,
        },
      };
    } catch (error) {
      return mapReadFailure(error);
    }
  }

  async readHistory(
    input: SessionConnectorHistoryRequestV1,
  ): Promise<SessionConnectorResultV1<SessionConnectorHistoryPageV1>> {
    const target = validateIdentity(input.identity);
    if (!target.ok) return target;
    if (input.contractVersion !== 1 || !Number.isInteger(input.limit) || input.limit < 1 || input.limit > HISTORY_RECONCILIATION_LIMIT) {
      return failure("invalid_request", "History limit must be an integer from 1 through 250", false);
    }
    const fetchLimit = input.afterCursor ? HISTORY_RECONCILIATION_LIMIT : input.limit;
    try {
      const result = await this.dependencies.getSessionHistory(
        target.value,
        fetchLimit,
        this.settings,
        undefined,
      );
      const mapped: SessionConnectorHistoryItemV1[] = [];
      const nativeIds = new Set<string>();
      for (const row of result.messages) {
        const item = mapHistoryRow(row);
        if (!item || nativeIds.has(item.nativeMessageId)) {
          return failure("degraded", "Happier history contained an invalid or duplicate native message", false);
        }
        nativeIds.add(item.nativeMessageId);
        mapped.push(item);
      }

      let start = 0;
      if (input.afterCursor) {
        const matched = mapped.findIndex((item) => item.cursor === input.afterCursor);
        if (matched < 0) {
          return failure(
            "ambiguous",
            "The requested history cursor is outside the bounded reconciliation window",
            false,
            { boundedWindow: HISTORY_RECONCILIATION_LIMIT },
          );
        }
        start = matched + 1;
      }
      const items = mapped.slice(start, start + input.limit);
      const completeThroughCursor = items.at(-1)?.cursor ?? input.afterCursor;
      return {
        ok: true,
        value: {
          items,
          nextCursor: items.at(-1)?.cursor ?? null,
          completeThroughCursor: completeThroughCursor ?? null,
        },
      };
    } catch (error) {
      return mapReadFailure(error);
    }
  }

  async subscribeEvents(
    _identity: SessionConnectorIdentityV1,
  ): Promise<SessionConnectorResultV1<AsyncIterable<SessionConnectorEventV1>>> {
    return unavailableResult("event subscription");
  }

  async send(
    input: SessionConnectorSendRequestV1,
  ): Promise<SessionConnectorResultV1<SessionConnectorSendReceiptV1>> {
    const target = validateIdentity(input.identity);
    if (!target.ok) return target;
    if (
      input.contractVersion !== 1
      || !input.bindingId.trim()
      || !input.logicalMessageId.trim()
      || !input.localMessageId.trim()
      || input.localMessageId.length > 128
      || !/^[A-Za-z0-9._:-]+$/u.test(input.localMessageId)
      || !input.idempotencyKey.trim()
      || !input.content.trim()
      || input.contentHash !== hashRoomValue(input.content)
    ) {
      return failure("invalid_request", "Happier send requires valid identity, idempotency, content, and content hash", false);
    }
    const localId = input.localMessageId;
    try {
      const result = await this.dependencies.sendMessage({
        sessionId: target.value,
        message: input.content,
        localId,
        timeoutSeconds: this.sendTimeoutSeconds,
      }, this.settings, undefined);
      return {
        ok: true,
        value: {
          outcome: "accepted",
          connectorAcknowledgementId: result.localId ?? localId,
          nativeMessageId: null,
          cursor: null,
          acceptedAt: this.now(),
        },
      };
    } catch (error) {
      if (
        error instanceof HappierCliError
        && (error.code === "timeout"
          || error.code === "server"
          || error.code === "process"
          || error.code === "protocol"
          || error.code === "invalid-json"
          || error.code === "output-limit")
      ) {
        return {
          ok: true,
          value: {
            outcome: "delivery_uncertain",
            connectorAcknowledgementId: null,
            nativeMessageId: null,
            cursor: null,
            acceptedAt: null,
          },
        };
      }
      return mapReadFailure(error);
    }
  }

  async interrupt(
    _input: SessionConnectorControlRequestV1,
  ): Promise<SessionConnectorResultV1<SessionConnectorControlResultV1>> {
    return unavailableResult("interrupt");
  }

  async resume(
    _input: SessionConnectorControlRequestV1,
  ): Promise<SessionConnectorResultV1<SessionConnectorControlResultV1>> {
    return unavailableResult("resume");
  }

  async takeover(
    _input: SessionConnectorControlRequestV1,
  ): Promise<SessionConnectorResultV1<SessionConnectorControlResultV1>> {
    return unavailableResult("takeover");
  }

  async getHealth(hostId: string): Promise<SessionConnectorHealthV1> {
    try {
      const health = await this.dependencies.probeRuntime(this.settings);
      const state = health.ready
        ? "healthy"
        : !health.authenticated
          ? "authentication_required"
          : health.discovered && health.executable
            ? "degraded"
            : "unavailable";
      return {
        connectorId: this.id,
        hostId,
        state,
        checkedAt: this.now(),
        safeReason: health.details.length > 0 ? health.details.join(",") : null,
        retryAfterMs: null,
      };
    } catch {
      return {
        connectorId: this.id,
        hostId,
        state: "unavailable",
        checkedAt: this.now(),
        safeReason: "happier-probe-failed",
        retryAfterMs: null,
      };
    }
  }

  async getDeepLinks(
    _identity: SessionConnectorIdentityV1,
  ): Promise<SessionConnectorResultV1<SessionConnectorDeepLinksV1>> {
    return unavailableResult("deep links");
  }
}
