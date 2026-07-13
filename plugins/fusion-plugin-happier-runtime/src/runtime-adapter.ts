/**
 * FNXC:HappierRuntime 2026-07-13-19:42:
 * Fusion owns scheduling and canonical native-id persistence while Happier
 * owns the native session and transcript. Each Fusion runtime session has a
 * private queue; ambiguous sends are reconciled once and are never resent.
 */

import {
  createHappierSession,
  getHappierSessionHistory,
  getHappierSessionStatus,
  resolveHappierCliSettings,
  sendHappierMessage,
} from "./cli-spawn.js";
import type { HappierCliSettings, HappierSessionHistoryResult, HappierSessionStatusResult } from "./types.js";
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

const HISTORY_LIMIT = 50;
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

interface NormalizedHistoryMessage {
  key: string;
  identifiers: string[];
  role?: string;
  text?: string;
  postIndex: number;
}

interface HistoryReconciliation {
  history: HappierSessionHistoryResult;
  status: HappierSessionStatusResult;
  added: NormalizedHistoryMessage[];
}

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
    (record.agentState && typeof record.agentState === "object" ? readStatusValue(record.agentState) : undefined) ??
    (record.session && typeof record.session === "object" ? readStatusValue(record.session) : undefined)
  );
}

function statusProvesResumable(result: { session: Record<string, unknown>; agentState?: Record<string, unknown> }): boolean {
  const session = result.session;
  const agentState = result.agentState;
  if (session.resumable === false || agentState?.resumable === false) return false;
  if (session.resumable === true || agentState?.resumable === true) return true;
  if (session.active === false) return false;
  if (session.active === true) return true;
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

function messageText(content: unknown): string | undefined {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const text = content.map((part) => messageText(part)).filter((part): part is string => part !== undefined).join("");
    return text || undefined;
  }
  if (!content || typeof content !== "object") return undefined;
  const record = content as Record<string, unknown>;
  return nonEmptyString(record.text) ?? messageText(record.content);
}

function normalizeMessage(message: unknown, postIndex: number): NormalizedHistoryMessage {
  if (!message || typeof message !== "object") {
    return { key: `value:${JSON.stringify(message)}`, identifiers: [], postIndex };
  }
  const record = message as Record<string, unknown>;
  const identifiers = [record.id, record.localId, record.messageId]
    .map(nonEmptyString)
    .filter((value): value is string => value !== undefined);
  let serialized: string;
  try {
    serialized = JSON.stringify(message);
  } catch {
    serialized = String(message);
  }
  return {
    key: identifiers[0] ? `id:${identifiers[0]}` : `value:${serialized}`,
    identifiers,
    role: nonEmptyString(record.role)?.toLowerCase(),
    text: messageText(record.content),
    postIndex,
  };
}

function addedHistoryMessages(before: unknown[], after: unknown[]): NormalizedHistoryMessage[] {
  const remaining = new Map<string, number>();
  for (const message of before.map(normalizeMessage)) {
    remaining.set(message.key, (remaining.get(message.key) ?? 0) + 1);
  }
  const added: NormalizedHistoryMessage[] = [];
  after.map(normalizeMessage).forEach((message) => {
    const count = remaining.get(message.key) ?? 0;
    if (count > 0) {
      remaining.set(message.key, count - 1);
    } else {
      added.push(message);
    }
  });
  return added;
}

function isAmbiguousSendError(error: unknown): boolean {
  return error instanceof HappierCliError && ["timeout", "process", "server", "daemon"].includes(error.code);
}

function asHappierSession(session: AgentSession): HappierAgentSession {
  return session as HappierAgentSession;
}

export class HappierRuntimeAdapter implements AgentRuntime {
  readonly id = "happier";
  readonly name = "Happier Runtime";

  private readonly settings: ReturnType<typeof resolveHappierCliSettings>;
  private readonly backend: HappierBackend;
  private readonly timeoutSeconds: number;
  private readonly sessionQueues = new WeakMap<object, Promise<void>>();

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
    if (!options.nativeSession) {
      throw new HappierRecoveryError(
        "native-session-binding-missing",
        "Happier runtime requires a canonical Fusion native-session binding",
        "",
      );
    }
    const sessionId = nonEmptyString(options.nativeSession.nativeSessionId) ?? "";
    const session = {
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
      nativeSession: options.nativeSession,
      needsReconciliation: Boolean(sessionId),
      needsPersistence: false,
      dispose: () => undefined,
    } as unknown as HappierAgentSession & { needsPersistence: boolean };
    return { session, sessionFile: undefined };
  }

  promptWithFallback(session: AgentSession, prompt: string, _options?: unknown): Promise<void> {
    if (!prompt.trim()) return Promise.reject(new HappierCliError("session", "Happier message is required"));
    const happierSession = asHappierSession(session) as HappierAgentSession & { needsPersistence: boolean };
    const prior = this.sessionQueues.get(session) ?? Promise.resolve();
    const current = prior.catch(() => undefined).then(() => this.runPrompt(happierSession, prompt));
    this.sessionQueues.set(session, current);
    return current.finally(() => {
      if (this.sessionQueues.get(session) === current) this.sessionQueues.delete(session);
    });
  }

  describeModel(session: AgentSession): string {
    return asHappierSession(session).lastModelDescription || this.describeFromSettings();
  }

  private async runPrompt(
    session: HappierAgentSession & { needsPersistence: boolean },
    prompt: string,
  ): Promise<void> {
    let localUserMessageAdded = false;
    try {
      if (!session.sessionId) {
        session.state.status = "starting";
        const created = await createHappierSession(
          { cwd: session.cwd, backend: this.backend, title: "Fusion Happier session" },
          this.settings,
        );
        session.sessionId = created.sessionId;
        session.needsPersistence = true;
      }

      if (session.needsPersistence) {
        try {
          await session.nativeSession.persistNativeSessionId(session.sessionId);
          session.nativeSession.nativeSessionId = session.sessionId;
          session.needsPersistence = false;
        } catch (error) {
          session.state.status = "blocked";
          throw new HappierRecoveryError(
            "native-session-persistence-failed",
            `Unable to persist Happier session ${session.sessionId}`,
            session.sessionId,
            error,
          );
        }
      }

      if (session.needsReconciliation) {
        await this.reconcilePersistedSession(session);
        session.needsReconciliation = false;
      }

      const before = await getHappierSessionHistory(session.sessionId, HISTORY_LIMIT, this.settings);
      session.state.status = "running";
      session.messages.push({ role: "user", content: prompt });
      session.state.messages = session.messages;
      localUserMessageAdded = true;

      try {
        const result = await sendHappierMessage(
          { sessionId: session.sessionId, message: prompt, timeoutSeconds: this.timeoutSeconds },
          this.settings,
        );
        const history = await getHappierSessionHistory(session.sessionId, HISTORY_LIMIT, this.settings);
        const status = await getHappierSessionStatus(session.sessionId, this.settings);
        const added = addedHistoryMessages(before.messages, history.messages);
        this.recordAssistantOutput(session, added, result.localId ?? undefined);
        session.state.status = statusToRuntimeState(status) ?? "ready";
      } catch (error) {
        if (!isAmbiguousSendError(error)) throw error;
        const reconciled = await this.reconcileAmbiguousSend(session, before, prompt, error);
        this.recordAssistantOutput(session, reconciled.added);
        session.state.status = statusToRuntimeState(reconciled.status) ?? "ready";
      }

      session.state.errorMessage = undefined;
    } catch (error) {
      if (localUserMessageAdded) session.messages.pop();
      session.state.messages = session.messages;
      session.state.errorMessage = error instanceof Error ? error.message : String(error);
      if (error instanceof HappierRecoveryError) {
        if (session.state.status !== "blocked") {
          session.state.status = error.code === "status-check-failed" ? "recovering" : "blocked";
        }
      } else {
        session.state.status = "failed";
      }
      throw error;
    }
  }

  private async reconcilePersistedSession(session: HappierAgentSession): Promise<void> {
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

  private async reconcileAmbiguousSend(
    session: HappierAgentSession,
    before: HappierSessionHistoryResult,
    prompt: string,
    originalError: unknown,
  ): Promise<HistoryReconciliation> {
    try {
      const status = await getHappierSessionStatus(session.sessionId, this.settings);
      const history = await getHappierSessionHistory(session.sessionId, HISTORY_LIMIT, this.settings);
      const added = addedHistoryMessages(before.messages, history.messages);
      const accepted = added.some((message) => message.role === "user" && message.text === prompt);
      if (!accepted) {
        throw new HappierRecoveryError(
          "ambiguous-send-unresolved",
          `Happier send outcome is ambiguous for session ${session.sessionId}`,
          session.sessionId,
          originalError,
        );
      }
      return { status, history, added };
    } catch (error) {
      if (error instanceof HappierRecoveryError) throw error;
      throw new HappierRecoveryError(
        "ambiguous-send-unresolved",
        `Happier send outcome is ambiguous for session ${session.sessionId}`,
        session.sessionId,
        { originalError, reconciliationError: error },
      );
    }
  }

  private recordAssistantOutput(
    session: HappierAgentSession,
    added: NormalizedHistoryMessage[],
    localId?: string,
  ): void {
    const localMessage = localId
      ? added.find((message) => message.identifiers.includes(localId))
      : undefined;
    const assistantMessages = added.filter((message) =>
      message.role === "assistant" &&
      message.text !== undefined &&
      (!localMessage || message.postIndex > localMessage.postIndex),
    );
    for (const message of assistantMessages) {
      session.messages.push({ role: "assistant", content: message.text });
      session.callbacks.onText?.(message.text!);
    }
    session.state.messages = session.messages;
  }

  private describeFromSettings(): string {
    return `happier/${this.backend}`;
  }
}

export type { HappierRuntimeState } from "./types.js";
