import type {
  HappierBackend,
  HappierJsonRecord,
} from "./types.js";

export type HappierCanonicalSession = Readonly<{
  canonicalSessionUri: string;
  providerId: HappierBackend;
  nativeSessionId: string;
}>;

export type HappierPersistedBinding = HappierCanonicalSession & Readonly<{
  happierSessionId: string;
  serverProfileId: string;
  machineId: string;
}>;

export type HappierBoundIdentity = Readonly<{
  canonicalSessionUri: string;
  providerId: HappierBackend;
  nativeSessionId: string;
  happierSessionId: string;
  serverProfileId: string;
  machineId: string;
}>;

function isRecord(value: unknown): value is HappierJsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value: unknown, maximum = 2_000): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > maximum || /[\u0000-\u001f\u007f]/u.test(trimmed)) return undefined;
  return trimmed;
}

export function parseHappierCanonicalSessionUri(value: string): HappierCanonicalSession | null {
  try {
    const uri = new URL(value);
    const providerId = uri.protocol.slice(0, -1);
    if (providerId !== "codex" && providerId !== "claude" && providerId !== "opencode") return null;
    const expectedHost = providerId === "codex" ? "threads" : "sessions";
    if (
      uri.hostname !== expectedHost
      || uri.username
      || uri.password
      || uri.port
      || uri.search
      || uri.hash
    ) return null;
    const path = uri.pathname.replace(/^\/+/u, "");
    const nativeSessionId = nonEmptyString(decodeURIComponent(path), 512);
    if (!nativeSessionId || nativeSessionId.includes("/")) return null;
    const canonicalSessionUri =
      `${providerId}://${expectedHost}/${encodeURIComponent(nativeSessionId)}`;
    if (value !== canonicalSessionUri) return null;
    return {
      canonicalSessionUri,
      providerId,
      nativeSessionId,
    };
  } catch {
    return null;
  }
}

function parsePersistedBinding(value: unknown): HappierPersistedBinding | null {
  if (!isRecord(value)) return null;
  const allowedFields = new Set([
    "canonicalSessionUri",
    "happierSessionId",
    "serverProfileId",
    "machineId",
    "takeoverConfirmedAt",
  ]);
  if (Object.keys(value).some((key) => !allowedFields.has(key))) return null;
  const canonical = typeof value.canonicalSessionUri === "string"
    ? parseHappierCanonicalSessionUri(value.canonicalSessionUri)
    : null;
  const happierSessionId = nonEmptyString(value.happierSessionId, 512);
  const serverProfileId = nonEmptyString(value.serverProfileId, 512);
  const machineId = nonEmptyString(value.machineId, 512);
  if (!canonical || !happierSessionId || !serverProfileId || !machineId) return null;
  if (value.takeoverConfirmedAt !== undefined) {
    const historicalTakeover = nonEmptyString(value.takeoverConfirmedAt, 128);
    if (!historicalTakeover || !Number.isFinite(Date.parse(historicalTakeover))) return null;
  }
  return { ...canonical, happierSessionId, serverProfileId, machineId };
}

/**
 * Defensive runtime validation for Core-owned persisted bindings. Only an
 * exact server-profile + machine + provider + canonical-session + Happier
 * target duplicate is collapsed; every mapping fork fails closed.
 */
export function parseHappierPersistedBindings(
  value: readonly unknown[],
): readonly HappierPersistedBinding[] {
  const parsed = value.map(parsePersistedBinding);
  if (parsed.some((binding) => binding === null)) {
    // PluginStore rejects this before persistence. If a caller bypasses that
    // authority, expose no binding instead of letting malformed metadata grant
    // connector access or crash plugin registration.
    return Object.freeze([]);
  }
  const sorted = (parsed as HappierPersistedBinding[]).sort((left, right) => [
    left.serverProfileId,
    left.machineId,
    left.providerId,
    left.canonicalSessionUri,
    left.happierSessionId,
  ].join("\u0000").localeCompare([
    right.serverProfileId,
    right.machineId,
    right.providerId,
    right.canonicalSessionUri,
    right.happierSessionId,
  ].join("\u0000"), "en"));
  const byExact = new Map<string, HappierPersistedBinding>();
  const byCanonical = new Map<string, string>();
  const byHappier = new Map<string, string>();
  for (const binding of sorted) {
    const tuple = [
      binding.serverProfileId,
      binding.machineId,
      binding.providerId,
      binding.canonicalSessionUri,
    ].join("\u0000");
    const exact = `${tuple}\u0000${binding.happierSessionId}`;
    if (
      (byCanonical.has(binding.canonicalSessionUri) && byCanonical.get(binding.canonicalSessionUri) !== exact)
      || (byHappier.has(binding.happierSessionId) && byHappier.get(binding.happierSessionId) !== tuple)
    ) {
      throw new Error("Happier Session binding identity conflict");
    }
    byCanonical.set(binding.canonicalSessionUri, exact);
    byHappier.set(binding.happierSessionId, tuple);
    byExact.set(exact, binding);
  }
  return Object.freeze([...byExact.values()]);
}
