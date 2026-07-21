export const ROOM_CONTEXT_PROVIDER_POLICY_CONTRACT_VERSION = 1 as const;

export type RoomContextProviderRoleV1 =
  | "producer"
  | "reviewer"
  | "controller"
  | "operator"
  | "observer";
export type RoomContextProviderScopeV1 = "project" | "room" | "role";
export type RoomContextProviderVisibilityV1 = "room" | "private_review";

export interface RoomContextProviderProvenanceV1 {
  readonly recordId: string;
  readonly sourceHash: string;
  readonly producedAt: string;
  readonly producerBindingId: string;
  readonly projectHash: string;
}

/** A supplied context candidate, not permission to fetch data from its source. */
export interface RoomContextProviderRecordV1 {
  readonly contractVersion: 1;
  readonly id: string;
  readonly projectId: string;
  readonly scope: RoomContextProviderScopeV1;
  readonly roomId: string | null;
  readonly role: RoomContextProviderRoleV1 | null;
  readonly reviewerBindingIds: readonly string[];
  readonly visibility: RoomContextProviderVisibilityV1;
  readonly priority: number;
  readonly content: string;
  readonly provenance: RoomContextProviderProvenanceV1;
  readonly expiresAt: string | null;
}

export interface RoomContextProviderRequestV1 {
  readonly projectId: string;
  readonly roomId: string;
  readonly role: RoomContextProviderRoleV1;
  readonly requesterBindingId: string;
  readonly requestedAt: string;
  readonly maximumAgeMs: number;
}

export interface EvaluateRoomContextProviderPolicyInputV1 {
  readonly contractVersion: 1;
  readonly request: RoomContextProviderRequestV1;
  readonly records: readonly RoomContextProviderRecordV1[];
}

export type RoomContextProviderWithheldCodeV1 =
  | "unexpected_input_property"
  | "invalid_input"
  | "invalid_request"
  | "invalid_record"
  | "invalid_provenance"
  | "duplicate_record_id"
  | "cross_project_denied"
  | "room_scope_mismatch"
  | "role_scope_mismatch"
  | "private_review_withheld"
  | "expired_context"
  | "stale_context";

export interface RoomContextProviderWithheldV1 {
  readonly code: RoomContextProviderWithheldCodeV1;
  readonly recordId: string | null;
  readonly path: string;
  readonly message: string;
}

export interface RoomContextProviderRedactedContextV1 {
  readonly id: string;
  readonly scope: RoomContextProviderScopeV1;
  readonly sourceHash: string;
  readonly content: string;
  readonly redacted: boolean;
}

export interface RoomContextProviderDecisionV1 {
  /** This policy filters supplied candidates; it never authorizes source reads. */
  readonly externalDataReadAuthorized: false;
  readonly context: readonly RoomContextProviderRedactedContextV1[];
  readonly withheld: readonly RoomContextProviderWithheldV1[];
}

interface ParsedRequest {
  readonly projectId: string;
  readonly roomId: string;
  readonly role: RoomContextProviderRoleV1;
  readonly requesterBindingId: string;
  readonly requestedAtMs: number;
  readonly maximumAgeMs: number;
}

interface ParsedRecord {
  readonly id: string;
  readonly projectId: string;
  readonly scope: RoomContextProviderScopeV1;
  readonly roomId: string | null;
  readonly role: RoomContextProviderRoleV1 | null;
  readonly reviewerBindingIds: readonly string[];
  readonly visibility: RoomContextProviderVisibilityV1;
  readonly priority: number;
  readonly content: string;
  readonly sourceHash: string;
  readonly producedAtMs: number;
  readonly expiresAtMs: number | null;
}

const ROLES = new Set<string>(["producer", "reviewer", "controller", "operator", "observer"]);
const SCOPES = new Set<string>(["project", "room", "role"]);
const VISIBILITIES = new Set<string>(["room", "private_review"]);
const SHA_256_HASH = /^sha256:[a-f0-9]{64}$/;
const SECRET_PATTERN = /(?:\b(?:api[_-]?key|token|password|secret)\b\s*[:=]\s*\S+|\bbearer\s+\S+|\bsk-[A-Za-z0-9_-]{8,}\b)/i;

/*
FNXC:RoomContextProviderPolicy 2026-07-19-09:05:
Context is selected only from already-supplied, provenance-bound records. Scope,
freshness, reviewer privacy, and redaction are all evaluated before content is
returned; no input flag can authorize a cross-project or external source read.
This is a pure policy and not an external data-read, credential, or ACL grant.
*/

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isCanonicalTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function isHash(value: unknown): value is string {
  return typeof value === "string" && SHA_256_HASH.test(value);
}

function isUniqueStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every(isNonEmptyString) && new Set(value).size === value.length;
}

function addWithheld(
  withheld: RoomContextProviderWithheldV1[],
  code: RoomContextProviderWithheldCodeV1,
  recordId: string | null,
  path: string,
  message: string,
): void {
  withheld.push({ code, recordId, path, message });
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
}

function parseRequest(value: unknown, withheld: RoomContextProviderWithheldV1[]): ParsedRequest | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, [
    "projectId", "roomId", "role", "requesterBindingId", "requestedAt", "maximumAgeMs",
  ])) {
    addWithheld(withheld, "invalid_request", null, "$.request", "Request has an invalid shape");
    return undefined;
  }
  if (
    !isNonEmptyString(value.projectId)
    || !isNonEmptyString(value.roomId)
    || !isNonEmptyString(value.requesterBindingId)
    || typeof value.role !== "string"
    || !ROLES.has(value.role)
    || !isCanonicalTimestamp(value.requestedAt)
    || typeof value.maximumAgeMs !== "number"
    || !Number.isSafeInteger(value.maximumAgeMs)
    || value.maximumAgeMs <= 0
  ) {
    addWithheld(withheld, "invalid_request", null, "$.request", "Request scope or freshness limit is invalid");
    return undefined;
  }
  return {
    projectId: value.projectId,
    roomId: value.roomId,
    role: value.role as RoomContextProviderRoleV1,
    requesterBindingId: value.requesterBindingId,
    requestedAtMs: Date.parse(value.requestedAt),
    maximumAgeMs: value.maximumAgeMs,
  };
}

function parseRecord(
  value: unknown,
  index: number,
  withheld: RoomContextProviderWithheldV1[],
): ParsedRecord | undefined {
  const path = `$.records[${index}]`;
  const declaredId = isRecord(value) && isNonEmptyString(value.id) ? value.id : null;
  if (!isRecord(value) || !hasOnlyKeys(value, [
    "contractVersion", "id", "projectId", "scope", "roomId", "role", "reviewerBindingIds", "visibility",
    "priority", "content", "provenance", "expiresAt",
  ])) {
    addWithheld(withheld, "invalid_record", declaredId, path, "Context record has an invalid shape");
    return undefined;
  }
  if (
    value.contractVersion !== ROOM_CONTEXT_PROVIDER_POLICY_CONTRACT_VERSION
    || !isNonEmptyString(value.id)
    || !isNonEmptyString(value.projectId)
    || typeof value.scope !== "string"
    || !SCOPES.has(value.scope)
    || !isUniqueStringArray(value.reviewerBindingIds)
    || typeof value.visibility !== "string"
    || !VISIBILITIES.has(value.visibility)
    || typeof value.priority !== "number"
    || !Number.isSafeInteger(value.priority)
    || value.priority < 0
    || !isNonEmptyString(value.content)
  ) {
    addWithheld(withheld, "invalid_record", declaredId, path, "Context record contains invalid fields");
    return undefined;
  }
  const scope = value.scope as RoomContextProviderScopeV1;
  const role = value.role as unknown;
  const roomId = value.roomId as unknown;
  const scopeValid = (scope === "project" && roomId === null && role === null)
    || (scope === "room" && isNonEmptyString(roomId) && role === null)
    || (scope === "role" && isNonEmptyString(roomId) && typeof role === "string" && ROLES.has(role));
  if (!scopeValid || (value.visibility === "private_review" && value.reviewerBindingIds.length === 0)) {
    addWithheld(withheld, "invalid_record", value.id, path, "Context record scope or private-review audience is invalid");
    return undefined;
  }
  if (!isRecord(value.provenance) || !hasOnlyKeys(value.provenance, [
    "recordId", "sourceHash", "producedAt", "producerBindingId", "projectHash",
  ]) || !isNonEmptyString(value.provenance.recordId) || !isHash(value.provenance.sourceHash)
    || !isCanonicalTimestamp(value.provenance.producedAt) || !isNonEmptyString(value.provenance.producerBindingId)
    || !isHash(value.provenance.projectHash)) {
    addWithheld(withheld, "invalid_provenance", value.id, `${path}.provenance`, "Context provenance is not durable and hash-bound");
    return undefined;
  }
  if (value.expiresAt !== null && !isCanonicalTimestamp(value.expiresAt)) {
    addWithheld(withheld, "invalid_record", value.id, `${path}.expiresAt`, "Context expiry must be a canonical timestamp or null");
    return undefined;
  }
  return {
    id: value.id,
    projectId: value.projectId,
    scope,
    roomId: roomId as string | null,
    role: role as RoomContextProviderRoleV1 | null,
    reviewerBindingIds: [...value.reviewerBindingIds],
    visibility: value.visibility as RoomContextProviderVisibilityV1,
    priority: value.priority,
    content: value.content,
    sourceHash: value.provenance.sourceHash,
    producedAtMs: Date.parse(value.provenance.producedAt),
    expiresAtMs: value.expiresAt === null ? null : Date.parse(value.expiresAt),
  };
}

function redactContent(content: string): { readonly content: string; readonly redacted: boolean } {
  return SECRET_PATTERN.test(content)
    ? { content: "[REDACTED: secret material]", redacted: true }
    : { content, redacted: false };
}

/**
 * Deterministically filters caller-supplied context. It has no I/O and returns
 * `externalDataReadAuthorized: false` on every path so callers cannot mistake
 * candidate selection for permission to read provider, session, or secret data.
 */
export function evaluateRoomContextProviderPolicy(
  input: EvaluateRoomContextProviderPolicyInputV1,
): RoomContextProviderDecisionV1 {
  const withheld: RoomContextProviderWithheldV1[] = [];
  if (!isRecord(input)) {
    addWithheld(withheld, "invalid_input", null, "$", "Input must be an object");
    return { externalDataReadAuthorized: false, context: [], withheld };
  }
  const allowedInputKeys = ["contractVersion", "request", "records"];
  for (const key of Object.keys(input).sort()) {
    if (!allowedInputKeys.includes(key)) {
      addWithheld(withheld, "unexpected_input_property", null, `$.${key}`, "Caller extension is not authority");
    }
  }
  if (input.contractVersion !== ROOM_CONTEXT_PROVIDER_POLICY_CONTRACT_VERSION || !Array.isArray(input.records)) {
    addWithheld(withheld, "invalid_input", null, "$", "Input requires v1 request and candidate records");
    return { externalDataReadAuthorized: false, context: [], withheld };
  }
  const request = parseRequest(input.request, withheld);
  if (!request) return { externalDataReadAuthorized: false, context: [], withheld };

  const parsedRecords = input.records
    .map((record, index) => parseRecord(record, index, withheld))
    .filter((record): record is ParsedRecord => record !== undefined);
  const duplicateIds = new Set<string>();
  const seenIds = new Set<string>();
  for (const record of parsedRecords) {
    if (seenIds.has(record.id)) duplicateIds.add(record.id);
    seenIds.add(record.id);
  }

  const context: RoomContextProviderRedactedContextV1[] = [];
  for (const record of parsedRecords) {
    if (duplicateIds.has(record.id)) {
      addWithheld(withheld, "duplicate_record_id", record.id, "$.records", "Duplicate context ids are not authoritative");
      continue;
    }
    if (record.projectId !== request.projectId) {
      addWithheld(withheld, "cross_project_denied", record.id, "$.records.projectId", "Cross-project context is denied by default");
      continue;
    }
    if (record.scope !== "project" && record.roomId !== request.roomId) {
      addWithheld(withheld, "room_scope_mismatch", record.id, "$.records.roomId", "Context belongs to a different Room");
      continue;
    }
    if (record.scope === "role" && record.role !== request.role) {
      addWithheld(withheld, "role_scope_mismatch", record.id, "$.records.role", "Context belongs to a different role");
      continue;
    }
    if (record.visibility === "private_review" && (request.role !== "reviewer" || !record.reviewerBindingIds.includes(request.requesterBindingId))) {
      addWithheld(withheld, "private_review_withheld", record.id, "$.records.visibility", "Private review remains sealed from this requester");
      continue;
    }
    if (record.expiresAtMs !== null && record.expiresAtMs < request.requestedAtMs) {
      addWithheld(withheld, "expired_context", record.id, "$.records.expiresAt", "Context expired before this request");
      continue;
    }
    if (request.requestedAtMs - record.producedAtMs > request.maximumAgeMs) {
      addWithheld(withheld, "stale_context", record.id, "$.records.provenance.producedAt", "Context exceeds the requested freshness window");
      continue;
    }
    const redaction = redactContent(record.content);
    context.push({
      id: record.id,
      scope: record.scope,
      sourceHash: record.sourceHash,
      content: redaction.content,
      redacted: redaction.redacted,
    });
  }
  context.sort((left, right) => {
    const leftPriority = parsedRecords.find((record) => record.id === left.id)?.priority ?? 0;
    const rightPriority = parsedRecords.find((record) => record.id === right.id)?.priority ?? 0;
    return leftPriority - rightPriority || left.id.localeCompare(right.id);
  });
  return { externalDataReadAuthorized: false, context, withheld };
}
