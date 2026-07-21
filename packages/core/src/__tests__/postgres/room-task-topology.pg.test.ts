import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";

import {
  AsyncRoomStore,
  type MutateRoomTaskGraphInputV1,
  type RoomCommandContext,
  type RoomTaskEdgeKindV1,
  type RoomTaskGraphMutationV1,
  type RoomTaskGraphProjectionV1,
  type RoomTaskNodeDefinitionV1,
} from "../../async-room-store.js";
import { hashRoomValue } from "../../room-integrity.js";
import { createConnectionSetFromUrl, type PostgresConnections } from "../../postgres/connection.js";
import { createAsyncDataLayer, type AsyncDataLayer } from "../../postgres/data-layer.js";
import { EmbeddedPostgresLifecycle } from "../../postgres/embedded-lifecycle.js";
import { applySchemaBaseline } from "../../postgres/schema-applier.js";
import { roomEvidence, roomTaskEdges, roomTaskNodes } from "../../postgres/schema/room.js";

/*
FNXC:SessionRoomTaskTopology 2026-07-18-15:05:
Hierarchical rewrites stay inside AsyncRoomStore.mutateTaskGraph. These focused
PostgreSQL contracts require atomic versioned topology, deterministic lineage,
active-edge projections, and dependency isolation without a parallel DAG model.
*/

interface EmbeddedTestContext {
  readonly dataDir: string;
  readonly lifecycle: EmbeddedPostgresLifecycle;
  connections: PostgresConnections | null;
}

interface Fixture {
  readonly layer: AsyncDataLayer;
  readonly store: AsyncRoomStore;
  readonly roomId: string;
  readonly aggregateVersion: number;
  readonly evidenceId: string;
}

const PROJECT_ID = "project-room-task-topology";
const BASE_TIME = "2026-07-18T07:05:00.000Z";
let sequence = 0;

async function startEmbeddedDatabase(): Promise<EmbeddedTestContext> {
  const dataDir = mkdtempSync(join(tmpdir(), "fusion-room-task-topology-"));
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

function context(roomId: string, label: string): RoomCommandContext {
  sequence += 1;
  return {
    eventId: `event-${roomId}-${label}`,
    actorType: "controller",
    actorId: "room-controller-topology-test",
    correlationId: `correlation-${roomId}-${label}`,
    causationId: null,
    occurredAt: new Date(Date.parse(BASE_TIME) + sequence * 1_000).toISOString(),
  };
}

function node(id: string, estimatedDurationMs = 1_000): RoomTaskNodeDefinitionV1 {
  return {
    id,
    parentNodeId: null,
    objective: `Complete ${id}`,
    inputRefs: [`input:${id}`],
    outputRefs: [`artifact:${id}`],
    roleRequirements: ["implementer"],
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
      recoveryActions: ["replan"],
    },
    progressSignature: `progress:${id}:v1`,
  };
}

function childNode(id: string): Omit<RoomTaskNodeDefinitionV1, "parentNodeId"> {
  const definition = node(id);
  return {
    id: definition.id,
    objective: definition.objective,
    inputRefs: definition.inputRefs,
    outputRefs: definition.outputRefs,
    roleRequirements: definition.roleRequirements,
    capabilityRequirements: definition.capabilityRequirements,
    resourceHints: definition.resourceHints,
    authorityScope: definition.authorityScope,
    acceptanceGateIds: definition.acceptanceGateIds,
    retryPolicy: definition.retryPolicy,
    progressSignature: definition.progressSignature,
  };
}

function edge(id: string, fromNodeId: string, toNodeId: string, kind: RoomTaskEdgeKindV1) {
  return { id, fromNodeId, toNodeId, kind } as const;
}

async function fixture(label: string): Promise<Fixture> {
  const roomId = `room-task-topology-${label}`;
  const store = new AsyncRoomStore(sharedLayer, { projectId: PROJECT_ID });
  const created = await store.createRoom({
    id: roomId,
    projectId: PROJECT_ID,
    objective: `Exercise Room task topology ${label}`,
    protocolId: "implementation",
    protocolVersion: 1,
    now: BASE_TIME,
  }, context(roomId, "created"));
  const evidenceId = `evidence:${roomId}`;
  await sharedLayer.db.insert(roomEvidence).values({
    id: evidenceId,
    projectId: PROJECT_ID,
    roomId,
    nodeId: "topology-controller",
    candidateId: null,
    kind: "task_topology_observation",
    authoritativeSourceUri: `room://${roomId}/topology-observation`,
    sourceVersionOrHash: hashRoomValue({ roomId, version: 1 }),
    capturedAt: BASE_TIME,
    collectionMethod: "focused_postgres_test",
    collectorBindingId: null,
    contentHash: hashRoomValue({ roomId, evidence: "topology" }),
    artifactIds: [],
    expiresAt: null,
  });
  return {
    layer: sharedLayer,
    store,
    roomId,
    aggregateVersion: created.room.aggregateVersion,
    evidenceId,
  };
}

async function mutate(
  current: Fixture,
  graph: Pick<RoomTaskGraphProjectionV1, "aggregateVersion" | "dagVersion">,
  label: string,
  mutations: readonly RoomTaskGraphMutationV1[],
  expectedNodeVersions?: Readonly<Record<string, number>>,
): Promise<RoomTaskGraphProjectionV1> {
  const commandContext = context(current.roomId, label);
  const normalizedMutations = mutations.map((mutation) => (
    ["split_node", "merge_nodes", "cancel_node", "remove_edge"].includes(mutation.action)
    && !("causalEvidenceIds" in mutation)
      ? { ...mutation, causalEvidenceIds: [current.evidenceId] }
      : mutation
  )) as readonly RoomTaskGraphMutationV1[];
  const input = {
    roomId: current.roomId,
    expectedAggregateVersion: graph.aggregateVersion,
    expectedDagVersion: graph.dagVersion,
    idempotencyKey: `task-topology:${current.roomId}:${label}`,
    mutations: normalizedMutations,
    mutatedAt: commandContext.occurredAt,
    ...(expectedNodeVersions ? { expectedNodeVersions } : {}),
  } as unknown as MutateRoomTaskGraphInputV1;
  return current.store.mutateTaskGraph(input, commandContext);
}

function findNode(graph: RoomTaskGraphProjectionV1, nodeId: string) {
  const found = graph.nodes.find((candidate) => candidate.id === nodeId);
  if (!found) throw new Error(`Missing topology node ${nodeId}`);
  return found;
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

describe("AsyncRoomStore PostgreSQL hierarchical topology commands", () => {
  it("splits one node into explicit children and deterministically rewires every edge kind", async () => {
    const current = await fixture("split-all-edge-kinds");
    const upstream = node("split-upstream");
    const invalidator = node("split-invalidator");
    const source = node("split-source", 4_000);
    const downstream = node("split-downstream", 2_000);
    let graph = await mutate(
      current,
      { aggregateVersion: current.aggregateVersion, dagVersion: 0 },
      "seed",
      [
        { action: "add_node", node: upstream },
        { action: "add_node", node: invalidator },
        { action: "add_node", node: source },
        { action: "add_node", node: downstream },
        { action: "add_edge", edge: edge("split-edge-informs", upstream.id, source.id, "informs") },
        { action: "add_edge", edge: edge("split-edge-invalidates", invalidator.id, source.id, "invalidates") },
        { action: "add_edge", edge: edge("split-edge-requires", source.id, downstream.id, "requires") },
      ],
    );

    const childA = { ...childNode("split-child-a"), assignedSeatIds: ["seat-split-a"] };
    const childB = { ...childNode("split-child-b"), assignedSeatIds: ["seat-split-b"] };
    graph = await mutate(
      current,
      graph,
      "split",
      [{
        action: "split_node",
        nodeId: source.id,
        children: [childA, childB],
        reason: "Provider work decomposed into two independently accepted slices",
      } as unknown as RoomTaskGraphMutationV1],
      {
        [upstream.id]: findNode(graph, upstream.id).nodeVersion,
        [invalidator.id]: findNode(graph, invalidator.id).nodeVersion,
        [source.id]: findNode(graph, source.id).nodeVersion,
        [downstream.id]: findNode(graph, downstream.id).nodeVersion,
      },
    );

    const terminalSource = findNode(graph, source.id) as typeof graph.nodes[number] & {
      terminalLineage: { kind: string; operationId: string } | null;
    };
    expect(terminalSource).toMatchObject({
      state: "cancelled",
      terminalLineage: { kind: "split", operationId: expect.any(String) },
    });
    for (const child of [childA, childB]) {
      expect(findNode(graph, child.id)).toMatchObject({
        id: child.id,
        parentNodeId: source.id,
        assignedSeatIds: child.assignedSeatIds,
        state: "ready",
        origin: {
          kind: "split_child",
          operationId: terminalSource.terminalLineage?.operationId,
          sourceNodeIds: [source.id],
        },
      });
    }
    expect(graph.edges).toHaveLength(6);
    expect(graph.edges.map((candidate) => ({
      fromNodeId: candidate.fromNodeId,
      toNodeId: candidate.toNodeId,
      kind: candidate.kind,
      derivedFromEdgeIds: (candidate as typeof candidate & { derivedFromEdgeIds: readonly string[] })
        .derivedFromEdgeIds,
    }))).toEqual(expect.arrayContaining([
      { fromNodeId: upstream.id, toNodeId: childA.id, kind: "informs", derivedFromEdgeIds: ["split-edge-informs"] },
      { fromNodeId: upstream.id, toNodeId: childB.id, kind: "informs", derivedFromEdgeIds: ["split-edge-informs"] },
      { fromNodeId: invalidator.id, toNodeId: childA.id, kind: "invalidates", derivedFromEdgeIds: ["split-edge-invalidates"] },
      { fromNodeId: invalidator.id, toNodeId: childB.id, kind: "invalidates", derivedFromEdgeIds: ["split-edge-invalidates"] },
      { fromNodeId: childA.id, toNodeId: downstream.id, kind: "requires", derivedFromEdgeIds: ["split-edge-requires"] },
      { fromNodeId: childB.id, toNodeId: downstream.id, kind: "requires", derivedFromEdgeIds: ["split-edge-requires"] },
    ]));
    expect(findNode(graph, downstream.id).state).toBe("waiting_dependency");

    graph = await mutate(current, graph, "accept-child-a", [{
      action: "transition_node",
      nodeId: childA.id,
      expectedNodeVersion: findNode(graph, childA.id).nodeVersion,
      to: "accepted",
      acceptanceEvidenceIds: ["evidence:split-child-a"],
      progressSignature: "progress:split-child-a:accepted",
    }]);
    expect(findNode(graph, downstream.id).state).toBe("waiting_dependency");

    graph = await mutate(current, graph, "accept-child-b", [{
      action: "transition_node",
      nodeId: childB.id,
      expectedNodeVersion: findNode(graph, childB.id).nodeVersion,
      to: "accepted",
      acceptanceEvidenceIds: ["evidence:split-child-b"],
      progressSignature: "progress:split-child-b:accepted",
    }]);
    expect(findNode(graph, downstream.id).state).toBe("ready");
  });

  it("merges same-parent nodes, collapses duplicate shapes, and rejects a derived all-edge cycle", async () => {
    const current = await fixture("merge-collapse-hierarchy");
    const parent = node("merge-parent");
    const upstream = node("merge-upstream");
    const left = { ...node("merge-left"), parentNodeId: parent.id };
    const right = { ...node("merge-right"), parentNodeId: parent.id };
    const downstream = node("merge-downstream");
    let graph = await mutate(
      current,
      { aggregateVersion: current.aggregateVersion, dagVersion: 0 },
      "seed",
      [
        { action: "add_node", node: parent },
        { action: "add_node", node: upstream },
        { action: "add_node", node: left },
        { action: "add_node", node: right },
        { action: "add_node", node: downstream },
        { action: "add_edge", edge: edge("merge-in-left", upstream.id, left.id, "requires") },
        { action: "add_edge", edge: edge("merge-in-right", upstream.id, right.id, "requires") },
        { action: "add_edge", edge: edge("merge-out-left", left.id, downstream.id, "informs") },
        { action: "add_edge", edge: edge("merge-out-right", right.id, downstream.id, "informs") },
        { action: "add_edge", edge: edge("merge-internal", left.id, right.id, "invalidates") },
      ],
    );
    const merged = childNode("merge-result");

    graph = await mutate(
      current,
      graph,
      "merge",
      [{
        action: "merge_nodes",
        nodeIds: [right.id, left.id],
        mergedNode: merged,
        reason: "Two sibling implementation slices now share one acceptance boundary",
      } as unknown as RoomTaskGraphMutationV1],
      {
        [parent.id]: findNode(graph, parent.id).nodeVersion,
        [upstream.id]: findNode(graph, upstream.id).nodeVersion,
        [left.id]: findNode(graph, left.id).nodeVersion,
        [right.id]: findNode(graph, right.id).nodeVersion,
        [downstream.id]: findNode(graph, downstream.id).nodeVersion,
      },
    );

    const mergedProjection = findNode(graph, merged.id) as typeof graph.nodes[number] & {
      origin: { kind: string; operationId: string; sourceNodeIds: readonly string[] };
    };
    expect(mergedProjection).toMatchObject({
      parentNodeId: parent.id,
      state: "waiting_dependency",
      origin: {
        kind: "merge_result",
        operationId: expect.any(String),
        sourceNodeIds: [left.id, right.id],
      },
    });
    expect(findNode(graph, left.id)).toMatchObject({
      state: "cancelled",
      terminalLineage: { kind: "merge", operationId: mergedProjection.origin.operationId },
    });
    expect(findNode(graph, right.id)).toMatchObject({
      state: "cancelled",
      terminalLineage: { kind: "merge", operationId: mergedProjection.origin.operationId },
    });
    expect(graph.edges).toHaveLength(2);
    expect(graph.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({
        fromNodeId: upstream.id,
        toNodeId: merged.id,
        kind: "requires",
        derivedFromEdgeIds: ["merge-in-left", "merge-in-right"],
      }),
      expect.objectContaining({
        fromNodeId: merged.id,
        toNodeId: downstream.id,
        kind: "informs",
        derivedFromEdgeIds: ["merge-out-left", "merge-out-right"],
      }),
    ]));

    const cyclic = await fixture("merge-derived-cycle");
    const cycleParent = node("merge-cycle-parent");
    const cyclePeer = node("merge-cycle-peer");
    const cycleLeft = { ...node("merge-cycle-left"), parentNodeId: cycleParent.id };
    const cycleRight = { ...node("merge-cycle-right"), parentNodeId: cycleParent.id };
    let cycleGraph = await mutate(
      cyclic,
      { aggregateVersion: cyclic.aggregateVersion, dagVersion: 0 },
      "seed",
      [
        { action: "add_node", node: cycleParent },
        { action: "add_node", node: cyclePeer },
        { action: "add_node", node: cycleLeft },
        { action: "add_node", node: cycleRight },
        { action: "add_edge", edge: edge("merge-cycle-in", cyclePeer.id, cycleLeft.id, "informs") },
        { action: "add_edge", edge: edge("merge-cycle-out", cycleRight.id, cyclePeer.id, "invalidates") },
      ],
    );
    const before = cycleGraph;
    const eventCountBefore = (await cyclic.store.listEvents(cyclic.roomId)).length;
    const commandContext = context(cyclic.roomId, "merge-cycle");
    const cycleInput = {
      roomId: cyclic.roomId,
      expectedAggregateVersion: cycleGraph.aggregateVersion,
      expectedDagVersion: cycleGraph.dagVersion,
      expectedNodeVersions: {
        [cycleParent.id]: findNode(cycleGraph, cycleParent.id).nodeVersion,
        [cyclePeer.id]: findNode(cycleGraph, cyclePeer.id).nodeVersion,
        [cycleLeft.id]: findNode(cycleGraph, cycleLeft.id).nodeVersion,
        [cycleRight.id]: findNode(cycleGraph, cycleRight.id).nodeVersion,
      },
      idempotencyKey: `task-topology:${cyclic.roomId}:merge-cycle`,
      mutations: [{
        action: "merge_nodes",
        nodeIds: [cycleLeft.id, cycleRight.id],
        mergedNode: childNode("merge-cycle-result"),
        causalEvidenceIds: [cyclic.evidenceId],
        reason: "This collapse must expose and reject its derived cycle",
      }],
      mutatedAt: commandContext.occurredAt,
    } as unknown as MutateRoomTaskGraphInputV1;
    await expect(cyclic.store.mutateTaskGraph(cycleInput, commandContext)).rejects.toMatchObject({
      code: "task_graph_cycle",
    });
    cycleGraph = (await cyclic.store.getTaskGraph(cyclic.roomId))!;
    expect(cycleGraph).toEqual(before);
    expect(await cyclic.store.listEvents(cyclic.roomId)).toHaveLength(eventCountBefore);
  });

  it("cancels only the source tombstone while preserving dependencies and independent readiness", async () => {
    const current = await fixture("cancel-dependency-isolation");
    const source = node("cancel-source");
    const dependent = node("cancel-dependent");
    const independent = node("cancel-independent");
    let graph = await mutate(
      current,
      { aggregateVersion: current.aggregateVersion, dagVersion: 0 },
      "seed",
      [
        { action: "add_node", node: source },
        { action: "add_node", node: dependent },
        { action: "add_node", node: independent },
        { action: "add_edge", edge: edge("cancel-requires", source.id, dependent.id, "requires") },
      ],
    );
    const originalEdges = graph.edges;

    graph = await mutate(
      current,
      graph,
      "cancel",
      [{
        action: "cancel_node",
        nodeId: source.id,
        reason: "This branch is superseded but its unsatisfied obligation remains visible",
      } as unknown as RoomTaskGraphMutationV1],
      {
        [source.id]: findNode(graph, source.id).nodeVersion,
        [dependent.id]: findNode(graph, dependent.id).nodeVersion,
      },
    );

    expect(findNode(graph, source.id)).toMatchObject({
      state: "cancelled",
      terminalLineage: {
        kind: "cancel",
        operationId: expect.any(String),
        reasonHash: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
      },
    });
    expect(graph.edges).toEqual(originalEdges);
    expect(findNode(graph, dependent.id).state).toBe("waiting_dependency");
    expect(findNode(graph, independent.id).state).toBe("ready");
    expect(graph.readyNodeIds).toContain(independent.id);
    expect(graph.readyNodeIds).not.toContain(dependent.id);
  });

  it("retires an edge before an atomic replacement and uses only active edges for readiness", async () => {
    const current = await fixture("remove-edge-replacement");
    const source = node("remove-edge-source");
    const dependent = node("remove-edge-dependent");
    let graph = await mutate(
      current,
      { aggregateVersion: current.aggregateVersion, dagVersion: 0 },
      "seed",
      [
        { action: "add_node", node: source },
        { action: "add_node", node: dependent },
        { action: "add_edge", edge: edge("remove-edge-old", source.id, dependent.id, "requires") },
      ],
    );
    expect(findNode(graph, dependent.id).state).toBe("waiting_dependency");

    const beforeInvalidOrder = graph;
    const invalidContext = context(current.roomId, "invalid-remove-order");
    await expect(current.store.mutateTaskGraph({
      roomId: current.roomId,
      expectedAggregateVersion: graph.aggregateVersion,
      expectedDagVersion: graph.dagVersion,
      expectedNodeVersions: {
        [source.id]: findNode(graph, source.id).nodeVersion,
        [dependent.id]: findNode(graph, dependent.id).nodeVersion,
      },
      idempotencyKey: `task-topology:${current.roomId}:invalid-remove-order`,
      mutations: [
        { action: "add_edge", edge: edge("remove-edge-invalid-new", source.id, dependent.id, "informs") },
        {
          action: "remove_edge",
          edgeId: "remove-edge-old",
          causalEvidenceIds: [current.evidenceId],
          reason: "Invalid order",
        },
      ],
      mutatedAt: invalidContext.occurredAt,
    } as unknown as MutateRoomTaskGraphInputV1, invalidContext)).rejects.toMatchObject({
      code: "task_graph_invalid_mutation",
    });
    expect(await current.store.getTaskGraph(current.roomId)).toEqual(beforeInvalidOrder);

    const reusedIdContext = context(current.roomId, "reused-retired-edge-id");
    await expect(current.store.mutateTaskGraph({
      roomId: current.roomId,
      expectedAggregateVersion: graph.aggregateVersion,
      expectedDagVersion: graph.dagVersion,
      expectedNodeVersions: {
        [source.id]: findNode(graph, source.id).nodeVersion,
        [dependent.id]: findNode(graph, dependent.id).nodeVersion,
      },
      idempotencyKey: `task-topology:${current.roomId}:reused-retired-edge-id`,
      mutations: [
        {
          action: "remove_edge",
          edgeId: "remove-edge-old",
          causalEvidenceIds: [current.evidenceId],
          reason: "Retire the dependency",
        },
        { action: "add_edge", edge: edge("remove-edge-old", source.id, dependent.id, "informs") },
      ],
      mutatedAt: reusedIdContext.occurredAt,
    } as unknown as MutateRoomTaskGraphInputV1, reusedIdContext)).rejects.toMatchObject({
      code: "task_graph_invalid_mutation",
    });
    expect(await current.store.getTaskGraph(current.roomId)).toEqual(beforeInvalidOrder);

    graph = await mutate(
      current,
      graph,
      "replace-edge",
      [
        {
          action: "remove_edge",
          edgeId: "remove-edge-old",
          reason: "The predecessor now informs but no longer blocks this task",
        } as unknown as RoomTaskGraphMutationV1,
        { action: "add_edge", edge: edge("remove-edge-new", source.id, dependent.id, "informs") },
      ],
      {
        [source.id]: findNode(graph, source.id).nodeVersion,
        [dependent.id]: findNode(graph, dependent.id).nodeVersion,
      },
    );

    expect(graph.edges).toEqual([expect.objectContaining({
      id: "remove-edge-new",
      fromNodeId: source.id,
      toNodeId: dependent.id,
      kind: "informs",
    })]);
    expect(findNode(graph, dependent.id).state).toBe("ready");
    const retiredRows = await current.layer.db
      .select()
      .from(roomTaskEdges)
      .where(and(
        eq(roomTaskEdges.projectId, PROJECT_ID),
        eq(roomTaskEdges.roomId, current.roomId),
        eq(roomTaskEdges.id, "remove-edge-old"),
      ));
    expect(retiredRows).toHaveLength(1);
    expect(retiredRows[0]).toMatchObject({
      retiredAt: expect.any(String),
      retiredByOperationId: expect.stringMatching(/^room-task-topology:sha256:[0-9a-f]{64}$/u),
      derivedFromEdgeIds: [],
    });
  });

  it("replays one deterministic split operation with hash-only audit and stable persisted lineage", async () => {
    const current = await fixture("split-idempotent-lineage");
    const source = node("lineage-source");
    const downstream = node("lineage-downstream");
    const seeded = await mutate(
      current,
      { aggregateVersion: current.aggregateVersion, dagVersion: 0 },
      "seed",
      [
        { action: "add_node", node: source },
        { action: "add_node", node: downstream },
        { action: "add_edge", edge: edge("lineage-edge", source.id, downstream.id, "requires") },
      ],
    );
    const reason = "Private provider incident details must never enter topology audit";
    const splitContext = context(current.roomId, "split-idempotent");
    const splitInput = {
      roomId: current.roomId,
      expectedAggregateVersion: seeded.aggregateVersion,
      expectedDagVersion: seeded.dagVersion,
      expectedNodeVersions: {
        [source.id]: findNode(seeded, source.id).nodeVersion,
        [downstream.id]: findNode(seeded, downstream.id).nodeVersion,
      },
      idempotencyKey: `task-topology:${current.roomId}:split-idempotent`,
      mutations: [{
        action: "split_node",
        nodeId: source.id,
        children: [childNode("lineage-child-a"), childNode("lineage-child-b")],
        causalEvidenceIds: [current.evidenceId],
        reason,
      }],
      mutatedAt: splitContext.occurredAt,
    } as unknown as MutateRoomTaskGraphInputV1;

    const first = await current.store.mutateTaskGraph(splitInput, splitContext);
    const eventCount = (await current.store.listEvents(current.roomId)).length;
    const nodeRowsBeforeReplay = await current.layer.db
      .select()
      .from(roomTaskNodes)
      .where(and(
        eq(roomTaskNodes.projectId, PROJECT_ID),
        eq(roomTaskNodes.roomId, current.roomId),
      ));
    const edgeRowsBeforeReplay = await current.layer.db
      .select()
      .from(roomTaskEdges)
      .where(and(
        eq(roomTaskEdges.projectId, PROJECT_ID),
        eq(roomTaskEdges.roomId, current.roomId),
      ));
    const sourceRow = nodeRowsBeforeReplay.find((candidate) => candidate.id === source.id);
    const terminal = sourceRow?.terminalLineage as { operationId?: unknown } | null | undefined;
    expect(terminal?.operationId).toMatch(/^room-task-topology:sha256:[0-9a-f]{64}$/u);
    expect(edgeRowsBeforeReplay).toHaveLength(3);
    expect(edgeRowsBeforeReplay.filter((candidate) => candidate.retiredAt !== null)).toEqual([
      expect.objectContaining({
        id: "lineage-edge",
        retiredByOperationId: terminal?.operationId,
      }),
    ]);
    const activeDerived = edgeRowsBeforeReplay.filter((candidate) => candidate.retiredAt === null);
    expect(activeDerived).toHaveLength(2);
    expect(activeDerived.every((candidate) =>
      /^room-task-edge:sha256:[0-9a-f]{64}$/u.test(candidate.id)
      && candidate.derivedFromEdgeIds.length === 1
      && candidate.derivedFromEdgeIds[0] === "lineage-edge")).toBe(true);

    const eventsBeforeReplay = await current.store.listEvents(current.roomId);
    const event = eventsBeforeReplay.find((candidate) => candidate.id === splitContext.eventId);
    expect(event?.payload).toMatchObject({
      commandAudit: {
        topologyOperationId: terminal?.operationId,
        mutations: [{
          action: "split_node",
          nodeId: source.id,
          childNodeIds: ["lineage-child-a", "lineage-child-b"],
          causalEvidenceIds: [current.evidenceId],
          reasonHash: hashRoomValue(reason),
        }],
      },
    });
    expect(JSON.stringify(event?.payload.commandAudit)).not.toContain(reason);

    const rejectTombstoneMutation = async (
      label: string,
      mutation: RoomTaskGraphMutationV1,
    ) => {
      const rejectedContext = context(current.roomId, label);
      await expect(current.store.mutateTaskGraph({
        roomId: current.roomId,
        expectedAggregateVersion: first.aggregateVersion,
        expectedDagVersion: first.dagVersion,
        idempotencyKey: `task-topology:${current.roomId}:${label}`,
        mutations: [mutation],
        mutatedAt: rejectedContext.occurredAt,
      }, rejectedContext)).rejects.toMatchObject({ code: "task_graph_invalid_mutation" });
    };
    await rejectTombstoneMutation("update-split-tombstone", {
      action: "update_node",
      nodeId: source.id,
      expectedNodeVersion: findNode(first, source.id).nodeVersion,
      patch: { objective: "Illegally rewrite a terminal topology source" },
      evidenceIds: ["evidence:tombstone-update"],
    });
    await rejectTombstoneMutation("add-child-to-split-tombstone", {
      action: "add_node",
      node: { ...node("lineage-late-child"), parentNodeId: source.id },
    });
    await rejectTombstoneMutation("attach-edge-to-split-tombstone", {
      action: "add_edge",
      edge: edge("lineage-late-edge", source.id, downstream.id, "informs"),
    });
    expect(await current.store.getTaskGraph(current.roomId)).toEqual(first);
    expect(await current.store.listEvents(current.roomId)).toEqual(eventsBeforeReplay);

    await expect(current.store.mutateTaskGraph(splitInput, splitContext)).resolves.toEqual(first);
    expect(await current.store.listEvents(current.roomId)).toHaveLength(eventCount);
    expect(await current.layer.db.select().from(roomTaskNodes).where(and(
      eq(roomTaskNodes.projectId, PROJECT_ID),
      eq(roomTaskNodes.roomId, current.roomId),
    ))).toEqual(nodeRowsBeforeReplay);
    expect(await current.layer.db.select().from(roomTaskEdges).where(and(
      eq(roomTaskEdges.projectId, PROJECT_ID),
      eq(roomTaskEdges.roomId, current.roomId),
    ))).toEqual(edgeRowsBeforeReplay);
    const reopened = new AsyncRoomStore(current.layer, { projectId: PROJECT_ID });
    await expect(reopened.getTaskGraph(current.roomId)).resolves.toEqual(first);
  });

  it("rejects stale affected-node CAS, unsafe versions, and bounded split expansion with zero writes", async () => {
    const current = await fixture("split-cas-bounds-rollback");
    const source = node("bounded-source");
    const neighbors = Array.from({ length: 5 }, (_, index) => node(`bounded-neighbor-${index}`));
    const graph = await mutate(
      current,
      { aggregateVersion: current.aggregateVersion, dagVersion: 0 },
      "seed",
      [
        { action: "add_node", node: source },
        ...neighbors.map((candidate) => ({ action: "add_node" as const, node: candidate })),
        ...neighbors.map((candidate, index) => ({
          action: "add_edge" as const,
          edge: edge(`bounded-edge-${index}`, source.id, candidate.id, "informs"),
        })),
      ],
    );
    const completeVersions = Object.fromEntries([
      [source.id, findNode(graph, source.id).nodeVersion],
      ...neighbors.map((candidate) => [candidate.id, findNode(graph, candidate.id).nodeVersion] as const),
    ]);
    const before = await current.store.getTaskGraph(current.roomId);
    const eventsBefore = await current.store.listEvents(current.roomId);
    const nodeRowsBefore = await current.layer.db.select().from(roomTaskNodes).where(and(
      eq(roomTaskNodes.projectId, PROJECT_ID),
      eq(roomTaskNodes.roomId, current.roomId),
    ));
    const edgeRowsBefore = await current.layer.db.select().from(roomTaskEdges).where(and(
      eq(roomTaskEdges.projectId, PROJECT_ID),
      eq(roomTaskEdges.roomId, current.roomId),
    ));

    const rejectSplit = async (
      label: string,
      expectedNodeVersions: Readonly<Record<string, number>>,
      children: readonly Omit<RoomTaskNodeDefinitionV1, "parentNodeId">[],
      code: string,
    ) => {
      const commandContext = context(current.roomId, label);
      await expect(current.store.mutateTaskGraph({
        roomId: current.roomId,
        expectedAggregateVersion: graph.aggregateVersion,
        expectedDagVersion: graph.dagVersion,
        expectedNodeVersions,
        idempotencyKey: `task-topology:${current.roomId}:${label}`,
        mutations: [{
          action: "split_node",
          nodeId: source.id,
          children,
          causalEvidenceIds: [current.evidenceId],
          reason: "This rejected command must roll back every write",
        }],
        mutatedAt: commandContext.occurredAt,
      } as unknown as MutateRoomTaskGraphInputV1, commandContext)).rejects.toMatchObject({ code });
      expect(await current.store.getTaskGraph(current.roomId)).toEqual(before);
      expect(await current.store.listEvents(current.roomId)).toEqual(eventsBefore);
    };

    await rejectSplit(
      "missing-neighbor-cas",
      { [source.id]: findNode(graph, source.id).nodeVersion },
      [childNode("stale-child-a"), childNode("stale-child-b")],
      "task_node_version_conflict",
    );
    await rejectSplit(
      "unsafe-node-version",
      { ...completeVersions, [source.id]: Number.MAX_SAFE_INTEGER + 1 },
      [childNode("unsafe-child-a"), childNode("unsafe-child-b")],
      "task_graph_invalid_mutation",
    );
    await rejectSplit(
      "too-many-children",
      completeVersions,
      Array.from({ length: 17 }, (_, index) => childNode(`too-many-child-${index}`)),
      "task_graph_invalid_mutation",
    );
    await rejectSplit(
      "too-many-rewires",
      completeVersions,
      Array.from({ length: 16 }, (_, index) => childNode(`too-many-rewire-child-${index}`)),
      "task_graph_invalid_mutation",
    );
    expect(await current.layer.db.select().from(roomTaskNodes).where(and(
      eq(roomTaskNodes.projectId, PROJECT_ID),
      eq(roomTaskNodes.roomId, current.roomId),
    ))).toEqual(nodeRowsBefore);
    expect(await current.layer.db.select().from(roomTaskEdges).where(and(
      eq(roomTaskEdges.projectId, PROJECT_ID),
      eq(roomTaskEdges.roomId, current.roomId),
    ))).toEqual(edgeRowsBefore);
  });

  it("fails closed for frozen sources, accepted incident neighbors, and non-exclusive topology commands", async () => {
    const current = await fixture("topology-freeze-command-shape");
    const acceptedSource = node("freeze-accepted-source");
    const cancelledSource = node("freeze-cancelled-source");
    const retryingSource = node("freeze-retrying-source");
    const mutableSource = node("freeze-mutable-source");
    const mergeLeft = node("freeze-merge-left");
    const mergeRight = node("freeze-merge-right");
    const acceptedParent = node("freeze-accepted-parent");
    const parentedMergeLeft = {
      ...node("freeze-parented-merge-left"),
      parentNodeId: acceptedParent.id,
    };
    const parentedMergeRight = {
      ...node("freeze-parented-merge-right"),
      parentNodeId: acceptedParent.id,
    };
    const acceptedNeighbor = node("freeze-accepted-neighbor");
    let graph = await mutate(
      current,
      { aggregateVersion: current.aggregateVersion, dagVersion: 0 },
      "seed",
      [
        ...[
          acceptedSource,
          cancelledSource,
          retryingSource,
          mutableSource,
          mergeLeft,
          mergeRight,
          acceptedParent,
          parentedMergeLeft,
          parentedMergeRight,
          acceptedNeighbor,
        ].map((candidate) => ({ action: "add_node" as const, node: candidate })),
        { action: "add_edge", edge: edge("freeze-mutable-neighbor", mutableSource.id, acceptedNeighbor.id, "informs") },
        { action: "add_edge", edge: edge("freeze-merge-neighbor", mergeLeft.id, acceptedNeighbor.id, "invalidates") },
      ],
    );
    const transition = async (nodeId: string, to: "accepted" | "cancelled" | "retrying", label: string) => {
      graph = await mutate(current, graph, label, [{
        action: "transition_node",
        nodeId,
        expectedNodeVersion: findNode(graph, nodeId).nodeVersion,
        to,
        acceptanceEvidenceIds: to === "accepted" ? [`evidence:${nodeId}`] : [],
        progressSignature: `progress:${nodeId}:${to}`,
      }]);
    };
    await transition(acceptedSource.id, "accepted", "accept-source");
    await transition(cancelledSource.id, "cancelled", "cancel-source");
    await transition(retryingSource.id, "retrying", "retry-source");
    await transition(acceptedNeighbor.id, "accepted", "accept-neighbor");
    await transition(acceptedParent.id, "accepted", "accept-parent");
    const before = graph;
    const eventsBefore = (await current.store.listEvents(current.roomId)).length;

    const reject = async (
      label: string,
      mutations: readonly unknown[],
      expectedNodeVersions: Readonly<Record<string, number>>,
      code: string,
    ) => {
      const commandContext = context(current.roomId, label);
      await expect(current.store.mutateTaskGraph({
        roomId: current.roomId,
        expectedAggregateVersion: graph.aggregateVersion,
        expectedDagVersion: graph.dagVersion,
        expectedNodeVersions,
        idempotencyKey: `task-topology:${current.roomId}:${label}`,
        mutations: mutations.map((mutation) => {
          if (
            mutation !== null
            && typeof mutation === "object"
            && "action" in mutation
            && ["split_node", "merge_nodes", "cancel_node", "remove_edge"].includes(
              String((mutation as { action?: unknown }).action),
            )
            && !("causalEvidenceIds" in mutation)
          ) {
            return { ...mutation, causalEvidenceIds: [current.evidenceId] };
          }
          return mutation;
        }),
        mutatedAt: commandContext.occurredAt,
      } as unknown as MutateRoomTaskGraphInputV1, commandContext)).rejects.toMatchObject({ code });
      expect(await current.store.getTaskGraph(current.roomId)).toEqual(before);
    };

    for (const [candidate, code] of [
      [acceptedSource, "accepted_node_frozen"],
      [cancelledSource, "task_graph_invalid_mutation"],
      [retryingSource, "task_graph_invalid_mutation"],
    ] as const) {
      await reject(`split-frozen-${candidate.id}`, [{
        action: "split_node",
        nodeId: candidate.id,
        children: [childNode(`${candidate.id}-a`), childNode(`${candidate.id}-b`)],
        reason: "Frozen topology source",
      }], { [candidate.id]: findNode(graph, candidate.id).nodeVersion }, code);
    }
    const mutableVersions = {
      [mutableSource.id]: findNode(graph, mutableSource.id).nodeVersion,
      [acceptedNeighbor.id]: findNode(graph, acceptedNeighbor.id).nodeVersion,
    };
    await reject("split-accepted-neighbor", [{
      action: "split_node",
      nodeId: mutableSource.id,
      children: [childNode("freeze-child-a"), childNode("freeze-child-b")],
      reason: "Accepted neighbor must freeze split",
    }], mutableVersions, "accepted_node_frozen");
    await reject("cancel-accepted-neighbor", [{
      action: "cancel_node",
      nodeId: mutableSource.id,
      reason: "Accepted neighbor must freeze cancellation",
    }], mutableVersions, "accepted_node_frozen");
    await reject("merge-accepted-neighbor", [{
      action: "merge_nodes",
      nodeIds: [mergeLeft.id, mergeRight.id],
      mergedNode: childNode("freeze-merge-result"),
      reason: "Accepted neighbor must freeze merge",
    }], {
      [mergeLeft.id]: findNode(graph, mergeLeft.id).nodeVersion,
      [mergeRight.id]: findNode(graph, mergeRight.id).nodeVersion,
      [acceptedNeighbor.id]: findNode(graph, acceptedNeighbor.id).nodeVersion,
    }, "accepted_node_frozen");
    await reject("merge-accepted-parent", [{
      action: "merge_nodes",
      nodeIds: [parentedMergeLeft.id, parentedMergeRight.id],
      mergedNode: childNode("freeze-parented-merge-result"),
      reason: "Accepted parent must freeze child topology",
    }], {
      [parentedMergeLeft.id]: findNode(graph, parentedMergeLeft.id).nodeVersion,
      [parentedMergeRight.id]: findNode(graph, parentedMergeRight.id).nodeVersion,
    }, "accepted_node_frozen");
    await reject("remove-accepted-endpoint", [{
      action: "remove_edge",
      edgeId: "freeze-mutable-neighbor",
      reason: "Accepted endpoint must freeze edge retirement",
    }], mutableVersions, "accepted_node_frozen");
    for (const [label, mutation] of [
      ["split-not-exclusive", {
        action: "split_node",
        nodeId: mutableSource.id,
        children: [childNode("exclusive-split-a"), childNode("exclusive-split-b")],
        reason: "Must be exclusive",
      }],
      ["merge-not-exclusive", {
        action: "merge_nodes",
        nodeIds: [mergeLeft.id, mergeRight.id],
        mergedNode: childNode("exclusive-merge"),
        reason: "Must be exclusive",
      }],
      ["cancel-not-exclusive", {
        action: "cancel_node",
        nodeId: mutableSource.id,
        reason: "Must be exclusive",
      }],
    ] as const) {
      await reject(label, [mutation, {
        action: "add_edge",
        edge: edge(`edge-${label}`, mergeRight.id, mutableSource.id, "informs"),
      }], mutableVersions, "task_graph_invalid_mutation");
    }
    expect(await current.store.listEvents(current.roomId)).toHaveLength(eventsBefore);
  });

  it("CAS-fences a mutable merge parent because the result changes its child topology", async () => {
    const current = await fixture("merge-parent-cas");
    const parent = node("merge-parent-cas-parent");
    const left = { ...node("merge-parent-cas-left"), parentNodeId: parent.id };
    const right = { ...node("merge-parent-cas-right"), parentNodeId: parent.id };
    let graph = await mutate(
      current,
      { aggregateVersion: current.aggregateVersion, dagVersion: 0 },
      "seed",
      [
        { action: "add_node", node: parent },
        { action: "add_node", node: left },
        { action: "add_node", node: right },
      ],
    );
    const before = graph;
    const eventsBefore = (await current.store.listEvents(current.roomId)).length;
    const mutation = {
      action: "merge_nodes",
      nodeIds: [left.id, right.id],
      mergedNode: childNode("merge-parent-cas-result"),
      causalEvidenceIds: [current.evidenceId],
      reason: "The shared mutable parent receives a replacement child",
    } as const;
    const reject = async (label: string, expectedNodeVersions: Readonly<Record<string, number>>) => {
      const commandContext = context(current.roomId, label);
      await expect(current.store.mutateTaskGraph({
        roomId: current.roomId,
        expectedAggregateVersion: graph.aggregateVersion,
        expectedDagVersion: graph.dagVersion,
        expectedNodeVersions,
        idempotencyKey: `task-topology:${current.roomId}:${label}`,
        mutations: [mutation],
        mutatedAt: commandContext.occurredAt,
      }, commandContext)).rejects.toMatchObject({ code: "task_node_version_conflict" });
      expect(await current.store.getTaskGraph(current.roomId)).toEqual(before);
      expect(await current.store.listEvents(current.roomId)).toHaveLength(eventsBefore);
    };
    await reject("missing-parent-cas", {
      [left.id]: findNode(graph, left.id).nodeVersion,
      [right.id]: findNode(graph, right.id).nodeVersion,
    });
    await reject("stale-parent-cas", {
      [parent.id]: findNode(graph, parent.id).nodeVersion + 1,
      [left.id]: findNode(graph, left.id).nodeVersion,
      [right.id]: findNode(graph, right.id).nodeVersion,
    });

    graph = await mutate(current, graph, "merge-with-parent-cas", [mutation], {
      [parent.id]: findNode(graph, parent.id).nodeVersion,
      [left.id]: findNode(graph, left.id).nodeVersion,
      [right.id]: findNode(graph, right.id).nodeVersion,
    });
    expect(findNode(graph, "merge-parent-cas-result").parentNodeId).toBe(parent.id);
    expect(findNode(graph, parent.id).nodeVersion).toBe(findNode(before, parent.id).nodeVersion + 1);
  });

  it("requires same-Room causal evidence and converts hostile topology payloads into typed zero-write errors", async () => {
    const current = await fixture("causal-evidence-runtime-shape");
    const foreign = await fixture("causal-evidence-foreign");
    const source = node("causal-runtime-source");
    const peer = node("causal-runtime-peer");
    const graph = await mutate(
      current,
      { aggregateVersion: current.aggregateVersion, dagVersion: 0 },
      "seed",
      [
        { action: "add_node", node: source },
        { action: "add_node", node: peer },
        { action: "add_edge", edge: edge("causal-runtime-edge", source.id, peer.id, "informs") },
      ],
    );
    const before = graph;
    const eventsBefore = (await current.store.listEvents(current.roomId)).length;
    const reject = async (label: string, mutation: unknown) => {
      const commandContext = context(current.roomId, label);
      await expect(current.store.mutateTaskGraph({
        roomId: current.roomId,
        expectedAggregateVersion: graph.aggregateVersion,
        expectedDagVersion: graph.dagVersion,
        expectedNodeVersions: {
          [source.id]: findNode(graph, source.id).nodeVersion,
          [peer.id]: findNode(graph, peer.id).nodeVersion,
        },
        idempotencyKey: `task-topology:${current.roomId}:${label}`,
        mutations: [mutation],
        mutatedAt: commandContext.occurredAt,
      } as unknown as MutateRoomTaskGraphInputV1, commandContext)).rejects.toMatchObject({
        code: "task_graph_invalid_mutation",
      });
      expect(await current.store.getTaskGraph(current.roomId)).toEqual(before);
      expect(await current.store.listEvents(current.roomId)).toHaveLength(eventsBefore);
    };

    await reject("missing-causal-evidence-field", {
      action: "cancel_node",
      nodeId: source.id,
      reason: "Missing evidence identity",
    });
    await reject("empty-causal-evidence", {
      action: "cancel_node",
      nodeId: source.id,
      causalEvidenceIds: [],
      reason: "Empty evidence identity",
    });
    await reject("foreign-causal-evidence", {
      action: "cancel_node",
      nodeId: source.id,
      causalEvidenceIds: [foreign.evidenceId],
      reason: "Foreign Room evidence identity",
    });
    await reject("unknown-causal-evidence", {
      action: "cancel_node",
      nodeId: source.id,
      causalEvidenceIds: ["evidence:missing"],
      reason: "Unknown evidence identity",
    });
    for (const [label, mutation] of [
      ["split-null-children", {
        action: "split_node",
        nodeId: source.id,
        children: null,
        causalEvidenceIds: [current.evidenceId],
        reason: "Hostile split",
      }],
      ["merge-null-node-ids", {
        action: "merge_nodes",
        nodeIds: null,
        mergedNode: childNode("hostile-merge-result-a"),
        causalEvidenceIds: [current.evidenceId],
        reason: "Hostile merge sources",
      }],
      ["merge-null-result", {
        action: "merge_nodes",
        nodeIds: [source.id, peer.id],
        mergedNode: null,
        causalEvidenceIds: [current.evidenceId],
        reason: "Hostile merge result",
      }],
      ["cancel-null-node-id", {
        action: "cancel_node",
        nodeId: null,
        causalEvidenceIds: [current.evidenceId],
        reason: "Hostile cancel",
      }],
      ["remove-null-edge-id", {
        action: "remove_edge",
        edgeId: null,
        causalEvidenceIds: [current.evidenceId],
        reason: "Hostile edge retirement",
      }],
    ] as const) {
      await reject(label, mutation);
    }
  });

  it("rejects persisted topology lineage that is structurally valid JSON but causally forged", async () => {
    const current = await fixture("forged-lineage");
    const source = node("forged-lineage-source");
    const target = node("forged-lineage-target");
    await mutate(
      current,
      { aggregateVersion: current.aggregateVersion, dagVersion: 0 },
      "seed",
      [
        { action: "add_node", node: source },
        { action: "add_node", node: target },
      ],
    );
    await current.layer.db
      .update(roomTaskNodes)
      .set({
        origin: {
          kind: "split_child",
          operationId: "room-task-topology:sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
          sourceNodeIds: [source.id],
        },
      })
      .where(and(
        eq(roomTaskNodes.projectId, PROJECT_ID),
        eq(roomTaskNodes.roomId, current.roomId),
        eq(roomTaskNodes.id, target.id),
      ));

    await expect(current.store.getTaskGraph(current.roomId)).rejects.toMatchObject({
      code: "task_graph_invalid_mutation",
    });
  });

  it("rejects a deterministic-looking derived edge whose retired source lineage is absent", async () => {
    const current = await fixture("forged-edge-lineage");
    const source = node("forged-edge-source");
    const target = node("forged-edge-target");
    await mutate(
      current,
      { aggregateVersion: current.aggregateVersion, dagVersion: 0 },
      "seed",
      [
        { action: "add_node", node: source },
        { action: "add_node", node: target },
      ],
    );
    const operationId = "room-task-topology:sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
    const missingSourceEdgeId = "forged-retired-source";
    const edgeShape = { fromNodeId: source.id, toNodeId: target.id, kind: "informs" as const };
    const forgedEdgeId = `room-task-edge:${hashRoomValue({
      version: 1,
      operationId,
      topology: edgeShape,
      derivedFromEdgeIds: [missingSourceEdgeId],
    })}`;
    await current.layer.db.insert(roomTaskEdges).values({
      id: forgedEdgeId,
      projectId: PROJECT_ID,
      roomId: current.roomId,
      ...edgeShape,
      createdAt: BASE_TIME,
      retiredAt: null,
      retiredByOperationId: null,
      createdByOperationId: operationId,
      derivedFromEdgeIds: [missingSourceEdgeId],
    });

    await expect(current.store.getTaskGraph(current.roomId)).rejects.toMatchObject({
      code: "task_graph_invalid_mutation",
    });
  });
});
