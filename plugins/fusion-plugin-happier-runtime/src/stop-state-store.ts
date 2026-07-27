import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import type {
  HappierBackend,
  HappierSessionBinding,
} from "./types.js";

const STOP_STATE_CONTRACT_VERSION = 1 as const;
const STOP_STATE_KEY_PATTERN = /^[a-f0-9]{64}$/u;
const SAFE_ID_PATTERN = /^[^\u0000-\u001f\u007f]{1,512}$/u;
const STOP_STATES = new Set<HappierStopState>([
  "stop_requested",
  "recovering",
  "stopped",
]);

export type HappierStopState =
  | "stop_requested"
  | "recovering"
  | "stopped";

export type HappierStopReasonCode = "stop_unconfirmed" | null;

export interface HappierStopIdentity {
  readonly keyHash: string;
  readonly happierSessionId: string;
  readonly serverProfileId: string | null;
  readonly machineId: string | null;
  readonly providerId: HappierBackend;
  readonly providerSessionId: string | null;
  readonly canonicalSessionUri: string | null;
}

export interface HappierStopStateRecord extends HappierStopIdentity {
  readonly contractVersion: typeof STOP_STATE_CONTRACT_VERSION;
  readonly state: HappierStopState;
  readonly reasonCode: HappierStopReasonCode;
  readonly updatedAt: string;
}

export interface HappierStopStateStore {
  read(keyHash: string): Promise<HappierStopStateRecord | null>;
  write(record: HappierStopStateRecord): Promise<void>;
}

export interface HappierStopStateStoreOptions {
  readonly directory?: string;
}

function safeId(value: unknown, field: string): string {
  if (typeof value !== "string" || !SAFE_ID_PATTERN.test(value)) {
    throw new Error(`Happier stop identity ${field} is invalid`);
  }
  return value;
}

function validBackend(value: unknown): value is HappierBackend {
  return value === "codex" || value === "claude" || value === "opencode";
}

function parseCanonicalSessionUri(
  value: string,
  backend: HappierBackend,
): Readonly<{ canonicalSessionUri: string; providerSessionId: string }> {
  let uri: URL;
  try {
    uri = new URL(value);
  } catch (error) {
    throw new Error("Happier stop identity canonical Session URI is invalid", { cause: error });
  }
  const providerId = uri.protocol.slice(0, -1);
  const expectedHost = backend === "codex" ? "threads" : "sessions";
  const providerSessionId = decodeURIComponent(uri.pathname.replace(/^\/+/u, ""));
  const canonicalSessionUri = `${backend}://${expectedHost}/${encodeURIComponent(providerSessionId)}`;
  if (
    providerId !== backend
    || uri.hostname !== expectedHost
    || uri.username
    || uri.password
    || uri.port
    || uri.search
    || uri.hash
    || providerSessionId.includes("/")
    || !SAFE_ID_PATTERN.test(providerSessionId)
    || value !== canonicalSessionUri
  ) {
    throw new Error("Happier stop identity canonical Session URI does not match the Provider");
  }
  return { canonicalSessionUri, providerSessionId };
}

function validateIdentity(
  value: Record<string, unknown>,
  expectedKeyHash: string,
): HappierStopIdentity {
  const keyHash = value.keyHash;
  const happierSessionId = value.happierSessionId;
  const providerId = value.providerId;
  const serverProfileId = value.serverProfileId;
  const machineId = value.machineId;
  const providerSessionId = value.providerSessionId;
  const canonicalSessionUri = value.canonicalSessionUri;
  if (
    keyHash !== expectedKeyHash
    || typeof keyHash !== "string"
    || !STOP_STATE_KEY_PATTERN.test(keyHash)
    || !validBackend(providerId)
    || typeof happierSessionId !== "string"
    || !SAFE_ID_PATTERN.test(happierSessionId)
    || (serverProfileId !== null && (
      typeof serverProfileId !== "string"
      || !SAFE_ID_PATTERN.test(serverProfileId)
    ))
    || (machineId !== null && (
      typeof machineId !== "string"
      || !SAFE_ID_PATTERN.test(machineId)
    ))
    || (providerSessionId !== null && (
      typeof providerSessionId !== "string"
      || !SAFE_ID_PATTERN.test(providerSessionId)
    ))
    || (canonicalSessionUri !== null && typeof canonicalSessionUri !== "string")
    || ([serverProfileId, machineId, providerSessionId, canonicalSessionUri]
      .filter((item) => item !== null).length !== 0
      && [serverProfileId, machineId, providerSessionId, canonicalSessionUri]
        .some((item) => item === null))
  ) {
    throw new Error("Happier stop identity failed contract validation");
  }
  if (canonicalSessionUri !== null) {
    const parsed = parseCanonicalSessionUri(canonicalSessionUri, providerId);
    if (parsed.providerSessionId !== providerSessionId) {
      throw new Error("Happier stop identity Provider Session does not match its canonical URI");
    }
  }
  return Object.freeze({
    keyHash,
    happierSessionId,
    serverProfileId,
    machineId,
    providerId,
    providerSessionId,
    canonicalSessionUri,
  });
}

function parseRecord(value: unknown, expectedKeyHash: string): HappierStopStateRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Happier stop state record is invalid");
  }
  const record = value as Record<string, unknown>;
  const allowed = new Set([
    "contractVersion",
    "keyHash",
    "happierSessionId",
    "serverProfileId",
    "machineId",
    "providerId",
    "providerSessionId",
    "canonicalSessionUri",
    "state",
    "reasonCode",
    "updatedAt",
  ]);
  if (Object.keys(record).some((key) => !allowed.has(key))) {
    throw new Error("Happier stop state record contains unsupported fields");
  }
  const identity = validateIdentity(record, expectedKeyHash);
  const state = record.state;
  const reasonCode = record.reasonCode;
  const updatedAt = record.updatedAt;
  if (
    record.contractVersion !== STOP_STATE_CONTRACT_VERSION
    || typeof state !== "string"
    || !STOP_STATES.has(state as HappierStopState)
    || (state === "recovering"
      ? reasonCode !== "stop_unconfirmed"
      : reasonCode !== null)
    || typeof updatedAt !== "string"
    || !Number.isFinite(Date.parse(updatedAt))
  ) {
    throw new Error("Happier stop state record failed contract validation");
  }
  return Object.freeze({
    contractVersion: STOP_STATE_CONTRACT_VERSION,
    ...identity,
    state: state as HappierStopState,
    reasonCode: reasonCode as HappierStopReasonCode,
    updatedAt,
  });
}

export function buildHappierStopIdentity(input: Readonly<{
  bindingKey: string;
  happierSessionId: string;
  backend: HappierBackend;
  binding?: HappierSessionBinding;
}>): HappierStopIdentity {
  const bindingKey = safeId(input.bindingKey, "binding key");
  const happierSessionId = safeId(input.happierSessionId, "Happier Session");
  let serverProfileId: string | null = null;
  let machineId: string | null = null;
  let providerSessionId: string | null = null;
  let canonicalSessionUri: string | null = null;
  if (input.binding) {
    if (safeId(input.binding.happierSessionId, "bound Happier Session") !== happierSessionId) {
      throw new Error("Happier stop identity binding points at another Session");
    }
    serverProfileId = safeId(input.binding.serverProfileId, "server profile");
    machineId = safeId(input.binding.machineId, "machine");
    const parsed = parseCanonicalSessionUri(input.binding.canonicalSessionUri, input.backend);
    providerSessionId = parsed.providerSessionId;
    canonicalSessionUri = parsed.canonicalSessionUri;
  }
  const keyHash = createHash("sha256")
    .update(JSON.stringify({
      contractVersion: STOP_STATE_CONTRACT_VERSION,
      bindingKey,
      happierSessionId,
      backend: input.backend,
    }))
    .digest("hex");
  return Object.freeze({
    keyHash,
    happierSessionId,
    serverProfileId,
    machineId,
    providerId: input.backend,
    providerSessionId,
    canonicalSessionUri,
  });
}

function defaultStopStateDirectory(): string {
  const fusionHome = process.env.FUSION_HOME?.trim();
  const root = fusionHome ? resolve(fusionHome) : join(homedir(), ".fusion");
  return join(root, "plugins", "fusion-plugin-happier-runtime", "stop-states");
}

/**
 * FNXC:HappierStopStateDurability 2026-07-27-16:04:
 * Remote cancellation is an atomic, secret-free recovery record. The owner
 * key is hashed, while every available server/machine/provider/native-thread
 * identity remains explicit so a restart cannot reinterpret an uncertain stop.
 */
export function createHappierStopStateStore(
  options: HappierStopStateStoreOptions = {},
): HappierStopStateStore {
  const directory = resolve(options.directory?.trim() || defaultStopStateDirectory());
  const fileFor = (keyHash: string): string => {
    if (!STOP_STATE_KEY_PATTERN.test(keyHash)) {
      throw new Error("Happier stop state key hash is invalid");
    }
    return join(directory, `${keyHash}.json`);
  };
  return Object.freeze({
    read: async (keyHash: string): Promise<HappierStopStateRecord | null> => {
      let source: string;
      try {
        source = await readFile(fileFor(keyHash), "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(source);
      } catch (error) {
        throw new Error("Happier stop state JSON is corrupt", { cause: error });
      }
      return parseRecord(parsed, keyHash);
    },
    write: async (record: HappierStopStateRecord): Promise<void> => {
      const validated = parseRecord(record, record.keyHash);
      const target = fileFor(validated.keyHash);
      const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
      await mkdir(directory, { recursive: true });
      try {
        await writeFile(temporary, `${JSON.stringify(validated)}\n`, {
          encoding: "utf8",
          mode: 0o600,
          flag: "wx",
        });
        await rename(temporary, target);
      } catch (error) {
        await unlink(temporary).catch(() => undefined);
        throw error;
      }
    },
  });
}
