import { createHash } from "node:crypto";
import { posix, win32 } from "node:path";

import type {
  AgentStore,
  AsyncRoomLeaseStore,
  BranchGroup,
  Settings,
  StoredRoomLeaseV1,
  Task,
  TaskStore,
} from "@fusion/core";

import {
  FusionRoomWorkspacePrimitives,
  type FusionRoomCandidateWorkspaceAuthorizationV1,
  type FusionRoomWorkspaceAuthorityPorts,
} from "./fusion-room-workspace-primitives.js";
import {
  RoomWorkspaceCoordinator,
  type RoomWorkspaceGrantV1,
  type RoomWorkspacePrimitiveContextV1,
  type RoomWorkspaceRequestV1,
} from "./room-workspace-coordinator.js";
import { acquireTaskWorktree } from "./worktree-acquisition.js";
import { resolveTaskWorktreePath } from "./worktree-paths.js";

export interface FusionRoomWorkspaceCheckoutRequestV1 {
  readonly agentId: string;
  readonly nodeId: string;
  readonly runId: string;
}

export interface PrepareFusionRoomWorkspaceInputV1 {
  readonly workspace: RoomWorkspaceRequestV1;
  /** The Fusion task checkout is intentionally distinct from the Room worker. */
  readonly checkout: FusionRoomWorkspaceCheckoutRequestV1;
}

export interface FusionRoomWorkspaceAllocationV1 {
  readonly contractVersion: 1;
  readonly id: string;
  readonly branchGroupSourceId: string;
  readonly branchName: string;
  readonly repositoryRoot: string;
  readonly worktreePath: string;
}

export interface FusionRoomWorkspaceGrantV1 {
  readonly contractVersion: 1;
  /** Frozen request lineage needed to reassert all three fences after recovery. */
  readonly request: RoomWorkspaceRequestV1;
  readonly workspace: RoomWorkspaceGrantV1;
  readonly allocation: FusionRoomWorkspaceAllocationV1;
  readonly checkout: Readonly<FusionRoomWorkspaceCheckoutRequestV1 & { readonly epoch: number }>;
}

/** A short-lived proof passed only into a caller's guarded local mutation. */
export interface FusionRoomWorkspacePublicationFenceV1 {
  readonly contractVersion: 1;
  readonly roomId: string;
  readonly taskId: string;
  readonly candidateId: string;
  readonly worktreePath: string;
  readonly branchName: string;
  readonly roomWorkerLease: StoredRoomLeaseV1;
  readonly workspaceLease: StoredRoomLeaseV1;
  readonly checkout: Readonly<FusionRoomWorkspaceCheckoutRequestV1 & { readonly epoch: number }>;
  readonly assertedAt: string;
}

export interface FusionRoomWorkspaceAuthorityStore {
  getRoom(roomId: string): Promise<{
    readonly room: {
      readonly id: string;
      readonly projectId: string;
      readonly aggregateVersion: number;
    };
  } | null>;
  assertWorkerAuthority(input: {
    readonly roomId: string;
    readonly lease: StoredRoomLeaseV1;
    readonly expectedAggregateVersion: number;
    readonly now: string;
  }): Promise<{ readonly lease: StoredRoomLeaseV1 }>;
}

export interface FusionRoomWorkspaceRuntimeOptions {
  readonly projectId: string;
  readonly workerId: string;
  readonly hostId: string;
  readonly rootDir: string;
  readonly roomStore: FusionRoomWorkspaceAuthorityStore;
  readonly leaseStore: Pick<
    AsyncRoomLeaseStore,
    "acquireLease" | "getActiveLease" | "assertFence" | "releaseLease"
  >;
  readonly taskStore: Pick<
    TaskStore,
    "getTask" | "getSettings" | "updateTask" | "ensureBranchGroupForSource" | "getBranchGroupBySource" | "updateBranchGroup"
  >;
  readonly agentStore: Pick<AgentStore, "checkoutTask">;
  readonly now?: () => string;
  readonly workspaceLeaseDurationMs?: number;
  readonly acquireTaskWorktree?: typeof acquireTaskWorktree;
}

export type FusionRoomWorkspaceRuntimeErrorCode =
  | "room_workspace_runtime_invalid_request"
  | "room_workspace_runtime_authority_rejected"
  | "room_workspace_runtime_task_unavailable"
  | "room_workspace_runtime_checkout_rejected"
  | "room_workspace_runtime_allocation_conflict"
  | "room_workspace_runtime_lease_unavailable"
  | "room_workspace_runtime_publication_fence_rejected";

export class FusionRoomWorkspaceRuntimeError extends Error {
  constructor(
    readonly code: FusionRoomWorkspaceRuntimeErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "FusionRoomWorkspaceRuntimeError";
  }
}

interface PreparedWorkspaceAllocation {
  readonly request: PrepareFusionRoomWorkspaceInputV1;
  readonly allocation: FusionRoomWorkspaceAllocationV1;
  readonly branchGroup: BranchGroup;
  readonly checkout: Readonly<FusionRoomWorkspaceCheckoutRequestV1 & { readonly epoch: number }>;
  readonly settings: Settings;
}

/*
FNXC:FusionRoomWorkspaceRuntime 2026-07-19:
The Room DAG does not get a second git implementation. A code candidate is
anchored to an existing Fusion Task checkout, a deterministic branch-group
source, and a deterministic non-root worktree path. The durable Task and
BranchGroup records are re-read on every authority check; in-memory state only
bridges the one coordinator call. Room-worker authority, Task checkout, and the
separate Room workspace lease are all required before local mutation or later
integration can proceed.
*/
export class FusionRoomWorkspaceRuntime {
  private readonly now: () => string;
  private readonly workspaceLeaseDurationMs: number;
  private readonly acquireTaskWorktreeImpl: typeof acquireTaskWorktree;

  constructor(private readonly options: FusionRoomWorkspaceRuntimeOptions) {
    requireNonBlank(options.projectId, "projectId");
    requireNonBlank(options.workerId, "workerId");
    requireNonBlank(options.hostId, "hostId");
    requireAbsolutePath(options.rootDir, "rootDir");
    if (!options.roomStore || !options.leaseStore || !options.taskStore || !options.agentStore) {
      throw new FusionRoomWorkspaceRuntimeError(
        "room_workspace_runtime_invalid_request",
        "Fusion Room workspace runtime requires Room, lease, task, and Agent stores",
      );
    }
    this.now = options.now ?? (() => new Date().toISOString());
    this.workspaceLeaseDurationMs = requirePositiveInteger(
      options.workspaceLeaseDurationMs ?? 30_000,
      "workspaceLeaseDurationMs",
    );
    this.acquireTaskWorktreeImpl = options.acquireTaskWorktree ?? acquireTaskWorktree;
  }

  /**
   * Claims the real Fusion Task, persists its isolated allocation, and obtains
   * the independent Room workspace lease through the existing primitives.
   */
  async prepare(input: PrepareFusionRoomWorkspaceInputV1): Promise<FusionRoomWorkspaceGrantV1> {
    const prepared = await this.prepareAllocation(input);
    const primitives = new FusionRoomWorkspacePrimitives({
      ports: this.createAuthorityPorts(prepared),
    });
    const coordinator = new RoomWorkspaceCoordinator({
      projectId: this.options.projectId,
      workerId: this.options.workerId,
      hostId: this.options.hostId,
      primitives,
    });
    const workspace = await coordinator.acquire(prepared.request.workspace);
    return Object.freeze({
      contractVersion: 1,
      request: prepared.request.workspace,
      workspace,
      allocation: prepared.allocation,
      checkout: prepared.checkout,
    });
  }

  /**
   * Reassert every independent fence before an authority-branch integration or
   * other guarded local write. This deliberately does not run raw git itself.
   */
  async assertPublicationAuthority(
    grant: FusionRoomWorkspaceGrantV1,
  ): Promise<FusionRoomWorkspacePublicationFenceV1> {
    const normalized = this.normalizeGrant(grant);
    const context = this.toGrantContext(normalized);
    const roomWorkerLease = await this.assertRoomWorkerAuthority(normalized.request);
    const authorization = await this.readAuthorization(
      context,
      normalized.allocation,
      normalized.checkout,
    );
    if (!authorization) {
      throw new FusionRoomWorkspaceRuntimeError(
        "room_workspace_runtime_publication_fence_rejected",
        "Candidate Task checkout, branch group, or worktree allocation no longer matches the grant",
      );
    }
    const workspaceLease = await this.assertWorkspaceLease(
      context,
      normalized.workspace.workspace.workspaceLease,
    );
    return Object.freeze({
      contractVersion: 1,
      roomId: normalized.workspace.roomId,
      taskId: normalized.workspace.taskId,
      candidateId: normalized.workspace.candidateId,
      worktreePath: normalized.allocation.worktreePath,
      branchName: normalized.allocation.branchName,
      roomWorkerLease,
      workspaceLease,
      checkout: normalized.checkout,
      assertedAt: canonicalNow(this.now()),
    });
  }

  /**
   * The completion fence is rechecked after the local operation so a caller
   * cannot report a stale-worker mutation as promotable work.
   */
  async withPublicationAuthority<TResult>(
    grant: FusionRoomWorkspaceGrantV1,
    action: (fence: FusionRoomWorkspacePublicationFenceV1) => Promise<TResult>,
  ): Promise<TResult> {
    if (typeof action !== "function") {
      throw new FusionRoomWorkspaceRuntimeError(
        "room_workspace_runtime_invalid_request",
        "withPublicationAuthority requires an action function",
      );
    }
    const before = await this.assertPublicationAuthority(grant);
    const result = await action(before);
    await this.assertPublicationAuthority(grant);
    return result;
  }

  /** Releases only the exact workspace epoch carried by the grant. */
  async release(grant: FusionRoomWorkspaceGrantV1): Promise<boolean> {
    const normalized = this.normalizeGrant(grant);
    const lease = normalized.workspace.workspace.workspaceLease;
    const result = await this.options.leaseStore.releaseLease({
      leaseId: lease.id,
      roomId: lease.roomId,
      kind: "workspace",
      resourceId: lease.resourceId,
      holderId: lease.holderId,
      hostId: lease.hostId,
      expectedEpoch: lease.epoch,
      now: canonicalNow(this.now()),
    });
    return result.ok === true;
  }

  private async prepareAllocation(input: PrepareFusionRoomWorkspaceInputV1): Promise<PreparedWorkspaceAllocation> {
    const request = normalizePrepareRequest(input, this.options.projectId, this.options.workerId, this.options.hostId);
    const roomWorkerLease = await this.assertRoomWorkerAuthority(request.workspace);
    if (!sameRoomWorkerLease(roomWorkerLease, request.workspace.worker.lease)) {
      throw new FusionRoomWorkspaceRuntimeError(
        "room_workspace_runtime_authority_rejected",
        "The current Room worker fence differs from the workspace request",
      );
    }

    const settings = await this.options.taskStore.getSettings();
    const allocation = this.deriveAllocation(request.workspace, settings);
    const taskBeforeCheckout = await this.requireTask(request.workspace.taskId);
    this.assertTaskLayoutCompatible(taskBeforeCheckout, allocation);
    if (
      taskBeforeCheckout.checkedOutBy
      && taskBeforeCheckout.checkedOutBy !== request.checkout.agentId
    ) {
      throw new FusionRoomWorkspaceRuntimeError(
        "room_workspace_runtime_checkout_rejected",
        `Task ${taskBeforeCheckout.id} is checked out by another Fusion Agent`,
      );
    }

    const existingEpoch = taskBeforeCheckout.checkoutLeaseEpoch;
    const sameCheckout = taskBeforeCheckout.checkedOutBy === request.checkout.agentId
      && taskBeforeCheckout.checkoutNodeId === request.checkout.nodeId
      && typeof existingEpoch === "number";
    await this.options.agentStore.checkoutTask(
      request.checkout.agentId,
      request.workspace.taskId,
      Object.freeze({
        nodeId: request.checkout.nodeId,
        runId: request.checkout.runId,
        renewedAt: canonicalNow(this.now()),
        ...(sameCheckout ? { leaseEpoch: existingEpoch } : {}),
      }),
    );

    await this.assertRoomWorkerAuthority(request.workspace);
    const checkedOutTask = await this.requireTask(request.workspace.taskId);
    const checkout = extractTaskCheckout(checkedOutTask, request.checkout);
    this.assertTaskLayoutCompatible(checkedOutTask, allocation);

    // Validate or reserve the deterministic branch group before changing the
    // Task's durable layout. A corrupt/colliding group therefore cannot leave
    // a Task falsely allocated to this candidate after a rejected prepare.
    const branchGroup = await this.options.taskStore.ensureBranchGroupForSource(
      "new-task",
      allocation.branchGroupSourceId,
      {
        branchName: allocation.branchName,
        worktreePath: allocation.worktreePath,
        autoMerge: false,
        status: "open",
      },
    );
    this.assertBranchGroup(branchGroup, allocation);
    await this.assertRoomWorkerAuthority(request.workspace);

    const allocatedTask = await this.options.taskStore.updateTask(checkedOutTask.id, {
      branch: allocation.branchName,
      worktree: allocation.worktreePath,
    });
    this.assertAllocatedTask(allocatedTask, allocation, checkout);
    await this.assertRoomWorkerAuthority(request.workspace);

    return Object.freeze({
      request,
      allocation,
      branchGroup,
      checkout,
      settings,
    });
  }

  private createAuthorityPorts(prepared: PreparedWorkspaceAllocation): FusionRoomWorkspaceAuthorityPorts {
    return {
      assertCurrentRoomWorker: async (context) => {
        try {
          await this.assertContextMatchesPrepared(context, prepared);
          await this.assertRoomWorkerAuthority(prepared.request.workspace);
          return true;
        } catch {
          return false;
        }
      },
      getAuthorizedCandidateWorkspace: async (context) => {
        try {
          await this.assertContextMatchesPrepared(context, prepared);
          return await this.readAuthorization(context, prepared.allocation, prepared.checkout);
        } catch {
          return null;
        }
      },
      assertTaskCheckout: async ({ context, checkout }) => {
        try {
          await this.assertContextMatchesPrepared(context, prepared);
          const current = await this.readAuthorization(context, prepared.allocation, prepared.checkout);
          return current !== null && sameCheckout(current.checkout, checkout);
        } catch {
          return false;
        }
      },
      acquireWorkspaceLease: async (input) => {
        try {
          await this.assertContextMatchesPrepared(input.context, prepared);
          if (input.resourceId !== prepared.allocation.worktreePath
            || input.holderId !== this.options.workerId
            || input.hostId !== this.options.hostId
            || input.expectedRoomWorkerEpoch !== prepared.request.workspace.worker.lease.epoch) {
            return null;
          }
          return await this.acquireWorkspaceLease(input.context, prepared);
        } catch {
          return null;
        }
      },
      acquireCandidateWorktree: async (input) => {
        try {
          await this.assertContextMatchesPrepared(input.context, prepared);
          const authorization = await this.readAuthorization(
            input.context,
            prepared.allocation,
            prepared.checkout,
          );
          if (!authorization || authorization.allocationId !== input.authorization.allocationId) return null;
          await this.assertRoomWorkerAuthority(prepared.request.workspace);
          await this.assertWorkspaceLease(input.context, input.workspaceLease);
          const task = await this.requireTask(input.context.taskId);
          this.assertAllocatedTask(task, prepared.allocation, prepared.checkout);
          const acquired = await this.acquireTaskWorktreeImpl({
            task,
            rootDir: this.options.rootDir,
            store: this.options.taskStore as TaskStore,
            settings: prepared.settings,
          });
          if (
            acquired.branch !== prepared.allocation.branchName
            || !samePath(acquired.worktreePath, prepared.allocation.worktreePath)
          ) {
            await this.releaseWorkspaceLease(input.workspaceLease);
            return null;
          }
          const updatedGroup = await this.options.taskStore.updateBranchGroup(
            prepared.branchGroup.id,
            { worktreePath: acquired.worktreePath },
          );
          this.assertBranchGroup(updatedGroup, prepared.allocation);
          await this.assertRoomWorkerAuthority(prepared.request.workspace);
          await this.assertWorkspaceLease(input.context, input.workspaceLease);
          return Object.freeze({
            id: prepared.allocation.id,
            isolationKey: input.context.isolationKey,
            branchGroupId: prepared.branchGroup.id,
            branchName: prepared.allocation.branchName,
            repositoryRoot: prepared.allocation.repositoryRoot,
            worktreePath: prepared.allocation.worktreePath,
            isIsolated: true,
          });
        } catch {
          await this.releaseWorkspaceLease(input.workspaceLease).catch(() => undefined);
          return null;
        }
      },
      // The existing Task owns worktree lifecycle. A stale Room worker may
      // release only its own Room lease; it must not delete a later Task holder's
      // workspace as best-effort cleanup.
      releaseCandidateWorktree: async () => undefined,
      releaseWorkspaceLease: async ({ workspace }) => {
        await this.releaseWorkspaceLease(workspace.workspaceLease);
      },
    };
  }

  private async acquireWorkspaceLease(
    context: RoomWorkspacePrimitiveContextV1,
    prepared: PreparedWorkspaceAllocation,
  ): Promise<StoredRoomLeaseV1 | null> {
    await this.assertRoomWorkerAuthority(prepared.request.workspace);
    const authorization = await this.readAuthorization(context, prepared.allocation, prepared.checkout);
    if (!authorization) return null;
    const now = canonicalNow(this.now());
    const active = await this.options.leaseStore.getActiveLease("workspace", prepared.allocation.worktreePath);
    if (active && !isLeaseExpired(active, now)) {
      const activeLeaseId = workspaceLeaseId(
        prepared.allocation,
        context.worker.lease,
        active.epoch,
      );
      if (sameWorkspaceLeaseIdentity(active, context, prepared.allocation.worktreePath, activeLeaseId)) {
        return active;
      }
      return null;
    }
    let expectedEpoch = active?.epoch ?? null;
    let leaseId = workspaceLeaseId(
      prepared.allocation,
      context.worker.lease,
      (expectedEpoch ?? 0) + 1,
    );
    let acquired = await this.options.leaseStore.acquireLease(
      this.workspaceLeaseAcquireInput({
        leaseId,
        context,
        worktreePath: prepared.allocation.worktreePath,
        expectedEpoch,
        now,
      }),
    );
    // A concurrent expiry takeover is safe to retry exactly once against the
    // fresh epoch. The new lease id also changes, preserving append-only
    // Room-lease history even when the same Room worker reacquires it.
    if (!acquired.ok && acquired.reason === "stale_epoch" && acquired.current) {
      expectedEpoch = acquired.current.epoch;
      leaseId = workspaceLeaseId(
        prepared.allocation,
        context.worker.lease,
        expectedEpoch + 1,
      );
      acquired = await this.options.leaseStore.acquireLease(
        this.workspaceLeaseAcquireInput({
          leaseId,
          context,
          worktreePath: prepared.allocation.worktreePath,
          expectedEpoch,
          now,
        }),
      );
    }
    if (!acquired.ok) return null;
    try {
      await this.assertRoomWorkerAuthority(prepared.request.workspace);
      const reread = await this.readAuthorization(context, prepared.allocation, prepared.checkout);
      if (!reread) throw new Error("allocation drifted after workspace lease acquisition");
      return acquired.lease;
    } catch {
      await this.releaseWorkspaceLease(acquired.lease).catch(() => undefined);
      return null;
    }
  }

  private async readAuthorization(
    context: RoomWorkspacePrimitiveContextV1,
    allocation: FusionRoomWorkspaceAllocationV1,
    checkout: Readonly<FusionRoomWorkspaceCheckoutRequestV1 & { readonly epoch: number }>,
  ): Promise<FusionRoomCandidateWorkspaceAuthorizationV1 | null> {
    const task = await this.options.taskStore.getTask(context.taskId);
    if (!task) return null;
    try {
      this.assertAllocatedTask(task, allocation, checkout);
      const group = await this.options.taskStore.getBranchGroupBySource(
        "new-task",
        allocation.branchGroupSourceId,
      );
      if (!group) return null;
      this.assertBranchGroup(group, allocation);
      return Object.freeze({
        allocationId: allocation.id,
        isolationKey: context.isolationKey,
        branchGroupId: group.id,
        branchName: allocation.branchName,
        repositoryRoot: allocation.repositoryRoot,
        worktreePath: allocation.worktreePath,
        checkout: Object.freeze({
          agentId: checkout.agentId,
          taskId: context.taskId,
          nodeId: checkout.nodeId,
          runId: checkout.runId,
          epoch: checkout.epoch,
        }),
      });
    } catch {
      return null;
    }
  }

  private async assertRoomWorkerAuthority(request: RoomWorkspaceRequestV1): Promise<StoredRoomLeaseV1> {
    const room = await this.options.roomStore.getRoom(request.roomId);
    if (
      !room
      || room.room.id !== request.roomId
      || room.room.projectId !== this.options.projectId
    ) {
      throw new FusionRoomWorkspaceRuntimeError(
        "room_workspace_runtime_authority_rejected",
        `Room ${request.roomId} is unavailable for workspace authority`,
      );
    }
    try {
      const authority = await this.options.roomStore.assertWorkerAuthority({
        roomId: request.roomId,
        lease: request.worker.lease,
        expectedAggregateVersion: room.room.aggregateVersion,
        now: canonicalNow(this.now()),
      });
      if (!sameRoomWorkerLease(authority.lease, request.worker.lease)) {
        throw new Error("authoritative Room lease changed");
      }
      return authority.lease;
    } catch (error) {
      throw new FusionRoomWorkspaceRuntimeError(
        "room_workspace_runtime_authority_rejected",
        `Room worker authority rejected: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async assertWorkspaceLease(
    context: RoomWorkspacePrimitiveContextV1,
    lease: StoredRoomLeaseV1,
  ): Promise<StoredRoomLeaseV1> {
    try {
      const asserted = await this.options.leaseStore.assertFence({
        leaseId: lease.id,
        roomId: context.roomId,
        kind: "workspace",
        resourceId: lease.resourceId,
        holderId: this.options.workerId,
        hostId: this.options.hostId,
        expectedEpoch: lease.epoch,
        now: canonicalNow(this.now()),
      });
      if (!sameWorkspaceLease(asserted, lease, context)) throw new Error("workspace lease changed");
      return asserted;
    } catch (error) {
      throw new FusionRoomWorkspaceRuntimeError(
        "room_workspace_runtime_publication_fence_rejected",
        `Workspace lease is no longer current: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async releaseWorkspaceLease(lease: StoredRoomLeaseV1): Promise<void> {
    await this.options.leaseStore.releaseLease({
      leaseId: lease.id,
      roomId: lease.roomId,
      kind: "workspace",
      resourceId: lease.resourceId,
      holderId: lease.holderId,
      hostId: lease.hostId,
      expectedEpoch: lease.epoch,
      now: canonicalNow(this.now()),
    });
  }

  private workspaceLeaseAcquireInput(input: {
    readonly leaseId: string;
    readonly context: RoomWorkspacePrimitiveContextV1;
    readonly worktreePath: string;
    readonly expectedEpoch: number | null;
    readonly now: string;
  }) {
    return {
      leaseId: input.leaseId,
      roomId: input.context.roomId,
      kind: "workspace" as const,
      resourceId: input.worktreePath,
      holderId: this.options.workerId,
      hostId: this.options.hostId,
      expectedEpoch: input.expectedEpoch,
      now: input.now,
      expiresAt: new Date(
        Date.parse(input.now) + this.workspaceLeaseDurationMs,
      ).toISOString(),
    };
  }

  private async requireTask(taskId: string): Promise<Task> {
    const task = await this.options.taskStore.getTask(taskId);
    if (!task) {
      throw new FusionRoomWorkspaceRuntimeError(
        "room_workspace_runtime_task_unavailable",
        `Fusion Task ${taskId} does not exist`,
      );
    }
    return task;
  }

  private deriveAllocation(request: RoomWorkspaceRequestV1, settings: Settings): FusionRoomWorkspaceAllocationV1 {
    if (!samePath(request.repositoryRoot, this.options.rootDir)) {
      throw new FusionRoomWorkspaceRuntimeError(
        "room_workspace_runtime_invalid_request",
        "Room workspace repositoryRoot must equal this ProjectEngine repository root",
      );
    }
    const identity = JSON.stringify({
      contract: "fusion-room-workspace-allocation/v1",
      projectId: this.options.projectId,
      roomId: request.roomId,
      taskId: request.taskId,
      candidateId: request.candidateId,
      repositoryRoot: normalizeAbsolutePath(request.repositoryRoot),
      binding: request.binding,
      node: request.node,
    });
    const digest = createHash("sha256").update(identity).digest("hex");
    return Object.freeze({
      contractVersion: 1,
      id: `room-workspace:${digest}`,
      branchGroupSourceId: `room-workspace:v1:${digest}`,
      branchName: `fusion/room/${digest.slice(0, 32)}`,
      repositoryRoot: request.repositoryRoot,
      worktreePath: resolveTaskWorktreePath(
        this.options.rootDir,
        settings,
        `room-${digest.slice(0, 24)}`,
      ),
    });
  }

  private assertTaskLayoutCompatible(task: Task, allocation: FusionRoomWorkspaceAllocationV1): void {
    if (task.column === "done" || task.column === "archived") {
      throw new FusionRoomWorkspaceRuntimeError(
        "room_workspace_runtime_task_unavailable",
        `Terminal Fusion Task ${task.id} cannot be allocated to a Room candidate`,
      );
    }
    if (task.branchContext?.assignmentMode === "shared") {
      throw new FusionRoomWorkspaceRuntimeError(
        "room_workspace_runtime_allocation_conflict",
        `Fusion Task ${task.id} is assigned to a shared branch group`,
      );
    }
    if (task.branch !== null && task.branch !== undefined && task.branch !== allocation.branchName) {
      throw new FusionRoomWorkspaceRuntimeError(
        "room_workspace_runtime_allocation_conflict",
        `Fusion Task ${task.id} already owns a different branch`,
      );
    }
    if (task.worktree !== null && task.worktree !== undefined && !samePath(task.worktree, allocation.worktreePath)) {
      throw new FusionRoomWorkspaceRuntimeError(
        "room_workspace_runtime_allocation_conflict",
        `Fusion Task ${task.id} already owns a different worktree`,
      );
    }
  }

  private assertAllocatedTask(
    task: Task,
    allocation: FusionRoomWorkspaceAllocationV1,
    checkout: Readonly<FusionRoomWorkspaceCheckoutRequestV1 & { readonly epoch: number }>,
  ): void {
    this.assertTaskLayoutCompatible(task, allocation);
    if (
      task.branch !== allocation.branchName
      || !samePath(task.worktree, allocation.worktreePath)
      || task.checkedOutBy !== checkout.agentId
      || task.checkoutNodeId !== checkout.nodeId
      || task.checkoutRunId !== checkout.runId
      || task.checkoutLeaseEpoch !== checkout.epoch
    ) {
      throw new FusionRoomWorkspaceRuntimeError(
        "room_workspace_runtime_checkout_rejected",
        `Fusion Task ${task.id} no longer matches the candidate checkout allocation`,
      );
    }
  }

  private assertBranchGroup(group: BranchGroup, allocation: FusionRoomWorkspaceAllocationV1): void {
    if (
      group.sourceType !== "new-task"
      || group.sourceId !== allocation.branchGroupSourceId
      || group.branchName !== allocation.branchName
      || !samePath(group.worktreePath, allocation.worktreePath)
      || group.status !== "open"
    ) {
      throw new FusionRoomWorkspaceRuntimeError(
        "room_workspace_runtime_allocation_conflict",
        "Existing Fusion branch group does not match the Room candidate allocation",
      );
    }
  }

  private async assertContextMatchesPrepared(
    context: RoomWorkspacePrimitiveContextV1,
    prepared: PreparedWorkspaceAllocation,
  ): Promise<void> {
    const request = prepared.request.workspace;
    if (
      context.projectId !== this.options.projectId
      || context.roomId !== request.roomId
      || context.taskId !== request.taskId
      || context.candidateId !== request.candidateId
      || !samePath(context.repositoryRoot, prepared.allocation.repositoryRoot)
      || context.binding.bindingId !== request.binding.bindingId
      || context.binding.seatId !== request.binding.seatId
      || context.binding.generation !== request.binding.generation
      || context.node.nodeId !== request.node.nodeId
      || context.node.dagVersion !== request.node.dagVersion
      || context.node.nodeVersion !== request.node.nodeVersion
      || !sameRoomWorkerLease(context.worker.lease, request.worker.lease)
    ) {
      throw new FusionRoomWorkspaceRuntimeError(
        "room_workspace_runtime_invalid_request",
        "Workspace primitive context drifted from the frozen candidate allocation",
      );
    }
  }

  private normalizeGrant(grant: FusionRoomWorkspaceGrantV1): FusionRoomWorkspaceGrantV1 {
    if (!grant || typeof grant !== "object" || grant.contractVersion !== 1) {
      throw new FusionRoomWorkspaceRuntimeError(
        "room_workspace_runtime_invalid_request",
        "Workspace grant must use contract version 1",
      );
    }
    if (
      grant.workspace.projectId !== this.options.projectId
      || grant.request.roomId !== grant.workspace.roomId
      || grant.request.taskId !== grant.workspace.taskId
      || grant.request.candidateId !== grant.workspace.candidateId
      || grant.workspace.workspace.repositoryRoot !== grant.allocation.repositoryRoot
      || !samePath(grant.workspace.workspace.worktreePath, grant.allocation.worktreePath)
      || grant.workspace.workspace.branchName !== grant.allocation.branchName
      || !samePath(
        grant.workspace.workspace.workspaceLease.resourceId,
        grant.allocation.worktreePath,
      )
      || !isPositiveInteger(grant.checkout.epoch)
    ) {
      throw new FusionRoomWorkspaceRuntimeError(
        "room_workspace_runtime_invalid_request",
        "Workspace grant lineage is malformed or belongs to another project",
      );
    }
    return grant;
  }

  private toGrantContext(grant: FusionRoomWorkspaceGrantV1): RoomWorkspacePrimitiveContextV1 {
    return Object.freeze({
      projectId: this.options.projectId,
      roomId: grant.request.roomId,
      taskId: grant.request.taskId,
      candidateId: grant.request.candidateId,
      repositoryRoot: grant.request.repositoryRoot,
      worker: Object.freeze({
        workerId: this.options.workerId,
        hostId: this.options.hostId,
        lease: grant.request.worker.lease,
      }),
      binding: grant.request.binding,
      node: grant.request.node,
      isolationKey: grant.workspace.isolationKey,
    });
  }
}

function normalizePrepareRequest(
  value: PrepareFusionRoomWorkspaceInputV1,
  projectId: string,
  workerId: string,
  hostId: string,
): PrepareFusionRoomWorkspaceInputV1 {
  if (!value || typeof value !== "object" || !value.workspace || !value.checkout) {
    throw new FusionRoomWorkspaceRuntimeError(
      "room_workspace_runtime_invalid_request",
      "Workspace preparation requires a Room workspace request and Fusion checkout request",
    );
  }
  const request = value.workspace;
  if (
    request.worker.lease.holderId !== workerId
    || request.worker.lease.hostId !== hostId
    || request.worker.lease.roomId !== request.roomId
    || request.worker.lease.kind !== "room_worker"
    || request.worker.lease.resourceId !== request.roomId
    || request.worker.lease.releasedAt !== null
  ) {
    throw new FusionRoomWorkspaceRuntimeError(
      "room_workspace_runtime_authority_rejected",
      "Workspace request does not carry this runtime's active Room worker lease",
    );
  }
  requireNonBlank(request.roomId, "workspace.roomId");
  requireNonBlank(request.taskId, "workspace.taskId");
  requireNonBlank(request.candidateId, "workspace.candidateId");
  requireAbsolutePath(request.repositoryRoot, "workspace.repositoryRoot");
  requireNonBlank(value.checkout.agentId, "checkout.agentId");
  requireNonBlank(value.checkout.nodeId, "checkout.nodeId");
  requireNonBlank(value.checkout.runId, "checkout.runId");
  if (value.checkout.agentId === workerId) {
    throw new FusionRoomWorkspaceRuntimeError(
      "room_workspace_runtime_invalid_request",
      "A Room worker id cannot be used as a Fusion Task checkout agent id",
    );
  }
  return Object.freeze({
    workspace: request,
    checkout: Object.freeze({ ...value.checkout }),
  });
}

function extractTaskCheckout(
  task: Task,
  request: FusionRoomWorkspaceCheckoutRequestV1,
): Readonly<FusionRoomWorkspaceCheckoutRequestV1 & { readonly epoch: number }> {
  if (
    task.checkedOutBy !== request.agentId
    || task.checkoutNodeId !== request.nodeId
    || task.checkoutRunId !== request.runId
    || !isPositiveInteger(task.checkoutLeaseEpoch)
  ) {
    throw new FusionRoomWorkspaceRuntimeError(
      "room_workspace_runtime_checkout_rejected",
      `Fusion Task ${task.id} did not persist the requested checkout fence`,
    );
  }
  return Object.freeze({ ...request, epoch: task.checkoutLeaseEpoch });
}

function workspaceLeaseId(
  allocation: FusionRoomWorkspaceAllocationV1,
  workerLease: StoredRoomLeaseV1,
  workspaceEpoch: number,
): string {
  return `${allocation.id}:worker:${workerLease.id}:epoch:${workerLease.epoch}:workspace:${workspaceEpoch}`;
}

function sameCheckout(
  left: FusionRoomCandidateWorkspaceAuthorizationV1["checkout"],
  right: FusionRoomCandidateWorkspaceAuthorizationV1["checkout"],
): boolean {
  return left.agentId === right.agentId
    && left.taskId === right.taskId
    && left.nodeId === right.nodeId
    && left.runId === right.runId
    && left.epoch === right.epoch;
}

function sameRoomWorkerLease(left: StoredRoomLeaseV1, right: StoredRoomLeaseV1): boolean {
  return left.id === right.id
    && left.roomId === right.roomId
    && left.kind === "room_worker"
    && right.kind === "room_worker"
    && left.resourceId === right.resourceId
    && left.holderId === right.holderId
    && left.hostId === right.hostId
    && left.epoch === right.epoch
    && left.releasedAt === null
    && right.releasedAt === null;
}

function sameWorkspaceLease(
  left: StoredRoomLeaseV1,
  right: StoredRoomLeaseV1,
  context: RoomWorkspacePrimitiveContextV1,
): boolean {
  return left.id === right.id
    && left.roomId === context.roomId
    && left.kind === "workspace"
    && right.kind === "workspace"
    && samePath(left.resourceId, right.resourceId)
    && left.holderId === context.worker.workerId
    && left.hostId === context.worker.hostId
    && left.epoch === right.epoch
    && left.releasedAt === null
    && right.releasedAt === null;
}

function sameWorkspaceLeaseIdentity(
  lease: StoredRoomLeaseV1,
  context: RoomWorkspacePrimitiveContextV1,
  worktreePath: string,
  leaseId: string,
): boolean {
  return lease.id === leaseId
    && lease.roomId === context.roomId
    && lease.kind === "workspace"
    && samePath(lease.resourceId, worktreePath)
    && lease.holderId === context.worker.workerId
    && lease.hostId === context.worker.hostId
    && lease.releasedAt === null;
}

function isLeaseExpired(lease: StoredRoomLeaseV1, now: string): boolean {
  return Date.parse(lease.expiresAt) <= Date.parse(now);
}

function canonicalNow(value: string): string {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    throw new FusionRoomWorkspaceRuntimeError(
      "room_workspace_runtime_invalid_request",
      "Room workspace clock must return a canonical UTC ISO timestamp",
    );
  }
  return value;
}

function requireNonBlank(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.trim() !== value) {
    throw new FusionRoomWorkspaceRuntimeError(
      "room_workspace_runtime_invalid_request",
      `${label} must be a nonblank trimmed string`,
    );
  }
  return value;
}

function requirePositiveInteger(value: unknown, label: string): number {
  if (!isPositiveInteger(value)) {
    throw new FusionRoomWorkspaceRuntimeError(
      "room_workspace_runtime_invalid_request",
      `${label} must be a positive safe integer`,
    );
  }
  return value;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function requireAbsolutePath(value: unknown, label: string): string {
  if (!isNonBlank(value) || normalizeAbsolutePath(value) === null) {
    throw new FusionRoomWorkspaceRuntimeError(
      "room_workspace_runtime_invalid_request",
      `${label} must be an absolute filesystem path`,
    );
  }
  return value;
}

function samePath(left: unknown, right: unknown): boolean {
  const normalizedLeft = normalizeAbsolutePath(left);
  const normalizedRight = normalizeAbsolutePath(right);
  return normalizedLeft !== null && normalizedLeft === normalizedRight;
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

function isNonBlank(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.trim() === value;
}
