import {
  AsyncCliSessionStore,
  CliSessionStore,
  type AsyncDataLayer,
  type CliAutonomyPosture,
  type CliSession,
  type CliSessionUpdateInput,
  type TaskStore,
} from "@fusion/core";
import {
  createTaskStoreNativeSessionBinding,
  resolveTaskHappierCliSessionId,
} from "./agent-runtime.js";

export { resolveTaskHappierCliSessionId };

export type HappierDirectSessionProviderId = "codex" | "claude" | "opencode";

export type HappierDirectSessionEnsureMetadata = {
  sessionId: string;
  providerId: HappierDirectSessionProviderId;
  remoteSessionId: string;
  machineId: string;
  serverId: string;
  openUrl?: string | null;
};

export type TaskHappierDirectSessionBinding = {
  cliSessionId: string;
  nativeSessionId: string;
  providerId: HappierDirectSessionProviderId;
  remoteSessionId: string;
  machineId: string;
  serverId: string;
  linkedAt: string;
};

export type Store = Pick<TaskStore, "getFusionDir" | "getDatabase" | "getAsyncLayer">;

export class TaskHappierDirectSessionConflictError extends Error {
  readonly code = "HAPPIER_DIRECT_SESSION_CONFLICT";

  constructor(
    readonly taskId: string,
    readonly cliSessionId: string,
    readonly existingNativeSessionId: string,
    readonly requestedNativeSessionId: string,
  ) {
    super(
      `Task ${taskId} Happier CLI session ${cliSessionId} already belongs to native session ${existingNativeSessionId}; cannot bind ${requestedNativeSessionId}`,
    );
    this.name = "TaskHappierDirectSessionConflictError";
  }
}

export class TaskHappierDirectSessionIntegrityError extends Error {
  readonly code = "HAPPIER_DIRECT_SESSION_INTEGRITY";

  constructor(
    readonly taskId: string,
    readonly cliSessionId: string,
    readonly nativeSessionId: string,
    readonly metadataNativeSessionId: string,
  ) {
    super(
      `Task ${taskId} Happier CLI session ${cliSessionId} has native session ${nativeSessionId}, but connected metadata names ${metadataNativeSessionId}`,
    );
    this.name = "TaskHappierDirectSessionIntegrityError";
  }
}

type SessionStore = {
  getSession(id: string): CliSession | undefined | Promise<CliSession | undefined>;
  updateSession(
    id: string,
    input: CliSessionUpdateInput,
  ): CliSession | undefined | Promise<CliSession | undefined>;
};

function resolveSessionStore(store: Store): SessionStore {
  const asyncLayer = store.getAsyncLayer();
  if (asyncLayer) return new AsyncCliSessionStore(asyncLayer);
  return new CliSessionStore(store.getFusionDir(), store.getDatabase());
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isProviderId(value: unknown): value is HappierDirectSessionProviderId {
  return value === "codex" || value === "claude" || value === "opencode";
}

function parsePersistedBinding(
  value: unknown,
  expectedCliSessionId: string,
): TaskHappierDirectSessionBinding | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (
    candidate.cliSessionId !== expectedCliSessionId
    || !isNonEmptyString(candidate.nativeSessionId)
    || !isProviderId(candidate.providerId)
    || !isNonEmptyString(candidate.remoteSessionId)
    || !isNonEmptyString(candidate.machineId)
    || !isNonEmptyString(candidate.serverId)
    || !isNonEmptyString(candidate.linkedAt)
    || !Number.isFinite(Date.parse(candidate.linkedAt))
  ) {
    return null;
  }

  return {
    cliSessionId: expectedCliSessionId,
    nativeSessionId: candidate.nativeSessionId,
    providerId: candidate.providerId,
    remoteSessionId: candidate.remoteSessionId,
    machineId: candidate.machineId,
    serverId: candidate.serverId,
    linkedAt: candidate.linkedAt,
  };
}

function bindingFromSession(input: {
  taskId: string;
  cliSessionId: string;
  session: CliSession | undefined;
}): TaskHappierDirectSessionBinding | null {
  const { session } = input;
  if (!session) return null;
  const persisted = parsePersistedBinding(
    session.autonomyPosture?.happierDirectSession,
    input.cliSessionId,
  );
  if (!persisted || !session.nativeSessionId) return null;
  if (session.nativeSessionId !== persisted.nativeSessionId) {
    throw new TaskHappierDirectSessionIntegrityError(
      input.taskId,
      input.cliSessionId,
      session.nativeSessionId,
      persisted.nativeSessionId,
    );
  }
  return persisted;
}

const SERIALIZABLE_TRANSACTION_ATTEMPTS = 3;

function isSerializationFailure(error: unknown): boolean {
  let candidate = error;
  for (let depth = 0; depth < 3; depth += 1) {
    if (!candidate || typeof candidate !== "object") return false;
    if ((candidate as { code?: unknown }).code === "40001") return true;
    candidate = (candidate as { cause?: unknown }).cause;
  }
  return false;
}

async function withSerializableRetry<T>(operation: () => Promise<T>): Promise<T> {
  for (let attempt = 1; attempt <= SERIALIZABLE_TRANSACTION_ATTEMPTS; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (!isSerializationFailure(error) || attempt === SERIALIZABLE_TRANSACTION_ATTEMPTS) {
        throw error;
      }
    }
  }
  throw new Error("Unreachable serializable transaction retry state");
}

function existingBindingForEnsure(input: {
  taskId: string;
  cliSessionId: string;
  session: CliSession | undefined;
  ensuredNativeSessionId: string;
}): TaskHappierDirectSessionBinding | null {
  const existing = bindingFromSession(input);
  if (existing && existing.nativeSessionId !== input.ensuredNativeSessionId) {
    throw new TaskHappierDirectSessionConflictError(
      input.taskId,
      input.cliSessionId,
      existing.nativeSessionId,
      input.ensuredNativeSessionId,
    );
  }
  return existing;
}

function createConnectedBinding(input: {
  cliSessionId: string;
  nativeSessionId: string;
  ensured: HappierDirectSessionEnsureMetadata;
}): TaskHappierDirectSessionBinding {
  return {
    cliSessionId: input.cliSessionId,
    nativeSessionId: input.nativeSessionId,
    providerId: input.ensured.providerId,
    remoteSessionId: input.ensured.remoteSessionId,
    machineId: input.ensured.machineId,
    serverId: input.ensured.serverId,
    linkedAt: new Date().toISOString(),
  };
}

function assertClaimedNativeSession(input: {
  taskId: string;
  cliSessionId: string;
  claimedNativeSessionId: string;
  ensuredNativeSessionId: string;
}): void {
  if (input.claimedNativeSessionId === input.ensuredNativeSessionId) return;
  throw new TaskHappierDirectSessionConflictError(
    input.taskId,
    input.cliSessionId,
    input.claimedNativeSessionId,
    input.ensuredNativeSessionId,
  );
}

async function bindAsyncTransaction(input: {
  sessionStore: AsyncCliSessionStore;
  taskId: string;
  cliSessionId: string;
  ensured: HappierDirectSessionEnsureMetadata;
}): Promise<TaskHappierDirectSessionBinding> {
  const currentSession = await input.sessionStore.getSession(input.cliSessionId);
  if (!currentSession) throw new Error(`CLI session not found: ${input.cliSessionId}`);
  const currentBinding = existingBindingForEnsure({
    ...input,
    session: currentSession,
    ensuredNativeSessionId: input.ensured.sessionId,
  });
  if (currentBinding) return currentBinding;

  const claim = await input.sessionStore.claimNativeSessionId(
    input.cliSessionId,
    input.ensured.sessionId,
  );
  if (!claim) throw new Error(`CLI session not found during native-session claim: ${input.cliSessionId}`);
  assertClaimedNativeSession({
    ...input,
    claimedNativeSessionId: claim.nativeSessionId,
    ensuredNativeSessionId: input.ensured.sessionId,
  });

  const latestSession = await input.sessionStore.getSession(input.cliSessionId);
  if (!latestSession) throw new Error(`CLI session not found after native-session claim: ${input.cliSessionId}`);
  const existingAfterClaim = existingBindingForEnsure({
    ...input,
    session: latestSession,
    ensuredNativeSessionId: input.ensured.sessionId,
  });
  if (existingAfterClaim) return existingAfterClaim;

  const binding = createConnectedBinding({
    cliSessionId: input.cliSessionId,
    nativeSessionId: claim.nativeSessionId,
    ensured: input.ensured,
  });
  const autonomyPosture: CliAutonomyPosture = {
    ...(latestSession.autonomyPosture ?? {}),
    happierDirectSession: binding,
  };
  const updated = await input.sessionStore.updateSession(input.cliSessionId, { autonomyPosture });
  if (!updated) throw new Error(`CLI session not found while linking Happier metadata: ${input.cliSessionId}`);
  return binding;
}

function bindSyncTransaction(input: {
  sessionStore: CliSessionStore;
  taskId: string;
  cliSessionId: string;
  ensured: HappierDirectSessionEnsureMetadata;
}): TaskHappierDirectSessionBinding {
  const currentSession = input.sessionStore.getSession(input.cliSessionId);
  if (!currentSession) throw new Error(`CLI session not found: ${input.cliSessionId}`);
  const currentBinding = existingBindingForEnsure({
    ...input,
    session: currentSession,
    ensuredNativeSessionId: input.ensured.sessionId,
  });
  if (currentBinding) return currentBinding;

  const claim = input.sessionStore.claimNativeSessionId(
    input.cliSessionId,
    input.ensured.sessionId,
  );
  if (!claim) throw new Error(`CLI session not found during native-session claim: ${input.cliSessionId}`);
  assertClaimedNativeSession({
    ...input,
    claimedNativeSessionId: claim.nativeSessionId,
    ensuredNativeSessionId: input.ensured.sessionId,
  });

  const latestSession = input.sessionStore.getSession(input.cliSessionId);
  if (!latestSession) throw new Error(`CLI session not found after native-session claim: ${input.cliSessionId}`);
  const existingAfterClaim = existingBindingForEnsure({
    ...input,
    session: latestSession,
    ensuredNativeSessionId: input.ensured.sessionId,
  });
  if (existingAfterClaim) return existingAfterClaim;

  const binding = createConnectedBinding({
    cliSessionId: input.cliSessionId,
    nativeSessionId: claim.nativeSessionId,
    ensured: input.ensured,
  });
  const autonomyPosture: CliAutonomyPosture = {
    ...(latestSession.autonomyPosture ?? {}),
    happierDirectSession: binding,
  };
  const updated = input.sessionStore.updateSession(input.cliSessionId, { autonomyPosture });
  if (!updated) throw new Error(`CLI session not found while linking Happier metadata: ${input.cliSessionId}`);
  return binding;
}

async function bindWithDatabaseSerialization(input: {
  store: Store;
  taskId: string;
  cliSessionId: string;
  ensured: HappierDirectSessionEnsureMetadata;
}): Promise<TaskHappierDirectSessionBinding> {
  const asyncLayer = input.store.getAsyncLayer();
  if (asyncLayer) {
    return withSerializableRetry(() => asyncLayer.transactionImmediate(
      async (transaction) => bindAsyncTransaction({
        ...input,
        sessionStore: new AsyncCliSessionStore({
          db: transaction as unknown as AsyncDataLayer["db"],
        }),
      }),
      { isolationLevel: "serializable" },
    ));
  }

  const database = input.store.getDatabase();
  return database.transactionImmediate(() => bindSyncTransaction({
    ...input,
    sessionStore: new CliSessionStore(input.store.getFusionDir(), database),
  }));
}

export async function readTaskHappierDirectSessionBinding(input: {
  store: Store;
  taskId: string;
}): Promise<TaskHappierDirectSessionBinding | null> {
  const cliSessionId = resolveTaskHappierCliSessionId({
    taskId: input.taskId,
    purpose: "execute",
  });
  const session = await resolveSessionStore(input.store).getSession(cliSessionId);
  return bindingFromSession({ taskId: input.taskId, cliSessionId, session });
}

export async function bindTaskHappierDirectSession(input: {
  store: Store;
  taskId: string;
  worktreePath?: string | null;
  ensured: HappierDirectSessionEnsureMetadata;
}): Promise<TaskHappierDirectSessionBinding> {
  const cliSessionId = resolveTaskHappierCliSessionId({
    taskId: input.taskId,
    purpose: "execute",
  });

  const nativeBinding = await createTaskStoreNativeSessionBinding({
    runtimeHint: "happier",
    taskStore: input.store,
    sessionKey: `executor:${input.taskId}:primary`,
    taskId: input.taskId,
    purpose: "execute",
    worktreePath: input.worktreePath,
  });
  if (!nativeBinding) throw new Error("Happier native-session binding was not created");

  return bindWithDatabaseSerialization({
    store: input.store,
    taskId: input.taskId,
    cliSessionId,
    ensured: input.ensured,
  });
}
