/**
 * FNXC:HappierRuntime 2026-07-13-14:48:
 * Task 1 exposes only the official Happier JSON CLI contract. Authentication,
 * encryption, provider credentials, and transcripts remain owned by Happier;
 * these types deliberately contain no credential-setting surface.
 */

export const HAPPIER_BACKENDS = ["codex", "claude", "opencode"] as const;

export type HappierBackend = (typeof HAPPIER_BACKENDS)[number];

export interface HappierCliSettings {
  executable?: string;
  entrypoint?: string;
  serverUrl?: string;
  webappUrl?: string;
  profile?: string;
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
  timeoutSeconds: number;
}

export type HappierSessionCreateResult = HappierJsonRecord & { sessionId: string; session: HappierJsonRecord; created: boolean };
export type HappierSessionMessageResult = HappierJsonRecord & { sessionId: string; localId?: string | null; waited?: boolean };
export type HappierSessionStatusResult = HappierJsonRecord & { sessionId: string; session: HappierJsonRecord };
export type HappierSessionHistoryResult = HappierJsonRecord & { sessionId: string; format: string; messages: unknown[] };

export type HappierRuntimeState =
  | "starting"
  | "ready"
  | "running"
  | "waitingOnInput"
  | "recovering"
  | "blocked"
  | "completed"
  | "failed";

export interface AgentRuntimeContext {
  sessionPurpose?: string;
  toolMode?: "coding" | "readonly";
  customToolNames?: string[];
  requestedSkillNames?: string[];
}

export interface AgentRuntimeOptions {
  cwd: string;
  systemPrompt: string;
  tools?: "coding" | "readonly";
  onText?: (text: string) => void;
  onThinking?: (text: string) => void;
  onToolStart?: (toolName: string, args?: unknown) => void;
  onToolEnd?: (toolName: string, isError: boolean, result?: unknown) => void;
  defaultProvider?: string;
  defaultModelId?: string;
  defaultThinkingLevel?: string;
  runtimeContext?: AgentRuntimeContext;
  /** Native id loaded from the canonical Fusion CLI session record. */
  sessionId?: string | null;
}

export interface HappierSessionState {
  status: HappierRuntimeState;
  messages: unknown[];
  errorMessage?: string;
}

export interface HappierAgentSession {
  model: undefined;
  cwd: string;
  systemPrompt: string;
  messages: unknown[];
  state: HappierSessionState;
  thinkingLevel: string | undefined;
  sessionId: string;
  lastModelDescription: string;
  callbacks: Pick<AgentRuntimeOptions, "onText" | "onThinking" | "onToolStart" | "onToolEnd">;
  runtimeContext?: AgentRuntimeContext;
  dispose(): void;
}

export type AgentSession = HappierAgentSession;

export interface AgentSessionResult {
  session: AgentSession;
  sessionFile?: string;
}

export interface AgentRuntime {
  readonly id: string;
  readonly name: string;
  createSession(options: AgentRuntimeOptions): Promise<AgentSessionResult>;
  promptWithFallback(session: AgentSession, prompt: string, options?: unknown): Promise<void>;
  describeModel(session: AgentSession): string;
}

export type HappierRecoveryErrorCode =
  | "session-missing"
  | "session-not-resumable"
  | "status-check-failed"
  | "ambiguous-send-unresolved";
