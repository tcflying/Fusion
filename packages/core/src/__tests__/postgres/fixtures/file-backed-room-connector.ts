import {
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

import {
  SESSION_CONNECTOR_CAPABILITIES,
  type SessionConnectorCapabilitiesV1,
  type SessionConnectorCapabilityState,
  type SessionConnectorDeepLinksV1,
  type SessionConnectorHealthV1,
  type SessionConnectorHistoryItemV1,
  type SessionConnectorIdentityV1,
  type SessionConnectorResultV1,
  type SessionConnectorSendReceiptV1,
  type SessionConnectorV1,
} from "../../../room-contracts/index.js";

export interface FileBackedRoomConnectorState {
  readonly acceptedByLocalMessageId: Readonly<Record<string, SessionConnectorHistoryItemV1>>;
  readonly sendCalls: number;
  readonly sideEffectCount: number;
}

const BASE_TIME = "2026-07-17T14:10:00.000Z";

function ok<T>(value: T): SessionConnectorResultV1<T> {
  return { ok: true, value };
}

function unavailable(message: string): SessionConnectorResultV1<never> {
  return {
    ok: false,
    error: { code: "unavailable", message, retryable: false },
  };
}

function defaultState(): FileBackedRoomConnectorState {
  return {
    acceptedByLocalMessageId: {},
    sendCalls: 0,
    sideEffectCount: 0,
  };
}

export function readFileBackedRoomConnectorState(
  stateFilePath: string,
): FileBackedRoomConnectorState {
  try {
    const raw = readFileSync(stateFilePath, "utf8");
    const parsed = JSON.parse(raw) as Partial<FileBackedRoomConnectorState>;
    return {
      acceptedByLocalMessageId: parsed.acceptedByLocalMessageId ?? {},
      sendCalls: Number(parsed.sendCalls ?? 0),
      sideEffectCount: Number(parsed.sideEffectCount ?? 0),
    };
  } catch {
    return defaultState();
  }
}

function writeState(
  stateFilePath: string,
  state: FileBackedRoomConnectorState,
): void {
  mkdirSync(dirname(stateFilePath), { recursive: true });
  writeFileSync(stateFilePath, JSON.stringify(state, null, 2), "utf8");
}

function connectorCapabilities(connectorId: string, checkedAt: string): SessionConnectorCapabilitiesV1 {
  const capabilities = Object.fromEntries(
    SESSION_CONNECTOR_CAPABILITIES.map((name) => {
      const state: SessionConnectorCapabilityState = "verified";
      return [name, {
        state,
        evidenceRef: `file-backed-room-connector://${connectorId}/${name}`,
        reasonCode: null,
        lastVerifiedAt: checkedAt,
      }];
    }),
  ) as SessionConnectorCapabilitiesV1["capabilities"];
  return {
    contractVersion: 1,
    connectorId,
    connectorVersion: "file-backed-deterministic-double-v1",
    sourceRevision: "test-double-not-live-provider",
    verifiedAt: checkedAt,
    capabilities,
  };
}

function connectorHealthCapabilities(): SessionConnectorHealthV1["capabilities"] {
  return Object.fromEntries(
    SESSION_CONNECTOR_CAPABILITIES.map((name) => [name, "verified"]),
  ) as SessionConnectorHealthV1["capabilities"];
}

/*
FNXC:SessionRoomCrashRecovery 2026-07-17-23:56:
Task 4.7 needs one connector double whose accepted-send side effects survive a
real process kill. Persisting the send/history evidence to a local JSON file
keeps the proof cross-process without pretending to be a live provider.
*/
export function createFileBackedRoomConnectorDouble(input: {
  readonly connectorId: string;
  readonly stateFilePath: string;
  readonly checkedAt?: string;
}): SessionConnectorV1 {
  const checkedAt = input.checkedAt ?? BASE_TIME;
  return {
    contractVersion: 1,
    id: input.connectorId,
    version: "file-backed-deterministic-double-v1",
    getCapabilities: async () => connectorCapabilities(input.connectorId, checkedAt),
    ensureExisting: async () => unavailable("not used by crash recovery"),
    create: async () => unavailable("not used by crash recovery"),
    getStatus: async (identity) => ok({
      identity,
      state: "idle",
      lastActivityAt: checkedAt,
      connectorCursor: null,
      nativeWriterDetected: false,
    }),
    readHistory: async (request) => {
      const state = readFileBackedRoomConnectorState(input.stateFilePath);
      const items = Object.values(state.acceptedByLocalMessageId)
        .filter((item) => request.afterCursor === null || item.cursor !== request.afterCursor)
        .sort((left, right) => left.cursor.localeCompare(right.cursor));
      const nextCursor = items.at(-1)?.cursor ?? request.afterCursor;
      return ok({
        items,
        nextCursor,
        completeThroughCursor: nextCursor,
        truncated: false,
      });
    },
    subscribeEvents: async () => unavailable("not used by crash recovery"),
    send: async (request) => {
      const state = readFileBackedRoomConnectorState(input.stateFilePath);
      let accepted = state.acceptedByLocalMessageId[request.localMessageId];
      let sideEffectCount = state.sideEffectCount;
      if (!accepted) {
        sideEffectCount += 1;
        accepted = {
          nativeMessageId: `native-${request.localMessageId}`,
          logicalMessageId: request.localMessageId,
          role: "user",
          contentHash: request.contentHash,
          occurredAt: BASE_TIME,
          cursor: `cursor-${request.localMessageId}`,
        };
      }
      writeState(input.stateFilePath, {
        acceptedByLocalMessageId: {
          ...state.acceptedByLocalMessageId,
          [request.localMessageId]: accepted,
        },
        sendCalls: state.sendCalls + 1,
        sideEffectCount,
      });
      return ok<SessionConnectorSendReceiptV1>({
        outcome: "confirmed",
        connectorAcknowledgementId: `ack-${request.localMessageId}`,
        nativeMessageId: accepted.nativeMessageId,
        cursor: accepted.cursor,
        acceptedAt: BASE_TIME,
      });
    },
    interrupt: async () => unavailable("not used by crash recovery"),
    resume: async () => unavailable("not used by crash recovery"),
    takeover: async () => unavailable("not used by crash recovery"),
    getHealth: async (hostId) => ({
      connectorId: input.connectorId,
      hostId,
      state: "healthy",
      checkedAt,
      authentication: "authenticated",
      daemon: "running",
      server: "reachable",
      backend: "ready",
      rateLimit: "clear",
      host: "reachable",
      capabilities: connectorHealthCapabilities(),
      reasonCodes: [],
      retryAfterMs: null,
    }),
    getDeepLinks: async (request) => ok<SessionConnectorDeepLinksV1>({
      contractVersion: 1,
      bindingId: request.bindingId,
      ...request.identity,
      happierUrl: null,
      nativeSessionUrl: null,
    }),
  };
}

export function connectorIdentityFromBinding(input: {
  readonly connectorId: string;
  readonly providerId: string;
  readonly nativeSessionId: string;
  readonly happierSessionId: string | null;
  readonly serverProfileId: string | null;
  readonly machineId: string | null;
  readonly hostId: string;
}): SessionConnectorIdentityV1 {
  return {
    connectorId: input.connectorId,
    providerId: input.providerId,
    nativeSessionId: input.nativeSessionId,
    happierSessionId: input.happierSessionId,
    serverProfileId: input.serverProfileId,
    machineId: input.machineId,
    hostId: input.hostId,
  };
}
