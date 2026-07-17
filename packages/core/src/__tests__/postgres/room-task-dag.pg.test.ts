import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { AsyncRoomStore, type RoomCommandContext } from "../../async-room-store.js";
import { createConnectionSetFromUrl, type PostgresConnections } from "../../postgres/connection.js";
import { createAsyncDataLayer, type AsyncDataLayer } from "../../postgres/data-layer.js";
import { EmbeddedPostgresLifecycle } from "../../postgres/embedded-lifecycle.js";
import { applySchemaBaseline } from "../../postgres/schema-applier.js";
import type { RoomTaskNodeState } from "../../room-contracts/storage.js";

type RoomTaskEdgeKind = "requires" | "informs" | "invalidates";

interface RoomTaskResourceHintsV1 {
  readonly estimatedDurationMs: number;
  readonly concurrencyClass: "serial" | "parallel";
  readonly preferredProviderIds: readonly string[];
}

interface RoomTaskAuthorityScopeV1 {
  readonly allowedActions: readonly string[];
  readonly readPaths: readonly string[];
  readonly writePaths: readonly string[];
}

interface RoomTaskRetryPolicyV1 {
  readonly maxAttempts: number;
  readonly backoff: "fixed" | "exponential";
  readonly baseDelayMs: number;
  readonly recoveryActions: readonly string[];
}

interface RoomTaskNodeDefinitionV1 {
  readonly id: string;
  readonly parentNodeId: string | null;
  readonly objective: string;
  readonly inputRefs: readonly string[];
  readonly outputRefs: readonly string[];
  readonly roleRequirements: readonly string[];
  readonly capabilityRequirements: readonly string[];
  readonly resourceHints: RoomTaskResourceHintsV1;
  readonly authorityScope: RoomTaskAuthorityScopeV1;
  readonly acceptanceGateIds: readonly string[];
  readonly retryPolicy: RoomTaskRetryPolicyV1;
  readonly progressSignature: string;
}

interface RoomTaskNodeProjectionV1 extends RoomTaskNodeDefinitionV1 {
  readonly state: RoomTaskNodeState;
  readonly nodeVersion: number;
  readonly acceptedAt: string | null;
  readonly acceptanceEvidenceIds: readonly string[];
  readonly invalidatedByEvidenceId: string | null;
  readonly reopenedByEvidenceId: string | null;
}

interface RoomTaskEdgeDefinitionV1 {
  readonly id: string;
  readonly fromNodeId: string;
  readonly toNodeId: string;
  readonly kind: RoomTaskEdgeKind;
}

interface AddRoomTaskNodeMutationV1 {
  readonly action: "add_node";
  readonly node: RoomTaskNodeDefinitionV1;
}

interface AddRoomTaskEdgeMutationV1 {
  readonly action: "add_edge";
  readonly edge: RoomTaskEdgeDefinitionV1;
}

interface UpdateRoomTaskNodeMutationV1 {
  readonly action: "update_node";
  readonly nodeId: string;
  readonly expectedNodeVersion: number;
  readonly patch: Partial<
    Pick<
      RoomTaskNodeDefinitionV1,
      | "objective"
      | "inputRefs"
      | "outputRefs"
      | "roleRequirements"
      | "capabilityRequirements"
      | "resourceHints"
      | "authorityScope"
      | "acceptanceGateIds"
      | "retryPolicy"
      | "progressSignature"
    >
  >;
  readonly evidenceIds: readonly string[];
}

interface TransitionRoomTaskNodeMutationV1 {
  readonly action: "transition_node";
  readonly nodeId: string;
  readonly expectedNodeVersion: number;
  readonly to: RoomTaskNodeState;
  readonly acceptanceEvidenceIds: readonly string[];
  readonly progressSignature: string;
}

interface InvalidateRoomTaskEvidenceMutationV1 {
  readonly action: "invalidate_acceptance_evidence";
  readonly nodeId: string;
  readonly expectedNodeVersion: number;
  readonly acceptanceEvidenceId: string;
  readonly invalidatedByEvidenceId: string;
  readonly reason: string;
}

interface ReopenRoomTaskNodeMutationV1 {
  readonly action: "reopen_node";
  readonly nodeId: string;
  readonly expectedNodeVersion: number;
  readonly upstreamNodeId: string;
  readonly invalidatedByEvidenceId: string;
  readonly reason: string;
}

type RoomTaskGraphMutationV1 =
  | AddRoomTaskNodeMutationV1
  | AddRoomTaskEdgeMutationV1
  | UpdateRoomTaskNodeMutationV1
  | TransitionRoomTaskNodeMutationV1
  | InvalidateRoomTaskEvidenceMutationV1
  | ReopenRoomTaskNodeMutationV1;

interface MutateRoomTaskGraphInputV1 {
  readonly roomId: string;
  readonly expectedAggregateVersion: number;
  readonly expectedDagVersion: number;
  readonly idempotencyKey: string;
  readonly mutations: readonly RoomTaskGraphMutationV1[];
  readonly mutatedAt: string;
}

interface RoomTaskGraphProjectionV1 {
  readonly roomId: string;
  readonly aggregateVersion: number;
  readonly dagVersion: number;
  readonly nodes: readonly RoomTaskNodeProjectionV1[];
  readonly edges: readonly RoomTaskEdgeDefinitionV1[];
  readonly readyNodeIds: readonly string[];
  readonly criticalPathNodeIds: readonly string[];
}

/*
FNXC:SessionRoomTaskDag 2026-07-17-21:22:
Task 5.1 requires the PostgreSQL Room store to own a typed, versioned task DAG. Readiness is derived only from `requires` edges, critical-path weight comes from estimated duration, accepted nodes are immutable, and evidence invalidation never silently reopens downstream work. Reopen must be an explicit causal command, while waiting or failure on one branch must not suppress independent ready nodes.

This RED contract names the smallest AsyncRoomStore seam without importing a nonexistent production symbol. Every test first proves the embedded PostgreSQL Room fixture is usable, then fails at the explicit runtime seam assertion until production supplies these two methods.
*/
interface RoomTaskGraphStoreApi {
  mutateTaskGraph(
    input: MutateRoomTaskGraphInputV1,
    context: RoomCommandContext,
  ): Promise<RoomTaskGraphProjectionV1>;
  getTaskGraph(roomId: string): Promise<RoomTaskGraphProjectionV1 | null>;
}

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

const PROJECT_ID = "project-room-task-dag";
const BASE_TIME = "2026-07-17T13:22:00.000Z";
let commandSequence = 0;

function requireTaskGraphApi(store: AsyncRoomStore): RoomTaskGraphStoreApi {
  const candidate = store as unknown as Partial<RoomTaskGraphStoreApi>;
  const seamTypes = {
    mutateTaskGraph: typeof candidate.mutateTaskGraph,
    getTaskGraph: typeof candidate.getTaskGraph,
  };
  if (
    typeof candidate.mutateTaskGraph !== "function"
    || typeof candidate.getTaskGraph !== "function"
  ) {
    expect(
      seamTypes,
      "Missing target production seam: AsyncRoomStore.mutateTaskGraph(input, context) and AsyncRoomStore.getTaskGraph(roomId)",
    ).toEqual({ mutateTaskGraph: "function", getTaskGraph: "function" });
    throw new Error("Missing AsyncRoomStore task-DAG production seam");
  }
  return {
    mutateTaskGraph: (input, context) => candidate.mutateTaskGraph!.call(store, input, context),
    getTaskGraph: (roomId) => candidate.getTaskGraph!.call(store, roomId),
  };
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
  const second = String(commandSequence).padStart(2, "0");
  return {
    eventId: `event-${roomId}-${label}`,
    actorType: "controller",
    actorId: "room-controller-task-dag-test",
    correlationId: `correlation-${roomId}-${label}`,
    causationId: null,
    occurredAt: `2026-07-17T13:22:${second}.000Z`,
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
  kind: RoomTaskEdgeKind,
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

    const graph = await mutateGraph(
      fixture,
      { aggregateVersion: fixture.aggregateVersion, dagVersion: 0 },
      "seed-typed-records",
      [
        { action: "add_node", node: producer },
        { action: "add_node", node: verifier },
        { action: "add_node", node: observer },
        ...edges.map((edge) => ({ action: "add_edge" as const, edge })),
      ],
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

  it("fails closed on stale DAG and node versions", async () => {
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
