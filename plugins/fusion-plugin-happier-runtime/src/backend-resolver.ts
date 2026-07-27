import {
  HAPPIER_BACKENDS,
  type HappierBackend,
  type HappierCliSettings,
} from "./types.js";

export const HAPPIER_DEFAULT_BACKEND: HappierBackend = "codex";

function isHappierBackend(value: unknown): value is HappierBackend {
  return typeof value === "string" && HAPPIER_BACKENDS.includes(value as HappierBackend);
}

const CANONICAL_SESSION_URI_PATTERNS: Readonly<Record<HappierBackend, RegExp>> = Object.freeze({
  codex: /^codex:\/\/threads\/[^/?#]+$/u,
  claude: /^claude:\/\/sessions\/[^/?#]+$/u,
  opencode: /^opencode:\/\/sessions\/[^/?#]+$/u,
});

/**
 * FNXC:HappierBackendResolver 2026-07-27-16:15:
 * Provider identity for an existing Session must come from the canonical URI
 * contract. Prefix guesses, alternate path families, and query fragments do
 * not authorize backend health or execution.
 */
export function resolveHappierBackendFromCanonicalSessionUri(
  canonicalSessionUri: unknown,
): HappierBackend | null {
  if (typeof canonicalSessionUri !== "string") return null;
  const normalized = canonicalSessionUri.trim();
  for (const backend of HAPPIER_BACKENDS) {
    if (CANONICAL_SESSION_URI_PATTERNS[backend].test(normalized)) return backend;
  }
  return null;
}

/**
 * FNXC:HappierBackendResolver 2026-07-27-04:04:
 * Runtime, health, and bound-session paths share one backend authority. An
 * explicit setting may narrow that authority, but it may never contradict the
 * provider encoded by a canonical bound Session identity.
 */
export function resolveHappierBackend(
  settings: Pick<HappierCliSettings, "backend"> | Record<string, unknown>,
  boundProvider?: HappierBackend,
): HappierBackend {
  const configured = settings.backend;
  if (configured !== undefined && !isHappierBackend(configured)) {
    throw new Error("Happier backend setting is unsupported");
  }
  if (configured && boundProvider && configured !== boundProvider) {
    throw new Error("Happier backend setting conflicts with the bound Session provider");
  }
  return configured ?? boundProvider ?? HAPPIER_DEFAULT_BACKEND;
}
