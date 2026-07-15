import {
  AsyncCliSessionStore,
  CliSessionStore,
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

const serializedMutations = new WeakMap<object, Map<string, Promise<void>>>();

function resolveSessionStore(store: Store): SessionStore {
  const asyncLayer = store.getAsyncLayer();
  if (asyncLayer) return new AsyncCliSessionStore(asyncLayer);
  return new CliSessionStore(store.getFusionDir(), store.getDatabase());
}

async function runSerialized<T>(
  store: Store,
  cliSessionId: string,
  operation: () => Promise<T>,
): Promise<T> {
  const owner = store as object;
  let queue = serializedMutations.get(owner);
  if (!queue) {
    queue = new Map();
    serializedMutations.set(owner, queue);
  }

  const previous = queue.get(cliSessionId) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => gate);
  queue.set(cliSessionId, tail);

  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (queue.get(cliSessionId) === tail) queue.delete(cliSessionId);
  }
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

  return runSerialized(input.store, cliSessionId, async () => {
    const sessionStore = resolveSessionStore(input.store);
    const currentSession = await sessionStore.getSession(cliSessionId);
    const currentBinding = bindingFromSession({
      taskId: input.taskId,
      cliSessionId,
      session: currentSession,
    });
    if (currentBinding) {
      if (currentBinding.nativeSessionId !== input.ensured.sessionId) {
        throw new TaskHappierDirectSessionConflictError(
          input.taskId,
          cliSessionId,
          currentBinding.nativeSessionId,
          input.ensured.sessionId,
        );
      }
      return currentBinding;
    }

    const nativeBinding = await createTaskStoreNativeSessionBinding({
      runtimeHint: "happier",
      taskStore: input.store,
      sessionKey: `executor:${input.taskId}:primary`,
      taskId: input.taskId,
      purpose: "execute",
      worktreePath: input.worktreePath,
    });
    if (!nativeBinding) throw new Error("Happier native-session binding was not created");

    const claim = await nativeBinding.claimNativeSessionId(input.ensured.sessionId);
    if (claim.nativeSessionId !== input.ensured.sessionId) {
      throw new TaskHappierDirectSessionConflictError(
        input.taskId,
        cliSessionId,
        claim.nativeSessionId,
        input.ensured.sessionId,
      );
    }

    const claimedSession = await sessionStore.getSession(cliSessionId);
    if (!claimedSession) throw new Error(`CLI session not found after native-session claim: ${cliSessionId}`);
    const existingAfterClaim = bindingFromSession({
      taskId: input.taskId,
      cliSessionId,
      session: claimedSession,
    });
    if (existingAfterClaim) return existingAfterClaim;

    const binding: TaskHappierDirectSessionBinding = {
      cliSessionId,
      nativeSessionId: claim.nativeSessionId,
      providerId: input.ensured.providerId,
      remoteSessionId: input.ensured.remoteSessionId,
      machineId: input.ensured.machineId,
      serverId: input.ensured.serverId,
      linkedAt: new Date().toISOString(),
    };
    const autonomyPosture: CliAutonomyPosture = {
      ...(claimedSession.autonomyPosture ?? {}),
      happierDirectSession: binding,
    };
    const updated = await sessionStore.updateSession(cliSessionId, { autonomyPosture });
    if (!updated) throw new Error(`CLI session not found while linking Happier metadata: ${cliSessionId}`);
    return binding;
  });
}
