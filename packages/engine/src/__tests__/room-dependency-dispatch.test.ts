import {
  hashRoomValue,
  type RoomTaskEdgeProjectionV1,
  type RoomTaskGraphProjectionV1,
  type RoomTaskNodeProjectionV1,
} from "@fusion/core";
import { describe, expect, it } from "vitest";

import {
  planRoomDependencyDispatch,
  RoomDependencyDispatchGraphError,
} from "../room-dependency-dispatch.js";

function taskNode(
  id: string,
  state: RoomTaskNodeProjectionV1["state"],
  estimatedDurationMs = 1,
): RoomTaskNodeProjectionV1 {
  return {
    id,
    parentNodeId: null,
    objective: `Complete ${id}`,
    inputRefs: [],
    outputRefs: [],
    roleRequirements: [],
    capabilityRequirements: [],
    resourceHints: {
      estimatedDurationMs,
      concurrencyClass: "parallel",
      preferredProviderIds: [],
    },
    authorityScope: {
      allowedActions: [],
      readPaths: [],
      writePaths: [],
    },
    acceptanceGateIds: [],
    retryPolicy: {
      maxAttempts: 1,
      backoff: "fixed",
      baseDelayMs: 0,
      recoveryActions: [],
    },
    progressSignature: `progress:${id}`,
    state,
    nodeVersion: 0,
    acceptedAt: state === "accepted" ? "2026-07-18T00:00:00.000Z" : null,
    acceptanceEvidenceIds: state === "accepted" ? [`evidence:${id}`] : [],
    invalidatedByEvidenceId: null,
    reopenedByEvidenceId: null,
    origin: { kind: "created" },
    terminalLineage: null,
  };
}

function taskEdge(
  id: string,
  fromNodeId: string,
  toNodeId: string,
  kind: RoomTaskEdgeProjectionV1["kind"] = "requires",
): RoomTaskEdgeProjectionV1 {
  return { id, fromNodeId, toNodeId, kind, createdByOperationId: null, derivedFromEdgeIds: [] };
}

function graph(
  nodes: readonly RoomTaskNodeProjectionV1[],
  edges: readonly RoomTaskEdgeProjectionV1[],
  criticalPathNodeIds: readonly string[],
): RoomTaskGraphProjectionV1 {
  return {
    roomId: "room-dispatch",
    aggregateVersion: 4,
    dagVersion: 2,
    nodes,
    edges,
    readyNodeIds: nodes
      .filter((node) => node.state === "ready")
      .map((node) => node.id)
      .sort(),
    criticalPathNodeIds,
  };
}

describe("planRoomDependencyDispatch", () => {
  it("orders a ready critical-path successor before independent B/D branches", () => {
    const projection = graph(
      [
        taskNode("A", "accepted", 8),
        taskNode("B", "ready", 2),
        taskNode("C", "ready", 7),
        taskNode("D", "ready", 1),
      ],
      [taskEdge("A-C", "A", "C")],
      ["A", "C"],
    );

    expect(planRoomDependencyDispatch(projection)).toEqual({
      roomId: "room-dispatch",
      aggregateVersion: 4,
      dagVersion: 2,
      readyCandidates: [
        { nodeId: "C", criticalPathRank: 1 },
        { nodeId: "B", criticalPathRank: null },
        { nodeId: "D", criticalPathRank: null },
      ],
      dependencyWaits: [],
    });
  });

  it.each(["waiting_dependency", "rate_limited", "failed"] as const)(
    "keeps independent B/D ready when A is %s and classifies C as dependency-waiting",
    (blockedState) => {
      const projection = graph(
        [
          taskNode("A", blockedState, 8),
          taskNode("B", "ready", 2),
          taskNode("C", "ready", 7),
          taskNode("D", "ready", 1),
        ],
        [taskEdge("A-C", "A", "C")],
        ["A", "C"],
      );

      const plan = planRoomDependencyDispatch(projection);

      expect(plan.readyCandidates).toEqual([
        { nodeId: "B", criticalPathRank: null },
        { nodeId: "D", criticalPathRank: null },
      ]);
      expect(plan.dependencyWaits).toEqual([
        {
          nodeId: "C",
          nodeStatus: "ready",
          blockers: [
            {
              nodeId: "A",
              status: blockedState,
              reason: "requires_upstream_acceptance",
            },
          ],
        },
      ]);
    },
  );

  it("reports only direct blockers through a transitive requires branch", () => {
    const projection = graph(
      [
        taskNode("E", "ready", 6),
        taskNode("B", "ready", 2),
        taskNode("C", "ready", 7),
        taskNode("A", "waiting_dependency", 8),
      ],
      [taskEdge("C-E", "C", "E"), taskEdge("A-C", "A", "C")],
      ["A", "C", "E"],
    );

    const plan = planRoomDependencyDispatch(projection);

    expect(plan.readyCandidates).toEqual([{ nodeId: "B", criticalPathRank: null }]);
    expect(plan.dependencyWaits).toEqual([
      {
        nodeId: "C",
        nodeStatus: "ready",
        blockers: [
          {
            nodeId: "A",
            status: "waiting_dependency",
            reason: "requires_upstream_acceptance",
          },
        ],
      },
      {
        nodeId: "E",
        nodeStatus: "ready",
        blockers: [
          { nodeId: "C", status: "ready", reason: "requires_upstream_acceptance" },
        ],
      },
    ]);
  });

  it("treats informs and invalidates edges as nonblocking", () => {
    const projection = graph(
      [taskNode("A", "failed", 10), taskNode("B", "ready", 1), taskNode("C", "ready", 2)],
      [
        taskEdge("A-C-info", "A", "C", "informs"),
        taskEdge("A-B-invalidate", "A", "B", "invalidates"),
      ],
      ["A"],
    );

    const plan = planRoomDependencyDispatch(projection);
    expect(plan.readyCandidates).toEqual([
      { nodeId: "B", criticalPathRank: null },
      { nodeId: "C", criticalPathRank: null },
    ]);
    expect(plan.dependencyWaits).toEqual([]);
  });

  it("keeps equal-duration critical-path tie-breaking stable across node and edge order", () => {
    const nodes = [
      taskNode("D", "ready", 5),
      taskNode("C", "ready", 5),
      taskNode("B", "accepted", 5),
      taskNode("A", "accepted", 5),
    ];
    const edges = [taskEdge("B-D", "B", "D"), taskEdge("A-C", "A", "C")];
    const projection = graph(nodes, edges, ["A", "C"]);
    const reordered = graph(
      [nodes[3]!, nodes[1]!, nodes[0]!, nodes[2]!],
      [edges[1]!, edges[0]!],
      ["A", "C"],
    );

    expect(planRoomDependencyDispatch(reordered)).toEqual(
      planRoomDependencyDispatch(projection),
    );
    expect(planRoomDependencyDispatch(reordered).readyCandidates).toEqual([
      { nodeId: "C", criticalPathRank: 1 },
      { nodeId: "D", criticalPathRank: null },
    ]);
  });

  it("rejects malformed or stale runtime projections", () => {
    const valid = graph(
      [taskNode("A", "accepted", 8), taskNode("C", "ready", 7)],
      [taskEdge("A-C", "A", "C")],
      ["A", "C"],
    );
    const malformed = [
      { ...valid, nodes: [...valid.nodes, valid.nodes[0]!] },
      { ...valid, edges: [taskEdge("missing-C", "missing", "C")] },
      { ...valid, readyNodeIds: [] },
      { ...valid, criticalPathNodeIds: ["C"] },
      { ...valid, unexpected: true },
    ];

    for (const candidate of malformed) {
      expect(() =>
        planRoomDependencyDispatch(candidate as unknown as RoomTaskGraphProjectionV1),
      ).toThrow(RoomDependencyDispatchGraphError);
    }
  });

  it("fails closed on Proxy, non-plain, symbol, sparse, and accessor-backed input", () => {
    const valid = graph(
      [taskNode("A", "accepted", 8), taskNode("C", "ready", 7)],
      [taskEdge("A-C", "A", "C")],
      ["A", "C"],
    );
    let getterCalls = 0;
    const accessorNodes = [...valid.nodes];
    Object.defineProperty(accessorNodes, "0", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return valid.nodes[0];
      },
    });
    const sparseNodes = [...valid.nodes];
    delete sparseNodes[0];
    const symbolNodes = [...valid.nodes] as unknown[] & Record<symbol, unknown>;
    symbolNodes[Symbol("hidden")] = true;
    const overriddenMap = [...valid.nodes] as RoomTaskNodeProjectionV1[] & {
      map: () => readonly RoomTaskNodeProjectionV1[];
    };
    Object.defineProperty(overriddenMap, "map", {
      enumerable: true,
      value: () => valid.nodes,
    });
    const nonPlainNode = Object.assign(Object.create({ inherited: true }), valid.nodes[0]);

    const hostile: unknown[] = [
      new Proxy(valid, {}),
      { ...valid, nodes: new Proxy([...valid.nodes], {}) },
      { ...valid, nodes: accessorNodes },
      { ...valid, nodes: sparseNodes },
      { ...valid, nodes: symbolNodes },
      { ...valid, nodes: overriddenMap },
      { ...valid, nodes: [nonPlainNode, valid.nodes[1]] },
    ];

    for (const candidate of hostile) {
      expect(() =>
        planRoomDependencyDispatch(candidate as RoomTaskGraphProjectionV1),
      ).toThrow(RoomDependencyDispatchGraphError);
    }
    expect(getterCalls).toBe(0);
  });

  it("rejects cycles across non-requires edges and critical-path duration overflow", () => {
    const cycle = graph(
      [taskNode("A", "ready"), taskNode("B", "ready")],
      [taskEdge("A-B", "A", "B", "informs"), taskEdge("B-A", "B", "A", "invalidates")],
      ["A"],
    );
    const overflow = graph(
      [
        taskNode("A", "accepted", Number.MAX_SAFE_INTEGER),
        taskNode("B", "ready", 1),
      ],
      [taskEdge("A-B", "A", "B")],
      ["A", "B"],
    );

    expect(() => planRoomDependencyDispatch(cycle)).toThrow(
      RoomDependencyDispatchGraphError,
    );
    expect(() => planRoomDependencyDispatch(overflow)).toThrow(
      RoomDependencyDispatchGraphError,
    );
  });

  it("rejects duplicate semantic edges and non-canonical accepted timestamps", () => {
    const duplicateShape = graph(
      [taskNode("A", "accepted"), taskNode("B", "ready")],
      [taskEdge("A-B-1", "A", "B"), taskEdge("A-B-2", "A", "B")],
      ["A", "B"],
    );
    const accepted = taskNode("A", "accepted");
    const nonCanonicalTimestamp = graph(
      [{ ...accepted, acceptedAt: "2026-07-18" }],
      [],
      ["A"],
    );

    expect(() => planRoomDependencyDispatch(duplicateShape)).toThrow(
      RoomDependencyDispatchGraphError,
    );
    expect(() => planRoomDependencyDispatch(nonCanonicalTimestamp)).toThrow(
      RoomDependencyDispatchGraphError,
    );
  });

  it("keeps embedded-NUL identifiers collision-free in edge and path ordering", () => {
    const projection = graph(
      [
        taskNode("A", "accepted"),
        taskNode("B\u0000C", "ready"),
        taskNode("A\u0000B", "accepted"),
        taskNode("C", "ready"),
      ],
      [
        taskEdge("edge-1", "A", "B\u0000C"),
        taskEdge("edge-2", "A\u0000B", "C"),
      ],
      ["A", "B\u0000C"],
    );

    expect(planRoomDependencyDispatch(projection).readyCandidates).toEqual([
      { nodeId: "B\u0000C", criticalPathRank: 1 },
      { nodeId: "C", criticalPathRank: null },
    ]);
  });

  it("orders NUL-colliding equal paths by segments even when the smaller path finishes later", () => {
    const projection = graph(
      [
        taskNode("A", "accepted", 1),
        taskNode("X\u0000Z", "accepted", 1),
        taskNode("zz", "ready", 1),
        taskNode("A\u0000X", "accepted", 1),
        taskNode("Z\u0000zz", "ready", 2),
      ],
      [
        taskEdge("path-1-a", "A", "X\u0000Z"),
        taskEdge("path-1-b", "X\u0000Z", "zz"),
        taskEdge("path-2", "A\u0000X", "Z\u0000zz"),
      ],
      ["A", "X\u0000Z", "zz"],
    );

    expect(planRoomDependencyDispatch(projection).readyCandidates).toEqual([
      { nodeId: "zz", criticalPathRank: 2 },
      { nodeId: "Z\u0000zz", criticalPathRank: null },
    ]);
  });

  it("validates topology lineage while keeping terminal source nodes undispatchable", () => {
    const source: RoomTaskNodeProjectionV1 = {
      ...taskNode("source", "cancelled", 100),
      terminalLineage: {
        kind: "split",
        operationId: "operation-1",
        at: "2026-07-18T00:00:00.000Z",
        reasonHash: `sha256:${"0".repeat(64)}`,
      },
    };
    const child: RoomTaskNodeProjectionV1 = {
      ...taskNode("child", "ready", 2),
      parentNodeId: source.id,
      origin: {
        kind: "split_child",
        operationId: "operation-1",
        sourceNodeIds: [source.id],
      },
    };

    expect(planRoomDependencyDispatch(graph([source, child], [], ["source"]))).toEqual({
      roomId: "room-dispatch",
      aggregateVersion: 4,
      dagVersion: 2,
      readyCandidates: [{ nodeId: "child", criticalPathRank: 0 }],
      dependencyWaits: [],
    });

    const parent = taskNode("parent", "cancelled", 1);
    const mergeSourceA: RoomTaskNodeProjectionV1 = {
      ...taskNode("merge-source-a", "cancelled", 1),
      parentNodeId: parent.id,
      terminalLineage: {
        kind: "merge",
        operationId: "operation-merge",
        at: "2026-07-18T00:00:00.000Z",
        reasonHash: `sha256:${"1".repeat(64)}`,
      },
    };
    const mergeSourceB: RoomTaskNodeProjectionV1 = {
      ...taskNode("merge-source-b", "cancelled", 1),
      parentNodeId: parent.id,
      terminalLineage: {
        kind: "merge",
        operationId: "operation-merge",
        at: "2026-07-18T00:00:00.000Z",
        reasonHash: `sha256:${"1".repeat(64)}`,
      },
    };
    const mergeResult: RoomTaskNodeProjectionV1 = {
      ...taskNode("merge-result", "ready", 3),
      parentNodeId: parent.id,
      origin: {
        kind: "merge_result",
        operationId: "operation-merge",
        sourceNodeIds: [mergeSourceA.id, mergeSourceB.id],
      },
    };
    expect(
      planRoomDependencyDispatch(
        graph([parent, mergeSourceA, mergeSourceB, mergeResult], [], [mergeResult.id]),
      ).readyCandidates,
    ).toEqual([{ nodeId: mergeResult.id, criticalPathRank: 0 }]);

    const secondSplitSource: RoomTaskNodeProjectionV1 = {
      ...source,
      id: "source-2",
      objective: "Complete source-2",
      progressSignature: "progress:source-2",
    };

    const baseline = graph(
      [taskNode("A", "accepted", 8), taskNode("C", "ready", 7)],
      [taskEdge("A-C", "A", "C")],
      ["A", "C"],
    );
    const malformed: unknown[] = [
      {
        ...graph([source, secondSplitSource, child], [], [source.id]),
        nodes: [source, secondSplitSource, {
          ...child,
          origin: {
            kind: "split_child",
            operationId: "operation-1",
            sourceNodeIds: [source.id, secondSplitSource.id],
          },
        }],
      },
      {
        ...baseline,
        nodes: [
          baseline.nodes[0],
          {
            ...baseline.nodes[1],
            terminalLineage: {
              kind: "cancel",
              operationId: "operation-1",
              at: "2026-07-18T00:00:00.000Z",
              reasonHash: `sha256:${"0".repeat(64)}`,
            },
          },
        ],
      },
      {
        ...baseline,
        edges: [{ ...baseline.edges[0], derivedFromEdgeIds: ["edge-1", "edge-1"] }],
      },
      {
        ...baseline,
        edges: [{
          ...baseline.edges[0],
          createdByOperationId: "operation-forged-edge",
          derivedFromEdgeIds: ["retired-edge-1"],
        }],
      },
      {
        ...baseline,
        nodes: [
          {
            ...baseline.nodes[0],
            state: "cancelled",
            acceptedAt: null,
            acceptanceEvidenceIds: [],
            terminalLineage: {
              kind: "cancel",
              operationId: "operation-1",
              at: "2026-07-18T00:00:00.000Z",
              reasonHash: "sha256:bad",
            },
          },
          baseline.nodes[1],
        ],
      },
      {
        ...graph([source, child], [], [source.id]),
        nodes: [source, {
          ...child,
          origin: {
            kind: "split_child",
            operationId: "different-operation",
            sourceNodeIds: [source.id],
          },
        }],
      },
      {
        ...graph([parent, mergeSourceA, mergeResult], [], [mergeResult.id]),
        nodes: [parent, mergeSourceA, {
          ...mergeResult,
          origin: {
            kind: "merge_result",
            operationId: "operation-merge",
            sourceNodeIds: [mergeSourceA.id],
          },
        }],
      },
    ];

    for (const candidate of malformed) {
      expect(() =>
        planRoomDependencyDispatch(candidate as RoomTaskGraphProjectionV1),
      ).toThrow(RoomDependencyDispatchGraphError);
    }
    const creationOperationId = "operation-edge-1";
    const derivedFromEdgeIds = ["retired-edge-1"];
    const edgeShape = {
      fromNodeId: baseline.edges[0]!.fromNodeId,
      toNodeId: baseline.edges[0]!.toNodeId,
      kind: baseline.edges[0]!.kind,
    };
    expect(
      planRoomDependencyDispatch({
        ...baseline,
        edges: [{
          ...baseline.edges[0]!,
          id: `room-task-edge:${hashRoomValue({
            version: 1,
            operationId: creationOperationId,
            topology: edgeShape,
            derivedFromEdgeIds,
          })}`,
          createdByOperationId: creationOperationId,
          derivedFromEdgeIds,
        }],
      }).readyCandidates,
    ).toEqual([{ nodeId: "C", criticalPathRank: 1 }]);
  });

  it("returns deeply frozen detached data that caller mutation cannot change", () => {
    const projection = graph(
      [
        taskNode("A", "waiting_dependency", 8),
        taskNode("B", "ready", 2),
        taskNode("C", "ready", 7),
      ],
      [taskEdge("A-C", "A", "C")],
      ["A", "C"],
    );
    const plan = planRoomDependencyDispatch(projection);

    (projection.nodes as RoomTaskNodeProjectionV1[])[0] = taskNode("A", "accepted", 8);
    (projection.edges as RoomTaskEdgeProjectionV1[]).length = 0;

    expect(plan.readyCandidates).toEqual([{ nodeId: "B", criticalPathRank: null }]);
    expect(plan.dependencyWaits[0]?.blockers[0]).toEqual({
      nodeId: "A",
      status: "waiting_dependency",
      reason: "requires_upstream_acceptance",
    });
    expect(Object.isFrozen(plan)).toBe(true);
    expect(Object.isFrozen(plan.readyCandidates)).toBe(true);
    expect(Object.isFrozen(plan.readyCandidates[0])).toBe(true);
    expect(Object.isFrozen(plan.dependencyWaits)).toBe(true);
    expect(Object.isFrozen(plan.dependencyWaits[0])).toBe(true);
    expect(Object.isFrozen(plan.dependencyWaits[0]?.blockers)).toBe(true);
    expect(Object.isFrozen(plan.dependencyWaits[0]?.blockers[0])).toBe(true);
    expect(() =>
      (plan.readyCandidates as Array<{ nodeId: string; criticalPathRank: number | null }>).push({
        nodeId: "mutated",
        criticalPathRank: null,
      }),
    ).toThrow(TypeError);
    expect(() => {
      (plan.dependencyWaits[0] as { nodeStatus: string }).nodeStatus = "accepted";
    }).toThrow(TypeError);
  });
});
