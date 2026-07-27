import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import type { HappierBackend } from "./types.js";

const CREATE_INTENT_CONTRACT_VERSION = 1 as const;
const CREATE_INTENT_KEY_PATTERN = /^[a-f0-9]{64}$/u;
const CREATE_INTENT_TAG_PREFIX = "fusion-happier-v1-";
const SESSION_ID_PATTERN = /^[^\u0000-\u001f\u007f]{1,512}$/u;
const CREATE_INTENT_STATES = new Set<HappierCreateIntentState>([
  "pending_create",
  "candidate_observed",
  "claimed",
  "cleanup_required",
  "cleaned",
]);

export type HappierCreateIntentState =
  | "pending_create"
  | "candidate_observed"
  | "claimed"
  | "cleanup_required"
  | "cleaned";

export interface HappierCreateIntentIdentity {
  readonly keyHash: string;
  readonly tag: string;
  readonly cwd: string;
  readonly backend: HappierBackend;
}

export interface HappierCreateIntentRecord extends HappierCreateIntentIdentity {
  readonly contractVersion: typeof CREATE_INTENT_CONTRACT_VERSION;
  readonly state: HappierCreateIntentState;
  readonly candidateSessionIds: readonly string[];
  readonly canonicalSessionId: string | null;
  readonly cleanupSessionIds: readonly string[];
  readonly updatedAt: string;
}

export interface HappierCreateIntentStore {
  read(keyHash: string): Promise<HappierCreateIntentRecord | null>;
  write(record: HappierCreateIntentRecord): Promise<void>;
}

export interface HappierCreateIntentStoreOptions {
  readonly directory?: string;
}

function normalizedCwd(cwd: string): string {
  const trimmed = cwd.trim();
  if (!trimmed || /[\u0000-\u001f\u007f]/u.test(trimmed)) {
    throw new Error("Happier create intent cwd is invalid");
  }
  return resolve(trimmed);
}

function validBackend(value: unknown): value is HappierBackend {
  return value === "codex" || value === "claude" || value === "opencode";
}

function uniqueSessionIds(value: unknown): readonly string[] | null {
  if (!Array.isArray(value)) return null;
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== "string" || !SESSION_ID_PATTERN.test(item) || seen.has(item)) return null;
    seen.add(item);
    ids.push(item);
  }
  return ids;
}

function parseRecord(value: unknown, expectedKeyHash: string): HappierCreateIntentRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Happier create intent record is invalid");
  }
  const record = value as Record<string, unknown>;
  const allowed = new Set([
    "contractVersion",
    "keyHash",
    "tag",
    "cwd",
    "backend",
    "state",
    "candidateSessionIds",
    "canonicalSessionId",
    "cleanupSessionIds",
    "updatedAt",
  ]);
  if (Object.keys(record).some((key) => !allowed.has(key))) {
    throw new Error("Happier create intent record contains unsupported fields");
  }
  const keyHash = record.keyHash;
  const tag = record.tag;
  const cwd = record.cwd;
  const backend = record.backend;
  const state = record.state;
  const candidateSessionIds = uniqueSessionIds(record.candidateSessionIds);
  const cleanupSessionIds = uniqueSessionIds(record.cleanupSessionIds);
  const canonicalSessionId = record.canonicalSessionId;
  const updatedAt = record.updatedAt;
  if (
    record.contractVersion !== CREATE_INTENT_CONTRACT_VERSION
    || keyHash !== expectedKeyHash
    || typeof keyHash !== "string"
    || !CREATE_INTENT_KEY_PATTERN.test(keyHash)
    || tag !== `${CREATE_INTENT_TAG_PREFIX}${keyHash.slice(0, 32)}`
    || typeof cwd !== "string"
    || normalizedCwd(cwd) !== cwd
    || !validBackend(backend)
    || typeof state !== "string"
    || !CREATE_INTENT_STATES.has(state as HappierCreateIntentState)
    || candidateSessionIds === null
    || cleanupSessionIds === null
    || (canonicalSessionId !== null && (
      typeof canonicalSessionId !== "string"
      || !SESSION_ID_PATTERN.test(canonicalSessionId)
    ))
    || typeof updatedAt !== "string"
    || !Number.isFinite(Date.parse(updatedAt))
  ) {
    throw new Error("Happier create intent record failed contract validation");
  }
  return Object.freeze({
    contractVersion: CREATE_INTENT_CONTRACT_VERSION,
    keyHash,
    tag,
    cwd,
    backend,
    state: state as HappierCreateIntentState,
    candidateSessionIds: Object.freeze([...candidateSessionIds]),
    canonicalSessionId,
    cleanupSessionIds: Object.freeze([...cleanupSessionIds]),
    updatedAt,
  });
}

export function buildHappierCreateIntentIdentity(input: Readonly<{
  bindingKey: string;
  cwd: string;
  backend: HappierBackend;
}>): HappierCreateIntentIdentity {
  const bindingKey = input.bindingKey.trim();
  if (!bindingKey || bindingKey.length > 2_000 || /[\u0000-\u001f\u007f]/u.test(bindingKey)) {
    throw new Error("Happier create intent binding key is invalid");
  }
  const cwd = normalizedCwd(input.cwd);
  const keyHash = createHash("sha256")
    .update(JSON.stringify({
      contractVersion: CREATE_INTENT_CONTRACT_VERSION,
      bindingKey,
      cwd,
      backend: input.backend,
    }))
    .digest("hex");
  return Object.freeze({
    keyHash,
    tag: `${CREATE_INTENT_TAG_PREFIX}${keyHash.slice(0, 32)}`,
    cwd,
    backend: input.backend,
  });
}

function defaultIntentDirectory(): string {
  const fusionHome = process.env.FUSION_HOME?.trim();
  const root = fusionHome ? resolve(fusionHome) : join(homedir(), ".fusion");
  return join(root, "plugins", "fusion-plugin-happier-runtime", "create-intents");
}

/**
 * FNXC:HappierCreateIntentDurability 2026-07-27-03:26:
 * A create intent is an atomic, secret-free local recovery fence written before
 * any remote spawn. The filename and tag derive from the same canonical hash,
 * so restart reconciliation cannot silently reinterpret a corrupt/moved record.
 */
export function createHappierCreateIntentStore(
  options: HappierCreateIntentStoreOptions = {},
): HappierCreateIntentStore {
  const directory = resolve(options.directory?.trim() || defaultIntentDirectory());
  const fileFor = (keyHash: string): string => {
    if (!CREATE_INTENT_KEY_PATTERN.test(keyHash)) {
      throw new Error("Happier create intent key hash is invalid");
    }
    return join(directory, `${keyHash}.json`);
  };
  return Object.freeze({
    read: async (keyHash: string): Promise<HappierCreateIntentRecord | null> => {
      const file = fileFor(keyHash);
      let source: string;
      try {
        source = await readFile(file, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(source);
      } catch (error) {
        throw new Error("Happier create intent JSON is corrupt", { cause: error });
      }
      return parseRecord(parsed, keyHash);
    },
    write: async (record: HappierCreateIntentRecord): Promise<void> => {
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
