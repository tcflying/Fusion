import {
  hashRoomValue,
  SESSION_CONNECTOR_HISTORY_PAGE_LIMIT,
  SESSION_CONNECTOR_PROVIDER_TELEMETRY_CONTRACT_VERSION,
  type SessionConnectorHistoryPageV1,
  type SessionConnectorHistoryRequestV1,
  type SessionConnectorIdentityV1,
  type SessionConnectorProviderTelemetryV1,
  type SessionConnectorProviderTelemetryWithheldReasonV1,
  type SessionConnectorResultV1,
  type SessionConnectorRuntimeSnapshotV1,
} from "@fusion/core";

import {
  HAPPIER_LOCAL_MCP_EXTENSION_TOOLS,
  type HappierMcpToolResult,
} from "./happier-mcp-client.js";
import { mcpResultRecord } from "./mcp-result-contract.js";
import type { HappierSessionIdentityResolver } from "./session-connector-identity.js";
import {
  happierConnectorFailure,
  isHappierJsonRecord,
  mapHappierMcpFailure,
  nonEmptyHappierString,
  validatedHappierToolNames,
  type HappierSessionConnectorTransport,
} from "./session-connector-transport.js";
import {
  isoTimestamp,
  sessionIdFromRecord,
} from "./session-connector-status.js";
import {
  HappierCliError,
  type HappierCliSettings,
  type HappierJsonRecord,
} from "./types.js";

const HAPPIER_LOCAL_RUNTIME_SNAPSHOT_REQUIRED =
  "happier_local_runtime_snapshot_extension_required";
const HAPPIER_LOCAL_RECONCILIATION_HISTORY_REQUIRED =
  "happier_local_reconciliation_history_extension_required";
const LOCAL_RUNTIME_SNAPSHOT_MAX_FUTURE_SKEW_MS = 5_000;

function canonicalIsoTimestamp(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return null;
  const canonical = new Date(parsed).toISOString();
  return value === canonical ? canonical : null;
}

function hasExactOwnKeys(
  value: HappierJsonRecord,
  expected: readonly string[],
): boolean {
  const keys = Reflect.ownKeys(value);
  return keys.length === expected.length
    && expected.every(
      (key) => Object.prototype.hasOwnProperty.call(value, key),
    );
}

function localRuntimeSnapshotRequired<T>():
  SessionConnectorResultV1<T> {
  return happierConnectorFailure(
    "unavailable",
    "The local Happier runtime snapshot extension is not enabled or not installed for this MCP process",
    false,
    {
      bridge: "local_happier_mcp_extension",
      extension: HAPPIER_LOCAL_MCP_EXTENSION_TOOLS.runtimeSnapshot,
      state: HAPPIER_LOCAL_RUNTIME_SNAPSHOT_REQUIRED,
    },
  );
}

function localRuntimeSnapshotWithheld<T>(
  reason: "model_metadata_unavailable" | "invalid_snapshot",
): SessionConnectorResultV1<T> {
  return happierConnectorFailure(
    reason === "model_metadata_unavailable"
      ? "unavailable"
      : "unverified",
    reason === "model_metadata_unavailable"
      ? "Happier local runtime metadata does not currently contain a validated ACP provider/model"
      : "Happier local runtime snapshot failed strict validation",
    false,
    {
      bridge: "local_happier_mcp_extension",
      extension: HAPPIER_LOCAL_MCP_EXTENSION_TOOLS.runtimeSnapshot,
      reason,
    },
  );
}

function localReconciliationHistoryRequired<T>():
  SessionConnectorResultV1<T> {
  return happierConnectorFailure(
    "unavailable",
    "The local Happier reconciliation-history extension is not enabled or not installed for this MCP process",
    false,
    {
      bridge: "local_happier_mcp_extension",
      extension: HAPPIER_LOCAL_MCP_EXTENSION_TOOLS.reconciliationHistory,
      state: HAPPIER_LOCAL_RECONCILIATION_HISTORY_REQUIRED,
    },
  );
}

function localReconciliationHistoryWithheld<T>():
  SessionConnectorResultV1<T> {
  return happierConnectorFailure(
    "unverified",
    "Happier local reconciliation history failed strict identity, cursor, or message validation",
    false,
    {
      bridge: "local_happier_mcp_extension",
      extension: HAPPIER_LOCAL_MCP_EXTENSION_TOOLS.reconciliationHistory,
      reason: "invalid_reconciliation_history",
    },
  );
}

function providerTelemetryIdentity(
  identity: SessionConnectorIdentityV1,
): SessionConnectorIdentityV1 {
  return Object.freeze({
    connectorId: identity.connectorId,
    providerId: identity.providerId,
    nativeSessionId: identity.nativeSessionId,
    happierSessionId: identity.happierSessionId,
    serverProfileId: identity.serverProfileId,
    machineId: identity.machineId,
    hostId: identity.hostId,
  });
}

function providerTelemetryWithheld(
  identity: SessionConnectorIdentityV1,
  reason: SessionConnectorProviderTelemetryWithheldReasonV1,
): SessionConnectorResultV1<SessionConnectorProviderTelemetryV1> {
  return {
    ok: true,
    value: Object.freeze({
      contractVersion:
        SESSION_CONNECTOR_PROVIDER_TELEMETRY_CONTRACT_VERSION,
      state: "withheld" as const,
      identity: providerTelemetryIdentity(identity),
      reason,
    }),
  };
}

function hasExpectedProviderTelemetryLimitations(
  value: unknown,
): boolean {
  if (
    !isHappierJsonRecord(value)
    || !hasExactOwnKeys(value, [
      "providerAvailability",
      "capacity",
      "onDemandProviderRefresh",
      "accountIdentity",
      "rawSnapshot",
    ])
  ) {
    return false;
  }
  return value.providerAvailability === "not_inferred"
    && value.capacity === "not_reported"
    && value.onDemandProviderRefresh === "not_attempted"
    && value.accountIdentity === "not_reported"
    && value.rawSnapshot === "not_reported";
}

function localProviderTelemetryWithheldReason(
  value: unknown,
): SessionConnectorProviderTelemetryWithheldReasonV1 | null {
  switch (value) {
    case "snapshot_stale":
      return "telemetry_stale";
    case "snapshot_unavailable":
    case "source_unavailable":
    case "invalid_request":
    case "session_unresolved":
    case "binding_unavailable":
      return "telemetry_unavailable";
    default:
      return null;
  }
}

type LocalProviderTelemetryMcpRecord =
  | Readonly<{ state: "record"; record: HappierJsonRecord }>
  | Readonly<{ state: "unavailable" }>
  | Readonly<{ state: "invalid" }>;

function strictLocalProviderTelemetryMcpRecord(
  result: HappierMcpToolResult,
): LocalProviderTelemetryMcpRecord {
  if (result.isError === true) return { state: "unavailable" };
  if (result.isError !== undefined && result.isError !== false) {
    return { state: "invalid" };
  }
  if (result.structuredContent !== undefined) {
    return isHappierJsonRecord(result.structuredContent)
        && result.content === undefined
      ? { state: "record", record: result.structuredContent }
      : { state: "invalid" };
  }
  if (!Array.isArray(result.content) || result.content.length !== 1) {
    return { state: "invalid" };
  }
  const content = result.content[0];
  if (
    !isHappierJsonRecord(content)
    || content.type !== "text"
    || typeof content.text !== "string"
  ) {
    return { state: "invalid" };
  }
  try {
    const parsed: unknown = JSON.parse(content.text);
    return isHappierJsonRecord(parsed)
      ? { state: "record", record: parsed }
      : { state: "invalid" };
  } catch {
    return { state: "invalid" };
  }
}

function providerTelemetryMcpFailure(
  identity: SessionConnectorIdentityV1,
  error: unknown,
): SessionConnectorResultV1<SessionConnectorProviderTelemetryV1> {
  return providerTelemetryWithheld(
    identity,
    error instanceof HappierCliError && error.code === "timeout"
      ? "telemetry_timeout"
      : "telemetry_unavailable",
  );
}

/*
 * FNXC:HappierProviderTelemetry 2026-07-21-03:00:
 * Project only one in-band persisted Codex snapshot into Core's canonical
 * telemetry contract. It cannot prove provider availability or capacity.
 */
function parseLocalProviderTelemetry(
  value: HappierJsonRecord,
  identity: SessionConnectorIdentityV1,
  now: string,
): SessionConnectorResultV1<SessionConnectorProviderTelemetryV1> {
  const baseFields = [
    "ok",
    "kind",
    "contractVersion",
    "state",
    "provider",
  ] as const;
  if (
    value.ok !== true
    || value.kind !== "fusion_provider_telemetry"
    || value.contractVersion !== 1
  ) {
    return providerTelemetryWithheld(
      identity,
      "telemetry_contract_invalid",
    );
  }
  if (value.state === "withheld") {
    const reason = localProviderTelemetryWithheldReason(value.reason);
    if (
      !hasExactOwnKeys(value, [
        "ok",
        "kind",
        "contractVersion",
        "state",
        "reason",
      ])
      || !reason
    ) {
      return providerTelemetryWithheld(
        identity,
        "telemetry_contract_invalid",
      );
    }
    return providerTelemetryWithheld(identity, reason);
  }
  if (
    value.state !== "reported"
    || !hasExactOwnKeys(value, [
      ...baseFields,
      "source",
      "freshness",
      "observedAt",
      "expiresAt",
      "limitations",
    ])
    || identity.providerId !== "codex"
    || value.provider !== "codex"
    || value.source
      !== "happier_persisted_in_band_provider_snapshot"
    || value.freshness !== "fresh"
    || !hasExpectedProviderTelemetryLimitations(value.limitations)
  ) {
    return providerTelemetryWithheld(
      identity,
      "telemetry_contract_invalid",
    );
  }
  const observedAt = canonicalIsoTimestamp(value.observedAt);
  const expiresAt = canonicalIsoTimestamp(value.expiresAt);
  const nowAt = canonicalIsoTimestamp(now);
  if (!observedAt || !expiresAt || !nowAt) {
    return providerTelemetryWithheld(
      identity,
      "telemetry_contract_invalid",
    );
  }
  const observedAtMs = Date.parse(observedAt);
  const expiresAtMs = Date.parse(expiresAt);
  const nowMs = Date.parse(nowAt);
  if (observedAtMs > nowMs || expiresAtMs <= observedAtMs) {
    return providerTelemetryWithheld(
      identity,
      "telemetry_contract_invalid",
    );
  }
  if (nowMs >= expiresAtMs) {
    return providerTelemetryWithheld(identity, "telemetry_stale");
  }
  return {
    ok: true,
    value: Object.freeze({
      contractVersion:
        SESSION_CONNECTOR_PROVIDER_TELEMETRY_CONTRACT_VERSION,
      state: "reported" as const,
      identity: providerTelemetryIdentity(identity),
      providerId: "codex" as const,
      source:
        "happier_persisted_in_band_provider_snapshot" as const,
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
    }),
  };
}

function numericSequenceCursor(value: unknown): string | null {
  if (
    typeof value !== "string"
    || !/^(?:0|[1-9][0-9]{0,15})$/u.test(value)
  ) {
    return null;
  }
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0
    ? value
    : null;
}

function sequenceCursorNumber(value: string | null): number | null {
  if (value === null) return 0;
  const canonical = numericSequenceCursor(value);
  return canonical === null ? null : Number(canonical);
}

function strictOpaqueIdentifier(
  value: unknown,
  maximum = 512,
): string | null {
  if (typeof value !== "string" || value !== value.trim()) return null;
  return nonEmptyHappierString(value, maximum) ?? null;
}

function epochMillisecondsToIso(value: unknown): string | null {
  if (
    typeof value !== "number"
    || !Number.isSafeInteger(value)
    || value < 0
  ) {
    return null;
  }
  const timestamp = new Date(value).toISOString();
  return Number.isNaN(Date.parse(timestamp)) ? null : timestamp;
}

type LocalReconciliationHistoryParse =
  | Readonly<{
    state: "ready";
    page: SessionConnectorHistoryPageV1;
  }>
  | Readonly<{ state: "withheld" }>;

/*
 * FNXC:HappierReconciliationHistory 2026-07-20-12:02:
 * Only the local extension retains both durable localId and monotonic server
 * sequence. Any nonexact page, identity, content, or cursor stays withheld.
 */
function parseLocalReconciliationHistory(
  value: HappierJsonRecord,
  expectedSessionId: string,
  input: SessionConnectorHistoryRequestV1,
): LocalReconciliationHistoryParse {
  const requestedAfterSequence =
    sequenceCursorNumber(input.afterCursor);
  if (
    requestedAfterSequence === null
    || value.ok !== true
    || value.kind !== "fusion_reconciliation_history"
    || value.contractVersion !== 1
    || !isHappierJsonRecord(value.session)
    || sessionIdFromRecord(value.session) !== expectedSessionId
    || !isHappierJsonRecord(value.page)
    || !Array.isArray(value.items)
    || !isHappierJsonRecord(value.provenance)
    || value.provenance.source
      !== "happier_local_encrypted_transcript"
    || value.provenance.transport !== "local_mcp_stdio"
    || value.provenance.sourceContractVersion !== 1
  ) {
    return { state: "withheld" };
  }
  const page = value.page;
  if (
    page.afterCursor !== input.afterCursor
    || typeof page.truncated !== "boolean"
  ) {
    return { state: "withheld" };
  }
  const completeThroughCursor = page.completeThroughCursor === null
    ? null
    : numericSequenceCursor(page.completeThroughCursor);
  const completeThroughSequence =
    sequenceCursorNumber(completeThroughCursor);
  if (
    completeThroughSequence === null
    || completeThroughSequence < requestedAfterSequence
    || (
      completeThroughCursor === null
      && input.afterCursor !== null
    )
  ) {
    return { state: "withheld" };
  }
  const providerNextCursor = page.nextCursor === null
    ? null
    : numericSequenceCursor(page.nextCursor);
  const providerNextSequence =
    sequenceCursorNumber(providerNextCursor);
  if (page.truncated) {
    if (
      providerNextSequence === null
      || providerNextSequence <= requestedAfterSequence
      || providerNextSequence !== completeThroughSequence
    ) {
      return { state: "withheld" };
    }
  } else if (page.nextCursor !== null) {
    return { state: "withheld" };
  }

  const nativeMessageIds = new Set<string>();
  const localMessageIds = new Set<string>();
  let previousItemSequence = requestedAfterSequence;
  const items:
    Array<SessionConnectorHistoryPageV1["items"][number]> = [];
  for (const item of value.items) {
    if (!isHappierJsonRecord(item)) return { state: "withheld" };
    const nativeMessageId =
      strictOpaqueIdentifier(item.nativeMessageId);
    const localMessageId =
      strictOpaqueIdentifier(item.localMessageId, 128);
    const content =
      typeof item.content === "string"
        && item.content.length > 0
        && item.content.length <= 100_000
        && !item.content.includes("\u0000")
        ? item.content
        : null;
    const occurredAt = epochMillisecondsToIso(item.occurredAtMs);
    const cursor = numericSequenceCursor(item.cursor);
    const sequence = sequenceCursorNumber(cursor);
    if (
      !nativeMessageId
      || !localMessageId
      || !/^[A-Za-z0-9._:-]+$/u.test(localMessageId)
      || !content
      || !occurredAt
      || !cursor
      || sequence === null
      || sequence <= previousItemSequence
      || sequence > completeThroughSequence
      || nativeMessageIds.has(nativeMessageId)
      || localMessageIds.has(localMessageId)
    ) {
      return { state: "withheld" };
    }
    nativeMessageIds.add(nativeMessageId);
    localMessageIds.add(localMessageId);
    previousItemSequence = sequence;
    items.push({
      nativeMessageId,
      logicalMessageId: localMessageId,
      role: "user",
      contentHash: hashRoomValue(content),
      occurredAt,
      cursor,
    });
  }
  const nextCursor = providerNextCursor ?? completeThroughCursor;
  return {
    state: "ready",
    page: {
      items,
      nextCursor,
      completeThroughCursor,
      truncated: page.truncated,
    },
  };
}

function hasExpectedRuntimeLimitations(value: unknown): boolean {
  if (!isHappierJsonRecord(value)) return false;
  return value.providerAccount === "not_reported"
    && value.providerQuota === "not_reported"
    && value.latency === "not_reported"
    && value.context === "not_reported"
    && value.tools === "not_reported"
    && value.quality === "not_reported";
}

function parseLocalRuntimeSnapshot(
  value: HappierJsonRecord,
  identity: SessionConnectorIdentityV1,
  expectedSessionId: string,
  now: string,
):
  | Readonly<{
    state: "ready";
    snapshot: SessionConnectorRuntimeSnapshotV1;
  }>
  | Readonly<{
    state: "withheld";
    reason: "model_metadata_unavailable" | "invalid_snapshot";
  }> {
  if (
    value.ok !== true
    || value.kind !== "fusion_local_runtime_snapshot"
    || value.contractVersion !== 1
  ) {
    return { state: "withheld", reason: "invalid_snapshot" };
  }
  const snapshot = isHappierJsonRecord(value.snapshot)
    ? value.snapshot
    : null;
  const session = isHappierJsonRecord(value.session)
    ? value.session
    : null;
  const runtime = isHappierJsonRecord(value.runtime)
    ? value.runtime
    : null;
  const provenance = isHappierJsonRecord(value.provenance)
    ? value.provenance
    : null;
  if (
    !snapshot
    || !session
    || !runtime
    || !provenance
    || sessionIdFromRecord(session) !== expectedSessionId
    || !hasExpectedRuntimeLimitations(value.limitations)
    || provenance.source !== "happier_local_acp_metadata"
    || provenance.transport !== "local_mcp_stdio"
    || provenance.sourceContractVersion !== 1
  ) {
    return { state: "withheld", reason: "invalid_snapshot" };
  }
  if (runtime.modelState !== "known") {
    return {
      state: "withheld",
      reason: "model_metadata_unavailable",
    };
  }
  const snapshotId = nonEmptyHappierString(snapshot.id, 512);
  const revision = snapshot.revision;
  const capturedAt = isoTimestamp(snapshot.capturedAt);
  const expiresAt = isoTimestamp(snapshot.expiresAt);
  const providerId = nonEmptyHappierString(runtime.providerId, 512);
  const modelId =
    nonEmptyHappierString(runtime.currentModelId, 512);
  const modelObservedAt = isoTimestamp(runtime.modelObservedAt);
  const nowMs = Date.parse(now);
  if (
    !snapshotId
    || typeof revision !== "number"
    || !Number.isSafeInteger(revision)
    || revision <= 0
    || !capturedAt
    || !expiresAt
    || !providerId
    || providerId !== identity.providerId
    || !modelId
    || !modelObservedAt
    || runtime.modelReason !== null
    || !Number.isFinite(nowMs)
    || Date.parse(capturedAt) > Date.parse(expiresAt)
    || Date.parse(modelObservedAt) > Date.parse(capturedAt)
    || Date.parse(capturedAt)
      > nowMs + LOCAL_RUNTIME_SNAPSHOT_MAX_FUTURE_SKEW_MS
    || nowMs > Date.parse(expiresAt)
  ) {
    return { state: "withheld", reason: "invalid_snapshot" };
  }
  return {
    state: "ready",
    snapshot: {
      contractVersion: 1,
      source: "connector_local_extension",
      identity,
      snapshotId,
      revision,
      capturedAt,
      expiresAt,
      providerId,
      modelId,
      modelObservedAt,
      accountId: null,
      coverage: {
        providerModel: "observed",
        providerAccount: "not_reported",
        providerQuota: "not_reported",
        latency: "not_reported",
        context: "not_reported",
        tools: "not_reported",
        quality: "not_reported",
      },
    },
  };
}

interface HappierSessionObservationOptions {
  readonly settings: Readonly<HappierCliSettings>;
  readonly identity: HappierSessionIdentityResolver;
  readonly transport: HappierSessionConnectorTransport;
  readonly now: () => string;
}

/*
 * FNXC:HappierSessionConnectorObservation 2026-07-27-18:14:
 * Local runtime, provider telemetry, and reconciliation history are strict
 * read projections. They share transport and identity but never become a
 * second provider Session state authority.
 */
export class HappierSessionObservationController {
  constructor(
    private readonly options: HappierSessionObservationOptions,
  ) {}

  async getRuntimeSnapshot(
    identity: SessionConnectorIdentityV1,
  ): Promise<
    SessionConnectorResultV1<SessionConnectorRuntimeSnapshotV1>
  > {
    const target = this.options.identity.validateBoundIdentity(
      identity,
      "read a local runtime snapshot",
    );
    if (!target.ok) return target;
    try {
      return await this.options.transport.withClient(
        target.value.happierSessionId,
        async (client) => {
          const available = validatedHappierToolNames(
            await client.listTools(),
          );
          if (
            !available.has(
              HAPPIER_LOCAL_MCP_EXTENSION_TOOLS.runtimeSnapshot,
            )
          ) {
            return localRuntimeSnapshotRequired();
          }
          const record = mcpResultRecord(
            await client.callTool({
              name:
                HAPPIER_LOCAL_MCP_EXTENSION_TOOLS.runtimeSnapshot,
              arguments: {
                sessionId: target.value.happierSessionId,
              },
            }),
            HAPPIER_LOCAL_MCP_EXTENSION_TOOLS.runtimeSnapshot,
          );
          const parsed = parseLocalRuntimeSnapshot(
            record,
            identity,
            target.value.happierSessionId,
            this.options.now(),
          );
          return parsed.state === "withheld"
            ? localRuntimeSnapshotWithheld(parsed.reason)
            : { ok: true as const, value: parsed.snapshot };
        },
      );
    } catch (error) {
      return mapHappierMcpFailure(
        error,
        "local_happier_mcp_extension",
      );
    }
  }

  async getProviderTelemetry(
    identity: SessionConnectorIdentityV1,
  ): Promise<
    SessionConnectorResultV1<SessionConnectorProviderTelemetryV1>
  > {
    if (identity.providerId !== "codex") {
      return providerTelemetryWithheld(
        identity,
        "telemetry_contract_invalid",
      );
    }
    const target = this.options.identity.validateBoundIdentity(
      identity,
      "read local provider telemetry",
    );
    if (!target.ok) {
      return providerTelemetryWithheld(
        identity,
        "telemetry_contract_invalid",
      );
    }
    if (!this.options.settings.enableLocalProviderTelemetry) {
      return providerTelemetryWithheld(
        identity,
        "connector_telemetry_unsupported",
      );
    }
    try {
      return await this.options.transport.withClient(
        target.value.happierSessionId,
        async (client) => {
          const available = validatedHappierToolNames(
            await client.listTools(),
          );
          if (
            !available.has(
              HAPPIER_LOCAL_MCP_EXTENSION_TOOLS.providerTelemetry,
            )
          ) {
            return providerTelemetryWithheld(
              identity,
              "telemetry_unavailable",
            );
          }
          const mcpResult = strictLocalProviderTelemetryMcpRecord(
            await client.callTool({
              name:
                HAPPIER_LOCAL_MCP_EXTENSION_TOOLS.providerTelemetry,
              arguments: {
                sessionId: target.value.happierSessionId,
              },
            }),
          );
          if (mcpResult.state === "unavailable") {
            return providerTelemetryWithheld(
              identity,
              "telemetry_unavailable",
            );
          }
          if (mcpResult.state === "invalid") {
            return providerTelemetryWithheld(
              identity,
              "telemetry_contract_invalid",
            );
          }
          return parseLocalProviderTelemetry(
            mcpResult.record,
            identity,
            this.options.now(),
          );
        },
      );
    } catch (error) {
      return providerTelemetryMcpFailure(identity, error);
    }
  }

  async readHistory(
    input: SessionConnectorHistoryRequestV1,
  ): Promise<SessionConnectorResultV1<SessionConnectorHistoryPageV1>> {
    const target = this.options.identity.validateBoundIdentity(
      input.identity,
      "read reconciliation history",
    );
    if (!target.ok) return target;
    if (
      input.contractVersion !== 1
      || sequenceCursorNumber(input.afterCursor) === null
      || !Number.isSafeInteger(input.limit)
      || input.limit < 1
      || input.limit > SESSION_CONNECTOR_HISTORY_PAGE_LIMIT
    ) {
      return happierConnectorFailure(
        "invalid_request",
        "Happier reconciliation history requires a bounded numeric cursor and page size",
        false,
      );
    }
    try {
      return await this.options.transport.withClient(
        target.value.happierSessionId,
        async (client) => {
          const available = validatedHappierToolNames(
            await client.listTools(),
          );
          if (
            !available.has(
              HAPPIER_LOCAL_MCP_EXTENSION_TOOLS
                .reconciliationHistory,
            )
          ) {
            return localReconciliationHistoryRequired();
          }
          const record = mcpResultRecord(
            await client.callTool({
              name:
                HAPPIER_LOCAL_MCP_EXTENSION_TOOLS
                  .reconciliationHistory,
              arguments: {
                sessionId: target.value.happierSessionId,
                afterCursor: input.afterCursor,
                limit: input.limit,
              },
            }),
            HAPPIER_LOCAL_MCP_EXTENSION_TOOLS
              .reconciliationHistory,
          );
          const parsed = parseLocalReconciliationHistory(
            record,
            target.value.happierSessionId,
            input,
          );
          return parsed.state === "withheld"
            ? localReconciliationHistoryWithheld()
            : { ok: true as const, value: parsed.page };
        },
      );
    } catch (error) {
      return mapHappierMcpFailure(
        error,
        "local_happier_mcp_extension",
      );
    }
  }
}
