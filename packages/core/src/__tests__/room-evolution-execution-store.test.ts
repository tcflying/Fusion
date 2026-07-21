import { describe, expect, it } from "vitest";

import {
  AsyncRoomEvolutionExecutionStore,
  RoomEvolutionExecutionStoreError,
  type CreateRoomEvolutionExecutionRunInputV1,
  type RoomEvolutionEffectClaimResultV1,
  type RoomEvolutionExecutionCompletionResultV1,
  type RoomEvolutionExecutionPersistence,
  type RoomEvolutionExecutionRunSnapshotV1,
  type RoomEvolutionExecutionTransaction,
} from "../room-evolution-execution-store.js";
import { hashRoomValue } from "../room-integrity.js";

const PROJECT_ID = "project-evolution-execution-pure";
const CREATED_AT = "2026-07-19T21:00:00.000Z";
const SCOPE = {
  projectId: PROJECT_ID,
  roomId: null,
  scopeKind: "project",
  scopeKey: `project:${PROJECT_ID}`,
} as const;

function createInput(
  overrides: Partial<CreateRoomEvolutionExecutionRunInputV1> = {},
): CreateRoomEvolutionExecutionRunInputV1 {
  const request = { operation: "evaluate-candidate", partition: "fixed-replay" };
  const effectPayload = { effect: "run-deterministic-gate", gate: "schema" };
  return {
    scope: SCOPE,
    id: "execution-run-pure-1",
    idempotencyKey: "request-pure-1",
    experimentId: "experiment-pure-1",
    candidateVersionId: "candidate-pure-1",
    request,
    requestHash: hashRoomValue(request),
    effects: [{
      id: "effect-pure-1",
      effectKey: "deterministic-gate",
      effectKind: "deterministic_gate",
      payload: effectPayload,
      payloadHash: hashRoomValue(effectPayload),
      maxAttempts: 2,
      availableAt: CREATED_AT,
    }],
    createdAt: CREATED_AT,
    ...overrides,
  };
}

class InMemoryExecutionPersistence implements RoomEvolutionExecutionPersistence {
  readonly createCalls: CreateRoomEvolutionExecutionRunInputV1[] = [];
  readonly completeCalls: Parameters<RoomEvolutionExecutionTransaction["recordEffectOutcome"]>[0][] = [];
  private readonly byKey = new Map<string, RoomEvolutionExecutionRunSnapshotV1>();

  async transaction<TResult>(
    operation: (transaction: RoomEvolutionExecutionTransaction) => Promise<TResult>,
  ): Promise<TResult> {
    return operation({
      createOrReadRun: async (input) => {
        this.createCalls.push(input);
        const key = `${input.scope.projectId}:${input.scope.scopeKey}:${input.idempotencyKey}`;
        const existing = this.byKey.get(key);
        if (existing) {
          if (existing.run.requestHash !== input.requestHash) {
            throw new RoomEvolutionExecutionStoreError(
              "idempotency_conflict",
              "Execution idempotency key already binds a different request hash",
            );
          }
          return { status: "idempotent", ...existing } as const;
        }
        const snapshot = snapshotFor(input);
        this.byKey.set(key, snapshot);
        return { status: "created", ...snapshot } as const;
      },
      claimNextEffect: async (): Promise<RoomEvolutionEffectClaimResultV1> => ({ claim: null, recoveredOutcome: null }),
      recordEffectOutcome: async (input): Promise<RoomEvolutionExecutionCompletionResultV1> => {
        this.completeCalls.push(input);
        throw new Error("test persistence does not execute outcomes");
      },
      readRun: async () => null,
    });
  }
}

function snapshotFor(input: CreateRoomEvolutionExecutionRunInputV1): RoomEvolutionExecutionRunSnapshotV1 {
  return {
    run: {
      contractVersion: 1,
      id: input.id,
      ...input.scope,
      experimentId: input.experimentId,
      candidateVersionId: input.candidateVersionId,
      idempotencyKey: input.idempotencyKey,
      request: input.request,
      requestHash: input.requestHash,
      state: "pending",
      effectCount: input.effects.length,
      completedEffectCount: 0,
      failedEffectCount: 0,
      createdAt: input.createdAt,
      updatedAt: input.createdAt,
      completedAt: null,
    },
    effects: input.effects.map((effect) => ({
      contractVersion: 1,
      id: effect.id,
      ...input.scope,
      runId: input.id,
      effectKey: effect.effectKey,
      effectKind: effect.effectKind,
      payload: effect.payload,
      payloadHash: effect.payloadHash,
      state: "pending",
      attemptCount: 0,
      maxAttempts: effect.maxAttempts,
      nextEligibleAt: effect.availableAt,
      claimToken: null,
      claimExpiresAt: null,
      claimedByWorkerId: null,
      claimedAt: null,
      lastErrorCode: null,
      completedAt: null,
      createdAt: input.createdAt,
      updatedAt: input.createdAt,
    })),
    outcomes: [],
  };
}

describe("AsyncRoomEvolutionExecutionStore", () => {
  it("fails closed before persistence when request or effect hashes do not bind their payloads", async () => {
    const persistence = new InMemoryExecutionPersistence();
    const store = new AsyncRoomEvolutionExecutionStore(persistence);

    await expect(store.createOrReadRun(createInput({ requestHash: hashRoomValue("tampered") })))
      .rejects.toMatchObject({ code: "invalid_input" });
    await expect(store.createOrReadRun(createInput({
      effects: [{
        ...createInput().effects[0]!,
        payloadHash: hashRoomValue("tampered"),
      }],
    }))).rejects.toMatchObject({ code: "invalid_input" });

    expect(persistence.createCalls).toEqual([]);
  });

  it("returns only the hash-identical durable run for an idempotency retry", async () => {
    const persistence = new InMemoryExecutionPersistence();
    const store = new AsyncRoomEvolutionExecutionStore(persistence);
    const first = await store.createOrReadRun(createInput());
    const replay = await store.createOrReadRun(createInput({ id: "execution-run-pure-replay" }));

    expect(first.status).toBe("created");
    expect(replay).toMatchObject({
      status: "idempotent",
      run: { id: "execution-run-pure-1", requestHash: first.run.requestHash },
    });
    await expect(store.createOrReadRun(createInput({
      request: { operation: "evaluate-candidate", partition: "different" },
      requestHash: hashRoomValue({ operation: "evaluate-candidate", partition: "different" }),
    }))).rejects.toMatchObject({ code: "idempotency_conflict" });
  });

  it("rejects a retry outcome without a future retry time before a worker can mutate recovery state", async () => {
    const persistence = new InMemoryExecutionPersistence();
    const store = new AsyncRoomEvolutionExecutionStore(persistence);
    const outcome = { retry: "transient connector pressure" };

    await expect(store.recordEffectOutcome({
      scope: SCOPE,
      runId: "execution-run-pure-1",
      effectId: "effect-pure-1",
      claimToken: "claim-pure-1",
      outcome: "retryable_failure",
      outcomePayload: outcome,
      outcomeHash: hashRoomValue(outcome),
      errorCode: "connector_pressure",
      retryAt: CREATED_AT,
      recordedAt: CREATED_AT,
    })).rejects.toMatchObject({ code: "invalid_input" });

    expect(persistence.completeCalls).toEqual([]);
  });
});
