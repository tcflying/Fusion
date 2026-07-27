/**
 * Compatibility barrel for the dashboard client API surface.
 *
 * Existing callers import from `../api` / `../../api`; keep this entrypoint stable
 * while implementation lives under `app/api/*` modules.
 */
import { getAuthToken } from "./auth";

export * from "./api/legacy";
export * from "./api/chat";
export * from "./api/happier-runtime";
export * from "./api-node";
export * from "./api/report";

/*
FNXC:DashboardApi 2026-07-27-15:50:
The compatibility barrel must expose focused-module contracts still consumed by AgentDetailView, AgentsView, and PlanningModeModal so package typechecking covers the same stable import surface as runtime loading.
*/
export {
  isAgentHeartbeatEnabled,
  withAgentHeartbeatEnabled,
} from "./api/agents";
export type { PlanningContextualComment } from "./api/planning";

export type HappierDirectSessionProviderId = "codex" | "claude" | "opencode";

export interface HappierDirectSessionDisconnected {
  connected: false;
  taskId: string;
}

export interface HappierDirectSessionConnected {
  connected: true;
  taskId: string;
  cliSessionId: string;
  nativeSessionId: string;
  providerId: HappierDirectSessionProviderId;
  happierSessionId: string;
  machineId: string;
  serverProfileId: string;
  linkedAt: string;
  openUrl: string;
}

export type HappierDirectSessionGetResponse =
  | HappierDirectSessionDisconnected
  | HappierDirectSessionConnected;

export type HappierDirectSessionResponse = HappierDirectSessionGetResponse;

export interface HappierDirectSessionPostResponse extends HappierDirectSessionConnected {
  created: boolean;
  agentId: string;
}

export interface ConnectHappierDirectSessionInput {
  uri: string;
  machineId?: string;
}

export class HappierDirectSessionApiError extends Error {
  readonly name = "HappierDirectSessionApiError";

  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

function happierDirectSessionUrl(taskId: string, projectId?: string): string {
  const search = new URLSearchParams();
  if (projectId) search.set("projectId", projectId);
  const query = search.size > 0 ? `?${search.toString()}` : "";
  return `/api/tasks/${encodeURIComponent(taskId)}/happier-direct-session${query}`;
}

async function happierDirectSessionRequest<TResponse>(
  taskId: string,
  projectId: string | undefined,
  init: RequestInit,
): Promise<TResponse> {
  const headers = new Headers(init.headers);
  headers.set("Content-Type", "application/json");
  const token = getAuthToken();
  if (token) headers.set("Authorization", `Bearer ${token}`);

  const response = await fetch(happierDirectSessionUrl(taskId, projectId), {
    ...init,
    headers,
  });
  const payload = await response.json().catch(() => null) as {
    error?: unknown;
    code?: unknown;
    details?: unknown;
  } | TResponse | null;

  if (!response.ok) {
    const errorPayload = payload && typeof payload === "object" ? payload as {
      error?: unknown;
      code?: unknown;
      details?: unknown;
    } : null;
    const message = typeof errorPayload?.error === "string"
      ? errorPayload.error
      : `Request failed: ${response.status} ${response.statusText}`;
    const details = errorPayload?.details && typeof errorPayload.details === "object" && !Array.isArray(errorPayload.details)
      ? errorPayload.details as Record<string, unknown>
      : undefined;
    const code = typeof errorPayload?.code === "string"
      ? errorPayload.code
      : typeof details?.code === "string"
        ? details.code
        : "request_failed";
    throw new HappierDirectSessionApiError(message, response.status, code, details);
  }

  return payload as TResponse;
}

/*
FNXC:HappierDirectSession 2026-07-15-21:02:
Task Detail reads and binds Happier sessions through task-scoped GET/POST calls. The POST body preserves the operator-entered native URI and optional machine ID exactly, while coded server failures remain available to retry and machine-selection UI.
*/
export function fetchHappierDirectSession(
  taskId: string,
  projectId?: string,
): Promise<HappierDirectSessionGetResponse> {
  return happierDirectSessionRequest<HappierDirectSessionGetResponse>(taskId, projectId, { method: "GET" });
}

export function connectHappierDirectSession(
  taskId: string,
  projectId: string | undefined,
  input: ConnectHappierDirectSessionInput,
): Promise<HappierDirectSessionPostResponse> {
  return happierDirectSessionRequest<HappierDirectSessionPostResponse>(taskId, undefined, {
    method: "POST",
    body: JSON.stringify({ projectId, ...input }),
  });
}
