import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

import {
  AsyncRoomStore,
  RoomStoreError,
  type MutateRoomTaskGraphInputV1,
  type RoomCommandContext,
  type RoomTaskEdgeDefinitionV1,
  type RoomTaskEdgeKindV1,
  type RoomTaskGraphMutationV1,
  type RoomTaskGraphProjectionV1,
  type RoomTaskNodeDefinitionV1,
  type RoomTaskNodeProjectionV1,
} from "../../async-room-store.js";
import { hashRoomValue } from "../../room-integrity.js";
import { createConnectionSetFromUrl, type PostgresConnections } from "../../postgres/connection.js";
import {
  createAsyncDataLayer,
  type AsyncDataLayer,
  type DbTransaction,
  type TransactionOptions,
} from "../../postgres/data-layer.js";
import { EmbeddedPostgresLifecycle } from "../../postgres/embedded-lifecycle.js";
import { applySchemaBaseline } from "../../postgres/schema-applier.js";
import { operationalRooms, roomTaskNodes } from "../../postgres/schema/room.js";
import type { RoomTaskNodeState } from "../../room-contracts/storage.js";

/*
FNXC:SessionRoomTaskDag 2026-07-17-21:22:
Task 5.1 requires the PostgreSQL Room store to own a typed, versioned task DAG. Readiness is derived only from `requires` edges, critical-path weight comes from estimated duration, accepted nodes are immutable, and evidence invalidation never silently reopens downstream work. Reopen must be an explicit causal command, while waiting or failure on one branch must not suppress independent ready nodes.

The retained RED contract now imports the production AsyncRoomStore contracts
directly so public signature or field drift is a compile-time failure.
*/
type RoomTaskGraphStoreApi = Pick<AsyncRoomStore, "mutateTaskGraph" | "getTaskGraph">;

interface EmbeddedTestContext {
  readonly dataDir: string;
  readonly lifecycle: EmbeddedPostgresLifecycle;
  connections: PostgresConnections | null;
}

interface RoomTaskGraphFixture {
  readonly layer: AsyncDataLayer;
  readonly store: AsyncRoomStore;
  readonly roomId: string;
  readonly aggregateVersion: number;
}

interface RejectedMutationOptions {
  readonly expectedAggregateVersion?: number;
  readonly expectedDagVersion?: number;
}

interface SelectResolutionState {
  count: number;
}

function wrapSelectResolution<T extends object>(
  value: T,
  state: SelectResolutionState,
  afterFirstSelect: () => Promise<void>,
): T {
  return new Proxy(value, {
    get(target, property) {
      const member = Reflect.get(target, property, target) as unknown;
      if (property === "then" && typeof member === "function") {
        return (
          onFulfilled?: (result: unknown) => unknown,
          onRejected?: (error: unknown) => unknown,
        ) => (member as (
          resolve: (result: unknown) => Promise<unknown>,
          reject?: (error: unknown) => unknown,
        ) => Promise<unknown>).call(
          target,
          async (result: unknown) => {
            state.count += 1;
            if (state.count === 1) await afterFirstSelect();
            return onFulfilled ? onFulfilled(result) : result;
          },
          onRejected,
        );
      }
      if (typeof member === "function") {
        return (...args: unknown[]) => wrapSelectResolution(
          (member as (...methodArgs: unknown[]) => object).apply(target, args),
          state,
          afterFirstSelect,
        );
      }
      return member;
    },
  });
}

function taskGraphSnapshotLayer(
  layer: AsyncDataLayer,
  afterFirstSelect: () => Promise<void>,
): AsyncDataLayer {
  const state: SelectResolutionState = { count: 0 };
  const wrapHandle = <T extends object>(handle: T): T => new Proxy(handle, {
    get(target, property) {
      const member = Reflect.get(target, property, target) as unknown;
      if (property === "select" && typeof member === "function") {
        return (...args: unknown[]) => wrapSelectResolution(
          (member as (...methodArgs: unknown[]) => object).apply(target, args),
          state,
          afterFirstSelect,
        );
      }
      return typeof member === "function" ? member.bind(target) : member;
    },
  });
  return {
    ...layer,
    db: wrapHandle(layer.db),
    transaction: <T>(
      fn: (tx: DbTransaction) => Promise<T>,
      options?: TransactionOptions,
    ) => layer.transaction((tx) => fn(wrapHandle(tx)), options),
  };
}

const PROJECT_ID = "project-room-task-dag";
const BASE_TIME = "2026-07-17T13:22:00.000Z";
let commandSequence = 0;

function requireTaskGraphApi(store: AsyncRoomStore): RoomTaskGraphStoreApi {
  return store;
}

async function startEmbeddedDatabase(): Promise<EmbeddedTestContext> {
  const dataDir = mkdtempSync(join(tmpdir(), "fusion-room-task-dag-"));
  const lifecycle = new EmbeddedPostgresLifecycle({
    dataDir,
    database: "fusion",
    user: "postgres",
    password: "password",
  });
  const backend = await lifecycle.start();
  const context = {
    dataDir,
    lifecycle,
    connections: await createConnectionSetFromUrl(backend, { poolMax: 4 }),
  } satisfies EmbeddedTestContext;
  await applySchemaBaseline(context.connections.migration, { pluginHooks: [] });
  return context;
}

function commandContext(roomId: string, label: string): RoomCommandContext {
  commandSequence += 1;
  return {
    eventId: `event-${roomId}-${label}`,
    actorType: "controller",
    actorId: "room-controller-task-dag-test",
    correlationId: `correlation-${roomId}-${label}`,
    causationId: null,
    occurredAt: new Date(Date.parse(BASE_TIME) + commandSequence * 1_000).toISOString(),
  };
}

function taskNode(
  id: string,
  estimatedDurationMs: number,
  role = "implementer",
): RoomTaskNodeDefinitionV1 {
  return {
    id,
    parentNodeId: null,
    objective: `Complete ${id}`,
    inputRefs: [`input:${id}`],
    outputRefs: [`artifact:${id}`],
    roleRequirements: [role],
    capabilityRequirements: [`capability:${id}`],
    resourceHints: {
      estimatedDurationMs,
      concurrencyClass: "parallel",
      preferredProviderIds: ["codex"],
    },
    authorityScope: {
      allowedActions: ["workspace:read", "workspace:write"],
      readPaths: [`packages/${id}`],
      writePaths: [`packages/${id}`],
    },
    acceptanceGateIds: [`gate:${id}`],
    retryPolicy: {
      maxAttempts: 2,
      backoff: "exponential",
      baseDelayMs: 1_000,
      recoveryActions: ["replan", "replace_participant"],
    },
    progressSignature: `progress:${id}:v1`,
  };
}

function taskEdge(
  id: string,
  fromNodeId: string,
  toNodeId: string,
  kind: RoomTaskEdgeKindV1,
): RoomTaskEdgeDefinitionV1 {
  return { id, fromNodeId, toNodeId, kind };
}

function findNode(
  graph: RoomTaskGraphProjectionV1,
  nodeId: string,
): RoomTaskNodeProjectionV1 {
  const node = graph.nodes.find((candidate) => candidate.id === nodeId);
  if (!node) throw new Error(`Task node ${nodeId} missing from graph projection`);
  return node;
}

async function createRoomTaskGraphFixture(label: string): Promise<RoomTaskGraphFixture> {
  const roomId = `room-task-dag-${label}`;
  const layer = sharedLayer;
  const store = new AsyncRoomStore(layer, { projectId: PROJECT_ID });
  const created = await store.createRoom(
    {
      id: roomId,
      projectId: PROJECT_ID,
      objective: `Exercise Room task DAG ${label}`,
      protocolId: "implementation",
      protocolVersion: 1,
      now: BASE_TIME,
    },
    commandContext(roomId, "created"),
  );
  return {
    layer,
    store,
    roomId,
    aggregateVersion: created.room.aggregateVersion,
  };
}

async function mutateGraph(
  fixture: RoomTaskGraphFixture,
  graph: Pick<RoomTaskGraphProjectionV1, "aggregateVersion" | "dagVersion">,
  label: string,
  mutations: readonly RoomTaskGraphMutationV1[],
): Promise<RoomTaskGraphProjectionV1> {
  const api = requireTaskGraphApi(fixture.store);
  const context = commandContext(fixture.roomId, label);
  return api.mutateTaskGraph(
    {
      roomId: fixture.roomId,
      expectedAggregateVersion: graph.aggregateVersion,
      expectedDagVersion: graph.dagVersion,
      idempotencyKey: `task-graph:${fixture.roomId}:${label}`,
      mutations,
      mutatedAt: context.occurredAt,
    },
    context,
  );
}

async function expectMutationRejectedAndUnchanged(
  fixture: RoomTaskGraphFixture,
  graph: RoomTaskGraphProjectionV1,
  label: string,
  mutations: readonly RoomTaskGraphMutationV1[],
  errorCode: string,
  options: RejectedMutationOptions = {},
): Promise<void> {
  const api = requireTaskGraphApi(fixture.store);
  const before = await api.getTaskGraph(fixture.roomId);
  const eventCountBefore = (await fixture.store.listEvents(fixture.roomId)).length;
  const context = commandContext(fixture.roomId, label);

  await expect(
    api.mutateTaskGraph(
      {
        roomId: fixture.roomId,
        expectedAggregateVersion: options.expectedAggregateVersion ?? graph.aggregateVersion,
        expectedDagVersion: options.expectedDagVersion ?? graph.dagVersion,
        idempotencyKey: `task-graph:${fixture.roomId}:${label}`,
        mutations,
        mutatedAt: context.occurredAt,
      },
      context,
    ),
  ).rejects.toMatchObject({ code: errorCode });

  expect(await api.getTaskGraph(fixture.roomId)).toEqual(before);
  expect(await fixture.store.listEvents(fixture.roomId)).toHaveLength(eventCountBefore);
}

const sharedContext = await startEmbeddedDatabase();
const sharedLayer = createAsyncDataLayer(sharedContext.connections!, { projectId: PROJECT_ID });

afterAll(async () => {
  if (sharedContext.connections) {
    await sharedContext.connections.close();
    sharedContext.connections = null;
  }
  await sharedContext.lifecycle.stop();
  rmSync(sharedContext.dataDir, { recursive: true, force: true });
});

describe("AsyncRoomStore PostgreSQL task DAG", () => {
  it("reads one repeatable task-graph snapshot across a concurrent mutation", async () => {
    const fixture = await createRoomTaskGraphFixture("consistent-snapshot");
    const concurrentNode = taskNode("node-concurrent-snapshot", 1_000);
    let committedGraph: RoomTaskGraphProjectionV1 | undefined;
    const snapshotLayer = taskGraphSnapshotLayer(fixture.layer, async () => {
      committedGraph = await mutateGraph(
        fixture,
        { aggregateVersion: fixture.aggregateVersion, dagVersion: 0 },
        "commit-during-read",
        [{ action: "add_node", node: concurrentNode }],
      );
    });
    const snapshotStore = new AsyncRoomStore(snapshotLayer, { projectId: PROJECT_ID });

    const observed = await requireTaskGraphApi(snapshotStore).getTaskGraph(fixture.roomId);

    expect(observed).toEqual({
      roomId: fixture.roomId,
      aggregateVersion: fixture.aggregateVersion,
      dagVersion: 0,
      nodes: [],
      edges: [],
      readyNodeIds: [],
      criticalPathNodeIds: [],
    });
    expect(committedGraph).toBeDefined();
    await expect(requireTaskGraphApi(fixture.store).getTaskGraph(fixture.roomId)).resolves.toEqual(committedGraph);
  });

  it("persists fully typed task nodes and requires/informs/invalidates edges", async () => {
    const fixture = await createRoomTaskGraphFixture("typed-records");
    const producer = taskNode("node-producer", 4_000, "producer");
    const verifier = taskNode("node-verifier", 8_000, "verifier");
    const observer = taskNode("node-observer", 2_000, "observer");
    const edges = [
      taskEdge("edge-producer-verifier", producer.id, verifier.id, "requires"),
      taskEdge("edge-producer-observer", producer.id, observer.id, "informs"),
      taskEdge("edge-verifier-observer", verifier.id, observer.id, "invalidates"),
    ] as const;
    const mutations = [
      { action: "add_node" as const, node: producer },
      { action: "add_node" as const, node: verifier },
      { action: "add_node" as const, node: observer },
      ...edges.map((edge) => ({ action: "add_edge" as const, edge })),
    ];

    const graph = await mutateGraph(
      fixture,
      { aggregateVersion: fixture.aggregateVersion, dagVersion: 0 },
      "seed-typed-records",
      mutations,
    );

    expect(graph).toMatchObject({
      roomId: fixture.roomId,
      aggregateVersion: fixture.aggregateVersion + 1,
      dagVersion: 1,
    });
    expect(graph.nodes).toHaveLength(3);
    expect(graph.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({ ...producer, state: "ready", nodeVersion: 0 }),
      expect.objectContaining({ ...verifier, state: "waiting_dependency", nodeVersion: 0 }),
      expect.objectContaining({ ...observer, state: "ready", nodeVersion: 0 }),
    ]));
    expect(graph.edges).toHaveLength(3);
    expect(graph.edges).toEqual(expect.arrayContaining(edges));
    expect(graph.readyNodeIds).toHaveLength(2);
    expect(graph.readyNodeIds).toEqual(expect.arrayContaining([producer.id, observer.id]));

    const reopenedStore = new AsyncRoomStore(fixture.layer, { projectId: PROJECT_ID });
    await expect(requireTaskGraphApi(reopenedStore).getTaskGraph(fixture.roomId)).resolves.toEqual(graph);

    const eventCountBeforeReplay = (await fixture.store.listEvents(fixture.roomId)).length;
    await expect(mutateGraph(
      fixture,
      { aggregateVersion: fixture.aggregateVersion, dagVersion: 0 },
      "seed-typed-records",
      mutations,
    )).resolves.toEqual(graph);
    expect(await fixture.store.listEvents(fixture.roomId)).toHaveLength(eventCountBeforeReplay);
  });

  it("rejects fractional and extra-key task JSON objects with a typed error", async () => {
    const fixture = await createRoomTaskGraphFixture("runtime-json-shape");
    const graph = await requireTaskGraphApi(fixture.store).getTaskGraph(fixture.roomId);
    expect(graph).not.toBeNull();
    if (!graph) throw new Error("Expected an empty task graph for runtime JSON validation");
    const base = taskNode("node-runtime-json-shape", 1_000);
    const malformed = [
      {
        label: "fractional-estimated-duration",
        node: {
          ...base,
          resourceHints: { ...base.resourceHints, estimatedDurationMs: 1.5 },
        },
      },
      {
        label: "extra-resource-hint-key",
        node: {
          ...base,
          resourceHints: { ...base.resourceHints, extra: true },
        } as unknown as RoomTaskNodeDefinitionV1,
      },
      {
        label: "extra-authority-key",
        node: {
          ...base,
          authorityScope: { ...base.authorityScope, extra: true },
        } as unknown as RoomTaskNodeDefinitionV1,
      },
      {
        label: "fractional-max-attempts",
        node: {
          ...base,
          retryPolicy: { ...base.retryPolicy, maxAttempts: 1.5 },
        },
      },
      {
        label: "fractional-base-delay",
        node: {
          ...base,
          retryPolicy: { ...base.retryPolicy, baseDelayMs: 0.5 },
        },
      },
      {
        label: "extra-retry-policy-key",
        node: {
          ...base,
          retryPolicy: { ...base.retryPolicy, extra: true },
        } as unknown as RoomTaskNodeDefinitionV1,
      },
    ] as const;

    for (const { label, node } of malformed) {
      await expectMutationRejectedAndUnchanged(
        fixture,
        graph,
        label,
        [{ action: "add_node", node }],
        "task_graph_invalid_mutation",
      );
    }
  });

  it("rejects malformed, proxied, sparse, and unbounded runtime commands with one typed error", async () => {
    const fixture = await createRoomTaskGraphFixture("runtime-command-shape");
    const node = taskNode("node-runtime-command-shape", 1_000);
    const graph = await mutateGraph(
      fixture,
      { aggregateVersion: fixture.aggregateVersion, dagVersion: 0 },
      "seed-runtime-command-shape",
      [{ action: "add_node", node }],
    );
    const api = requireTaskGraphApi(fixture.store);
    let accessorArrayGetterCalls = 0;
    const makeValidPair = (label: string) => {
      const context = commandContext(fixture.roomId, label);
      const input: MutateRoomTaskGraphInputV1 = {
        roomId: fixture.roomId,
        expectedAggregateVersion: graph.aggregateVersion,
        expectedDagVersion: graph.dagVersion,
        idempotencyKey: `task-graph:${fixture.roomId}:${label}`,
        mutations: [{
          action: "update_node",
          nodeId: node.id,
          expectedNodeVersion: findNode(graph, node.id).nodeVersion,
          patch: { progressSignature: `progress:${label}` },
          evidenceIds: [`evidence:${label}`],
        }],
        mutatedAt: context.occurredAt,
      };
      return { input, context };
    };
    const malformedCases: Array<{
      readonly label: string;
      readonly build: () => { readonly input: unknown; readonly context: unknown };
    }> = [
      { label: "null-input", build: () => ({ input: null, context: makeValidPair("null-input").context }) },
      { label: "undefined-input", build: () => ({ input: undefined, context: makeValidPair("undefined-input").context }) },
      { label: "primitive-input", build: () => ({ input: 1, context: makeValidPair("primitive-input").context }) },
      { label: "array-input", build: () => ({ input: [], context: makeValidPair("array-input").context }) },
      { label: "malformed-input", build: () => ({ input: {}, context: makeValidPair("malformed-input").context }) },
      {
        label: "proxied-input",
        build: () => {
          const pair = makeValidPair("proxied-input");
          return {
            input: new Proxy(pair.input, { get: () => { throw new TypeError("input proxy trap"); } }),
            context: pair.context,
          };
        },
      },
      { label: "null-context", build: () => ({ input: makeValidPair("null-context").input, context: null }) },
      { label: "undefined-context", build: () => ({ input: makeValidPair("undefined-context").input, context: undefined }) },
      { label: "primitive-context", build: () => ({ input: makeValidPair("primitive-context").input, context: 1 }) },
      { label: "malformed-context", build: () => ({ input: makeValidPair("malformed-context").input, context: {} }) },
      {
        label: "proxied-context",
        build: () => {
          const pair = makeValidPair("proxied-context");
          return {
            input: pair.input,
            context: new Proxy(pair.context, { get: () => { throw new TypeError("context proxy trap"); } }),
          };
        },
      },
      {
        label: "null-mutations",
        build: () => {
          const pair = makeValidPair("null-mutations");
          return { input: { ...pair.input, mutations: null }, context: pair.context };
        },
      },
      {
        label: "undefined-mutations",
        build: () => {
          const pair = makeValidPair("undefined-mutations");
          return { input: { ...pair.input, mutations: undefined }, context: pair.context };
        },
      },
      {
        label: "object-mutations",
        build: () => {
          const pair = makeValidPair("object-mutations");
          return { input: { ...pair.input, mutations: {} }, context: pair.context };
        },
      },
      {
        label: "sparse-mutations",
        build: () => {
          const pair = makeValidPair("sparse-mutations");
          return { input: { ...pair.input, mutations: new Array(1) }, context: pair.context };
        },
      },
      {
        label: "extra-key-mutations",
        build: () => {
          const pair = makeValidPair("extra-key-mutations");
          const mutations = [...pair.input.mutations] as RoomTaskGraphMutationV1[] & { extra?: boolean };
          mutations.extra = true;
          return { input: { ...pair.input, mutations }, context: pair.context };
        },
      },
      {
        label: "accessor-evidence-ids",
        build: () => {
          const pair = makeValidPair("accessor-evidence-ids");
          const evidenceIds = ["evidence-1"];
          Object.defineProperty(evidenceIds, "0", {
            enumerable: true,
            configurable: true,
            get: () => {
              accessorArrayGetterCalls += 1;
              return "evidence-1";
            },
          });
          return {
            input: {
              ...pair.input,
              mutations: [{ ...pair.input.mutations[0]!, evidenceIds }],
            },
            context: pair.context,
          };
        },
      },
      {
        label: "symbol-key-mutations",
        build: () => {
          const pair = makeValidPair("symbol-key-mutations");
          const mutations = [...pair.input.mutations];
          Object.defineProperty(mutations, Symbol("hidden"), {
            enumerable: true,
            configurable: true,
            value: true,
          });
          return { input: { ...pair.input, mutations }, context: pair.context };
        },
      },
      {
        label: "non-plain-mutations",
        build: () => {
          const pair = makeValidPair("non-plain-mutations");
          class NonPlainMutationArray extends Array<RoomTaskGraphMutationV1> {}
          const mutations = new NonPlainMutationArray(...pair.input.mutations);
          return { input: { ...pair.input, mutations }, context: pair.context };
        },
      },
      {
        label: "prototype-pollution-patch",
        build: () => {
          const pair = makeValidPair("prototype-pollution-patch");
          const patch = { progressSignature: "progress:prototype-pollution" };
          Object.defineProperty(patch, "__proto__", {
            enumerable: true,
            configurable: true,
            value: { objective: "inherited unaudited objective" },
          });
          return {
            input: {
              ...pair.input,
              mutations: [{ ...pair.input.mutations[0]!, patch }],
            },
            context: pair.context,
          };
        },
      },
      {
        label: "proxied-mutations",
        build: () => {
          const pair = makeValidPair("proxied-mutations");
          return {
            input: {
              ...pair.input,
              mutations: new Proxy([...pair.input.mutations], {
                get: () => { throw new TypeError("mutations proxy trap"); },
              }),
            },
            context: pair.context,
          };
        },
      },
      {
        label: "proxied-mutation",
        build: () => {
          const pair = makeValidPair("proxied-mutation");
          return {
            input: {
              ...pair.input,
              mutations: [new Proxy(pair.input.mutations[0]!, {
                get: () => { throw new TypeError("mutation proxy trap"); },
              })],
            },
            context: pair.context,
          };
        },
      },
      {
        label: "sparse-evidence-ids",
        build: () => {
          const pair = makeValidPair("sparse-evidence-ids");
          return {
            input: {
              ...pair.input,
              mutations: [{ ...pair.input.mutations[0]!, evidenceIds: new Array(1) }],
            },
            context: pair.context,
          };
        },
      },
      {
        label: "unbounded-mutations",
        build: () => {
          const pair = makeValidPair("unbounded-mutations");
          return {
            input: {
              ...pair.input,
              mutations: Array.from({ length: 65 }, (_, index) => ({
                action: "add_node",
                node: taskNode(`node-unbounded-${index}`, 1),
              })),
            },
            context: pair.context,
          };
        },
      },
    ];

    for (const { label, build } of malformedCases) {
      const before = await api.getTaskGraph(fixture.roomId);
      const eventCountBefore = (await fixture.store.listEvents(fixture.roomId)).length;
      const { input, context } = build();
      let caught: unknown;
      try {
        await api.mutateTaskGraph(
          input as MutateRoomTaskGraphInputV1,
          context as RoomCommandContext,
        );
      } catch (error) {
        caught = error;
      }
      expect(caught, label).toBeInstanceOf(RoomStoreError);
      expect(caught, label).toMatchObject({ code: "task_graph_invalid_mutation" });
      expect(await api.getTaskGraph(fixture.roomId), label).toEqual(before);
      expect(await fixture.store.listEvents(fixture.roomId), label).toHaveLength(eventCountBefore);
    }
    expect(accessorArrayGetterCalls).toBe(0);
  });

  it("persists hash-safe causal command audit and preserves its original replay event", async () => {
    const fixture = await createRoomTaskGraphFixture("causal-command-audit");
    const node = taskNode("node-causal-command-audit", 1_000);
    let graph = await mutateGraph(
      fixture,
      { aggregateVersion: fixture.aggregateVersion, dagVersion: 0 },
      "seed-causal-command-audit",
      [{ action: "add_node", node }],
    );
    const updateReasonContent = "replace the private incident narrative";
    const updateEvidenceIds = ["evidence:update:z", "evidence:update:a"];
    const updateContext = commandContext(fixture.roomId, "audit-update-node");
    const updateInput = {
      roomId: fixture.roomId,
      expectedAggregateVersion: graph.aggregateVersion,
      expectedDagVersion: graph.dagVersion,
      idempotencyKey: `task-graph:${fixture.roomId}:audit-update-node`,
      mutations: [{
        action: "update_node" as const,
        nodeId: node.id,
        expectedNodeVersion: findNode(graph, node.id).nodeVersion,
        patch: {
          objective: updateReasonContent,
          progressSignature: "private progress narrative",
        },
        evidenceIds: updateEvidenceIds,
      }],
      mutatedAt: updateContext.occurredAt,
    };
    const updateProjection = await requireTaskGraphApi(fixture.store).mutateTaskGraph(
      updateInput,
      updateContext,
    );
    graph = updateProjection;

    const acceptanceEvidenceId = "evidence:audit:accepted";
    graph = await mutateGraph(fixture, graph, "audit-accept-node", [{
      action: "transition_node",
      nodeId: node.id,
      expectedNodeVersion: findNode(graph, node.id).nodeVersion,
      to: "accepted",
      acceptanceEvidenceIds: [acceptanceEvidenceId],
      progressSignature: "progress:audit:accepted",
    }]);
    const invalidatedByEvidenceId = "evidence:audit:invalidated";
    const invalidationReason = "private invalidation narrative";
    const invalidationContext = commandContext(fixture.roomId, "audit-invalidate-node");
    graph = await requireTaskGraphApi(fixture.store).mutateTaskGraph({
      roomId: fixture.roomId,
      expectedAggregateVersion: graph.aggregateVersion,
      expectedDagVersion: graph.dagVersion,
      idempotencyKey: `task-graph:${fixture.roomId}:audit-invalidate-node`,
      mutations: [{
        action: "invalidate_acceptance_evidence",
        nodeId: node.id,
        expectedNodeVersion: findNode(graph, node.id).nodeVersion,
        acceptanceEvidenceId,
        invalidatedByEvidenceId,
        reason: invalidationReason,
      }],
      mutatedAt: invalidationContext.occurredAt,
    }, invalidationContext);
    const reopenReason = "private reopen narrative";
    const reopenContext = commandContext(fixture.roomId, "audit-reopen-node");
    graph = await requireTaskGraphApi(fixture.store).mutateTaskGraph({
      roomId: fixture.roomId,
      expectedAggregateVersion: graph.aggregateVersion,
      expectedDagVersion: graph.dagVersion,
      idempotencyKey: `task-graph:${fixture.roomId}:audit-reopen-node`,
      mutations: [{
        action: "reopen_node",
        nodeId: node.id,
        expectedNodeVersion: findNode(graph, node.id).nodeVersion,
        upstreamNodeId: node.id,
        invalidatedByEvidenceId,
        reason: reopenReason,
      }],
      mutatedAt: reopenContext.occurredAt,
    }, reopenContext);

    const eventsBeforeReplay = await fixture.store.listEvents(fixture.roomId);
    const updateEvent = eventsBeforeReplay.find((event) => event.id === updateContext.eventId);
    const invalidationEvent = eventsBeforeReplay.find((event) => event.id === invalidationContext.eventId);
    const reopenEvent = eventsBeforeReplay.find((event) => event.id === reopenContext.eventId);
    expect(updateEvent?.payload).toMatchObject({
      commandAudit: {
        version: 1,
        mutationCount: 1,
        mutations: [{
          action: "update_node",
          nodeId: node.id,
          expectedNodeVersion: 0,
          changedFields: ["objective", "progressSignature"],
          evidenceIds: ["evidence:update:a", "evidence:update:z"],
          patchHash: hashRoomValue(updateInput.mutations[0].patch),
        }],
      },
    });
    expect(invalidationEvent?.payload).toMatchObject({
      commandAudit: {
        version: 1,
        mutationCount: 1,
        mutations: [{
          action: "invalidate_acceptance_evidence",
          nodeId: node.id,
          acceptanceEvidenceId,
          invalidatedByEvidenceId,
          reasonHash: hashRoomValue(invalidationReason),
        }],
      },
    });
    expect(reopenEvent?.payload).toMatchObject({
      commandAudit: {
        version: 1,
        mutationCount: 1,
        mutations: [{
          action: "reopen_node",
          nodeId: node.id,
          upstreamNodeId: node.id,
          invalidatedByEvidenceId,
          reasonHash: hashRoomValue(reopenReason),
        }],
      },
    });
    expect(JSON.stringify(updateEvent?.payload.commandAudit)).not.toContain(updateReasonContent);
    expect(JSON.stringify(updateEvent?.payload.commandAudit)).not.toContain("private progress narrative");
    expect(JSON.stringify(invalidationEvent?.payload.commandAudit)).not.toContain(invalidationReason);
    expect(JSON.stringify(reopenEvent?.payload.commandAudit)).not.toContain(reopenReason);

    await expect(
      requireTaskGraphApi(fixture.store).mutateTaskGraph(updateInput, updateContext),
    ).resolves.toEqual(updateProjection);
    expect(await fixture.store.listEvents(fixture.roomId)).toEqual(eventsBeforeReplay);
  });

  it("promotes a dependent node to ready only after every required predecessor is accepted", async () => {
    const fixture = await createRoomTaskGraphFixture("dependency-readiness");
    const upstream = taskNode("node-upstream", 4_000);
    const downstream = taskNode("node-downstream", 6_000);
    let graph = await mutateGraph(
      fixture,
      { aggregateVersion: fixture.aggregateVersion, dagVersion: 0 },
      "seed-dependency-readiness",
      [
        { action: "add_node", node: upstream },
        { action: "add_node", node: downstream },
        {
          action: "add_edge",
          edge: taskEdge("edge-upstream-downstream", upstream.id, downstream.id, "requires"),
        },
      ],
    );

    expect(findNode(graph, upstream.id).state).toBe("ready");
    expect(findNode(graph, downstream.id).state).toBe("waiting_dependency");

    graph = await mutateGraph(fixture, graph, "accept-upstream", [{
      action: "transition_node",
      nodeId: upstream.id,
      expectedNodeVersion: findNode(graph, upstream.id).nodeVersion,
      to: "accepted",
      acceptanceEvidenceIds: ["evidence:upstream-gates-green"],
      progressSignature: "progress:node-upstream:accepted",
    }]);

    expect(findNode(graph, upstream.id)).toMatchObject({
      state: "accepted",
      acceptanceEvidenceIds: ["evidence:upstream-gates-green"],
    });
    expect(findNode(graph, downstream.id).state).toBe("ready");
    expect(graph.readyNodeIds).toEqual([downstream.id]);
  });

  it("fails closed when an unsatisfied requires edge targets active work", async () => {
    const activeStates = [
      "running",
      "waiting_approval",
      "rate_limited",
      "retrying",
    ] as const satisfies readonly RoomTaskNodeState[];

    for (const activeState of activeStates) {
      const fixture = await createRoomTaskGraphFixture(`active-requires-${activeState}`);
      const upstream = taskNode(`node-active-upstream-${activeState}`, 1_000);
      const target = taskNode(`node-active-target-${activeState}`, 1_000);
      let graph = await mutateGraph(
        fixture,
        { aggregateVersion: fixture.aggregateVersion, dagVersion: 0 },
        `seed-active-requires-${activeState}`,
        [
          { action: "add_node", node: upstream },
          { action: "add_node", node: target },
        ],
      );
      graph = await mutateGraph(fixture, graph, `enter-${activeState}`, [{
        action: "transition_node",
        nodeId: target.id,
        expectedNodeVersion: findNode(graph, target.id).nodeVersion,
        to: activeState,
        acceptanceEvidenceIds: [],
        progressSignature: `progress:${target.id}:${activeState}`,
      }]);

      await expectMutationRejectedAndUnchanged(
        fixture,
        graph,
        `reject-active-requires-${activeState}`,
        [{
          action: "add_edge",
          edge: taskEdge(
            `edge-active-requires-${activeState}`,
            upstream.id,
            target.id,
            "requires",
          ),
        }],
        "task_graph_invalid_mutation",
      );
    }
  });

  it("computes the critical path from requires edges and estimated duration", async () => {
    const fixture = await createRoomTaskGraphFixture("critical-path");
    const backend = taskNode("node-backend", 5_000);
    const review = taskNode("node-review", 8_000);
    const connector = taskNode("node-connector", 20_000);
    const integration = taskNode("node-integration", 2_000);
    const graph = await mutateGraph(
      fixture,
      { aggregateVersion: fixture.aggregateVersion, dagVersion: 0 },
      "seed-critical-path",
      [
        { action: "add_node", node: backend },
        { action: "add_node", node: review },
        { action: "add_node", node: connector },
        { action: "add_node", node: integration },
        {
          action: "add_edge",
          edge: taskEdge("edge-backend-review", backend.id, review.id, "requires"),
        },
        {
          action: "add_edge",
          edge: taskEdge("edge-review-integration", review.id, integration.id, "requires"),
        },
        {
          action: "add_edge",
          edge: taskEdge("edge-connector-integration", connector.id, integration.id, "requires"),
        },
      ],
    );

    expect(graph.criticalPathNodeIds).toEqual([connector.id, integration.id]);
  });

  it("rejects an unsafe accumulated critical-path duration without partial writes", async () => {
    const fixture = await createRoomTaskGraphFixture("critical-path-overflow");
    const graph = await requireTaskGraphApi(fixture.store).getTaskGraph(fixture.roomId);
    expect(graph).not.toBeNull();
    if (!graph) throw new Error("Expected an empty graph for critical-path overflow validation");
    const first = taskNode("node-critical-path-max", Number.MAX_SAFE_INTEGER);
    const second = taskNode("node-critical-path-overflow", 1);

    await expectMutationRejectedAndUnchanged(
      fixture,
      graph,
      "reject-critical-path-overflow",
      [
        { action: "add_node", node: first },
        { action: "add_node", node: second },
        {
          action: "add_edge",
          edge: taskEdge("edge-critical-path-overflow", first.id, second.id, "requires"),
        },
      ],
      "task_graph_critical_path_overflow",
    );
  });

  it("rejects aggregate, DAG, and node version overflow before any graph write", async () => {
    const aggregateFixture = await createRoomTaskGraphFixture("aggregate-version-overflow");
    await aggregateFixture.layer.db
      .update(operationalRooms)
      .set({ aggregateVersion: Number.MAX_SAFE_INTEGER })
      .where(eq(operationalRooms.id, aggregateFixture.roomId));
    const aggregateGraph = await requireTaskGraphApi(aggregateFixture.store)
      .getTaskGraph(aggregateFixture.roomId);
    if (!aggregateGraph) throw new Error("Expected aggregate-overflow graph");
    await expectMutationRejectedAndUnchanged(
      aggregateFixture,
      aggregateGraph,
      "reject-aggregate-version-overflow",
      [{ action: "add_node", node: taskNode("node-aggregate-overflow", 1) }],
      "task_graph_version_overflow",
    );

    const dagFixture = await createRoomTaskGraphFixture("dag-version-overflow");
    await dagFixture.layer.db
      .update(operationalRooms)
      .set({ taskGraphVersion: Number.MAX_SAFE_INTEGER })
      .where(eq(operationalRooms.id, dagFixture.roomId));
    const dagGraph = await requireTaskGraphApi(dagFixture.store).getTaskGraph(dagFixture.roomId);
    if (!dagGraph) throw new Error("Expected DAG-overflow graph");
    await expectMutationRejectedAndUnchanged(
      dagFixture,
      dagGraph,
      "reject-dag-version-overflow",
      [{ action: "add_node", node: taskNode("node-dag-overflow", 1) }],
      "task_graph_version_overflow",
    );

    const nodeFixture = await createRoomTaskGraphFixture("node-version-overflow");
    const node = taskNode("node-version-overflow", 1);
    let nodeGraph = await mutateGraph(
      nodeFixture,
      { aggregateVersion: nodeFixture.aggregateVersion, dagVersion: 0 },
      "seed-node-version-overflow",
      [{ action: "add_node", node }],
    );
    await nodeFixture.layer.db
      .update(roomTaskNodes)
      .set({ nodeVersion: Number.MAX_SAFE_INTEGER })
      .where(eq(roomTaskNodes.id, node.id));
    const reloadedNodeGraph = await requireTaskGraphApi(nodeFixture.store)
      .getTaskGraph(nodeFixture.roomId);
    if (!reloadedNodeGraph) throw new Error("Expected node-overflow graph");
    nodeGraph = reloadedNodeGraph;
    await expectMutationRejectedAndUnchanged(
      nodeFixture,
      nodeGraph,
      "reject-node-version-overflow",
      [{
        action: "update_node",
        nodeId: node.id,
        expectedNodeVersion: Number.MAX_SAFE_INTEGER,
        patch: { progressSignature: "progress:node-version-overflow:next" },
        evidenceIds: ["evidence:node-version-overflow"],
      }],
      "task_graph_version_overflow",
    );
  });

  it("freezes an accepted node against ordinary definition mutations", async () => {
    const fixture = await createRoomTaskGraphFixture("accepted-freeze");
    const acceptedNode = taskNode("node-accepted", 3_000);
    let graph = await mutateGraph(
      fixture,
      { aggregateVersion: fixture.aggregateVersion, dagVersion: 0 },
      "seed-accepted-freeze",
      [{ action: "add_node", node: acceptedNode }],
    );
    graph = await mutateGraph(fixture, graph, "accept-frozen-node", [{
      action: "transition_node",
      nodeId: acceptedNode.id,
      expectedNodeVersion: findNode(graph, acceptedNode.id).nodeVersion,
      to: "accepted",
      acceptanceEvidenceIds: ["evidence:accepted-node-green"],
      progressSignature: "progress:node-accepted:accepted",
    }]);

    await expectMutationRejectedAndUnchanged(
      fixture,
      graph,
      "rewrite-accepted-node",
      [{
        action: "update_node",
        nodeId: acceptedNode.id,
        expectedNodeVersion: findNode(graph, acceptedNode.id).nodeVersion,
        patch: { objective: "Silently rewrite accepted work" },
        evidenceIds: ["evidence:ordinary-edit"],
      }],
      "accepted_node_frozen",
    );
  });

  it("requires explicit causal reopen after upstream acceptance evidence is invalidated", async () => {
    const fixture = await createRoomTaskGraphFixture("evidence-reopen");
    const upstream = taskNode("node-certified-capability", 2_000);
    const downstream = taskNode("node-provider-implementation", 5_000);
    const independent = taskNode("node-independent-docs", 1_000);
    const acceptedEvidenceId = "evidence:provider-capability:v1";
    const invalidationEvidenceId = "evidence:provider-capability:v2-unavailable";
    let graph = await mutateGraph(
      fixture,
      { aggregateVersion: fixture.aggregateVersion, dagVersion: 0 },
      "seed-evidence-reopen",
      [
        { action: "add_node", node: upstream },
        { action: "add_node", node: downstream },
        { action: "add_node", node: independent },
        {
          action: "add_edge",
          edge: taskEdge("edge-certified-implementation", upstream.id, downstream.id, "requires"),
        },
      ],
    );
    graph = await mutateGraph(fixture, graph, "accept-upstream-evidence", [{
      action: "transition_node",
      nodeId: upstream.id,
      expectedNodeVersion: findNode(graph, upstream.id).nodeVersion,
      to: "accepted",
      acceptanceEvidenceIds: [acceptedEvidenceId],
      progressSignature: "progress:capability:accepted",
    }]);
    graph = await mutateGraph(fixture, graph, "accept-downstream", [{
      action: "transition_node",
      nodeId: downstream.id,
      expectedNodeVersion: findNode(graph, downstream.id).nodeVersion,
      to: "accepted",
      acceptanceEvidenceIds: ["evidence:provider-implementation:green"],
      progressSignature: "progress:provider-implementation:accepted",
    }]);
    graph = await mutateGraph(fixture, graph, "accept-independent", [{
      action: "transition_node",
      nodeId: independent.id,
      expectedNodeVersion: findNode(graph, independent.id).nodeVersion,
      to: "accepted",
      acceptanceEvidenceIds: ["evidence:independent-docs:green"],
      progressSignature: "progress:independent-docs:accepted",
    }]);

    await expectMutationRejectedAndUnchanged(
      fixture,
      graph,
      "reopen-without-invalidation",
      [{
        action: "reopen_node",
        nodeId: downstream.id,
        expectedNodeVersion: findNode(graph, downstream.id).nodeVersion,
        upstreamNodeId: upstream.id,
        invalidatedByEvidenceId: invalidationEvidenceId,
        reason: "must not reopen before causal evidence is recorded",
      }],
      "reopen_requires_invalidated_upstream",
    );

    graph = await mutateGraph(fixture, graph, "invalidate-upstream-evidence", [{
      action: "invalidate_acceptance_evidence",
      nodeId: upstream.id,
      expectedNodeVersion: findNode(graph, upstream.id).nodeVersion,
      acceptanceEvidenceId: acceptedEvidenceId,
      invalidatedByEvidenceId: invalidationEvidenceId,
      reason: "current connector certification disproves the accepted capability",
    }]);

    expect(findNode(graph, upstream.id)).toMatchObject({
      state: "accepted",
      invalidatedByEvidenceId: invalidationEvidenceId,
    });
    expect(findNode(graph, downstream.id).state).toBe("accepted");
    expect(findNode(graph, independent.id).state).toBe("accepted");

    await expectMutationRejectedAndUnchanged(
      fixture,
      graph,
      "reopen-unrelated-node",
      [{
        action: "reopen_node",
        nodeId: independent.id,
        expectedNodeVersion: findNode(graph, independent.id).nodeVersion,
        upstreamNodeId: upstream.id,
        invalidatedByEvidenceId: invalidationEvidenceId,
        reason: "unrelated accepted work must stay frozen",
      }],
      "reopen_requires_invalidated_upstream",
    );

    graph = await mutateGraph(fixture, graph, "reopen-dependent-node", [{
      action: "reopen_node",
      nodeId: downstream.id,
      expectedNodeVersion: findNode(graph, downstream.id).nodeVersion,
      upstreamNodeId: upstream.id,
      invalidatedByEvidenceId: invalidationEvidenceId,
      reason: "the accepted implementation depended on the invalidated capability",
    }]);

    expect(findNode(graph, downstream.id)).toMatchObject({
      state: "waiting_dependency",
      acceptedAt: null,
      reopenedByEvidenceId: invalidationEvidenceId,
    });
    expect(findNode(graph, upstream.id).invalidatedByEvidenceId).toBe(invalidationEvidenceId);
    expect(findNode(graph, independent.id).state).toBe("accepted");
  });

  it("allows an invalidated accepted source to explicitly reopen itself", async () => {
    const fixture = await createRoomTaskGraphFixture("source-self-reopen");
    const source = taskNode("node-invalidated-source", 2_000);
    const acceptedEvidenceId = "evidence:source:v1";
    const invalidationEvidenceId = "evidence:source:v2-invalid";
    let graph = await mutateGraph(
      fixture,
      { aggregateVersion: fixture.aggregateVersion, dagVersion: 0 },
      "seed-source-self-reopen",
      [{ action: "add_node", node: source }],
    );
    graph = await mutateGraph(fixture, graph, "accept-source-self-reopen", [{
      action: "transition_node",
      nodeId: source.id,
      expectedNodeVersion: findNode(graph, source.id).nodeVersion,
      to: "accepted",
      acceptanceEvidenceIds: [acceptedEvidenceId],
      progressSignature: "progress:source:accepted",
    }]);
    graph = await mutateGraph(fixture, graph, "invalidate-source-self-reopen", [{
      action: "invalidate_acceptance_evidence",
      nodeId: source.id,
      expectedNodeVersion: findNode(graph, source.id).nodeVersion,
      acceptanceEvidenceId: acceptedEvidenceId,
      invalidatedByEvidenceId: invalidationEvidenceId,
      reason: "the source evidence was superseded",
    }]);

    graph = await mutateGraph(fixture, graph, "reopen-source-itself", [{
      action: "reopen_node",
      nodeId: source.id,
      expectedNodeVersion: findNode(graph, source.id).nodeVersion,
      upstreamNodeId: source.id,
      invalidatedByEvidenceId: invalidationEvidenceId,
      reason: "the invalidated source must be recomputed",
    }]);

    expect(findNode(graph, source.id)).toMatchObject({
      state: "ready",
      acceptedAt: null,
      acceptanceEvidenceIds: [],
      invalidatedByEvidenceId: null,
      reopenedByEvidenceId: invalidationEvidenceId,
    });
  });

  it("fails closed when a requires edge would create a cycle", async () => {
    const fixture = await createRoomTaskGraphFixture("cycle");
    const first = taskNode("node-cycle-first", 1_000);
    const second = taskNode("node-cycle-second", 1_000);
    const graph = await mutateGraph(
      fixture,
      { aggregateVersion: fixture.aggregateVersion, dagVersion: 0 },
      "seed-cycle",
      [
        { action: "add_node", node: first },
        { action: "add_node", node: second },
        {
          action: "add_edge",
          edge: taskEdge("edge-cycle-forward", first.id, second.id, "requires"),
        },
      ],
    );

    await expectMutationRejectedAndUnchanged(
      fixture,
      graph,
      "create-cycle",
      [{
        action: "add_edge",
        edge: taskEdge("edge-cycle-back", second.id, first.id, "requires"),
      }],
      "task_graph_cycle",
    );
  });

  it("includes informs and invalidates edges in the all-edge DAG cycle rule", async () => {
    const fixture = await createRoomTaskGraphFixture("all-edge-cycle");
    const graph = await requireTaskGraphApi(fixture.store).getTaskGraph(fixture.roomId);
    expect(graph).not.toBeNull();
    if (!graph) throw new Error("Expected an empty graph for all-edge cycle validation");
    const first = taskNode("node-all-edge-first", 1_000);
    const second = taskNode("node-all-edge-second", 1_000);
    const third = taskNode("node-all-edge-third", 1_000);

    await expectMutationRejectedAndUnchanged(
      fixture,
      graph,
      "reject-all-edge-cycle",
      [
        { action: "add_node", node: first },
        { action: "add_node", node: second },
        { action: "add_node", node: third },
        {
          action: "add_edge",
          edge: taskEdge("edge-all-edge-requires", first.id, second.id, "requires"),
        },
        {
          action: "add_edge",
          edge: taskEdge("edge-all-edge-informs", second.id, third.id, "informs"),
        },
        {
          action: "add_edge",
          edge: taskEdge("edge-all-edge-invalidates", third.id, first.id, "invalidates"),
        },
      ],
      "task_graph_cycle",
    );
  });

  it("fails closed on a self edge", async () => {
    const fixture = await createRoomTaskGraphFixture("self-edge");
    const node = taskNode("node-self-edge", 1_000);
    const graph = await mutateGraph(
      fixture,
      { aggregateVersion: fixture.aggregateVersion, dagVersion: 0 },
      "seed-self-edge",
      [{ action: "add_node", node }],
    );

    await expectMutationRejectedAndUnchanged(
      fixture,
      graph,
      "create-self-edge",
      [{
        action: "add_edge",
        edge: taskEdge("edge-self", node.id, node.id, "requires"),
      }],
      "task_graph_self_edge",
    );
  });

  it("fails closed when an edge references an unknown node", async () => {
    const fixture = await createRoomTaskGraphFixture("unknown-node");
    const known = taskNode("node-known", 1_000);
    const graph = await mutateGraph(
      fixture,
      { aggregateVersion: fixture.aggregateVersion, dagVersion: 0 },
      "seed-known-node",
      [{ action: "add_node", node: known }],
    );

    await expectMutationRejectedAndUnchanged(
      fixture,
      graph,
      "edge-to-unknown-node",
      [{
        action: "add_edge",
        edge: taskEdge("edge-to-missing", known.id, "node-missing", "requires"),
      }],
      "task_graph_unknown_node",
    );
  });

  it("fails closed on stale aggregate, DAG, and node versions", async () => {
    const fixture = await createRoomTaskGraphFixture("version-conflict");
    const first = taskNode("node-version-first", 1_000);
    const graph = await mutateGraph(
      fixture,
      { aggregateVersion: fixture.aggregateVersion, dagVersion: 0 },
      "seed-version-conflict",
      [{ action: "add_node", node: first }],
    );

    await expectMutationRejectedAndUnchanged(
      fixture,
      graph,
      "stale-aggregate-version",
      [{ action: "add_node", node: taskNode("node-version-aggregate-stale", 1_000) }],
      "aggregate_version_conflict",
      { expectedAggregateVersion: graph.aggregateVersion - 1 },
    );
    await expectMutationRejectedAndUnchanged(
      fixture,
      graph,
      "stale-dag-version",
      [{ action: "add_node", node: taskNode("node-version-second", 1_000) }],
      "dag_version_conflict",
      { expectedDagVersion: graph.dagVersion - 1 },
    );
    await expectMutationRejectedAndUnchanged(
      fixture,
      graph,
      "stale-node-version",
      [{
        action: "transition_node",
        nodeId: first.id,
        expectedNodeVersion: findNode(graph, first.id).nodeVersion - 1,
        to: "running",
        acceptanceEvidenceIds: [],
        progressSignature: "progress:stale-writer",
      }],
      "task_node_version_conflict",
    );
  });

  it("keeps an independent branch ready while another branch waits", async () => {
    const fixture = await createRoomTaskGraphFixture("independent-readiness");
    const waiting = taskNode("node-waiting-approval", 3_000);
    const dependent = taskNode("node-dependent-on-approval", 5_000);
    const independent = taskNode("node-independent-ready", 2_000);
    let graph = await mutateGraph(
      fixture,
      { aggregateVersion: fixture.aggregateVersion, dagVersion: 0 },
      "seed-independent-readiness",
      [
        { action: "add_node", node: waiting },
        { action: "add_node", node: dependent },
        { action: "add_node", node: independent },
        {
          action: "add_edge",
          edge: taskEdge("edge-waiting-dependent", waiting.id, dependent.id, "requires"),
        },
      ],
    );
    graph = await mutateGraph(fixture, graph, "wait-for-approval", [{
      action: "transition_node",
      nodeId: waiting.id,
      expectedNodeVersion: findNode(graph, waiting.id).nodeVersion,
      to: "waiting_approval",
      acceptanceEvidenceIds: [],
      progressSignature: "progress:waiting-for-operator-approval",
    }]);

    expect(findNode(graph, waiting.id).state).toBe("waiting_approval");
    expect(findNode(graph, dependent.id).state).toBe("waiting_dependency");
    expect(findNode(graph, independent.id).state).toBe("ready");
    expect(graph.readyNodeIds).toEqual([independent.id]);
  });
});
