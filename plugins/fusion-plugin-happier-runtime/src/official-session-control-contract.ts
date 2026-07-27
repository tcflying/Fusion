import type { HappierJsonRecord } from "./types.js";

export const HAPPIER_OFFICIAL_SESSION_CONTROL_SOURCE = Object.freeze({
  repository: "https://github.com/happier-dev/happier",
  sourceCommit: "6e059c41d865343c1efc9c98676e5af3882d85ff",
  sourceModule: "packages/protocol/src/sessionControl/contract.ts",
  contract: "sessionControl/v1",
  package: "@happier-dev/protocol",
  packagePublication: "private_workspace_package",
} as const);

export const HAPPIER_OFFICIAL_MCP_TOOLS = {
  list: "session_list",
  status: "session_status_get",
  send: "session_message_send",
  wait: "session_wait_idle",
  history: "session_history_get",
  stop: "session_stop",
} as const;

export type HappierOfficialMcpToolName =
  (typeof HAPPIER_OFFICIAL_MCP_TOOLS)[keyof typeof HAPPIER_OFFICIAL_MCP_TOOLS];

export interface HappierOfficialSessionSendResult extends HappierJsonRecord {
  readonly sessionId: string;
  readonly localId: string;
  readonly waited: boolean;
}

export interface HappierOfficialSessionWaitResult extends HappierJsonRecord {
  readonly sessionId: string;
  readonly idle: true;
  readonly observedAt: number;
}

export interface HappierOfficialRawHistoryResult extends HappierJsonRecord {
  readonly sessionId: string;
  readonly format: "raw";
  readonly messages: readonly HappierJsonRecord[];
}

export type HappierOfficialSendValidation =
  | Readonly<{ ok: true; value: HappierOfficialSessionSendResult }>
  | Readonly<{
    ok: false;
    reason: "send_session_mismatch" | "send_local_id_mismatch" | "send_waited_mismatch";
  }>;

export type HappierOfficialWaitValidation =
  | Readonly<{ ok: true; value: HappierOfficialSessionWaitResult }>
  | Readonly<{
    ok: false;
    reason: "wait_session_mismatch" | "wait_not_idle" | "wait_observed_at_invalid";
  }>;

export type HappierOfficialHistoryValidation =
  | Readonly<{ ok: true; value: HappierOfficialRawHistoryResult }>
  | Readonly<{
    ok: false;
    reason: "history_session_mismatch" | "raw_history_unavailable";
  }>;

/**
 * FNXC:HappierOfficialTypedContract 2026-07-27-04:50:
 * This adapter mirrors the pinned upstream Zod result types because the
 * official protocol package is private to the Happier workspace. It preserves
 * upstream passthrough semantics while centralizing every field assertion used
 * by CLI/MCP paths; source commit and module are part of compatibility proof.
 */
export function validateOfficialSessionSendResult(
  record: HappierJsonRecord,
  expected: Readonly<{ sessionId: string; localId: string; waited: boolean }>,
): HappierOfficialSendValidation {
  if (record.sessionId !== expected.sessionId) return { ok: false, reason: "send_session_mismatch" };
  if (record.localId !== expected.localId) return { ok: false, reason: "send_local_id_mismatch" };
  if (record.waited !== expected.waited) return { ok: false, reason: "send_waited_mismatch" };
  return { ok: true, value: record as HappierOfficialSessionSendResult };
}

export function validateOfficialSessionWaitResult(
  record: HappierJsonRecord,
  expectedSessionId: string,
): HappierOfficialWaitValidation {
  if (record.sessionId !== expectedSessionId) return { ok: false, reason: "wait_session_mismatch" };
  if (record.idle !== true) return { ok: false, reason: "wait_not_idle" };
  if (
    typeof record.observedAt !== "number"
    || !Number.isSafeInteger(record.observedAt)
    || record.observedAt < 0
    || !Number.isFinite(new Date(record.observedAt).getTime())
  ) return { ok: false, reason: "wait_observed_at_invalid" };
  return { ok: true, value: record as HappierOfficialSessionWaitResult };
}

export function validateOfficialRawHistoryResult(
  record: HappierJsonRecord,
  expectedSessionId: string,
): HappierOfficialHistoryValidation {
  if (record.sessionId !== expectedSessionId) return { ok: false, reason: "history_session_mismatch" };
  if (record.format !== "raw" || !Array.isArray(record.messages)) {
    return { ok: false, reason: "raw_history_unavailable" };
  }
  return { ok: true, value: record as HappierOfficialRawHistoryResult };
}
