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

/**
 * FNXC:HappierOfficialMcpBridge 2026-07-19-19:29:
 * A Direct UI operator records the exact already-existing Happier session that
 * represents a native provider session. Fusion never derives this mapping from
 * a `codex://`, `claude://`, or `opencode://` URI; writes additionally require
 * recorded manual takeover evidence from that UI.
 */
export interface HappierSessionBinding {
  readonly canonicalSessionUri: string;
  readonly happierSessionId: string;
  readonly serverProfileId: string;
  readonly machineId: string;
  readonly takeoverConfirmedAt?: string;
}

export interface HappierCliSettings {
  executable?: string;
  entrypoint?: string;
  homeDir?: string;
  activeServerId?: string;
  serverUrl?: string;
  publicServerUrl?: string;
  webappUrl?: string;
  profile?: string;
  backend?: HappierBackend;
  happierSessionBindings?: readonly HappierSessionBinding[];
  /**
   * Opt in to Fusion's separately-versioned local Happier MCP extension. This
   * never changes which operations are treated as official MCP capabilities.
   */
  enableLocalRuntimeSnapshot?: boolean;
  /**
   * FNXC:HappierReconciliationHistoryConfig 2026-07-20-12:04:
   * Opt in to Fusion's separately-versioned local, cursor-preserving Happier
   * history extension. It is not an upstream MCP capability and is used only
   * for fail-closed durable reconciliation.
   */
  enableLocalReconciliationHistory?: boolean;
  /**
   * FNXC:HappierProviderTelemetryConfig 2026-07-21-02:51:
   * Explicitly opt in to the non-official local MCP telemetry read. It can
   * report only a fresh persisted in-band snapshot and never grants provider,
   * dispatch, or capacity readiness.
   */
  enableLocalProviderTelemetry?: boolean;
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

export type HappierDirectSessionEnsureResult = {
  providerId: "codex" | "claude" | "opencode";
  remoteSessionId: string;
  machineId: string;
  serverId: string;
  sessionId: string;
  created: boolean;
  openUrl: string;
};

export type HappierDirectSessionSource =
  | { readonly kind: "codexHome"; readonly home: "user" }
  | { readonly kind: "claudeConfig" }
  | { readonly kind: "opencodeServer" };

export interface HappierDirectSessionTranscriptInput {
  readonly providerId: HappierBackend;
  readonly remoteSessionId: string;
  readonly sessionId: string;
  readonly machineId: string;
  readonly afterCursor: string | null;
  readonly limit: number;
}

export interface HappierDirectSessionTranscriptRawMessage {
  readonly id: string;
  readonly createdAtMs: number;
  readonly localId?: string | null;
  readonly raw: Readonly<Record<string, unknown>>;
}

export interface HappierDirectSessionTranscriptDelta {
  readonly machineId: string;
  readonly providerId: HappierBackend;
  readonly remoteSessionId: string;
  readonly sessionId: string;
  readonly source: HappierDirectSessionSource;
  readonly fromCursor: string | null;
  readonly nextCursor: string | null;
  readonly truncated: boolean;
  readonly items: readonly HappierDirectSessionTranscriptRawMessage[];
}

export interface HappierDirectSessionStatusDelta {
  readonly eventType: "status";
  readonly machineId: string;
  readonly providerId: HappierBackend;
  readonly remoteSessionId: string;
  readonly sessionId: string;
  readonly source: HappierDirectSessionSource;
  readonly isRunning: boolean;
  readonly lastActivityAtMs: number | null;
  readonly observedAtMs: number;
}

export type HappierDirectSessionEvent =
  | HappierDirectSessionTranscriptDelta
  | HappierDirectSessionStatusDelta;

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
  | "provider-process-failed"
  | "ambiguous-send-unresolved";
