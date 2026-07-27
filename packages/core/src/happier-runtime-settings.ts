import {
  isAbsolute,
  relative,
  resolve,
} from "node:path";

export const HAPPIER_RUNTIME_PLUGIN_ID = "fusion-plugin-happier-runtime";
export const HAPPIER_RUNTIME_SETTING_KEYS = new Set([
  "executable",
  "entrypoint",
  "allowedCliRoots",
  "homeDir",
  "activeServerId",
  "serverUrl",
  "publicServerUrl",
  "webappUrl",
  "profile",
  "backend",
  "timeoutMs",
  "spawnTimeoutMs",
  "connectTimeoutMs",
  "toolTimeoutMs",
  "waitTimeoutMs",
  "waitTimeoutGraceMs",
  "timeoutSeconds",
  "maxOutputBytes",
  "enableLocalRuntimeSnapshot",
  "enableLocalReconciliationHistory",
  "enableLocalProviderTelemetry",
  "createIntentDirectory",
  "deliveryFenceDirectory",
  "happierSessionBindings",
]);

export type HappierRuntimeBackend = "codex" | "claude" | "opencode";

export type HappierRuntimeSessionBinding = Readonly<{
  canonicalSessionUri: string;
  happierSessionId: string;
  serverProfileId: string;
  machineId: string;
  takeoverConfirmedAt?: string;
}>;

export type NormalizedHappierSessionBindings = Readonly<{
  bindings: readonly HappierRuntimeSessionBinding[];
  errors: readonly string[];
}>;

const HAPPIER_SESSION_BINDING_FIELDS = new Set([
  "canonicalSessionUri",
  "happierSessionId",
  "serverProfileId",
  "machineId",
  "takeoverConfirmedAt",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function safeHappierSettingString(value: unknown, maximum = 512): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed && trimmed.length <= maximum && !/[\u0000-\u001f\u007f]/u.test(trimmed) ? trimmed : null;
}

export function canonicalHappierSessionUri(value: unknown): string | null {
  const candidate = safeHappierSettingString(value, 2_000);
  if (!candidate) return null;
  try {
    const uri = new URL(candidate);
    const providerId = uri.protocol.slice(0, -1);
    if (providerId !== "codex" && providerId !== "claude" && providerId !== "opencode") return null;
    const expectedHost = providerId === "codex" ? "threads" : "sessions";
    if (uri.hostname !== expectedHost || uri.username || uri.password || uri.port || uri.search || uri.hash) return null;
    const nativeSessionId = safeHappierSettingString(decodeURIComponent(uri.pathname.replace(/^\/+/u, "")), 512);
    if (!nativeSessionId || nativeSessionId.includes("/")) return null;
    const canonical = `${providerId}://${expectedHost}/${encodeURIComponent(nativeSessionId)}`;
    return candidate === canonical ? canonical : null;
  } catch {
    return null;
  }
}

function providerFromCanonicalSession(canonicalSessionUri: string): HappierRuntimeBackend {
  return canonicalSessionUri.slice(0, canonicalSessionUri.indexOf(":")) as HappierRuntimeBackend;
}

function normalizeBinding(value: unknown): HappierRuntimeSessionBinding | null {
  if (!isRecord(value)) return null;
  if (Object.keys(value).some((key) => !HAPPIER_SESSION_BINDING_FIELDS.has(key))) return null;
  const canonicalSessionUri = canonicalHappierSessionUri(value.canonicalSessionUri);
  const happierSessionId = safeHappierSettingString(value.happierSessionId);
  const serverProfileId = safeHappierSettingString(value.serverProfileId);
  const machineId = safeHappierSettingString(value.machineId);
  if (!canonicalSessionUri || !happierSessionId || !serverProfileId || !machineId) return null;
  const takeoverConfirmedAt = value.takeoverConfirmedAt === undefined
    ? undefined
    : safeHappierSettingString(value.takeoverConfirmedAt, 128);
  if (
    value.takeoverConfirmedAt !== undefined
    && (!takeoverConfirmedAt || !Number.isFinite(Date.parse(takeoverConfirmedAt)))
  ) return null;
  return {
    canonicalSessionUri,
    happierSessionId,
    serverProfileId,
    machineId,
    ...(takeoverConfirmedAt ? { takeoverConfirmedAt } : {}),
  };
}

function bindingIdentity(binding: HappierRuntimeSessionBinding): string {
  return [
    binding.serverProfileId,
    binding.machineId,
    providerFromCanonicalSession(binding.canonicalSessionUri),
    binding.canonicalSessionUri,
  ].join("\u0000");
}

function exactBindingIdentity(binding: HappierRuntimeSessionBinding): string {
  return `${bindingIdentity(binding)}\u0000${binding.happierSessionId}`;
}

/**
 * FNXC:HappierBindingIdentity 2026-07-27-04:23:
 * Persisted bindings are compared as server-profile + machine + provider +
 * canonical-session identities. Exact duplicate mappings collapse; every
 * canonical or Happier-id fork is rejected independent of input order.
 */
export function normalizeHappierSessionBindings(value: unknown): NormalizedHappierSessionBindings {
  if (!Array.isArray(value)) {
    return { bindings: [], errors: ["happierSessionBindings must be an array"] };
  }
  const parsed: HappierRuntimeSessionBinding[] = [];
  const errors = new Set<string>();
  for (const candidate of value) {
    const binding = normalizeBinding(candidate);
    if (!binding) errors.add("Happier binding is invalid or contains unsupported fields");
    else parsed.push(binding);
  }
  if (errors.size > 0) return { bindings: [], errors: [...errors].sort() };

  parsed.sort((left, right) => {
    const identityOrder = exactBindingIdentity(left).localeCompare(exactBindingIdentity(right), "en");
    if (identityOrder !== 0) return identityOrder;
    return (left.takeoverConfirmedAt ?? "").localeCompare(right.takeoverConfirmedAt ?? "", "en");
  });
  const byExactIdentity = new Map<string, HappierRuntimeSessionBinding>();
  const byCanonicalSession = new Map<string, string>();
  const byHappierSession = new Map<string, string>();
  for (const binding of parsed) {
    const identity = bindingIdentity(binding);
    const exactIdentity = exactBindingIdentity(binding);
    const priorCanonical = byCanonicalSession.get(binding.canonicalSessionUri);
    if (priorCanonical !== undefined && priorCanonical !== exactIdentity) {
      errors.add(`Happier binding conflict for canonical Session ${binding.canonicalSessionUri}`);
    }
    const priorHappier = byHappierSession.get(binding.happierSessionId);
    if (priorHappier !== undefined && priorHappier !== identity) {
      errors.add(`Happier binding conflict for Happier Session ${binding.happierSessionId}`);
    }
    byCanonicalSession.set(binding.canonicalSessionUri, exactIdentity);
    byHappierSession.set(binding.happierSessionId, identity);
    const priorExact = byExactIdentity.get(exactIdentity);
    if (
      !priorExact
      || (binding.takeoverConfirmedAt ?? "") > (priorExact.takeoverConfirmedAt ?? "")
    ) {
      byExactIdentity.set(exactIdentity, binding);
    }
  }
  if (errors.size > 0) return { bindings: [], errors: [...errors].sort() };
  return {
    bindings: Object.freeze([...byExactIdentity.values()]),
    errors: [],
  };
}

function samePath(left: string, right: string): boolean {
  return process.platform === "win32"
    ? left.toLocaleLowerCase("en-US") === right.toLocaleLowerCase("en-US")
    : left === right;
}

function pathWithin(root: string, candidate: string): boolean {
  const child = relative(root, candidate);
  return child === "" || (!child.startsWith("..") && !isAbsolute(child));
}

function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function validateHttpUrl(value: unknown, key: string, errors: string[]): void {
  if (value === undefined) return;
  const candidate = safeHappierSettingString(value, 2_000);
  if (!candidate) {
    errors.push(`Happier ${key} must be a non-empty URL`);
    return;
  }
  try {
    const url = new URL(candidate);
    if (
      (url.protocol !== "http:" && url.protocol !== "https:")
      || url.username
      || url.password
      || url.hash
    ) errors.push(`Happier ${key} must be an HTTP(S) URL without credentials or a fragment`);
  } catch {
    errors.push(`Happier ${key} must be a valid URL`);
  }
}

/**
 * Cross-field validation used by every PluginStore write path. Runtime probes
 * repeat filesystem/hash checks because persistence validation alone is not
 * evidence that the selected artifact stayed unchanged.
 */
export function validateHappierRuntimeSettings(settings: Record<string, unknown>): string[] {
  const errors: string[] = [];
  const unsupported = Object.keys(settings).filter((key) => !HAPPIER_RUNTIME_SETTING_KEYS.has(key));
  if (unsupported.length > 0) errors.push(`Unsupported Happier setting(s): ${unsupported.sort().join(", ")}`);

  const backend = settings.backend;
  if (backend !== undefined && backend !== "codex" && backend !== "claude" && backend !== "opencode") {
    errors.push("Happier backend must be codex, claude, or opencode");
  }

  const normalizedBindings = "happierSessionBindings" in settings
    ? normalizeHappierSessionBindings(settings.happierSessionBindings)
    : { bindings: [], errors: [] };
  errors.push(...normalizedBindings.errors);
  const providers = new Set(normalizedBindings.bindings.map((binding) =>
    providerFromCanonicalSession(binding.canonicalSessionUri)));
  if (typeof backend === "string") {
    for (const provider of [...providers].sort()) {
      if (provider !== backend) errors.push(`Happier backend conflicts with persisted Session provider ${provider}`);
    }
  } else if (providers.size > 1) {
    errors.push("Happier backend must be explicit when persisted Sessions use multiple providers");
  }
  const activeServerId = safeHappierSettingString(settings.activeServerId);
  if (settings.activeServerId !== undefined && !activeServerId) {
    errors.push("Happier activeServerId is invalid");
  } else if (activeServerId) {
    for (const profileId of [...new Set(normalizedBindings.bindings.map((binding) => binding.serverProfileId))].sort()) {
      if (profileId !== activeServerId) errors.push(`Happier activeServerId conflicts with persisted server profile ${profileId}`);
    }
  }

  const executable = settings.executable;
  if (executable !== undefined) {
    const candidate = safeHappierSettingString(executable, 4_096);
    if (!candidate || !isAbsolute(candidate) || !samePath(resolve(candidate), resolve(process.execPath))) {
      errors.push("Happier executable must be the current absolute Node executable");
    }
  }
  const entrypoint = settings.entrypoint;
  const allowedCliRoots = settings.allowedCliRoots;
  if (allowedCliRoots !== undefined && (
    !Array.isArray(allowedCliRoots)
    || allowedCliRoots.length === 0
    || allowedCliRoots.length > 8
    || allowedCliRoots.some((root) => !safeHappierSettingString(root, 4_096) || !isAbsolute(String(root)))
  )) {
    errors.push("Happier allowedCliRoots must contain one through eight absolute paths");
  }
  if (entrypoint !== undefined) {
    const candidate = safeHappierSettingString(entrypoint, 4_096);
    const roots = Array.isArray(allowedCliRoots)
      ? allowedCliRoots.filter((root): root is string => typeof root === "string" && isAbsolute(root))
      : [];
    if (!candidate || !isAbsolute(candidate)) {
      errors.push("Happier entrypoint must be an absolute path");
    } else if (roots.length === 0 || !roots.some((root) => {
      if (!pathWithin(resolve(root), resolve(candidate))) return false;
      return relative(resolve(root), resolve(candidate)).replaceAll("\\", "/") === "apps/cli/package-dist/index.mjs";
    })) {
      errors.push("Happier entrypoint must be the pinned package-dist path inside an allowed CLI root");
    }
  } else if (allowedCliRoots !== undefined) {
    errors.push("Happier entrypoint is required when allowedCliRoots is configured");
  }

  const numericBounds: ReadonlyArray<readonly [string, number, number]> = [
    ["timeoutMs", 100, 3_600_000],
    ["spawnTimeoutMs", 100, 300_000],
    ["connectTimeoutMs", 100, 300_000],
    ["toolTimeoutMs", 100, 3_600_000],
    ["waitTimeoutMs", 100, 3_605_000],
    ["waitTimeoutGraceMs", 100, 300_000],
    ["timeoutSeconds", 1, 3_600],
    ["maxOutputBytes", 1, 64 * 1024 * 1024],
  ];
  for (const [key, minimum, maximum] of numericBounds) {
    const value = settings[key];
    if (value !== undefined && (!finiteNumber(value) || !Number.isInteger(value) || value < minimum || value > maximum)) {
      errors.push(`Happier ${key} must be an integer from ${minimum} through ${maximum}`);
    }
  }
  if (finiteNumber(settings.waitTimeoutMs)) {
    const innerSeconds = finiteNumber(settings.timeoutSeconds) ? settings.timeoutSeconds : 300;
    const graceMs = finiteNumber(settings.waitTimeoutGraceMs) ? settings.waitTimeoutGraceMs : 5_000;
    if (settings.waitTimeoutMs < innerSeconds * 1_000 + graceMs) {
      errors.push("Happier waitTimeoutMs must cover timeoutSeconds plus waitTimeoutGraceMs");
    }
  }

  for (const key of [
    "enableLocalRuntimeSnapshot",
    "enableLocalReconciliationHistory",
    "enableLocalProviderTelemetry",
  ]) {
    if (settings[key] !== undefined && typeof settings[key] !== "boolean") {
      errors.push(`Happier ${key} must be boolean`);
    }
  }
  for (const key of ["homeDir", "createIntentDirectory", "deliveryFenceDirectory"]) {
    const value = settings[key];
    if (value !== undefined && (
      !safeHappierSettingString(value, 4_096)
      || !isAbsolute(String(value))
    )) errors.push(`Happier ${key} must be an absolute path`);
  }
  for (const key of ["profile"]) {
    if (settings[key] !== undefined && !safeHappierSettingString(settings[key])) {
      errors.push(`Happier ${key} is invalid`);
    }
  }
  validateHttpUrl(settings.serverUrl, "serverUrl", errors);
  validateHttpUrl(settings.publicServerUrl, "publicServerUrl", errors);
  validateHttpUrl(settings.webappUrl, "webappUrl", errors);
  return [...new Set(errors)].sort();
}
