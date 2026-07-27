/**
 * Side-effect-free skills.sh search client shared by Dashboard and CLI.
 *
 * Keep this module independent of the Dashboard server/core barrels so CLI
 * search does not initialize unrelated runtime integrations.
 */

/** Search mechanism and fallback diagnostics for a search response. */
export interface SkillsSearchMetadata {
  source: string;
  fallbackUsed: boolean;
  fallbackSource?: string;
  warning?: string;
}

export type UpstreamErrorCode =
  | "upstream_timeout"
  | "upstream_http_error"
  | "upstream_invalid_payload";

export interface UpstreamError {
  error: string;
  code: UpstreamErrorCode;
}

export interface PublicSkillsSearchEntry {
  id: string;
  skillId: string;
  name: string;
  installs: number;
  source: string;
}

export interface PublicSkillsSearchResult {
  skills: PublicSkillsSearchEntry[];
  search: SkillsSearchMetadata;
}

const MAX_PUBLIC_SEARCH_FALLBACK_TOKENS = 4;
const SEMANTIC_SEARCH_FALLBACK_WARNING =
  "Semantic skill search was unavailable; showing keyword fallback results.";

function buildSearchUrl(baseUrl: string, limit: number, query: string): string {
  const params = new URLSearchParams();
  params.set("q", query);
  params.set("limit", String(limit));
  return `${baseUrl.replace(/\/$/, "")}/api/search?${params.toString()}`;
}

function publicSearchTokens(query: string): string[] {
  const tokens =
    query.toLocaleLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}._+-]*/gu) ?? [];
  return [...new Set(tokens)].slice(0, MAX_PUBLIC_SEARCH_FALLBACK_TOKENS);
}

function normalizePublicSearchEntry(entry: unknown): PublicSkillsSearchEntry | null {
  if (!entry || typeof entry !== "object") return null;
  const record = entry as Record<string, unknown>;
  const source = String(record.source ?? record.repo ?? "");
  const skillId = String(record.skillId ?? record.slug ?? record.name ?? "");
  const id = String(record.id ?? (source && skillId ? `${source}/${skillId}` : skillId));
  const name = String(record.name ?? record.title ?? skillId);
  if (!id || !name) return null;
  return {
    id,
    skillId: skillId || name,
    name,
    installs: typeof record.installs === "number" ? record.installs : 0,
    source,
  };
}

function fallbackSourceFor(searchTypes: Iterable<string>): string {
  const normalized = [...searchTypes].map((value) => value.toLocaleLowerCase());
  if (normalized.some((value) => value.includes("fts"))) return "sqlite-fts";
  if (normalized.some((value) => value.includes("fuzzy"))) return "skills.sh-fuzzy";
  if (normalized.some((value) => value.includes("brute"))) return "brute-force";
  return (
    normalized.find((value) => value && value !== "semantic" && value !== "unknown")
    ?? "brute-force"
  );
}

function searchMetadataFromResponse(
  query: string,
  record: Record<string, unknown>,
): SkillsSearchMetadata {
  const source =
    typeof record.searchType === "string" && record.searchType.trim()
      ? record.searchType.trim()
      : "unknown";
  const explicitFallbackSource =
    typeof record.fallbackSource === "string" && record.fallbackSource.trim()
      ? record.fallbackSource.trim()
      : undefined;
  const explicitWarning =
    typeof record.warning === "string" && record.warning.trim()
      ? record.warning.trim()
      : undefined;
  const semanticWasRequested = publicSearchTokens(query).length > 1;
  const fallbackUsed =
    record.fallbackUsed === true
    || explicitFallbackSource !== undefined
    || explicitWarning !== undefined
    || (semanticWasRequested && source !== "semantic" && source !== "unknown");

  return {
    source,
    fallbackUsed,
    ...(fallbackUsed
      ? { fallbackSource: explicitFallbackSource ?? fallbackSourceFor([source]) }
      : {}),
    ...(explicitWarning
      ? { warning: explicitWarning }
      : fallbackUsed
        ? { warning: SEMANTIC_SEARCH_FALLBACK_WARNING }
        : {}),
  };
}

function isTimeoutError(error: Error): boolean {
  return (
    error.name === "TimeoutError"
    || error.name === "AbortError"
    || /timed?\s*out/i.test(error.message)
  );
}

async function fetchPublicSearchOnce(
  baseUrl: string,
  limit: number,
  query: string,
  fetchImpl: typeof fetch,
): Promise<PublicSkillsSearchResult | UpstreamError> {
  try {
    const response = await fetchImpl(buildSearchUrl(baseUrl, limit, query), {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      return {
        error: `Upstream returned ${response.status}: ${response.statusText}`,
        code: "upstream_http_error",
      };
    }

    let data: unknown;
    try {
      data = await response.json();
    } catch {
      return {
        error: "Invalid upstream response format",
        code: "upstream_invalid_payload",
      };
    }
    if (!data || typeof data !== "object") {
      return {
        error: "Invalid upstream response format",
        code: "upstream_invalid_payload",
      };
    }

    const record = data as Record<string, unknown>;
    const rawSkills = Array.isArray(record.skills)
      ? record.skills
      : Array.isArray(record.data)
        ? record.data
        : null;
    if (!rawSkills) {
      return {
        error: "Invalid upstream response format: expected { skills: [...] } or { data: [...] }",
        code: "upstream_invalid_payload",
      };
    }

    return {
      skills: rawSkills.flatMap((entry) => {
        const normalized = normalizePublicSearchEntry(entry);
        return normalized ? [normalized] : [];
      }),
      search: searchMetadataFromResponse(query, record),
    };
  } catch (err) {
    const error = err as Error;
    if (isTimeoutError(error)) {
      return { error: "Upstream request timed out", code: "upstream_timeout" };
    }
    return {
      error: error.message || "Upstream request failed",
      code: "upstream_http_error",
    };
  }
}

/*
 * FNXC:SkillsSearchFallback 2026-07-27-02:38:
 * Multi-word skills.sh queries normally use semantic search. If sqlite-vec/semantic search is unavailable or returns no observable result, retry at most four unique tokens through the upstream fuzzy/FTS path, merge duplicate hits deterministically, and report warning plus fallbackSource. A total upstream failure remains an error rather than an empty successful search.
 */
export async function searchPublicSkillsWithFallback(input: {
  baseUrl?: string;
  limit: number;
  query: string;
  fetchImpl?: typeof fetch;
}): Promise<PublicSkillsSearchResult | UpstreamError> {
  const baseUrl = input.baseUrl ?? "https://skills.sh";
  const fetchImpl = input.fetchImpl ?? fetch;
  const query = input.query.trim();
  const primary = await fetchPublicSearchOnce(baseUrl, input.limit, query, fetchImpl);
  const tokens = publicSearchTokens(query);
  if (!("error" in primary)) {
    if (primary.skills.length > 0 || tokens.length < 2 || primary.search.fallbackUsed) {
      return primary;
    }
  } else if (tokens.length < 2) {
    return primary;
  }

  const fallbackAttempts = await Promise.all(
    tokens.map(async (token) => ({
      token,
      result: await fetchPublicSearchOnce(baseUrl, input.limit, token, fetchImpl),
    })),
  );
  const successfulAttempts = fallbackAttempts.filter(
    (attempt): attempt is { token: string; result: PublicSkillsSearchResult } =>
      !("error" in attempt.result),
  );
  if (successfulAttempts.length === 0) {
    return "error" in primary ? primary : fallbackAttempts[0]!.result;
  }

  const merged = new Map<
    string,
    {
      entry: PublicSkillsSearchEntry;
      tokenHits: Set<string>;
    }
  >();
  for (const attempt of successfulAttempts) {
    for (const entry of attempt.result.skills) {
      const existing = merged.get(entry.id);
      if (existing) {
        existing.tokenHits.add(attempt.token);
        if (entry.installs > existing.entry.installs) existing.entry = entry;
      } else {
        merged.set(entry.id, { entry, tokenHits: new Set([attempt.token]) });
      }
    }
  }

  const skills = [...merged.values()]
    .sort(
      (left, right) =>
        right.tokenHits.size - left.tokenHits.size
        || right.entry.installs - left.entry.installs
        || left.entry.name.localeCompare(right.entry.name),
    )
    .slice(0, input.limit)
    .map(({ entry }) => entry);
  const fallbackSource = fallbackSourceFor(
    successfulAttempts.map((attempt) => attempt.result.search.source),
  );

  return {
    skills,
    search: {
      source: "brute-force",
      fallbackUsed: true,
      fallbackSource,
      warning: SEMANTIC_SEARCH_FALLBACK_WARNING,
    },
  };
}
