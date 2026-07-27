import { createHash } from "node:crypto";

import type { CliSession, NotificationPayload, Task } from "@fusion/core";

export const CLI_AGENT_AWAITING_INPUT_EVENT = "cli-agent-awaiting-input" as const;

export interface CliAgentAwaitingInputNotificationInfo {
  sessionId: string;
  notification: Record<string, unknown> | undefined;
}

function stableNotificationJson(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? String(value);
  if (Array.isArray(value)) return `[${value.map((entry) => stableNotificationJson(entry)).join(",")}]`;
  const record = value as Record<string, unknown>;
  const fields = Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableNotificationJson(record[key])}`);
  return `{${fields.join(",")}}`;
}

function buildCliAgentNotificationDedupeKey(input: {
  projectId: string;
  info: CliAgentAwaitingInputNotificationInfo;
  session: CliSession | undefined;
}): string {
  const notificationFingerprint = createHash("sha256")
    .update(stableNotificationJson(input.info.notification ?? null))
    .digest("hex")
    .slice(0, 16);
  const waitingEpoch = input.session?.updatedAt ?? "unknown-waiting-epoch";
  return [
    "cli-agent",
    input.projectId,
    input.info.sessionId,
    CLI_AGENT_AWAITING_INPUT_EVENT,
    waitingEpoch,
    notificationFingerprint,
  ].join(":");
}

export function buildCliAgentAwaitingInputNotificationPayload(input: {
  projectId: string;
  info: CliAgentAwaitingInputNotificationInfo;
  session: CliSession | undefined;
  task: Task | undefined;
}): NotificationPayload {
  const taskId = input.session?.taskId ?? undefined;
  const adapterId = input.session?.adapterId;
  const notificationKind = typeof input.info.notification?.kind === "string"
    ? input.info.notification.kind
    : "waiting_on_input";

  return {
    ...(taskId ? { taskId } : {}),
    taskTitle: input.task?.title,
    taskDescription: input.task?.description,
    event: CLI_AGENT_AWAITING_INPUT_EVENT,
    metadata: {
      sessionId: input.info.sessionId,
      projectId: input.projectId,
      ...(adapterId ? { adapterId } : {}),
      notificationKind,
      notification: input.info.notification ?? null,
      // FNXC:ToolPermissionNotifications 2026-06-27-00:00: CLI adapters can emit duplicate waiting-on-input records for one blocked prompt. The external notification path carries a waiting-epoch plus prompt-fingerprint key so repeated telemetry for the same blocked prompt does not spam providers, while later tool requests in the same session still notify operators.
      notificationDedupeKey: buildCliAgentNotificationDedupeKey(input),
    },
  };
}
