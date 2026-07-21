import { isProxy } from "node:util/types";

import { hashRoomValue } from "@fusion/core";
import type {
  RoomTaskEdgeProjectionV1,
  RoomTaskGraphProjectionV1,
  RoomTaskNodeOriginV1,
  RoomTaskNodeProjectionV1,
  RoomTaskNodeTerminalLineageV1,
} from "@fusion/core";

type NodeStatus = RoomTaskNodeProjectionV1["state"];

const GRAPH_KEYS = [
  "roomId",
  "aggregateVersion",
  "dagVersion",
  "nodes",
  "edges",
  "readyNodeIds",
  "criticalPathNodeIds",
] as const;
const NODE_BASE_KEYS = [
  "id",
  "parentNodeId",
  "objective",
  "inputRefs",
  "outputRefs",
  "roleRequirements",
  "capabilityRequirements",
  "resourceHints",
  "authorityScope",
  "acceptanceGateIds",
  "retryPolicy",
  "progressSignature",
  "state",
  "nodeVersion",
  "acceptedAt",
  "acceptanceEvidenceIds",
  "invalidatedByEvidenceId",
  "reopenedByEvidenceId",
  "origin",
  "terminalLineage",
] as const;
const NODE_KEYS = [...NODE_BASE_KEYS, "assignedSeatIds"] as const;
const RESOURCE_HINT_KEYS = [
  "estimatedDurationMs",
  "concurrencyClass",
  "preferredProviderIds",
] as const;
const AUTHORITY_SCOPE_KEYS = ["allowedActions", "readPaths", "writePaths"] as const;
const RETRY_POLICY_KEYS = [
  "maxAttempts",
  "backoff",
  "baseDelayMs",
  "recoveryActions",
] as const;
const EDGE_KEYS = [
  "id",
  "fromNodeId",
  "toNodeId",
  "kind",
  "createdByOperationId",
  "derivedFromEdgeIds",
] as const;
const CREATED_ORIGIN_KEYS = ["kind"] as const;
const DERIVED_ORIGIN_KEYS = ["kind", "operationId", "sourceNodeIds"] as const;
const TERMINAL_LINEAGE_KEYS = ["kind", "operationId", "at", "reasonHash"] as const;
const NODE_STATE_VALUES = {
  pending: "pending",
  ready: "ready",
  running: "running",
  blocked: "blocked",
  rate_limited: "rate_limited",
  retrying: "retrying",
  waiting_dependency: "waiting_dependency",
  waiting_approval: "waiting_approval",
  accepted: "accepted",
  failed: "failed",
  cancelled: "cancelled",
} as const satisfies { readonly [State in NodeStatus]: State };
const NODE_STATES: readonly NodeStatus[] = Object.values(NODE_STATE_VALUES);
const EDGE_KINDS = ["requires", "informs", "invalidates"] as const;
const MAX_GRAPH_NODES = 10_000;
const MAX_GRAPH_EDGES = 30_000;
const MAX_ARRAY_ENTRIES = 30_000;
const MAX_OBJECT_KEYS = 32;
const MAX_RUNTIME_DEPTH = 16;
const MAX_RUNTIME_VALUES = 500_000;
const MAX_RUNTIME_STRING_CODE_UNITS = 16_000_000;

interface RuntimeBudget {
  valueCount: number;
  stringCodeUnits: number;
}

export interface RoomDependencyDispatchCandidateV1 {
  readonly nodeId: string;
  readonly criticalPathRank: number | null;
}

export interface RoomDependencyDispatchBlockerV1 {
  readonly nodeId: string;
  readonly status: NodeStatus;
  readonly reason: "requires_upstream_acceptance";
}

export interface RoomDependencyDispatchWaitV1 {
  readonly nodeId: string;
  readonly nodeStatus: NodeStatus;
  readonly blockers: readonly RoomDependencyDispatchBlockerV1[];
}

export interface RoomDependencyDispatchPlanV1 {
  readonly roomId: string;
  readonly aggregateVersion: number;
  readonly dagVersion: number;
  readonly readyCandidates: readonly RoomDependencyDispatchCandidateV1[];
  readonly dependencyWaits: readonly RoomDependencyDispatchWaitV1[];
}

export class RoomDependencyDispatchGraphError extends Error {
  readonly code = "room_dependency_dispatch_invalid_graph";

  constructor(message: string) {
    super(message);
    this.name = "RoomDependencyDispatchGraphError";
  }
}

/**
 * FNXC:RoomDependencyDispatch 2026-07-18-14:38:
 * Room dispatch planning must remain a pure, dependency-aware policy over a validated graph projection. Only direct `requires` edges block dispatch; waiting, rate-limited, or failed work must not stall independent ready branches. Revalidate and detach caller-owned projection data before deriving stable critical-path candidates and explicit direct blocker evidence.
 */
export function planRoomDependencyDispatch(
  input: Readonly<RoomTaskGraphProjectionV1>,
): RoomDependencyDispatchPlanV1 {
  const graph = safelyValidateAndDetachGraph(input);
  const nodeById = new Map(graph.nodes.map((node) => [node.id, node] as const));
  const blockersByNodeId = new Map<string, RoomDependencyDispatchBlockerV1[]>();

  for (const edge of graph.edges) {
    if (edge.kind !== "requires") continue;
    const upstream = nodeById.get(edge.fromNodeId)!;
    if (upstream.state === "accepted") continue;
    const blockers = blockersByNodeId.get(edge.toNodeId) ?? [];
    blockers.push({
      nodeId: upstream.id,
      status: upstream.state,
      reason: "requires_upstream_acceptance",
    });
    blockersByNodeId.set(edge.toNodeId, blockers);
  }

  const activeNodeIds = new Set(
    graph.nodes.filter((node) => node.state !== "cancelled").map((node) => node.id),
  );
  const dispatchCriticalPathNodeIds = computeCriticalPath(
    graph.nodes.filter((node) => activeNodeIds.has(node.id)),
    graph.edges.filter((edge) =>
      activeNodeIds.has(edge.fromNodeId) && activeNodeIds.has(edge.toNodeId)),
  );
  const criticalPathRank = new Map(
    dispatchCriticalPathNodeIds.map((nodeId, index) => [nodeId, index] as const),
  );
  const readyCandidates = graph.nodes
    .filter((node) => node.state === "ready" && !blockersByNodeId.has(node.id))
    .map((node): RoomDependencyDispatchCandidateV1 => ({
      nodeId: node.id,
      criticalPathRank: criticalPathRank.get(node.id) ?? null,
    }))
    .sort(compareCandidates)
    .map((candidate) => Object.freeze(candidate));

  const dependencyWaits = [...blockersByNodeId.entries()]
    .map(([nodeId, blockers]): RoomDependencyDispatchWaitV1 => ({
      nodeId,
      nodeStatus: nodeById.get(nodeId)!.state,
      blockers: Object.freeze(
        blockers
          .sort((left, right) => compareText(left.nodeId, right.nodeId))
          .map((blocker) => Object.freeze(blocker)),
      ),
    }))
    .sort((left, right) => compareText(left.nodeId, right.nodeId))
    .map((wait) => Object.freeze(wait));

  return Object.freeze({
    roomId: graph.roomId,
    aggregateVersion: graph.aggregateVersion,
    dagVersion: graph.dagVersion,
    readyCandidates: Object.freeze(readyCandidates),
    dependencyWaits: Object.freeze(dependencyWaits),
  });
}

function safelyValidateAndDetachGraph(input: unknown): RoomTaskGraphProjectionV1 {
  try {
    return validateAndDetachGraph(input);
  } catch (error) {
    if (error instanceof RoomDependencyDispatchGraphError) throw error;
    throw new RoomDependencyDispatchGraphError("graph is inaccessible or malformed");
  }
}

function compareCandidates(
  left: RoomDependencyDispatchCandidateV1,
  right: RoomDependencyDispatchCandidateV1,
): number {
  if (left.criticalPathRank !== null && right.criticalPathRank !== null) {
    return left.criticalPathRank - right.criticalPathRank;
  }
  if (left.criticalPathRank !== null) return -1;
  if (right.criticalPathRank !== null) return 1;
  return compareText(left.nodeId, right.nodeId);
}

function validateAndDetachGraph(input: unknown): RoomTaskGraphProjectionV1 {
  const detached = cloneRuntimeValue(
    input,
    "graph",
    { valueCount: 0, stringCodeUnits: 0 },
    new WeakSet<object>(),
    0,
  );
  const graph = exactRecord(detached, GRAPH_KEYS, "graph");
  const roomId = nonBlankString(graph.roomId, "graph.roomId");
  const aggregateVersion = nonNegativeInteger(graph.aggregateVersion, "graph.aggregateVersion");
  const dagVersion = nonNegativeInteger(graph.dagVersion, "graph.dagVersion");
  if (!Array.isArray(graph.nodes) || !Array.isArray(graph.edges)) {
    invalid("graph.nodes and graph.edges must be arrays");
  }
  if (graph.nodes.length > MAX_GRAPH_NODES || graph.edges.length > MAX_GRAPH_EDGES) {
    invalid("graph exceeds the node or edge limit");
  }

  const nodes = graph.nodes.map((node, index) => validateNode(node, `graph.nodes[${index}]`));
  const edges = graph.edges.map((edge, index) => validateEdge(edge, `graph.edges[${index}]`));
  const readyNodeIds = stringArray(graph.readyNodeIds, "graph.readyNodeIds", true);
  const criticalPathNodeIds = stringArray(
    graph.criticalPathNodeIds,
    "graph.criticalPathNodeIds",
    true,
  );
  const nodeById = uniqueById(nodes, "node");
  uniqueById(edges, "edge");
  const edgeShapes = new Map<string, Map<string, Set<RoomTaskEdgeProjectionV1["kind"]>>>();
  for (const edge of edges) {
    const byTarget = edgeShapes.get(edge.fromNodeId) ?? new Map();
    const kinds = byTarget.get(edge.toNodeId) ?? new Set();
    if (kinds.has(edge.kind)) invalid(`duplicate edge shape ${edge.id}`);
    kinds.add(edge.kind);
    byTarget.set(edge.toNodeId, kinds);
    edgeShapes.set(edge.fromNodeId, byTarget);
  }

  for (const node of nodes) {
    if (node.parentNodeId !== null && !nodeById.has(node.parentNodeId)) {
      invalid(`node ${node.id} references unknown parent ${node.parentNodeId}`);
    }
    if (node.parentNodeId === node.id) invalid(`node ${node.id} cannot parent itself`);
  }
  assertParentHierarchyAcyclic(nodes, nodeById);
  assertTopologyLineage(nodes, nodeById);

  for (const edge of edges) {
    if (!nodeById.has(edge.fromNodeId) || !nodeById.has(edge.toNodeId)) {
      invalid(`edge ${edge.id} references an unknown node`);
    }
    if (edge.fromNodeId === edge.toNodeId) invalid(`edge ${edge.id} cannot be self-referential`);
  }
  assertAllEdgesAcyclic(nodes, edges);

  const expectedReady = nodes
    .filter((node) => node.state === "ready")
    .map((node) => node.id)
    .sort(compareText);
  assertSameIds(readyNodeIds, expectedReady, "graph.readyNodeIds is stale");

  const expectedCriticalPath = computeCriticalPath(nodes, edges);
  assertSameIds(
    criticalPathNodeIds,
    expectedCriticalPath,
    "graph.criticalPathNodeIds is stale",
  );

  return {
    roomId,
    aggregateVersion,
    dagVersion,
    nodes,
    edges,
    readyNodeIds,
    criticalPathNodeIds,
  };
}

function validateNode(value: unknown, label: string): RoomTaskNodeProjectionV1 {
  const hasAssignedSeatIds = value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.prototype.hasOwnProperty.call(value, "assignedSeatIds");
  const node = exactRecord(value, hasAssignedSeatIds ? NODE_KEYS : NODE_BASE_KEYS, label);
  const assignedSeatIds = hasAssignedSeatIds
    ? stringArray(
      (node as Record<string, unknown>).assignedSeatIds,
      `${label}.assignedSeatIds`,
      true,
    )
    : [];
  const state = enumValue(node.state, NODE_STATES, `${label}.state`);
  const acceptedAt = nullableTimestamp(node.acceptedAt, `${label}.acceptedAt`);
  const acceptanceEvidenceIds = stringArray(
    node.acceptanceEvidenceIds,
    `${label}.acceptanceEvidenceIds`,
    true,
  );
  if (state === "accepted") {
    if (acceptedAt === null || acceptanceEvidenceIds.length === 0) {
      invalid(`${label} accepted state requires acceptance time and evidence`);
    }
  } else if (acceptedAt !== null || acceptanceEvidenceIds.length > 0) {
    invalid(`${label} non-accepted state cannot retain acceptance fields`);
  }

  const resourceHints = exactRecord(
    node.resourceHints,
    RESOURCE_HINT_KEYS,
    `${label}.resourceHints`,
  );
  const authorityScope = exactRecord(
    node.authorityScope,
    AUTHORITY_SCOPE_KEYS,
    `${label}.authorityScope`,
  );
  const retryPolicy = exactRecord(
    node.retryPolicy,
    RETRY_POLICY_KEYS,
    `${label}.retryPolicy`,
  );
  const origin = validateOrigin(node.origin, `${label}.origin`);
  const terminalLineage = validateTerminalLineage(
    node.terminalLineage,
    `${label}.terminalLineage`,
  );
  if (terminalLineage !== null && state !== "cancelled") {
    invalid(`${label} terminal lineage requires cancelled state`);
  }

  return {
    id: nonBlankString(node.id, `${label}.id`),
    parentNodeId: nullableString(node.parentNodeId, `${label}.parentNodeId`),
    objective: nonBlankString(node.objective, `${label}.objective`),
    assignedSeatIds,
    inputRefs: stringArray(node.inputRefs, `${label}.inputRefs`, true),
    outputRefs: stringArray(node.outputRefs, `${label}.outputRefs`, true),
    roleRequirements: stringArray(node.roleRequirements, `${label}.roleRequirements`, true),
    capabilityRequirements: stringArray(
      node.capabilityRequirements,
      `${label}.capabilityRequirements`,
      true,
    ),
    resourceHints: {
      estimatedDurationMs: positiveInteger(
        resourceHints.estimatedDurationMs,
        `${label}.resourceHints.estimatedDurationMs`,
      ),
      concurrencyClass: enumValue(
        resourceHints.concurrencyClass,
        ["serial", "parallel"] as const,
        `${label}.resourceHints.concurrencyClass`,
      ),
      preferredProviderIds: stringArray(
        resourceHints.preferredProviderIds,
        `${label}.resourceHints.preferredProviderIds`,
        true,
      ),
    },
    authorityScope: {
      allowedActions: stringArray(
        authorityScope.allowedActions,
        `${label}.authorityScope.allowedActions`,
        true,
      ),
      readPaths: stringArray(authorityScope.readPaths, `${label}.authorityScope.readPaths`, true),
      writePaths: stringArray(
        authorityScope.writePaths,
        `${label}.authorityScope.writePaths`,
        true,
      ),
    },
    acceptanceGateIds: stringArray(
      node.acceptanceGateIds,
      `${label}.acceptanceGateIds`,
      true,
    ),
    retryPolicy: {
      maxAttempts: positiveInteger(retryPolicy.maxAttempts, `${label}.retryPolicy.maxAttempts`),
      backoff: enumValue(
        retryPolicy.backoff,
        ["fixed", "exponential"] as const,
        `${label}.retryPolicy.backoff`,
      ),
      baseDelayMs: nonNegativeInteger(
        retryPolicy.baseDelayMs,
        `${label}.retryPolicy.baseDelayMs`,
      ),
      recoveryActions: stringArray(
        retryPolicy.recoveryActions,
        `${label}.retryPolicy.recoveryActions`,
        true,
      ),
    },
    progressSignature: nonBlankString(node.progressSignature, `${label}.progressSignature`),
    state,
    nodeVersion: nonNegativeInteger(node.nodeVersion, `${label}.nodeVersion`),
    acceptedAt,
    acceptanceEvidenceIds,
    invalidatedByEvidenceId: nullableString(
      node.invalidatedByEvidenceId,
      `${label}.invalidatedByEvidenceId`,
    ),
    reopenedByEvidenceId: nullableString(
      node.reopenedByEvidenceId,
      `${label}.reopenedByEvidenceId`,
    ),
    origin,
    terminalLineage,
  };
}

function validateEdge(value: unknown, label: string): RoomTaskEdgeProjectionV1 {
  const edge = exactRecord(value, EDGE_KEYS, label);
  const id = nonBlankString(edge.id, `${label}.id`);
  const fromNodeId = nonBlankString(edge.fromNodeId, `${label}.fromNodeId`);
  const toNodeId = nonBlankString(edge.toNodeId, `${label}.toNodeId`);
  const kind = enumValue(edge.kind, EDGE_KINDS, `${label}.kind`);
  const createdByOperationId = nullableString(
    edge.createdByOperationId,
    `${label}.createdByOperationId`,
  );
  const derivedFromEdgeIds = stringArray(
    edge.derivedFromEdgeIds,
    `${label}.derivedFromEdgeIds`,
    true,
  );
  if ((createdByOperationId === null) !== (derivedFromEdgeIds.length === 0)) {
    invalid(`${label} must pair a topology operation with non-empty derived lineage`);
  }
  if (createdByOperationId !== null) {
    const expectedId = `room-task-edge:${hashRoomValue({
      version: 1,
      operationId: createdByOperationId,
      topology: { fromNodeId, toNodeId, kind },
      derivedFromEdgeIds: [...derivedFromEdgeIds].sort(compareText),
    })}`;
    if (id !== expectedId) invalid(`${label}.id does not match its deterministic topology lineage`);
  }
  return {
    id,
    fromNodeId,
    toNodeId,
    kind,
    createdByOperationId,
    derivedFromEdgeIds,
  };
}

function validateOrigin(value: unknown, label: string): RoomTaskNodeOriginV1 {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    invalid(`${label} must be an object`);
  }
  const kind = (value as Record<string, unknown>).kind;
  if (kind === "created") {
    exactRecord(value, CREATED_ORIGIN_KEYS, label);
    return { kind };
  }
  const origin = exactRecord(value, DERIVED_ORIGIN_KEYS, label);
  const derivedKind = enumValue(
    origin.kind,
    ["split_child", "merge_result"] as const,
    `${label}.kind`,
  );
  const sourceNodeIds = stringArray(origin.sourceNodeIds, `${label}.sourceNodeIds`, true);
  if (
    (derivedKind === "split_child" && sourceNodeIds.length !== 1)
    || (derivedKind === "merge_result" && sourceNodeIds.length < 2)
  ) {
    invalid(`${label} has invalid source lineage`);
  }
  return {
    kind: derivedKind,
    operationId: nonBlankString(origin.operationId, `${label}.operationId`),
    sourceNodeIds,
  };
}

function validateTerminalLineage(
  value: unknown,
  label: string,
): RoomTaskNodeTerminalLineageV1 | null {
  if (value === null) return null;
  const lineage = exactRecord(value, TERMINAL_LINEAGE_KEYS, label);
  const reasonHash = nonBlankString(lineage.reasonHash, `${label}.reasonHash`);
  if (!/^sha256:[0-9a-f]{64}$/u.test(reasonHash)) {
    invalid(`${label}.reasonHash must be a canonical hash`);
  }
  const at = nullableTimestamp(lineage.at, `${label}.at`);
  if (at === null) invalid(`${label}.at must be a canonical UTC ISO timestamp`);
  return {
    kind: enumValue(
      lineage.kind,
      ["split", "merge", "cancel"] as const,
      `${label}.kind`,
    ),
    operationId: nonBlankString(lineage.operationId, `${label}.operationId`),
    at,
    reasonHash,
  };
}

function computeCriticalPath(
  nodes: readonly RoomTaskNodeProjectionV1[],
  edges: readonly RoomTaskEdgeProjectionV1[],
): readonly string[] {
  if (nodes.length === 0) return [];
  const requires = edges.filter((edge) => edge.kind === "requires");
  const indegree = new Map<string, number>(nodes.map((node) => [node.id, 0] as const));
  const adjacency = new Map<string, string[]>();
  for (const edge of requires) {
    indegree.set(edge.toNodeId, indegree.get(edge.toNodeId)! + 1);
    const targets = adjacency.get(edge.fromNodeId) ?? [];
    targets.push(edge.toNodeId);
    adjacency.set(edge.fromNodeId, targets);
  }
  for (const targets of adjacency.values()) targets.sort(compareText);

  const queue = [...indegree.entries()]
    .filter(([, degree]) => degree === 0)
    .map(([nodeId]) => nodeId)
    .sort(compareText);
  const topologicalOrder: string[] = [];
  while (queue.length > 0) {
    const nodeId = queue.shift()!;
    topologicalOrder.push(nodeId);
    for (const targetId of adjacency.get(nodeId) ?? []) {
      const nextDegree = indegree.get(targetId)! - 1;
      indegree.set(targetId, nextDegree);
      if (nextDegree === 0) {
        queue.push(targetId);
        queue.sort(compareText);
      }
    }
  }
  if (topologicalOrder.length !== nodes.length) invalid("requires edges must be acyclic");

  const nodeById = new Map(nodes.map((node) => [node.id, node] as const));
  const best = new Map<string, { duration: number; path: readonly string[] }>();
  for (const nodeId of topologicalOrder) {
    const current = best.get(nodeId) ?? {
      duration: nodeById.get(nodeId)!.resourceHints.estimatedDurationMs,
      path: [nodeId],
    };
    best.set(nodeId, current);
    for (const targetId of adjacency.get(nodeId) ?? []) {
      const targetDuration = nodeById.get(targetId)!.resourceHints.estimatedDurationMs;
      if (current.duration > Number.MAX_SAFE_INTEGER - targetDuration) {
        invalid(`critical path through ${nodeId}->${targetId} exceeds the safe duration range`);
      }
      const candidate = {
        duration: current.duration + targetDuration,
        path: [...current.path, targetId],
      };
      const existing = best.get(targetId);
      if (!existing || comparePaths(candidate, existing) < 0) best.set(targetId, candidate);
    }
  }

  let selected: { duration: number; path: readonly string[] } | undefined;
  for (const candidate of best.values()) {
    if (!selected || comparePaths(candidate, selected) < 0) selected = candidate;
  }
  return selected!.path;
}

function assertAllEdgesAcyclic(
  nodes: readonly RoomTaskNodeProjectionV1[],
  edges: readonly RoomTaskEdgeProjectionV1[],
): void {
  const indegree = new Map<string, number>(nodes.map((node) => [node.id, 0] as const));
  const adjacency = new Map<string, string[]>();
  for (const edge of edges) {
    indegree.set(edge.toNodeId, indegree.get(edge.toNodeId)! + 1);
    const targets = adjacency.get(edge.fromNodeId) ?? [];
    targets.push(edge.toNodeId);
    adjacency.set(edge.fromNodeId, targets);
  }
  const queue = [...indegree.entries()]
    .filter(([, degree]) => degree === 0)
    .map(([nodeId]) => nodeId);
  let visited = 0;
  for (let index = 0; index < queue.length; index += 1) {
    const nodeId = queue[index]!;
    visited += 1;
    for (const targetId of adjacency.get(nodeId) ?? []) {
      const nextDegree = indegree.get(targetId)! - 1;
      indegree.set(targetId, nextDegree);
      if (nextDegree === 0) queue.push(targetId);
    }
  }
  if (visited !== nodes.length) invalid("all task graph edge kinds must remain acyclic");
}

function comparePaths(
  left: { readonly duration: number; readonly path: readonly string[] },
  right: { readonly duration: number; readonly path: readonly string[] },
): number {
  if (left.duration !== right.duration) return right.duration - left.duration;
  const sharedLength = Math.min(left.path.length, right.path.length);
  for (let index = 0; index < sharedLength; index += 1) {
    const compared = compareText(left.path[index]!, right.path[index]!);
    if (compared !== 0) return compared;
  }
  return left.path.length - right.path.length;
}

function assertParentHierarchyAcyclic(
  nodes: readonly RoomTaskNodeProjectionV1[],
  nodeById: ReadonlyMap<string, RoomTaskNodeProjectionV1>,
): void {
  for (const node of nodes) {
    const seen = new Set<string>();
    let current: RoomTaskNodeProjectionV1 | undefined = node;
    while (current?.parentNodeId !== null) {
      if (!current || seen.has(current.id)) invalid("node parent hierarchy must be acyclic");
      seen.add(current.id);
      current = nodeById.get(current.parentNodeId);
    }
  }
}

function assertTopologyLineage(
  nodes: readonly RoomTaskNodeProjectionV1[],
  nodeById: ReadonlyMap<string, RoomTaskNodeProjectionV1>,
): void {
  for (const node of nodes) {
    const origin = node.origin;
    if (origin.kind === "created") continue;
    const sources = origin.sourceNodeIds.map((sourceNodeId) => {
      const source = nodeById.get(sourceNodeId);
      if (!source || source.id === node.id) {
        invalid(`node ${node.id} has unknown or self-referential topology lineage`);
      }
      return source;
    });
    const expectedTerminalKind = origin.kind === "split_child" ? "split" : "merge";
    if (
      sources.some((source) =>
        source.terminalLineage?.kind !== expectedTerminalKind
        || source.terminalLineage.operationId !== origin.operationId)
    ) {
      invalid(`node ${node.id} has inconsistent topology operation lineage`);
    }
    if (origin.kind === "split_child") {
      if (node.parentNodeId !== sources[0]!.id) {
        invalid(`split child ${node.id} must retain its source as parent`);
      }
      continue;
    }
    const commonParentNodeId = sources[0]!.parentNodeId;
    if (
      node.parentNodeId !== commonParentNodeId
      || sources.some((source) => source.parentNodeId !== commonParentNodeId)
    ) {
      invalid(`merge result ${node.id} must retain the source parent lineage`);
    }
  }
}

function uniqueById<T extends { readonly id: string }>(
  values: readonly T[],
  label: string,
): Map<string, T> {
  const result = new Map<string, T>();
  for (const value of values) {
    if (result.has(value.id)) invalid(`duplicate ${label} id ${value.id}`);
    result.set(value.id, value);
  }
  return result;
}

function exactRecord<const T extends readonly string[]>(
  value: unknown,
  keys: T,
  label: string,
): Record<T[number], unknown> {
  if (
    value === null
    || typeof value !== "object"
    || Array.isArray(value)
    || isProxy(value)
  ) {
    invalid(`${label} must be an object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    invalid(`${label} must be a plain data object`);
  }
  const record = value as Record<string, unknown>;
  const descriptors = Object.getOwnPropertyDescriptors(record);
  const ownKeys = Reflect.ownKeys(record);
  if (
    ownKeys.some((key) => typeof key !== "string")
    || ownKeys.some((key) => {
      const descriptor = descriptors[key as string];
      return !descriptor?.enumerable || !("value" in descriptor);
    })
  ) {
    invalid(`${label} must contain only enumerable data properties`);
  }
  const actualKeys = (ownKeys as string[]).sort(compareText);
  const expectedKeys = [...keys].sort(compareText);
  if (
    actualKeys.length !== expectedKeys.length
    || actualKeys.some((key, index) => key !== expectedKeys[index])
  ) {
    invalid(`${label} has unexpected or missing keys`);
  }
  return Object.fromEntries(
    actualKeys.map((key) => [key, descriptors[key]!.value]),
  ) as Record<T[number], unknown>;
}

function stringArray(value: unknown, label: string, unique: boolean): readonly string[] {
  const values = dataArray(value, label);
  const result = values.map((item, index) => nonBlankString(item, `${label}[${index}]`));
  if (unique && new Set(result).size !== result.length) invalid(`${label} must contain unique values`);
  return result;
}

function dataArray(value: unknown, label: string): readonly unknown[] {
  if (
    !Array.isArray(value)
    || isProxy(value)
    || Object.getPrototypeOf(value) !== Array.prototype
    || value.length > MAX_ARRAY_ENTRIES
  ) {
    invalid(`${label} must be a bounded plain array`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const allowedKeys = new Set([
    "length",
    ...Array.from({ length: value.length }, (_, index) => String(index)),
  ]);
  if (
    Reflect.ownKeys(value).some((key) => typeof key !== "string" || !allowedKeys.has(key))
  ) {
    invalid(`${label} must not contain sparse, symbol, or extra entries`);
  }
  const result: unknown[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (!descriptor?.enumerable || !("value" in descriptor)) {
      invalid(`${label} must contain only enumerable data entries and must not be sparse`);
    }
    result.push(descriptor.value);
  }
  return result;
}

function cloneRuntimeValue(
  value: unknown,
  label: string,
  budget: RuntimeBudget,
  ancestors: WeakSet<object>,
  depth: number,
): unknown {
  budget.valueCount += 1;
  if (budget.valueCount > MAX_RUNTIME_VALUES || depth > MAX_RUNTIME_DEPTH) {
    invalid(`${label} exceeds the graph shape limit`);
  }
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") {
    budget.stringCodeUnits += value.length;
    if (budget.stringCodeUnits > MAX_RUNTIME_STRING_CODE_UNITS) {
      invalid(`${label} exceeds the graph text limit`);
    }
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) invalid(`${label} must be a finite number`);
    return value;
  }
  if (typeof value !== "object" || isProxy(value)) {
    invalid(`${label} contains an unsupported value`);
  }
  if (ancestors.has(value)) invalid(`${label} must not contain a cycle`);
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const values = dataArray(value, label);
      return values.map((item, index) =>
        cloneRuntimeValue(item, `${label}[${index}]`, budget, ancestors, depth + 1));
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      invalid(`${label} must be a plain object`);
    }
    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.length > MAX_OBJECT_KEYS || ownKeys.some((key) => typeof key !== "string")) {
      invalid(`${label} exceeds the object shape limit`);
    }
    const cloned = Object.create(null) as Record<string, unknown>;
    for (const key of ownKeys as string[]) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !("value" in descriptor)) {
        invalid(`${label}.${key} must be an enumerable data property`);
      }
      cloned[key] = cloneRuntimeValue(
        descriptor.value,
        `${label}.${key}`,
        budget,
        ancestors,
        depth + 1,
      );
    }
    return cloned;
  } finally {
    ancestors.delete(value);
  }
}

function nonBlankString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    invalid(`${label} must be a non-blank string`);
  }
  return value;
}

function nullableString(value: unknown, label: string): string | null {
  return value === null ? null : nonBlankString(value, label);
}

function nullableTimestamp(value: unknown, label: string): string | null {
  if (value === null) return null;
  const timestamp = nonBlankString(value, label);
  const epoch = Date.parse(timestamp);
  if (!Number.isFinite(epoch) || new Date(epoch).toISOString() !== timestamp) {
    invalid(`${label} must be a canonical UTC ISO timestamp`);
  }
  return timestamp;
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    invalid(`${label} must be a non-negative safe integer`);
  }
  return value as number;
}

function positiveInteger(value: unknown, label: string): number {
  const result = nonNegativeInteger(value, label);
  if (result === 0) invalid(`${label} must be positive`);
  return result;
}

function enumValue<const T extends readonly string[]>(
  value: unknown,
  allowed: T,
  label: string,
): T[number] {
  if (typeof value !== "string" || !allowed.includes(value)) {
    invalid(`${label} must be one of ${allowed.join(", ")}`);
  }
  return value as T[number];
}

function assertSameIds(
  actual: readonly string[],
  expected: readonly string[],
  message: string,
): void {
  if (actual.length !== expected.length || actual.some((value, index) => value !== expected[index])) {
    invalid(message);
  }
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function invalid(message: string): never {
  throw new RoomDependencyDispatchGraphError(message);
}
