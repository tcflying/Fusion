import { createHash } from "node:crypto";

/** Canonical SHA-256 used by Room idempotency, snapshots, and evidence records. */
export function hashRoomValue(value: unknown): string {
  return `sha256:${createHash("sha256")
    .update(stableSerializeRoomValue(value), "utf8")
    .digest("hex")}`;
}

export interface BuildRoomConnectorLocalMessageIdInput {
  readonly logicalMessageId: string;
  readonly bindingId: string;
  readonly idempotencyKey: string;
  readonly payloadHash: string;
}

/**
 * Stable provider-safe local id persisted before an external send begins.
 * The plaintext payload is deliberately excluded; only its canonical hash is
 * bound into the id so retries reproduce the same connector idempotency key.
 */
export function buildRoomConnectorLocalMessageId(
  input: BuildRoomConnectorLocalMessageIdInput,
): string {
  for (const [label, value] of Object.entries(input)) {
    if (typeof value !== "string" || value.trim().length === 0) {
      throw new Error(`Room connector local message id requires ${label}`);
    }
  }
  const digest = hashRoomValue({
    logicalMessageId: input.logicalMessageId,
    bindingId: input.bindingId,
    idempotencyKey: input.idempotencyKey,
    payloadHash: input.payloadHash,
  }).slice("sha256:".length);
  return `fusion-room-${digest}`;
}

/**
 * Deterministic JSON-compatible encoding. Object key order and process locale
 * cannot change a persisted Room hash; unsupported values fail closed.
 */
export function stableSerializeRoomValue(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) {
    return `[${value.map(stableSerializeRoomValue).join(",")}]`;
  }
  switch (typeof value) {
    case "string":
    case "boolean":
      return JSON.stringify(value);
    case "number":
      if (!Number.isFinite(value)) throw new Error("Cannot hash a non-finite number");
      return JSON.stringify(value);
    case "object": {
      const entries = Object.entries(value as Record<string, unknown>)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => compareRoomText(left, right));
      return `{${entries
        .map(([key, entry]) => `${JSON.stringify(key)}:${stableSerializeRoomValue(entry)}`)
        .join(",")}}`;
    }
    default:
      throw new Error(`Cannot hash unsupported value type ${typeof value}`);
  }
}

/** Locale-independent UTF-16 lexical order for persisted canonical values. */
export function compareRoomText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
