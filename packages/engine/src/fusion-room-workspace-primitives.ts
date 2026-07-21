import { posix, win32 } from "node:path";

import type { StoredRoomLeaseV1 } from "@fusion/core";

import type {
  RoomWorkspaceAllocationV1,
  RoomWorkspaceBranchGroupV1,
  RoomWorkspacePrimitiveContextV1,
  RoomWorkspacePrimitives,
} from "./room-workspace-coordinator.js";

export interface FusionRoomTaskCheckoutFenceV1 {
  readonly agentId: string;
  readonly taskId: string;
  readonly nodeId: string;
  readonly runId: string;
  readonly epoch: number;
}

/**
 * Persisted candidate grant. The integration layer must derive this from a
 * candidate-allocation record; it must not reconstruct a worktree path from a
 * Room worker identity or an untrusted request.
 */
export interface FusionRoomCandidateWorkspaceAuthorizationV1 {
  readonly allocationId: string;
  readonly isolationKey: string;
  readonly branchGroupId: string;
  readonly branchName: string;
  readonly repositoryRoot: string;
  readonly worktreePath: string;
  readonly checkout: FusionRoomTaskCheckoutFenceV1;
}

export interface FusionRoomWorkspaceLeaseAcquireInputV1 {
  readonly context: RoomWorkspacePrimitiveContextV1;
  readonly resourceId: string;
  readonly holderId: string;
  readonly hostId: string;
  readonly expectedRoomWorkerEpoch: number;
}

export interface FusionRoomCandidateWorktreeAcquireInputV1 {
  readonly context: RoomWorkspacePrimitiveContextV1;
  readonly authorization: FusionRoomCandidateWorkspaceAuthorizationV1;
  readonly workspaceLease: StoredRoomLeaseV1;
}

export interface FusionRoomCandidateWorktreeReleaseInputV1 {
  readonly context: RoomWorkspacePrimitiveContextV1;
  readonly authorization: FusionRoomCandidateWorkspaceAuthorizationV1;
  readonly workspace: RoomWorkspaceAllocationV1;
}

/**
 * Integration-only ports. Production wiring must adapt existing RoomController
 * authority, candidate-allocation storage, Task checkout, Room leases, and
 * Fusion worktree acquisition separately; no port is a raw Git escape hatch.
 */
export interface FusionRoomWorkspaceAuthorityPorts {
  /** Must include Room lease, posture, and aggregate-version authority. */
  assertCurrentRoomWorker(input: RoomWorkspacePrimitiveContextV1): Promise<boolean>;
  /** Reads the immutable persisted candidate-allocation grant. */
  getAuthorizedCandidateWorkspace(
    input: RoomWorkspacePrimitiveContextV1,
  ): Promise<FusionRoomCandidateWorkspaceAuthorizationV1 | null>;
  /** Uses the canonical Fusion task checkout authority, never a Room worker id. */
  assertTaskCheckout(input: {
    readonly context: RoomWorkspacePrimitiveContextV1;
    readonly checkout: FusionRoomTaskCheckoutFenceV1;
  }): Promise<boolean>;
  /** Acquires the independent Room `workspace` lease for the canonical path. */
  acquireWorkspaceLease(
    input: FusionRoomWorkspaceLeaseAcquireInputV1,
  ): Promise<StoredRoomLeaseV1 | null>;
  /** Delegates to the existing candidate-aware worktree primitive. */
  acquireCandidateWorktree(
    input: FusionRoomCandidateWorktreeAcquireInputV1,
  ): Promise<Omit<RoomWorkspaceAllocationV1, "workspaceLease"> | null>;
  releaseCandidateWorktree(input: FusionRoomCandidateWorktreeReleaseInputV1): Promise<void>;
  releaseWorkspaceLease(input: FusionRoomCandidateWorktreeReleaseInputV1): Promise<void>;
}

export interface FusionRoomWorkspacePrimitivesOptions {
  readonly ports: FusionRoomWorkspaceAuthorityPorts;
}

/*
FNXC:FusionRoomWorkspacePrimitives 2026-07-19:
This is deliberately a fail-closed adapter, not a second dispatcher or a Git
implementation. Every candidate path first comes from a persisted grant, is
re-read to detect allocation drift, then needs independent Room-worker posture,
Fusion Task checkout, and Room workspace-lease fences before the injected
worktree primitive is called. A Room worker id is never an Agent checkout id.
*/
export class FusionRoomWorkspacePrimitives implements RoomWorkspacePrimitives {
  private readonly ports: FusionRoomWorkspaceAuthorityPorts;
  private readonly authorizations = new Map<string, FusionRoomCandidateWorkspaceAuthorizationV1>();

  constructor(options: FusionRoomWorkspacePrimitivesOptions) {
    if (!options.ports) throw new TypeError("FusionRoomWorkspacePrimitives requires authority ports");
    this.ports = options.ports;
  }

  async assertCurrentRoomWorker(input: RoomWorkspacePrimitiveContextV1): Promise<boolean> {
    if (!isValidContext(input)) return false;
    try {
      return await this.ports.assertCurrentRoomWorker(input) === true;
    } catch {
      return false;
    }
  }

  async ensureCandidateBranchGroup(
    input: RoomWorkspacePrimitiveContextV1,
  ): Promise<RoomWorkspaceBranchGroupV1 | null> {
    if (!(await this.assertCurrentRoomWorker(input))) return null;
    const authorization = await this.readAuthorization(input);
    if (!authorization) return null;
    this.authorizations.set(input.isolationKey, authorization);
    return Object.freeze({
      id: authorization.branchGroupId,
      branchName: authorization.branchName,
      isolationKey: authorization.isolationKey,
    });
  }

  async acquireIsolatedWorkspace(
    input: RoomWorkspacePrimitiveContextV1 & { readonly branchGroup: RoomWorkspaceBranchGroupV1 },
  ): Promise<RoomWorkspaceAllocationV1 | null> {
    if (!(await this.assertCurrentRoomWorker(input))) return null;
    const cached = this.authorizations.get(input.isolationKey);
    if (!cached || !matchesBranchGroup(cached, input.branchGroup)) return null;

    const current = await this.readAuthorization(input);
    if (!current || !sameAuthorization(cached, current)) return null;

    const checkoutCurrent = await this.assertTaskCheckout(input, current.checkout);
    if (!checkoutCurrent) return null;

    const workspaceLease = await this.acquireWorkspaceLease(input, current.worktreePath);
    if (!workspaceLease) return null;

    const candidateWorktree = await this.acquireCandidateWorktree(input, current, workspaceLease);
    if (!candidateWorktree) return null;
    return Object.freeze({ ...candidateWorktree, workspaceLease });
  }

  async releaseIsolatedWorkspace(
    input: RoomWorkspacePrimitiveContextV1 & { readonly workspace: RoomWorkspaceAllocationV1 },
  ): Promise<void> {
    const authorization = this.authorizations.get(input.isolationKey);
    if (!authorization || !matchesAllocation(input, authorization, input.workspace)) return;
    const release = Object.freeze({ context: input, authorization, workspace: input.workspace });
    try {
      await this.ports.releaseCandidateWorktree(release);
    } finally {
      await this.ports.releaseWorkspaceLease(release);
      this.authorizations.delete(input.isolationKey);
    }
  }

  private async readAuthorization(
    input: RoomWorkspacePrimitiveContextV1,
  ): Promise<FusionRoomCandidateWorkspaceAuthorizationV1 | null> {
    try {
      const result = await this.ports.getAuthorizedCandidateWorkspace(input);
      return result && normalizeAuthorization(input, result);
    } catch {
      return null;
    }
  }

  private async assertTaskCheckout(
    context: RoomWorkspacePrimitiveContextV1,
    checkout: FusionRoomTaskCheckoutFenceV1,
  ): Promise<boolean> {
    try {
      if (!isValidCheckout(context, checkout)) return false;
      return await this.ports.assertTaskCheckout({ context, checkout }) === true;
    } catch {
      return false;
    }
  }

  private async acquireWorkspaceLease(
    context: RoomWorkspacePrimitiveContextV1,
    worktreePath: string,
  ): Promise<StoredRoomLeaseV1 | null> {
    try {
      const result = await this.ports.acquireWorkspaceLease({
        context,
        resourceId: worktreePath,
        holderId: context.worker.workerId,
        hostId: context.worker.hostId,
        expectedRoomWorkerEpoch: context.worker.lease.epoch,
      });
      return result && isMatchingWorkspaceLease(context, worktreePath, result) ? result : null;
    } catch {
      return null;
    }
  }

  private async acquireCandidateWorktree(
    context: RoomWorkspacePrimitiveContextV1,
    authorization: FusionRoomCandidateWorkspaceAuthorizationV1,
    workspaceLease: StoredRoomLeaseV1,
  ): Promise<Omit<RoomWorkspaceAllocationV1, "workspaceLease"> | null> {
    try {
      const result = await this.ports.acquireCandidateWorktree({ context, authorization, workspaceLease });
      return result && matchesCandidateWorktree(authorization, result) ? result : null;
    } catch {
      return null;
    }
  }
}

function normalizeAuthorization(
  context: RoomWorkspacePrimitiveContextV1,
  value: FusionRoomCandidateWorkspaceAuthorizationV1,
): FusionRoomCandidateWorkspaceAuthorizationV1 | null {
  if (!isRecord(value)) return null;
  if (
    !isNonBlank(value.allocationId)
    || value.isolationKey !== context.isolationKey
    || !isNonBlank(value.branchGroupId)
    || !isNonBlank(value.branchName)
    || !samePath(value.repositoryRoot, context.repositoryRoot)
    || !isSafeCandidateWorktreePath(value.worktreePath, context.repositoryRoot)
    || !isValidCheckout(context, value.checkout)
  ) return null;
  return Object.freeze({
    allocationId: value.allocationId,
    isolationKey: value.isolationKey,
    branchGroupId: value.branchGroupId,
    branchName: value.branchName,
    repositoryRoot: value.repositoryRoot,
    worktreePath: value.worktreePath,
    checkout: Object.freeze({ ...value.checkout }),
  });
}

function isValidContext(value: unknown): value is RoomWorkspacePrimitiveContextV1 {
  if (!isRecord(value) || !isRecord(value.worker) || !isRecord(value.worker.lease)) return false;
  const lease = value.worker.lease as unknown as StoredRoomLeaseV1;
  return isNonBlank(value.projectId)
    && isNonBlank(value.roomId)
    && isNonBlank(value.taskId)
    && isNonBlank(value.candidateId)
    && isNonBlank(value.isolationKey)
    && isSafeAbsolutePath(value.repositoryRoot)
    && isNonBlank(value.worker.workerId)
    && isNonBlank(value.worker.hostId)
    && lease.kind === "room_worker"
    && lease.roomId === value.roomId
    && lease.resourceId === value.roomId
    && lease.holderId === value.worker.workerId
    && lease.hostId === value.worker.hostId
    && lease.releasedAt === null
    && isPositiveInteger(lease.epoch);
}

function isValidCheckout(
  context: RoomWorkspacePrimitiveContextV1,
  value: unknown,
): value is FusionRoomTaskCheckoutFenceV1 {
  if (!isRecord(value)) return false;
  return isNonBlank(value.agentId)
    && value.agentId !== context.worker.workerId
    && value.taskId === context.taskId
    && isNonBlank(value.nodeId)
    && isNonBlank(value.runId)
    && isPositiveInteger(value.epoch);
}

function isMatchingWorkspaceLease(
  context: RoomWorkspacePrimitiveContextV1,
  worktreePath: string,
  lease: StoredRoomLeaseV1,
): boolean {
  return lease.contractVersion === 1
    && lease.kind === "workspace"
    && lease.roomId === context.roomId
    && samePath(lease.resourceId, worktreePath)
    && lease.holderId === context.worker.workerId
    && lease.hostId === context.worker.hostId
    && lease.releasedAt === null
    && isNonBlank(lease.id)
    && isPositiveInteger(lease.epoch);
}

function matchesBranchGroup(
  authorization: FusionRoomCandidateWorkspaceAuthorizationV1,
  branchGroup: RoomWorkspaceBranchGroupV1,
): boolean {
  return branchGroup.id === authorization.branchGroupId
    && branchGroup.branchName === authorization.branchName
    && branchGroup.isolationKey === authorization.isolationKey;
}

function matchesCandidateWorktree(
  authorization: FusionRoomCandidateWorkspaceAuthorizationV1,
  value: Omit<RoomWorkspaceAllocationV1, "workspaceLease">,
): value is Omit<RoomWorkspaceAllocationV1, "workspaceLease"> {
  return value.isIsolated === true
    && isNonBlank(value.id)
    && value.isolationKey === authorization.isolationKey
    && value.branchGroupId === authorization.branchGroupId
    && value.branchName === authorization.branchName
    && samePath(value.repositoryRoot, authorization.repositoryRoot)
    && samePath(value.worktreePath, authorization.worktreePath)
    && isSafeCandidateWorktreePath(value.worktreePath, authorization.repositoryRoot);
}

function matchesAllocation(
  context: RoomWorkspacePrimitiveContextV1,
  authorization: FusionRoomCandidateWorkspaceAuthorizationV1,
  workspace: RoomWorkspaceAllocationV1,
): boolean {
  return workspace.isolationKey === authorization.isolationKey
    && workspace.branchGroupId === authorization.branchGroupId
    && workspace.branchName === authorization.branchName
    && samePath(workspace.repositoryRoot, authorization.repositoryRoot)
    && samePath(workspace.worktreePath, authorization.worktreePath)
    && isMatchingWorkspaceLease(context, authorization.worktreePath, workspace.workspaceLease);
}

function sameAuthorization(
  left: FusionRoomCandidateWorkspaceAuthorizationV1,
  right: FusionRoomCandidateWorkspaceAuthorizationV1,
): boolean {
  return left.allocationId === right.allocationId
    && left.isolationKey === right.isolationKey
    && left.branchGroupId === right.branchGroupId
    && left.branchName === right.branchName
    && samePath(left.repositoryRoot, right.repositoryRoot)
    && samePath(left.worktreePath, right.worktreePath)
    && left.checkout.agentId === right.checkout.agentId
    && left.checkout.taskId === right.checkout.taskId
    && left.checkout.nodeId === right.checkout.nodeId
    && left.checkout.runId === right.checkout.runId
    && left.checkout.epoch === right.checkout.epoch;
}

function isSafeCandidateWorktreePath(path: unknown, repositoryRoot: unknown): boolean {
  return isSafeAbsolutePath(path) && !samePath(path, repositoryRoot);
}

function samePath(left: unknown, right: unknown): boolean {
  const normalizedLeft = normalizeAbsolutePath(left);
  const normalizedRight = normalizeAbsolutePath(right);
  return normalizedLeft !== null && normalizedLeft === normalizedRight;
}

function isSafeAbsolutePath(value: unknown): boolean {
  return normalizeAbsolutePath(value) !== null;
}

function normalizeAbsolutePath(value: unknown): string | null {
  if (!isNonBlank(value)) return null;
  if (win32.isAbsolute(value)) {
    const normalized = win32.normalize(value);
    return trimTrailingSeparators(normalized, win32.parse(normalized).root).toLowerCase();
  }
  if (posix.isAbsolute(value)) {
    const normalized = posix.normalize(value);
    return trimTrailingSeparators(normalized, posix.parse(normalized).root);
  }
  return null;
}

function trimTrailingSeparators(path: string, root: string): string {
  return path === root ? path : path.replace(/[\\/]+$/, "");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isNonBlank(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.trim() === value;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}
