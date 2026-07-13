/**
 * FNXC:HappierRuntime 2026-07-13-14:48:
 * Task 1 exposes only the official Happier JSON CLI contract. Authentication,
 * encryption, provider credentials, and transcripts remain owned by Happier;
 * these types deliberately contain no credential-setting surface.
 */

import type {
  AgentRuntime,
  AgentRuntimeNativeSessionBinding,
  AgentRuntimeOptions,
  AgentSessionResult,
} from "@fusion/engine/agent-runtime";

export type {
  AgentRuntime,
  AgentRuntimeNativeSessionBinding,
  AgentRuntimeOptions,
  AgentSessionResult,
} from "@fusion/engine/agent-runtime";

export type AgentSession = Parameters<AgentRuntime["promptWithFallback"]>[0];

export const HAPPIER_BACKENDS = ["codex", "claude", "opencode"] as const;

export type HappierBackend = (typeof HAPPIER_BACKENDS)[number];

export interface HappierCliSettings {
  executable?: string;
  entrypoint?: string;
  serverUrl?: string;
  webappUrl?: string;
  profile?: string;
  backend?: HappierBackend;
  timeoutMs?: number;
  maxOutputBytes?: number;
}

export interface HappierCliInvocation {
  command: string;
  args: string[];
}

export type HappierErrorCode =
  | "process"
  | "timeout"
  | "output-limit"
  | "invalid-json"
  | "authentication"
  | "server"
  | "daemon"
  | "backend"
  | "protocol"
  | "session";

export class HappierCliError extends Error {
  readonly name = "HappierCliError";

  constructor(
    readonly code: HappierErrorCode,
    message: string,
    readonly details?: {
      exitCode?: number | null;
      stdout?: string;
      stderr?: string;
    },
    readonly officialCode?: string,
  ) {
    super(message);
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export type HappierJsonRecord = Record<string, unknown>;

export interface HappierSuccessEnvelope<T = unknown> {
  v: 1;
  ok: true;
  kind: string;
  data: T;
}

export interface HappierFailureEnvelope {
  v: 1;
  ok: false;
  kind: string;
  error: {
    code: string;
    message?: string;
    [key: string]: unknown;
  };
}

export type HappierJsonEnvelope<T = unknown> = HappierSuccessEnvelope<T> | HappierFailureEnvelope;

export interface HappierSessionCreateInput {
  cwd: string;
  backend: HappierBackend;
  title: string;
}

export interface HappierMessageInput {
  sessionId: string;
  message: string;
  localId: string;
  timeoutSeconds: number;
}

export type HappierSessionCreateResult = HappierJsonRecord & { sessionId: string; session: HappierJsonRecord; created: boolean };
export type HappierSessionMessageResult = HappierJsonRecord & { sessionId: string; localId?: string | null; waited?: boolean };
export type HappierSessionStatusResult = HappierJsonRecord & { sessionId: string; session: HappierJsonRecord };
export interface HappierRawHistoryRow {
  id: string;
  localId?: string;
  createdAt: number;
  role: string;
  raw: Record<string, unknown>;
}
export type HappierSessionHistoryResult = HappierJsonRecord & { sessionId: string; format: string; messages: HappierRawHistoryRow[] };

export type HappierRuntimeState =
  | "starting"
  | "ready"
  | "running"
  | "waitingOnInput"
  | "recovering"
  | "blocked"
  | "completed"
  | "failed";

export interface HappierSessionState {
  status: HappierRuntimeState;
  messages: unknown[];
  errorMessage?: string;
}

export interface HappierAgentSessionShape {
  model: undefined;
  cwd: string;
  systemPrompt: string;
  messages: unknown[];
  state: HappierSessionState;
  thinkingLevel: string | undefined;
  sessionId: string;
  lastModelDescription: string;
  callbacks: Pick<AgentRuntimeOptions, "onText" | "onThinking" | "onToolStart" | "onToolEnd">;
  runtimeContext?: AgentRuntimeOptions["runtimeContext"];
  nativeSession: AgentRuntimeNativeSessionBinding;
  needsReconciliation: boolean;
  dispose(): void;
}

export type HappierAgentSession = AgentSession & HappierAgentSessionShape;

export type HappierRecoveryErrorCode =
  | "session-missing"
  | "session-not-resumable"
  | "status-check-failed"
  | "native-session-binding-missing"
  | "native-session-persistence-failed"
  | "history-reconciliation-failed"
  | "ambiguous-send-unresolved";
