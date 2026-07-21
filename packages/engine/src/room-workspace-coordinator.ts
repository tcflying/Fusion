import { createHash } from "node:crypto";
import { posix, win32 } from "node:path";

import type {
  RoomTaskNodeOriginV1,
  StoredRoomLeaseV1,
} from "@fusion/core";

export interface RoomWorkspaceWorkerIdentityV1 {
  readonly workerId: string;
  readonly hostId: string;
  readonly lease: StoredRoomLeaseV1;
}

/** Immutable binding identity: a replacement must use a new binding generation. */
export interface RoomWorkspaceBindingLineageV1 {
  readonly seatId: string;
  readonly bindingId: string;
  readonly generation: number;
}

/** Immutable DAG identity for one candidate workspace request. */
export interface RoomWorkspaceNodeLineageV1 {
  readonly nodeId: string;
  readonly parentNodeId: string | null;
  readonly dagVersion: number;
  readonly nodeVersion: number;
  readonly origin: RoomTaskNodeOriginV1;
}

export interface RoomWorkspaceRequestV1 {
  readonly roomId: string;
  /** Existing Fusion task identity consumed by the checkout/worktree primitive. */
  readonly taskId: string;
  /** Stable identifier for one parallel candidate under the Room node. */
  readonly candidateId: string;
  readonly repositoryRoot: string;
  readonly worker: {
    readonly lease: StoredRoomLeaseV1;
  };
  readonly binding: RoomWorkspaceBindingLineageV1;
  readonly node: RoomWorkspaceNodeLineageV1;
}

export interface RoomWorkspacePrimitiveContextV1 {
  readonly projectId: string;
  readonly roomId: string;
  readonly taskId: string;
  readonly candidateId: string;
  readonly repositoryRoot: string;
  readonly worker: RoomWorkspaceWorkerIdentityV1;
  readonly binding: RoomWorkspaceBindingLineageV1;
  readonly node: RoomWorkspaceNodeLineageV1;
  /** Stable, opaque source identity for the existing branch-group primitive. */
  readonly isolationKey: string;
}

export interface RoomWorkspaceBranchGroupV1 {
  readonly id: string;
  readonly branchName: string;
  readonly isolationKey: string;
}

export interface RoomWorkspaceAllocationV1 {
  readonly id: string;
  readonly isolationKey: string;
  readonly branchGroupId: string;
  readonly branchName: string;
  readonly repositoryRoot: string;
  readonly worktreePath: string;
  readonly isIsolated: boolean;
  /** A Room `workspace` lease whose resource is exactly this worktree path. */
  readonly workspaceLease: StoredRoomLeaseV1;
}

export interface RoomWorkspacePrimitives {
  /** Delegates to the canonical Room worker-fence assertion. */
  assertCurrentRoomWorker(input: RoomWorkspacePrimitiveContextV1): Promise<boolean>;
  /** Delegates to the existing branch-group ensure/create primitive. */
  ensureCandidateBranchGroup(input: RoomWorkspacePrimitiveContextV1): Promise<RoomWorkspaceBranchGroupV1 | null>;
  /** Delegates to the existing checkout/worktree acquisition primitive. */
  acquireIsolatedWorkspace(
    input: RoomWorkspacePrimitiveContextV1 & { readonly branchGroup: RoomWorkspaceBranchGroupV1 },
  ): Promise<RoomWorkspaceAllocationV1 | null>;
  /** Best-effort cleanup when the Room worker loses authority after acquisition. */
  releaseIsolatedWorkspace(
    input: RoomWorkspacePrimitiveContextV1 & { readonly workspace: RoomWorkspaceAllocationV1 },
  ): Promise<void>;
}

export interface RoomWorkspaceCoordinatorOptions {
  readonly projectId: string;
  readonly workerId: string;
  readonly hostId: string;
  readonly primitives: RoomWorkspacePrimitives;
}

export interface RoomWorkspaceGrantV1 {
  readonly projectId: string;
  readonly roomId: string;
  readonly taskId: string;
  readonly candidateId: string;
  readonly isolationKey: string;
  readonly branchGroup: RoomWorkspaceBranchGroupV1;
  readonly workspace: RoomWorkspaceAllocationV1;
}

export type RoomWorkspaceCoordinatorErrorCode =
  | "room_workspace_invalid_request"
  | "room_workspace_worker_fence_rejected"
  | "room_workspace_branch_group_unavailable"
  | "room_workspace_unavailable"
  | "room_workspace_unsafe";

export class RoomWorkspaceCoordinatorError extends Error {
  constructor(
    readonly code: RoomWorkspaceCoordinatorErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "RoomWorkspaceCoordinatorError";
  }
}

/*
FNXC:RoomWorkspaceCoordinator 2026-07-19-07:45:
Room writes may use Fusion's mature branch-group and worktree primitives, but a
Room worker never gains write authority from a path alone. This adapter carries
the exact live room-worker fence plus immutable binding/node lineage into each
injected primitive, requires a separately fenced isolated worktree result, and
rejects every missing, stale, root, or mismatched allocation. It intentionally
contains no raw Git command or checkout creation path.
*/
export class RoomWorkspaceCoordinator {
  private readonly projectId: string;
  private readonly workerId: string;
  private readonly hostId: string;
  private readonly primitives: RoomWorkspacePrimitives;

  constructor(options: RoomWorkspaceCoordinatorOptions) {
    this.projectId = requireNonBlankString(options.projectId, "projectId");
    this.workerId = requireNonBlankString(options.workerId, "workerId");
    this.hostId = requireNonBlankString(options.hostId, "hostId");
    if (!options.primitives) {
      throw new RoomWorkspaceCoordinatorError(
        "room_workspace_invalid_request",
        "RoomWorkspaceCoordinator requires injected workspace primitives",
      );
    }
    this.primitives = options.primitives;
  }

  async acquire(input: RoomWorkspaceRequestV1): Promise<RoomWorkspaceGrantV1> {
    const context = this.normalizeRequest(input);
    await this.assertCurrentWorker(context, "before branch-group preparation");

    const branchGroup = await this.ensureBranchGroup(context);
    await this.assertCurrentWorker(context, "before workspace acquisition");

    const workspace = await this.acquireWorkspace(context, branchGroup);
    try {
      await this.assertCurrentWorker(context, "after workspace acquisition");
    } catch (error) {
      await this.releaseAfterFenceLoss(context, workspace);
      throw error;
    }

    return Object.freeze({
      projectId: context.projectId,
      roomId: context.roomId,
      taskId: context.taskId,
      candidateId: context.candidateId,
      isolationKey: context.isolationKey,
      branchGroup,
      workspace,
    });
  }

  private normalizeRequest(input: RoomWorkspaceRequestV1): RoomWorkspacePrimitiveContextV1 {
    if (!isRecord(input)) {
      throw new RoomWorkspaceCoordinatorError(
        "room_workspace_invalid_request",
        "Room workspace request must be an object",
      );
    }
    const roomId = requireNonBlankString(input.roomId, "roomId");
    const taskId = requireNonBlankString(input.taskId, "taskId");
    const candidateId = requireNonBlankString(input.candidateId, "candidateId");
    const repositoryRoot = requireAbsolutePath(input.repositoryRoot, "repositoryRoot").original;
    const worker = Object.freeze({
      workerId: this.workerId,
      hostId: this.hostId,
      lease: normalizeRoomWorkerLease(input.worker?.lease, roomId, this.workerId, this.hostId),
    });
    const binding = normalizeBindingLineage(input.binding);
    const node = normalizeNodeLineage(input.node);
    const base = {
      projectId: this.projectId,
      roomId,
      taskId,
      candidateId,
      repositoryRoot,
      worker,
      binding,
      node,
    };
    const isolationKey = createIsolationKey(base);
    return Object.freeze({ ...base, isolationKey });
  }

  private async assertCurrentWorker(
    context: RoomWorkspacePrimitiveContextV1,
    stage: string,
  ): Promise<void> {
    let current = false;
    try {
      current = await this.primitives.assertCurrentRoomWorker(context);
    } catch {
      throw new RoomWorkspaceCoordinatorError(
        "room_workspace_worker_fence_rejected",
        `Room worker fence could not be asserted ${stage}`,
      );
    }
    if (current !== true) {
      throw new RoomWorkspaceCoordinatorError(
        "room_workspace_worker_fence_rejected",
        `Room worker fence is not current ${stage}`,
      );
    }
  }

  private async ensureBranchGroup(
    context: RoomWorkspacePrimitiveContextV1,
  ): Promise<RoomWorkspaceBranchGroupV1> {
    let result: RoomWorkspaceBranchGroupV1 | null;
    try {
      result = await this.primitives.ensureCandidateBranchGroup(context);
    } catch {
      throw new RoomWorkspaceCoordinatorError(
        "room_workspace_branch_group_unavailable",
        "Candidate branch-group preparation failed",
      );
    }
    if (!result) {
      throw new RoomWorkspaceCoordinatorError(
        "room_workspace_branch_group_unavailable",
        "Candidate branch-group preparation returned no branch group",
      );
    }
    return normalizeBranchGroup(result, context.isolationKey);
  }

  private async acquireWorkspace(
    context: RoomWorkspacePrimitiveContextV1,
    branchGroup: RoomWorkspaceBranchGroupV1,
  ): Promise<RoomWorkspaceAllocationV1> {
    let result: RoomWorkspaceAllocationV1 | null;
    try {
      result = await this.primitives.acquireIsolatedWorkspace({ ...context, branchGroup });
    } catch {
      throw new RoomWorkspaceCoordinatorError(
        "room_workspace_unavailable",
        "Candidate workspace acquisition failed",
      );
    }
    if (!result) {
      throw new RoomWorkspaceCoordinatorError(
        "room_workspace_unavailable",
        "Candidate workspace acquisition returned no workspace",
      );
    }
    return normalizeWorkspaceAllocation(context, branchGroup, result);
  }

  private async releaseAfterFenceLoss(
    context: RoomWorkspacePrimitiveContextV1,
    workspace: RoomWorkspaceAllocationV1,
  ): Promise<void> {
    try {
      await this.primitives.releaseIsolatedWorkspace({ ...context, workspace });
    } catch {
      /*
      FNXC:RoomWorkspaceCoordinator 2026-07-18-08:03:
      A release must carry the same workspace fence, so a stale worker cannot
      remove a newer holder's allocation. Preserve the primary fence failure.
      */
    }
  }
}

function normalizeRoomWorkerLease(
  value: unknown,
  roomId: string,
  workerId: string,
  hostId: string,
): StoredRoomLeaseV1 {
  if (!isRecord(value)) invalidRequest("worker.lease must be an object");
  const lease = Object.freeze({ ...value }) as unknown as StoredRoomLeaseV1;
  if (
    lease.contractVersion !== 1
    || lease.kind !== "room_worker"
    || lease.roomId !== roomId
    || lease.resourceId !== roomId
    || lease.holderId !== workerId
    || lease.hostId !== hostId
    || lease.releasedAt !== null
  ) {
    invalidRequest("worker.lease does not identify the configured active Room worker");
  }
  requireNonBlankString(lease.id, "worker.lease.id");
  requirePositiveInteger(lease.epoch, "worker.lease.epoch");
  requireNonBlankString(lease.acquiredAt, "worker.lease.acquiredAt");
  requireNonBlankString(lease.heartbeatAt, "worker.lease.heartbeatAt");
  requireNonBlankString(lease.expiresAt, "worker.lease.expiresAt");
  return lease;
}

function normalizeBindingLineage(value: unknown): RoomWorkspaceBindingLineageV1 {
  if (!isRecord(value)) invalidRequest("binding lineage must be an object");
  return Object.freeze({
    seatId: requireNonBlankString(value.seatId, "binding.seatId"),
    bindingId: requireNonBlankString(value.bindingId, "binding.bindingId"),
    generation: requirePositiveInteger(value.generation, "binding.generation"),
  });
}

function normalizeNodeLineage(value: unknown): RoomWorkspaceNodeLineageV1 {
  if (!isRecord(value)) invalidRequest("node lineage must be an object");
  const nodeId = requireNonBlankString(value.nodeId, "node.nodeId");
  const parentNodeId = value.parentNodeId === null
    ? null
    : requireNonBlankString(value.parentNodeId, "node.parentNodeId");
  if (parentNodeId === nodeId) invalidRequest("node.parentNodeId cannot equal node.nodeId");
  return Object.freeze({
    nodeId,
    parentNodeId,
    dagVersion: requireNonNegativeInteger(value.dagVersion, "node.dagVersion"),
    nodeVersion: requireNonNegativeInteger(value.nodeVersion, "node.nodeVersion"),
    origin: normalizeNodeOrigin(value.origin),
  });
}

function normalizeNodeOrigin(value: unknown): RoomTaskNodeOriginV1 {
  if (!isRecord(value)) invalidRequest("node.origin must be an object");
  if (value.kind === "created") return Object.freeze({ kind: "created" });
  if (value.kind !== "split_child" && value.kind !== "merge_result") {
    invalidRequest("node.origin.kind is invalid");
  }
  if (!Array.isArray(value.sourceNodeIds) || value.sourceNodeIds.length === 0) {
    invalidRequest("derived node origin requires sourceNodeIds");
  }
  const sourceNodeIds = value.sourceNodeIds.map((sourceNodeId, index) =>
    requireNonBlankString(sourceNodeId, `node.origin.sourceNodeIds[${index}]`));
  if (new Set(sourceNodeIds).size !== sourceNodeIds.length) {
    invalidRequest("node.origin.sourceNodeIds must be unique");
  }
  return Object.freeze({
    kind: value.kind,
    operationId: requireNonBlankString(value.operationId, "node.origin.operationId"),
    sourceNodeIds: Object.freeze(sourceNodeIds),
  });
}

function normalizeBranchGroup(value: unknown, isolationKey: string): RoomWorkspaceBranchGroupV1 {
  if (!isRecord(value)) unsafeWorkspace("branch-group primitive returned a malformed result");
  if (value.isolationKey !== isolationKey) {
    unsafeWorkspace("branch-group primitive returned a mismatched isolation key");
  }
  return Object.freeze({
    id: requireNonBlankString(value.id, "branchGroup.id"),
    branchName: requireNonBlankString(value.branchName, "branchGroup.branchName"),
    isolationKey,
  });
}

function normalizeWorkspaceAllocation(
  context: RoomWorkspacePrimitiveContextV1,
  branchGroup: RoomWorkspaceBranchGroupV1,
  value: unknown,
): RoomWorkspaceAllocationV1 {
  if (!isRecord(value)) unsafeWorkspace("workspace primitive returned a malformed result");
  if (value.isIsolated !== true) unsafeWorkspace("workspace primitive did not return an isolated workspace");
  if (value.isolationKey !== context.isolationKey) unsafeWorkspace("workspace isolation key does not match the request");
  if (value.branchGroupId !== branchGroup.id) unsafeWorkspace("workspace branch group does not match the request");
  if (value.branchName !== branchGroup.branchName) unsafeWorkspace("workspace branch does not match the branch group");

  const expectedRoot = requireAbsolutePath(context.repositoryRoot, "repositoryRoot");
  const returnedRoot = requireAbsolutePath(value.repositoryRoot, "workspace.repositoryRoot");
  const worktreePath = requireAbsolutePath(value.worktreePath, "workspace.worktreePath");
  if (returnedRoot.canonical !== expectedRoot.canonical) {
    unsafeWorkspace("workspace repository root does not match the request");
  }
  if (worktreePath.canonical === expectedRoot.canonical) {
    unsafeWorkspace("workspace primitive returned the repository root instead of an isolated worktree");
  }

  const workspaceLease = normalizeWorkspaceLease(value.workspaceLease, context, worktreePath.original);
  return Object.freeze({
    id: requireNonBlankString(value.id, "workspace.id"),
    isolationKey: context.isolationKey,
    branchGroupId: branchGroup.id,
    branchName: branchGroup.branchName,
    repositoryRoot: returnedRoot.original,
    worktreePath: worktreePath.original,
    isIsolated: true,
    workspaceLease,
  });
}

function normalizeWorkspaceLease(
  value: unknown,
  context: RoomWorkspacePrimitiveContextV1,
  worktreePath: string,
): StoredRoomLeaseV1 {
  if (!isRecord(value)) unsafeWorkspace("workspace primitive returned no workspace fence");
  const lease = Object.freeze({ ...value }) as unknown as StoredRoomLeaseV1;
  if (
    lease.contractVersion !== 1
    || lease.kind !== "workspace"
    || lease.roomId !== context.roomId
    || lease.resourceId !== worktreePath
    || lease.holderId !== context.worker.workerId
    || lease.hostId !== context.worker.hostId
    || lease.releasedAt !== null
  ) {
    unsafeWorkspace("workspace primitive returned a mismatched workspace fence");
  }
  requireNonBlankString(lease.id, "workspace.workspaceLease.id");
  requirePositiveInteger(lease.epoch, "workspace.workspaceLease.epoch");
  requireNonBlankString(lease.acquiredAt, "workspace.workspaceLease.acquiredAt");
  requireNonBlankString(lease.heartbeatAt, "workspace.workspaceLease.heartbeatAt");
  requireNonBlankString(lease.expiresAt, "workspace.workspaceLease.expiresAt");
  return lease;
}

function createIsolationKey(input: Omit<RoomWorkspacePrimitiveContextV1, "isolationKey">): string {
  const payload = JSON.stringify({
    contract: "room-workspace/v1",
    projectId: input.projectId,
    roomId: input.roomId,
    taskId: input.taskId,
    candidateId: input.candidateId,
    binding: input.binding,
    node: input.node,
  });
  return `room-workspace/v1:${createHash("sha256").update(payload).digest("hex")}`;
}

function requireAbsolutePath(value: unknown, label: string): { readonly original: string; readonly canonical: string } {
  const original = requireNonBlankString(value, label);
  if (win32.isAbsolute(original)) {
    const normalized = win32.normalize(original);
    return Object.freeze({ original, canonical: trimTrailingSeparators(normalized, win32.parse(normalized).root).toLowerCase() });
  }
  if (posix.isAbsolute(original)) {
    const normalized = posix.normalize(original);
    return Object.freeze({ original, canonical: trimTrailingSeparators(normalized, posix.parse(normalized).root) });
  }
  unsafeWorkspace(`${label} must be an absolute path`);
}

function trimTrailingSeparators(path: string, root: string): string {
  return path === root ? path : path.replace(/[\\/]+$/, "");
}

function requireNonBlankString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.trim() !== value) {
    invalidRequest(`${label} must be a non-blank, trimmed string`);
  }
  return value;
}

function requirePositiveInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    invalidRequest(`${label} must be a positive integer`);
  }
  return value;
}

function requireNonNegativeInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    invalidRequest(`${label} must be a non-negative integer`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalidRequest(message: string): never {
  throw new RoomWorkspaceCoordinatorError("room_workspace_invalid_request", message);
}

function unsafeWorkspace(message: string): never {
  throw new RoomWorkspaceCoordinatorError("room_workspace_unsafe", message);
}
