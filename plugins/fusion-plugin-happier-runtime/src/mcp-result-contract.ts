import type { HappierMcpToolResult } from "./happier-mcp-client.js";
import {
  HappierCliError,
  type HappierJsonRecord,
} from "./types.js";

function isRecord(value: unknown): value is HappierJsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value: unknown, maximum = 2_000): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > maximum || /[\u0000-\u001f\u007f]/u.test(trimmed)) return undefined;
  return trimmed;
}

export interface HappierApprovalRequiredOutcome {
  readonly kind: "approval_required";
  readonly actionState: "approval_request_created";
  readonly artifactId: string;
  readonly operation: string;
}

/**
 * FNXC:HappierApprovalOutcome 2026-07-27-15:58:
 * CLI JSON and MCP structured results must converge on one typed waiting
 * outcome. Creating an approval artifact is never provider execution, so every
 * caller receives the same artifact and operation without inferring success.
 */
export class HappierApprovalRequiredError extends Error {
  readonly actionState = "approval_request_created" as const;
  readonly artifactId: string;
  readonly operation: string;

  constructor(readonly outcome: HappierApprovalRequiredOutcome) {
    super("Happier requires an approval before the requested action executes");
    this.name = "HappierApprovalRequiredError";
    this.artifactId = outcome.artifactId;
    this.operation = outcome.operation;
  }
}

export { HappierApprovalRequiredError as HappierMcpApprovalRequestError };

const MAX_MCP_ACTION_RESULT_WRAPPER_DEPTH = 8;

export function happierApprovalOutcomeFromActionRecord(
  value: HappierJsonRecord,
  operation: string,
): HappierApprovalRequiredOutcome | null {
  let current = value;
  for (let depth = 0; depth < MAX_MCP_ACTION_RESULT_WRAPPER_DEPTH; depth += 1) {
    if (current.kind === "approval_request_created") {
      const artifactId = nonEmptyString(current.artifactId, 512);
      if (!artifactId) {
        throw new HappierCliError(
          "protocol",
          `Happier ${operation} returned an approval request without an artifact identity`,
          undefined,
          "approval_artifact_missing",
        );
      }
      return Object.freeze({
        kind: "approval_required",
        actionState: "approval_request_created",
        artifactId,
        operation,
      });
    }
    const nested = isRecord(current.result)
      ? current.result
      : isRecord(current.data)
        ? current.data
        : null;
    if (!nested) return null;
    current = nested;
  }
  throw new HappierCliError("protocol", `Happier ${operation} exceeded the supported action-result wrapper depth`);
}

function extractMcpResultRecords(
  result: HappierMcpToolResult,
  operation: string,
): readonly HappierJsonRecord[] {
  const records: HappierJsonRecord[] = [];
  if (isRecord(result.structuredContent)) records.push(result.structuredContent);
  if (Array.isArray(result.content)) {
    for (const item of result.content) {
      if (!isRecord(item) || item.type !== "text" || typeof item.text !== "string") continue;
      try {
        const parsed: unknown = JSON.parse(item.text);
        if (isRecord(parsed)) records.push(parsed);
      } catch {
        // Continue to the next textual content item; no transcript text is surfaced.
      }
    }
  }
  if (records.length === 0) {
    throw new HappierCliError("protocol", `Happier MCP ${operation} returned no structured result`);
  }
  return records;
}

function throwMcpApprovalRequest(value: HappierJsonRecord, operation: string): never {
  const outcome = happierApprovalOutcomeFromActionRecord(value, operation);
  if (!outcome) {
    throw new HappierCliError("protocol", `Happier MCP ${operation} approval outcome is invalid`);
  }
  throw new HappierApprovalRequiredError(outcome);
}

function mapMcpOfficialErrorCode(officialCode: string): HappierCliError["code"] {
  switch (officialCode.toLowerCase().replace(/[-\s]/g, "_")) {
    case "not_authenticated":
    case "authentication_required":
    case "auth_required":
    case "unauthorized":
    case "forbidden":
    case "invalid_token":
    case "token_expired":
      return "authentication";
    case "timeout":
    case "timed_out":
      return "timeout";
    case "server_unreachable":
    case "server_unavailable":
    case "connection_failed":
    case "network_error":
      return "server";
    case "daemon_unavailable":
    case "daemon_not_running":
      return "daemon";
    case "backend_unavailable":
    case "backend_not_found":
    case "provider_unavailable":
    case "model_unavailable":
      return "backend";
    case "session_not_found":
    case "session_id_ambiguous":
    case "session_archived":
    case "session_unavailable":
    case "invalid_session":
      return "session";
    default:
      return "protocol";
  }
}

function throwMcpActionFailure(value: HappierJsonRecord, operation: string): never {
  const officialCode = nonEmptyString(value.errorCode, 128)
    ?? nonEmptyString(value.code, 128)
    ?? "mcp_action_failed";
  throw new HappierCliError(
    mapMcpOfficialErrorCode(officialCode),
    `Happier MCP ${operation} failed: ${officialCode}`,
    undefined,
    officialCode,
  );
}

function assertMcpActionApprovalSafe(value: HappierJsonRecord, operation: string): void {
  let current = value;
  for (let depth = 0; depth < MAX_MCP_ACTION_RESULT_WRAPPER_DEPTH; depth += 1) {
    if (current.kind === "approval_request_created") {
      throwMcpApprovalRequest(current, operation);
    }
    if (current.ok !== true || !isRecord(current.result)) return;
    current = current.result;
  }
  throw new HappierCliError("protocol", `Happier MCP ${operation} exceeded the supported action-result wrapper depth`);
}

function unwrapMcpActionResult(value: HappierJsonRecord, operation: string): HappierJsonRecord {
  let current = value;
  for (let depth = 0; depth < MAX_MCP_ACTION_RESULT_WRAPPER_DEPTH; depth += 1) {
    if (current.kind === "approval_request_created") {
      throwMcpApprovalRequest(current, operation);
    }
    if (current.ok === false) throwMcpActionFailure(current, operation);
    if (current.ok !== true || !isRecord(current.result)) return current;
    current = current.result;
  }
  throw new HappierCliError("protocol", `Happier MCP ${operation} exceeded the supported action-result wrapper depth`);
}

/**
 * Normalize the official action envelope once for every connector operation.
 * A secondary approval envelope can veto success but cannot replace a primary
 * official failure.
 */
export function mcpResultRecord(
  result: HappierMcpToolResult,
  operation: string,
): HappierJsonRecord {
  const records = extractMcpResultRecords(result, operation);
  const primary = records[0]!;
  if (result.isError === true) {
    assertMcpActionApprovalSafe(primary, operation);
    throwMcpActionFailure(primary, operation);
  }
  for (const record of records) assertMcpActionApprovalSafe(record, operation);
  return unwrapMcpActionResult(primary, operation);
}
