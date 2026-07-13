/**
 * FNXC:HappierRuntime 2026-07-13-19:42:
 * Fusion owns scheduling and canonical native-id persistence while Happier
 * owns the native session and transcript. Each Fusion runtime session has a
 * private queue; ambiguous sends are reconciled once and are never resent.
 */

import { randomUUID } from "node:crypto";

import {
  archiveHappierSession,
  createHappierSession,
  getHappierSessionHistory,
  getHappierSessionStatus,
  resolveHappierCliSettings,
  sendHappierMessage,
} from "./cli-spawn.js";
import type {
  HappierCliSettings,
  HappierRawHistoryRow,
  HappierSessionHistoryResult,
  HappierSessionStatusResult,
} from "./types.js";
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

const HISTORY_LIMIT = 250;
const bindingQueues = new Map<string, Promise<void>>();
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

interface ParsedHistoryRow {
  id: string;
  localId?: string;
  createdAt: number;
  role: string;
  text?: string;
  postIndex: number;
}

interface HistoryWatermark {
  markerId?: string;
  markerCreatedAt?: number;
  rowIds: string[];
}

interface HistoryReconciliation {
  history: HappierSessionHistoryResult;
  status: HappierSessionStatusResult;
  added: ParsedHistoryRow[];
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

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function readFirstText(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return undefined;
  const parts: string[] = [];
  for (const item of value) {
    const record = asRecord(item);
    const text = record?.text ?? record?.content;
    if (typeof text === "string") parts.push(text);
  }
  return parts.length > 0 ? parts.join("") : undefined;
}

/** Parse only content variants emitted by Happier's official raw transcript row builder. */
function rawContentText(raw: Record<string, unknown>): string | undefined {
  const content = asRecord(raw.content);
  if (!content) return undefined;
  if (content.type === "text") return readFirstText(content.text);
  if (content.type === "output") {
    const data = asRecord(content.data);
    const message = asRecord(data?.message);
    return readFirstText(message?.content) ?? (typeof data?.text === "string" ? data.text : undefined);
  }
  if (content.type === "acp" || content.type === "codex" || content.type === "event") {
    const data = asRecord(content.data);
    return data?.type === "message" && typeof data.message === "string" ? data.message : undefined;
  }
  return undefined;
}

function parseRawHistoryRows(history: HappierSessionHistoryResult): ParsedHistoryRow[] {
  if (history.format !== "raw") {
    throw new Error(`expected raw history, received ${history.format}`);
  }
  const seenIds = new Set<string>();
  let priorCreatedAt = Number.NEGATIVE_INFINITY;
  return history.messages.map((message: HappierRawHistoryRow, postIndex) => {
    const record = asRecord(message);
    const id = nonEmptyString(record?.id);
    const role = nonEmptyString(record?.role)?.toLowerCase();
    const createdAt = record?.createdAt;
    const raw = asRecord(record?.raw);
    const localId = record?.localId === undefined ? undefined : nonEmptyString(record.localId);
    if (!id || !role || typeof createdAt !== "number" || !Number.isFinite(createdAt) || !raw) {
      throw new Error(`invalid raw history row at index ${postIndex}`);
    }
    if (record?.localId !== undefined && !localId) throw new Error(`invalid raw history localId at index ${postIndex}`);
    if (seenIds.has(id)) throw new Error(`duplicate raw history row id ${id}`);
    if (createdAt < priorCreatedAt) throw new Error(`raw history order regressed at row ${id}`);
    seenIds.add(id);
    priorCreatedAt = createdAt;
    return { id, ...(localId ? { localId } : {}), createdAt, role, text: rawContentText(raw), postIndex };
  });
}

function captureHistoryWatermark(history: HappierSessionHistoryResult): HistoryWatermark {
  const rows = parseRawHistoryRows(history);
  const marker = rows.at(-1);
  return {
    rowIds: rows.map((row) => row.id),
    ...(marker ? { markerId: marker.id, markerCreatedAt: marker.createdAt } : {}),
  };
}

function rowsAfterWatermark(
  watermark: HistoryWatermark,
  history: HappierSessionHistoryResult,
): ParsedHistoryRow[] {
  const rows = parseRawHistoryRows(history);
  if (!watermark.markerId) return rows;

  const markerIndex = rows.findIndex((row) => row.id === watermark.markerId);
  if (markerIndex < 0) throw new Error(`pre-send history marker ${watermark.markerId} disappeared`);
  const marker = rows[markerIndex];
  if (marker.createdAt !== watermark.markerCreatedAt) {
    throw new Error(`pre-send history marker ${watermark.markerId} changed timestamp`);
  }

  const preSendIds = new Set(watermark.rowIds);
  const retainedBeforeMarker = rows
    .slice(0, markerIndex + 1)
    .filter((row) => preSendIds.has(row.id))
    .map((row) => row.id);
  if (
    retainedBeforeMarker.length !== watermark.rowIds.length
    || retainedBeforeMarker.some((id, index) => id !== watermark.rowIds[index])
    || rows.slice(markerIndex + 1).some((row) => preSendIds.has(row.id))
  ) {
    throw new Error("bounded raw history no longer preserves pre-send transcript order");
  }

  const added = rows.slice(markerIndex + 1);
  if (added.some((row) => row.createdAt < marker.createdAt)) {
    throw new Error("post-watermark raw history regressed in time");
  }
  return added;
}

function correlatePromptOutput(
  watermark: HistoryWatermark,
  history: HappierSessionHistoryResult,
  localId: string,
): { added: ParsedHistoryRow[]; assistant: ParsedHistoryRow[] } {
  const added = rowsAfterWatermark(watermark, history);
  const matchingUsers = added.filter((row) => row.role === "user" && row.localId === localId);
  if (matchingUsers.length !== 1) {
    throw new Error(`expected one post-watermark user row for localId ${localId}, received ${matchingUsers.length}`);
  }
  const userIndex = matchingUsers[0].postIndex;
  const assistant = added.filter((row) =>
    row.postIndex > userIndex
    && (row.role === "assistant" || row.role === "agent")
    && row.text !== undefined,
  );
  return { added, assistant };
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
    const queueKey = happierSession.nativeSession.key;
    const prior = bindingQueues.get(queueKey) ?? Promise.resolve();
    const current = prior.catch(() => undefined).then(() => this.runPrompt(happierSession, prompt));
    const tail = current.then(() => undefined, () => undefined);
    bindingQueues.set(queueKey, tail);
    return current.finally(() => {
      if (bindingQueues.get(queueKey) === tail) bindingQueues.delete(queueKey);
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
      await this.ensureNativeSession(session);

      if (session.needsReconciliation) {
        await this.reconcilePersistedSession(session);
        session.needsReconciliation = false;
      }

      let watermark: HistoryWatermark;
      try {
        const before = await getHappierSessionHistory(session.sessionId, HISTORY_LIMIT, this.settings);
        watermark = captureHistoryWatermark(before);
      } catch (error) {
        session.state.status = "blocked";
        throw new HappierRecoveryError(
          "history-reconciliation-failed",
          `Unable to capture a trustworthy raw history watermark for Happier session ${session.sessionId}`,
          session.sessionId,
          error,
        );
      }
      session.state.status = "running";
      session.messages.push({ role: "user", content: prompt });
      session.state.messages = session.messages;
      localUserMessageAdded = true;
      const localId = `fusion-${randomUUID()}`;

      try {
        await sendHappierMessage(
          { sessionId: session.sessionId, message: prompt, localId, timeoutSeconds: this.timeoutSeconds },
          this.settings,
        );
        const history = await getHappierSessionHistory(session.sessionId, HISTORY_LIMIT, this.settings);
        const status = await getHappierSessionStatus(session.sessionId, this.settings);
        let correlated: ReturnType<typeof correlatePromptOutput>;
        try {
          correlated = correlatePromptOutput(watermark, history, localId);
          if (correlated.assistant.length === 0) {
            throw new Error("successful --wait history contained no correlated assistant text");
          }
        } catch (error) {
          session.state.status = "blocked";
          throw new HappierRecoveryError(
            "history-reconciliation-failed",
            `Unable to correlate Happier output after send for session ${session.sessionId}`,
            session.sessionId,
            error,
          );
        }
        this.recordAssistantOutput(session, correlated.assistant);
        session.state.status = statusToRuntimeState(status) ?? "ready";
      } catch (error) {
        if (error instanceof HappierCliError && error.code === "protocol") {
          session.state.status = "blocked";
          throw new HappierRecoveryError(
            "history-reconciliation-failed",
            `Happier send response could not be correlated for session ${session.sessionId}`,
            session.sessionId,
            error,
          );
        }
        if (!isAmbiguousSendError(error)) throw error;
        const reconciled = await this.reconcileAmbiguousSend(session, watermark, localId, error);
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

  private async ensureNativeSession(
    session: HappierAgentSession & { needsPersistence: boolean },
  ): Promise<void> {
    let persisted: string | null;
    try {
      persisted = await session.nativeSession.refreshNativeSessionId();
    } catch (error) {
      session.state.status = "blocked";
      throw new HappierRecoveryError(
        "native-session-persistence-failed",
        "Unable to refresh the canonical Fusion native session id",
        session.sessionId,
        error,
      );
    }
    if (persisted) {
      const learnedPersistedId = !session.sessionId;
      if (session.sessionId && session.sessionId !== persisted) {
        session.state.status = "blocked";
        throw new HappierRecoveryError(
          "native-session-persistence-failed",
          `Canonical native session changed from ${session.sessionId} to ${persisted}`,
          session.sessionId,
        );
      }
      session.sessionId = persisted;
      session.nativeSession.nativeSessionId = persisted;
      session.needsPersistence = false;
      if (learnedPersistedId) session.needsReconciliation = true;
      return;
    }

    session.state.status = "starting";
    const created = await createHappierSession(
      { cwd: session.cwd, backend: this.backend, title: "Fusion Happier session" },
      this.settings,
    );
    let claim: { claimed: boolean; nativeSessionId: string };
    try {
      claim = await session.nativeSession.claimNativeSessionId(created.sessionId);
    } catch (error) {
      session.state.status = "blocked";
      throw new HappierRecoveryError(
        "native-session-persistence-failed",
        `Unable to atomically claim Happier session ${created.sessionId}`,
        created.sessionId,
        error,
      );
    }
    if (!claim.claimed && claim.nativeSessionId !== created.sessionId) {
      try {
        await archiveHappierSession(created.sessionId, this.settings);
      } catch (error) {
        session.state.status = "blocked";
        throw new HappierRecoveryError(
          "native-session-persistence-failed",
          `Native session claim lost to ${claim.nativeSessionId}; failed to archive orphan ${created.sessionId}`,
          claim.nativeSessionId,
          error,
        );
      }
      session.needsReconciliation = true;
    }
    session.sessionId = claim.nativeSessionId;
    session.nativeSession.nativeSessionId = claim.nativeSessionId;
    session.needsPersistence = false;
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
    watermark: HistoryWatermark,
    localId: string,
    originalError: unknown,
  ): Promise<HistoryReconciliation> {
    try {
      const status = await getHappierSessionStatus(session.sessionId, this.settings);
      const history = await getHappierSessionHistory(session.sessionId, HISTORY_LIMIT, this.settings);
      const correlated = correlatePromptOutput(watermark, history, localId);
      return { status, history, added: correlated.assistant };
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
    assistantMessages: ParsedHistoryRow[],
  ): void {
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
