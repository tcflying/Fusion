/**
 * FNXC:HappierRuntime 2026-07-13-16:10:
 * Fusion owns scheduling while Happier owns the native session and transcript.
 * A persisted native id is status-checked before reuse; recovery never creates
 * a replacement implicitly, and ambiguous sends get one status/history check.
 */

import {
  createHappierSession,
  getHappierSessionHistory,
  getHappierSessionStatus,
  resolveHappierCliSettings,
  sendHappierMessage,
} from "./cli-spawn.js";
import type { HappierCliSettings } from "./types.js";
import {
  HAPPIER_BACKENDS,
  HappierCliError,
  type AgentRuntime,
  type AgentRuntimeOptions,
  type AgentSession,
  type AgentSessionResult,
  type HappierAgentSession,
  type HappierBackend,
  type HappierRecoveryErrorCode,
  type HappierRuntimeState,
} from "./types.js";

const RESUMABLE_STATES = new Set([
  "active",
  "idle",
  "ready",
  "running",
  "waiting",
  "waitingoninput",
  "paused",
  "recoverable",
]);

export class HappierRecoveryError extends Error {
  readonly name = "HappierRecoveryError";

  constructor(
    readonly code: HappierRecoveryErrorCode,
    message: string,
    readonly nativeSessionId: string,
    readonly cause?: unknown,
  ) {
    super(message);
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function readStatusValue(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  return (
    nonEmptyString(record.status) ??
    nonEmptyString(record.state) ??
    (record.agentState && typeof record.agentState === "object" ? readStatusValue(record.agentState) : undefined)
  );
}

function statusProvesResumable(result: { session: Record<string, unknown>; agentState?: Record<string, unknown> }): boolean {
  const session = result.session;
  const agentState = result.agentState;
  if (session.active === false || session.resumable === false || agentState?.resumable === false) return false;
  if (session.active === true || session.resumable === true || agentState?.resumable === true) return true;
  const state = (readStatusValue(agentState) ?? readStatusValue(session))?.toLowerCase();
  return state !== undefined && RESUMABLE_STATES.has(state);
}

function statusToRuntimeState(value: unknown): HappierRuntimeState | undefined {
  const status = readStatusValue(value)?.toLowerCase();
  if (!status) return undefined;
  if (status === "waiting" || status === "waitingoninput" || status === "awaiting_input") return "waitingOnInput";
  if (status === "running" || status === "active" || status === "busy") return "running";
  if (status === "completed" || status === "done") return "completed";
  if (status === "failed" || status === "error") return "failed";
  if (status === "blocked") return "blocked";
  if (status === "recovering") return "recovering";
  if (status === "starting") return "starting";
  return "ready";
}

function historyContainsPrompt(messages: unknown[], prompt: string): boolean {
  return messages.some((message) => {
    if (!message || typeof message !== "object") return false;
    const record = message as Record<string, unknown>;
    if (record.role !== undefined && record.role !== "user") return false;
    const content = record.content;
    if (typeof content === "string") return content === prompt;
    if (Array.isArray(content)) {
      return content.some((part) => typeof part === "object" && part !== null && (part as Record<string, unknown>).text === prompt);
    }
    if (content && typeof content === "object") {
      return (content as Record<string, unknown>).text === prompt;
    }
    return false;
  });
}

function isAmbiguousSendError(error: unknown): boolean {
  return error instanceof HappierCliError && ["timeout", "process", "server", "daemon"].includes(error.code);
}

export class HappierRuntimeAdapter implements AgentRuntime {
  readonly id = "happier";
  readonly name = "Happier Runtime";

  private readonly settings: ReturnType<typeof resolveHappierCliSettings>;
  private readonly backend: HappierBackend;
  private readonly timeoutSeconds: number;

  constructor(settings?: Record<string, unknown> | HappierCliSettings) {
    const raw = (settings ?? {}) as Record<string, unknown>;
    this.settings = resolveHappierCliSettings(settings);
    const configuredBackend = nonEmptyString(raw.backend);
    this.backend = HAPPIER_BACKENDS.includes(configuredBackend as HappierBackend)
      ? (configuredBackend as HappierBackend)
      : "codex";
    const configuredTimeout = Number(raw.timeoutSeconds ?? 120);
    this.timeoutSeconds = Number.isInteger(configuredTimeout) && configuredTimeout > 0 ? configuredTimeout : 120;
  }

  async createSession(options: AgentRuntimeOptions): Promise<AgentSessionResult> {
    const sessionId = nonEmptyString(options.sessionId) ?? "";
    const session: HappierAgentSession = {
      model: undefined,
      cwd: options.cwd,
      systemPrompt: options.systemPrompt,
      messages: [],
      state: {
        status: sessionId ? "recovering" : "ready",
        messages: [],
      },
      thinkingLevel: options.defaultThinkingLevel,
      sessionId,
      lastModelDescription: this.describeFromSettings(),
      callbacks: {
        onText: options.onText,
        onThinking: options.onThinking,
        onToolStart: options.onToolStart,
        onToolEnd: options.onToolEnd,
      },
      runtimeContext: options.runtimeContext,
      dispose: () => undefined,
    };
    return { session, sessionFile: undefined };
  }

  async promptWithFallback(session: AgentSession, prompt: string, _options?: unknown): Promise<void> {
    if (!prompt.trim()) throw new HappierCliError("session", "Happier message is required");
    session.state.status = "starting";

    if (!session.sessionId) {
      const created = await createHappierSession(
        { cwd: session.cwd, backend: this.backend, title: "Fusion Happier session" },
        this.settings,
      );
      session.sessionId = created.sessionId;
    } else if (session.state.status === "starting" || session.state.status === "recovering") {
      await this.reconcilePersistedSession(session);
    }

    session.state.status = "running";
    session.messages.push({ role: "user", content: prompt });
    session.state.messages = session.messages;
    try {
      const result = await this.send(session, prompt);
      session.state.errorMessage = undefined;
      this.recordResult(session, result);
    } catch (error) {
      session.messages.pop();
      session.state.errorMessage = error instanceof Error ? error.message : String(error);
      session.state.status = error instanceof HappierRecoveryError ? "recovering" : "failed";
      throw error;
    }
  }

  describeModel(session: AgentSession): string {
    return session.lastModelDescription || this.describeFromSettings();
  }

  private async reconcilePersistedSession(session: AgentSession): Promise<void> {
    session.state.status = "recovering";
    try {
      const status = await getHappierSessionStatus(session.sessionId, this.settings);
      if (!statusProvesResumable(status)) {
        session.state.status = "blocked";
        throw new HappierRecoveryError(
          "session-not-resumable",
          `Happier session ${session.sessionId} is not resumable`,
          session.sessionId,
        );
      }
    } catch (error) {
      if (error instanceof HappierRecoveryError) throw error;
      const code = error instanceof HappierCliError && error.code === "session" ? "session-missing" : "status-check-failed";
      session.state.status = code === "session-missing" ? "blocked" : "recovering";
      throw new HappierRecoveryError(
        code,
        `Unable to reconcile Happier session ${session.sessionId}`,
        session.sessionId,
        error,
      );
    }
  }

  private async send(session: AgentSession, prompt: string) {
    try {
      return await sendHappierMessage(
        { sessionId: session.sessionId, message: prompt, timeoutSeconds: this.timeoutSeconds },
        this.settings,
      );
    } catch (error) {
      if (!isAmbiguousSendError(error)) throw error;
      return this.reconcileAmbiguousSend(session, prompt, error);
    }
  }

  private async reconcileAmbiguousSend(session: AgentSession, prompt: string, originalError: unknown) {
    try {
      const status = await getHappierSessionStatus(session.sessionId, this.settings);
      if (!statusProvesResumable(status)) {
        throw new Error("Happier status did not prove the session resumable");
      }
      const history = await getHappierSessionHistory(session.sessionId, 50, this.settings);
      if (historyContainsPrompt(history.messages, prompt)) {
        return { sessionId: session.sessionId, waited: true };
      }
      return await sendHappierMessage(
        { sessionId: session.sessionId, message: prompt, timeoutSeconds: this.timeoutSeconds },
        this.settings,
      );
    } catch (error) {
      throw new HappierRecoveryError(
        "ambiguous-send-unresolved",
        `Happier send outcome is ambiguous for session ${session.sessionId}`,
        session.sessionId,
        { originalError, reconciliationError: error },
      );
    }
  }

  private recordResult(session: AgentSession, result: Record<string, unknown>): void {
    const state = statusToRuntimeState(result);
    session.state.status = state ?? (result.waited === false ? "waitingOnInput" : "ready");
    const text = nonEmptyString(result.body) ?? nonEmptyString(result.text);
    if (text) {
      session.messages.push({ role: "assistant", content: text });
      session.callbacks.onText?.(text);
    }
  }

  private describeFromSettings(): string {
    return `happier/${this.backend}`;
  }
}

export type { HappierRuntimeState } from "./types.js";
