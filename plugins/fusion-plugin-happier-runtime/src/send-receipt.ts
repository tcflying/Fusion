import {
  hashRoomValue,
  type SessionConnectorSendReceiptV1,
  type SessionConnectorSendRequestV1,
} from "@fusion/core";

import type { HappierBoundIdentity } from "./binding-identity.js";
import type { HappierDeliveryFenceInput } from "./delivery-fence-store.js";
import type { HappierJsonRecord } from "./types.js";

function isRecord(value: unknown): value is HappierJsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value: unknown, maximum = 2_000): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > maximum || /[\u0000-\u001f\u007f]/u.test(trimmed)) return undefined;
  return trimmed;
}

export function deliveryFenceInput(
  target: HappierBoundIdentity,
  input: SessionConnectorSendRequestV1,
): HappierDeliveryFenceInput {
  return {
    canonicalSessionUri: target.canonicalSessionUri,
    providerId: target.providerId,
    nativeSessionId: target.nativeSessionId,
    happierSessionId: target.happierSessionId,
    serverProfileId: target.serverProfileId,
    machineId: target.machineId,
    localMessageId: input.localMessageId,
    contentHash: input.contentHash,
  };
}

export function confirmedSendReceipt(
  target: HappierBoundIdentity,
  input: SessionConnectorSendRequestV1,
  nativeMessageId: string,
  observedAt: number | null,
): SessionConnectorSendReceiptV1 {
  return {
    outcome: "confirmed",
    connectorAcknowledgementId: `happier-receipt:${hashRoomValue({
      canonicalSessionUri: target.canonicalSessionUri,
      providerId: target.providerId,
      nativeSessionId: target.nativeSessionId,
      happierSessionId: target.happierSessionId,
      serverProfileId: target.serverProfileId,
      machineId: target.machineId,
      hostId: input.identity.hostId,
      bindingId: input.bindingId,
      logicalMessageId: input.logicalMessageId,
      localMessageId: input.localMessageId,
      contentHash: input.contentHash,
      nativeMessageId,
      observedAt,
    })}`,
    nativeMessageId,
    cursor: null,
    acceptedAt: observedAt === null ? null : new Date(observedAt).toISOString(),
  };
}

export type HappierRawHistoryLocalIdCorrelation =
  | Readonly<{ outcome: "matched"; nativeMessageId: string }>
  | Readonly<{
    outcome: "uncertain";
    reason:
      | "raw_history_unavailable"
      | "local_id_not_found"
      | "ambiguous_local_id"
      | "content_hash_unavailable"
      | "content_hash_mismatch";
  }>;

/**
 * Reconcile only one exact raw-history localId and its immutable content hash.
 * Transcript position, text search, or timestamps can never confirm delivery.
 */
export function correlateRawHappierHistoryLocalId(
  rawHistory: unknown,
  expected: Readonly<{ localMessageId: string; contentHash: string }>,
): HappierRawHistoryLocalIdCorrelation {
  if (
    !nonEmptyString(expected.localMessageId, 128)
    || !/^[A-Za-z0-9._:-]+$/u.test(expected.localMessageId)
    || !nonEmptyString(expected.contentHash, 256)
    || !isRecord(rawHistory)
    || rawHistory.format !== "raw"
    || !Array.isArray(rawHistory.messages)
  ) {
    return { outcome: "uncertain", reason: "raw_history_unavailable" };
  }

  const candidates = rawHistory.messages.filter((message): message is HappierJsonRecord =>
    isRecord(message)
    && typeof message.localId === "string"
    && message.localId === expected.localMessageId,
  );
  if (candidates.length === 0) return { outcome: "uncertain", reason: "local_id_not_found" };
  if (candidates.length !== 1) return { outcome: "uncertain", reason: "ambiguous_local_id" };

  const candidate = candidates[0]!;
  const nativeMessageId = nonEmptyString(candidate.id, 512);
  const raw = isRecord(candidate.raw) ? candidate.raw : null;
  const content = raw && isRecord(raw.content) ? raw.content : null;
  if (!nativeMessageId || content?.type !== "text" || typeof content.text !== "string") {
    return { outcome: "uncertain", reason: "content_hash_unavailable" };
  }
  if (hashRoomValue(content.text) !== expected.contentHash) {
    return { outcome: "uncertain", reason: "content_hash_mismatch" };
  }
  return { outcome: "matched", nativeMessageId };
}
