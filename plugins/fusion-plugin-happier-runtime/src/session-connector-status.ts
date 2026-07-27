import type { SessionConnectorStatusV1 } from "@fusion/core";

import type { HappierJsonRecord } from "./types.js";

function isRecord(value: unknown): value is HappierJsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value: unknown, maximum = 2_000): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > maximum || /[\u0000-\u001f\u007f]/u.test(trimmed)) return undefined;
  return trimmed;
}

export function sessionIdFromRecord(record: HappierJsonRecord): string | undefined {
  return nonEmptyString(record.sessionId, 512)
    ?? (isRecord(record.session) ? nonEmptyString(record.session.id, 512) : undefined)
    ?? nonEmptyString(record.id, 512);
}

export function statusState(record: HappierJsonRecord): SessionConnectorStatusV1["state"] {
  const session = isRecord(record.session) ? record.session : record;
  const agentState = isRecord(record.agentState) ? record.agentState : undefined;
  const raw = nonEmptyString(agentState?.status)
    ?? nonEmptyString(agentState?.state)
    ?? nonEmptyString(session.status)
    ?? nonEmptyString(session.state);
  switch (raw?.toLowerCase()) {
    case "waiting":
    case "waitingoninput":
    case "awaiting_input":
    case "waiting_input":
      return "waiting_input";
    case "running":
    case "active":
    case "busy":
    case "starting":
    case "recovering":
      return "running";
    case "paused":
    case "blocked":
      return "paused";
    case "failed":
    case "error":
    case "lost":
    case "unavailable":
      return "lost";
    default:
      return session.active === true ? "idle" : session.active === false ? "lost" : "unknown";
  }
}

export function isoTimestamp(value: unknown): string | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

export function statusLastActivity(record: HappierJsonRecord): string | null {
  const session = isRecord(record.session) ? record.session : record;
  const agentState = isRecord(record.agentState) ? record.agentState : undefined;
  for (const value of [
    session.lastActivityAt,
    session.updatedAt,
    agentState?.lastActivityAt,
    agentState?.updatedAt,
    record.lastActivityAt,
    record.updatedAt,
  ]) {
    const parsed = isoTimestamp(value);
    if (parsed) return parsed;
  }
  return null;
}

export function sessionListContains(record: HappierJsonRecord, expectedSessionId: string): boolean {
  const sessions = Array.isArray(record.sessions)
    ? record.sessions
    : isRecord(record.data) && Array.isArray(record.data.sessions)
      ? record.data.sessions
      : [];
  return sessions.some((candidate) => isRecord(candidate) && sessionIdFromRecord(candidate) === expectedSessionId);
}
