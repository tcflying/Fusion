import { createHash, randomUUID } from "node:crypto";
import {
  link,
  mkdir,
  readFile,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import type { SessionConnectorSendReceiptV1 } from "@fusion/core";

import type { HappierBackend } from "./types.js";

const DELIVERY_FENCE_CONTRACT_VERSION = 1 as const;
const HASH_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const KEY_HASH_PATTERN = /^[a-f0-9]{64}$/u;
const LOCAL_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/u;
const SESSION_ID_PATTERN = /^[^\u0000-\u001f\u007f]{1,512}$/u;

export interface HappierDeliveryFenceInput {
  readonly canonicalSessionUri: string;
  readonly providerId: HappierBackend;
  readonly nativeSessionId: string;
  readonly happierSessionId: string;
  readonly serverProfileId: string;
  readonly machineId: string;
  readonly localMessageId: string;
  readonly contentHash: string;
}

export interface HappierDeliveryFenceRecord extends HappierDeliveryFenceInput {
  readonly contractVersion: typeof DELIVERY_FENCE_CONTRACT_VERSION;
  readonly keyHash: string;
  readonly state: "pending" | "confirmed";
  readonly receipt: SessionConnectorSendReceiptV1 | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type HappierDeliveryFenceReservation =
  | Readonly<{ state: "created" | "pending" | "confirmed"; record: HappierDeliveryFenceRecord }>
  | Readonly<{ state: "conflict"; record: HappierDeliveryFenceRecord }>;

export interface HappierDeliveryFenceStore {
  reserve(input: HappierDeliveryFenceInput): Promise<HappierDeliveryFenceReservation>;
  confirm(
    input: HappierDeliveryFenceInput,
    receipt: SessionConnectorSendReceiptV1,
  ): Promise<Readonly<{ state: "confirmed"; record: HappierDeliveryFenceRecord }>>;
}

export interface HappierDeliveryFenceStoreOptions {
  readonly directory?: string;
  readonly now?: () => string;
}

function exactFields(record: Record<string, unknown>, allowed: readonly string[]): boolean {
  const set = new Set(allowed);
  return Object.keys(record).every((key) => set.has(key));
}

function validIsoTimestamp(value: unknown): value is string {
  return typeof value === "string"
    && Number.isFinite(Date.parse(value))
    && new Date(value).toISOString() === value;
}

function validText(value: unknown): value is string {
  return typeof value === "string" && SESSION_ID_PATTERN.test(value);
}

function canonicalSessionUri(value: string): string | null {
  try {
    const uri = new URL(value);
    const provider = uri.protocol.slice(0, -1);
    if (provider !== "codex" && provider !== "claude" && provider !== "opencode") return null;
    const host = provider === "codex" ? "threads" : "sessions";
    if (uri.hostname !== host || uri.search || uri.hash || uri.username || uri.password || uri.port) return null;
    const nativeSessionId = decodeURIComponent(uri.pathname.replace(/^\/+/u, ""));
    if (!validText(nativeSessionId) || nativeSessionId.includes("/")) return null;
    const canonical = `${provider}://${host}/${encodeURIComponent(nativeSessionId)}`;
    return canonical === value ? canonical : null;
  } catch {
    return null;
  }
}

function validateInput(input: HappierDeliveryFenceInput): HappierDeliveryFenceInput {
  const canonical = canonicalSessionUri(input.canonicalSessionUri);
  const expectedPrefix = `${input.providerId}://`;
  if (
    !canonical
    || canonical !== input.canonicalSessionUri
    || !canonical.startsWith(expectedPrefix)
    || !validText(input.nativeSessionId)
    || !validText(input.happierSessionId)
    || !validText(input.serverProfileId)
    || !validText(input.machineId)
    || !LOCAL_ID_PATTERN.test(input.localMessageId)
    || !HASH_PATTERN.test(input.contentHash)
  ) {
    throw new Error("Happier delivery fence input is invalid");
  }
  return Object.freeze({ ...input });
}

function keyHashFor(input: HappierDeliveryFenceInput): string {
  return createHash("sha256").update(JSON.stringify({
    contractVersion: DELIVERY_FENCE_CONTRACT_VERSION,
    serverProfileId: input.serverProfileId,
    machineId: input.machineId,
    providerId: input.providerId,
    canonicalSessionUri: input.canonicalSessionUri,
    happierSessionId: input.happierSessionId,
    nativeSessionId: input.nativeSessionId,
    localMessageId: input.localMessageId,
  })).digest("hex");
}

function parseReceipt(value: unknown): SessionConnectorSendReceiptV1 | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const receipt = value as Record<string, unknown>;
  if (
    !exactFields(receipt, [
      "outcome",
      "connectorAcknowledgementId",
      "nativeMessageId",
      "cursor",
      "acceptedAt",
    ])
    || receipt.outcome !== "confirmed"
    || !validText(receipt.connectorAcknowledgementId)
    || !validText(receipt.nativeMessageId)
    || (receipt.cursor !== null && !validText(receipt.cursor))
    || (receipt.acceptedAt !== null && !validIsoTimestamp(receipt.acceptedAt))
  ) return null;
  return receipt as unknown as SessionConnectorSendReceiptV1;
}

function parseRecord(value: unknown, expectedKeyHash: string): HappierDeliveryFenceRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Happier delivery fence record is invalid");
  }
  const record = value as Record<string, unknown>;
  if (!exactFields(record, [
    "contractVersion",
    "keyHash",
    "state",
    "canonicalSessionUri",
    "providerId",
    "nativeSessionId",
    "happierSessionId",
    "serverProfileId",
    "machineId",
    "localMessageId",
    "contentHash",
    "receipt",
    "createdAt",
    "updatedAt",
  ])) throw new Error("Happier delivery fence record contains unsupported fields");
  const input = validateInput({
    canonicalSessionUri: String(record.canonicalSessionUri ?? ""),
    providerId: record.providerId as HappierBackend,
    nativeSessionId: String(record.nativeSessionId ?? ""),
    happierSessionId: String(record.happierSessionId ?? ""),
    serverProfileId: String(record.serverProfileId ?? ""),
    machineId: String(record.machineId ?? ""),
    localMessageId: String(record.localMessageId ?? ""),
    contentHash: String(record.contentHash ?? ""),
  });
  const receipt = record.receipt === null ? null : parseReceipt(record.receipt);
  if (
    record.contractVersion !== DELIVERY_FENCE_CONTRACT_VERSION
    || record.keyHash !== expectedKeyHash
    || !KEY_HASH_PATTERN.test(expectedKeyHash)
    || keyHashFor(input) !== expectedKeyHash
    || (record.state !== "pending" && record.state !== "confirmed")
    || (record.state === "pending" && record.receipt !== null)
    || (record.state === "confirmed" && receipt === null)
    || !validIsoTimestamp(record.createdAt)
    || !validIsoTimestamp(record.updatedAt)
    || Date.parse(record.updatedAt) < Date.parse(record.createdAt)
  ) throw new Error("Happier delivery fence record failed contract validation");
  return Object.freeze({
    contractVersion: DELIVERY_FENCE_CONTRACT_VERSION,
    keyHash: expectedKeyHash,
    state: record.state,
    ...input,
    receipt,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  });
}

function defaultDirectory(): string {
  const fusionHome = process.env.FUSION_HOME?.trim();
  const root = fusionHome ? resolve(fusionHome) : join(homedir(), ".fusion");
  return join(root, "plugins", "fusion-plugin-happier-runtime", "delivery-fences");
}

function transientReplaceError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === "EBUSY" || code === "EPERM";
}

async function replaceWithRetry(source: string, target: string): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await rename(source, target);
      return;
    } catch (error) {
      if (attempt === 2 || !transientReplaceError(error)) throw error;
      await new Promise<void>((resolveDelay) => {
        const timer = setTimeout(resolveDelay, attempt === 0 ? 75 : 250);
        timer.unref();
      });
    }
  }
}

/**
 * FNXC:HappierDeliveryFenceDurability 2026-07-27-04:30:
 * The first localId/contentHash reservation is atomically linked into place
 * before MCP send. A restarted connector may reconcile a pending reservation
 * or replay a confirmed receipt, but it never resends an unresolved localId.
 */
export function createHappierDeliveryFenceStore(
  options: HappierDeliveryFenceStoreOptions = {},
): HappierDeliveryFenceStore {
  const directory = resolve(options.directory?.trim() || defaultDirectory());
  const now = options.now ?? (() => new Date().toISOString());
  const fileFor = (keyHash: string): string => {
    if (!KEY_HASH_PATTERN.test(keyHash)) throw new Error("Happier delivery fence key is invalid");
    return join(directory, `${keyHash}.json`);
  };
  const read = async (keyHash: string): Promise<HappierDeliveryFenceRecord> => {
    let source: string;
    try {
      source = await readFile(fileFor(keyHash), "utf8");
    } catch (error) {
      throw new Error("Happier delivery fence could not be read", { cause: error });
    }
    try {
      return parseRecord(JSON.parse(source), keyHash);
    } catch (error) {
      throw new Error("Happier delivery fence is corrupt", { cause: error });
    }
  };
  const writeInitial = async (record: HappierDeliveryFenceRecord): Promise<boolean> => {
    const target = fileFor(record.keyHash);
    const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
    await mkdir(directory, { recursive: true });
    try {
      await writeFile(temporary, `${JSON.stringify(record)}\n`, {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx",
      });
      try {
        await link(temporary, target);
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
        throw error;
      }
    } finally {
      await unlink(temporary).catch(() => undefined);
    }
  };
  const writeReplacement = async (record: HappierDeliveryFenceRecord): Promise<void> => {
    const target = fileFor(record.keyHash);
    const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(record)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    try {
      await replaceWithRetry(temporary, target);
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
  };
  const store: HappierDeliveryFenceStore = {
    reserve: async (
      unvalidatedInput: HappierDeliveryFenceInput,
    ): Promise<HappierDeliveryFenceReservation> => {
      const input = validateInput(unvalidatedInput);
      const keyHash = keyHashFor(input);
      const timestamp = now();
      if (!validIsoTimestamp(timestamp)) throw new Error("Happier delivery fence clock is invalid");
      const created = parseRecord({
        contractVersion: DELIVERY_FENCE_CONTRACT_VERSION,
        keyHash,
        state: "pending",
        ...input,
        receipt: null,
        createdAt: timestamp,
        updatedAt: timestamp,
      }, keyHash);
      if (await writeInitial(created)) return { state: "created", record: created };
      const existing = await read(keyHash);
      if (existing.contentHash !== input.contentHash) return { state: "conflict", record: existing };
      return { state: existing.state, record: existing };
    },
    confirm: async (
      unvalidatedInput: HappierDeliveryFenceInput,
      receipt: SessionConnectorSendReceiptV1,
    ): Promise<Readonly<{ state: "confirmed"; record: HappierDeliveryFenceRecord }>> => {
      const input = validateInput(unvalidatedInput);
      const keyHash = keyHashFor(input);
      const existing = await read(keyHash);
      if (existing.contentHash !== input.contentHash) {
        throw new Error("Happier delivery fence content hash conflicts");
      }
      if (existing.state === "confirmed") return { state: "confirmed", record: existing };
      const parsedReceipt = parseReceipt(receipt);
      if (!parsedReceipt) throw new Error("Happier delivery fence receipt is invalid");
      const confirmed = parseRecord({
        ...existing,
        state: "confirmed",
        receipt: parsedReceipt,
        updatedAt: now(),
      }, keyHash);
      await writeReplacement(confirmed);
      return { state: "confirmed", record: confirmed };
    },
  };
  return Object.freeze(store);
}
