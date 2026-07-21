import { describe, expect, it, vi } from "vitest";
import type { StoredRoomLeaseV1 } from "@fusion/core";

import {
  RoomWorkspaceCoordinator,
  type RoomWorkspacePrimitives,
} from "../room-workspace-coordinator.js";

const PROJECT_ID = "project-room-workspace";
const ROOM_ID = "room-workspace";
const WORKER_ID = "room-worker-1";
const HOST_ID = "windows-node-1";
const NOW = "2026-07-19T07:41:00.000Z";

/*
FNXC:RoomWorkspaceCoordinatorTests 2026-07-19-07:41:
These fakes prove the adapter only coordinates an already-fenced Room worker
with the existing branch-group/workspace seams. It must never create a raw Git
checkout, and it must withhold a grant for stale, missing, or unsafe workspaces.
*/

function roomWorkerLease(overrides: Partial<StoredRoomLeaseV1> = {}): StoredRoomLeaseV1 {
  return {
    contractVersion: 1,
    id: "room-worker-lease-1",
    roomId: ROOM_ID,
    kind: "room_worker",
    resourceId: ROOM_ID,
    holderId: WORKER_ID,
    hostId: HOST_ID,
    epoch: 7,
    acquiredAt: NOW,
    heartbeatAt: NOW,
    expiresAt: "2026-07-19T07:51:00.000Z",
    releasedAt: null,
    ...overrides,
  };
}

function workspaceLease(worktreePath: string): StoredRoomLeaseV1 {
  return {
    contractVersion: 1,
    id: `workspace-lease:${worktreePath}`,
    roomId: ROOM_ID,
    kind: "workspace",
    resourceId: worktreePath,
    holderId: WORKER_ID,
    hostId: HOST_ID,
    epoch: 3,
    acquiredAt: NOW,
    heartbeatAt: NOW,
    expiresAt: "2026-07-19T07:51:00.000Z",
    releasedAt: null,
  };
}

function request(overrides: Partial<{
  taskId: string;
  candidateId: string;
  bindingId: string;
  bindingGeneration: number;
  nodeId: string;
  parentNodeId: string | null;
  dagVersion: number;
  nodeVersion: number;
}> = {}) {
  const {
    taskId = "FN-room-workspace-a",
    candidateId = "candidate-a",
    bindingId = "binding-a",
    bindingGeneration = 1,
    nodeId = "node-a",
    parentNodeId = null,
    dagVersion = 4,
    nodeVersion = 2,
  } = overrides;
  return {
    roomId: ROOM_ID,
    taskId,
    candidateId,
    repositoryRoot: "G:\\repos\\fusion",
    worker: {
      lease: roomWorkerLease(),
    },
    binding: {
      seatId: "seat-a",
      bindingId,
      generation: bindingGeneration,
    },
    node: {
      nodeId,
      parentNodeId,
      dagVersion,
      nodeVersion,
      origin: { kind: "created" as const },
    },
  };
}

function createPrimitives(options: {
  readonly fence?: () => Promise<boolean>;
  readonly workspace?: (input: Parameters<RoomWorkspacePrimitives["acquireIsolatedWorkspace"]>[0]) => ReturnType<RoomWorkspacePrimitives["acquireIsolatedWorkspace"]>;
} = {}) {
  const observedBranchRequests: unknown[] = [];
  const observedWorkspaceRequests: unknown[] = [];
  const assertCurrentRoomWorker = vi.fn(options.fence ?? (async () => true));
  const ensureCandidateBranchGroup = vi.fn(async (input: Parameters<RoomWorkspacePrimitives["ensureCandidateBranchGroup"]>[0]) => {
    observedBranchRequests.push(input);
    return {
      id: `branch-group:${input.isolationKey}`,
      branchName: `fusion/${input.candidateId}`,
      isolationKey: input.isolationKey,
    };
  });
  const acquireIsolatedWorkspace = vi.fn(async (input: Parameters<RoomWorkspacePrimitives["acquireIsolatedWorkspace"]>[0]) => {
    observedWorkspaceRequests.push(input);
    if (options.workspace) return options.workspace(input);
    const worktreePath = `G:\\room-worktrees\\${input.candidateId}`;
    return {
      id: `room-workspace:${input.candidateId}`,
      isolationKey: input.isolationKey,
      branchGroupId: input.branchGroup.id,
      branchName: input.branchGroup.branchName,
      repositoryRoot: input.repositoryRoot,
      worktreePath,
      isIsolated: true,
      workspaceLease: workspaceLease(worktreePath),
    };
  });
  const releaseIsolatedWorkspace = vi.fn(async () => undefined);

  return {
    primitives: {
      assertCurrentRoomWorker,
      ensureCandidateBranchGroup,
      acquireIsolatedWorkspace,
      releaseIsolatedWorkspace,
    } satisfies RoomWorkspacePrimitives,
    assertCurrentRoomWorker,
    ensureCandidateBranchGroup,
    acquireIsolatedWorkspace,
    releaseIsolatedWorkspace,
    observedBranchRequests,
    observedWorkspaceRequests,
  };
}

function coordinator(primitives: RoomWorkspacePrimitives): RoomWorkspaceCoordinator {
  return new RoomWorkspaceCoordinator({
    projectId: PROJECT_ID,
    workerId: WORKER_ID,
    hostId: HOST_ID,
    primitives,
  });
}

describe("RoomWorkspaceCoordinator", () => {
  it("passes a current Room worker fence and frozen binding/node lineage to the primitive seam", async () => {
    const fake = createPrimitives();
    const input = request();

    const grant = await coordinator(fake.primitives).acquire(input);

    expect(fake.assertCurrentRoomWorker).toHaveBeenCalledTimes(3);
    expect(fake.ensureCandidateBranchGroup).toHaveBeenCalledTimes(1);
    expect(fake.acquireIsolatedWorkspace).toHaveBeenCalledTimes(1);
    const branchRequest = fake.observedBranchRequests[0] as {
      readonly roomId: string;
      readonly taskId: string;
      readonly worker: { readonly workerId: string; readonly hostId: string; readonly lease: StoredRoomLeaseV1 };
      readonly binding: { readonly bindingId: string; readonly generation: number };
      readonly node: { readonly nodeId: string; readonly dagVersion: number; readonly nodeVersion: number };
    };
    expect(branchRequest).toMatchObject({
      projectId: PROJECT_ID,
      roomId: ROOM_ID,
      taskId: "FN-room-workspace-a",
      worker: { workerId: WORKER_ID, hostId: HOST_ID, lease: { epoch: 7 } },
      binding: { bindingId: "binding-a", generation: 1 },
      node: { nodeId: "node-a", dagVersion: 4, nodeVersion: 2 },
    });
    expect(Object.isFrozen(branchRequest)).toBe(true);
    expect(Object.isFrozen(branchRequest.worker)).toBe(true);
    expect(Object.isFrozen(branchRequest.binding)).toBe(true);
    expect(Object.isFrozen(branchRequest.node)).toBe(true);
    expect(branchRequest.binding).not.toBe(input.binding);
    expect(branchRequest.node).not.toBe(input.node);
    expect(grant.workspace.worktreePath).toBe("G:\\room-worktrees\\candidate-a");
  });

  it("uses different branch-group isolation keys and worktrees for parallel task candidates", async () => {
    const fake = createPrimitives();
    const subject = coordinator(fake.primitives);

    const first = await subject.acquire(request({
      taskId: "FN-room-workspace-a",
      candidateId: "candidate-a",
      bindingId: "binding-a",
      nodeId: "node-a",
    }));
    const second = await subject.acquire(request({
      taskId: "FN-room-workspace-b",
      candidateId: "candidate-b",
      bindingId: "binding-b",
      bindingGeneration: 2,
      nodeId: "node-b",
      parentNodeId: "node-parent",
      dagVersion: 5,
      nodeVersion: 1,
    }));

    const branchRequests = fake.observedBranchRequests as Array<{
      readonly taskId: string;
      readonly candidateId: string;
      readonly isolationKey: string;
      readonly binding: { readonly bindingId: string; readonly generation: number };
      readonly node: { readonly nodeId: string; readonly parentNodeId: string | null; readonly dagVersion: number; readonly nodeVersion: number };
    }>;
    expect(branchRequests).toHaveLength(2);
    expect(branchRequests[0]).toMatchObject({
      taskId: "FN-room-workspace-a",
      candidateId: "candidate-a",
      binding: { bindingId: "binding-a", generation: 1 },
      node: { nodeId: "node-a", parentNodeId: null, dagVersion: 4, nodeVersion: 2 },
    });
    expect(branchRequests[1]).toMatchObject({
      taskId: "FN-room-workspace-b",
      candidateId: "candidate-b",
      binding: { bindingId: "binding-b", generation: 2 },
      node: { nodeId: "node-b", parentNodeId: "node-parent", dagVersion: 5, nodeVersion: 1 },
    });
    expect(first.isolationKey).not.toBe(second.isolationKey);
    expect(first.workspace.worktreePath).not.toBe(second.workspace.worktreePath);
    expect(branchRequests[0]?.isolationKey).toBe(first.isolationKey);
    expect(branchRequests[1]?.isolationKey).toBe(second.isolationKey);
  });

  it("fails closed before branch or workspace acquisition when the worker fence is no longer current", async () => {
    const fake = createPrimitives({ fence: async () => false });

    await expect(coordinator(fake.primitives).acquire(request())).rejects.toMatchObject({
      code: "room_workspace_worker_fence_rejected",
    });
    expect(fake.ensureCandidateBranchGroup).not.toHaveBeenCalled();
    expect(fake.acquireIsolatedWorkspace).not.toHaveBeenCalled();
  });

  it("fails closed for missing or unsafe workspace allocations", async () => {
    const missing = createPrimitives({ workspace: async () => null });
    await expect(coordinator(missing.primitives).acquire(request())).rejects.toMatchObject({
      code: "room_workspace_unavailable",
    });

    const unsafe = createPrimitives({
      workspace: async (input) => {
        const worktreePath = input.repositoryRoot;
        return {
          id: "unsafe-workspace",
          isolationKey: input.isolationKey,
          branchGroupId: input.branchGroup.id,
          branchName: input.branchGroup.branchName,
          repositoryRoot: input.repositoryRoot,
          worktreePath,
          isIsolated: false,
          workspaceLease: workspaceLease(worktreePath),
        };
      },
    });
    await expect(coordinator(unsafe.primitives).acquire(request())).rejects.toMatchObject({
      code: "room_workspace_unsafe",
    });
    expect(unsafe.releaseIsolatedWorkspace).not.toHaveBeenCalled();
  });

  it("does not invoke raw Git or checkout creation outside the injected primitive seam", async () => {
    const fake = createPrimitives();
    const rawGit = vi.fn(async () => {
      throw new Error("raw Git must not be called");
    });
    const rawCheckout = vi.fn(async () => {
      throw new Error("raw checkout creation must not be called");
    });
    const primitives = Object.assign(fake.primitives, {
      rawGit,
      createRawCheckout: rawCheckout,
    });

    await coordinator(primitives).acquire(request());

    expect(rawGit).not.toHaveBeenCalled();
    expect(rawCheckout).not.toHaveBeenCalled();
    expect(fake.acquireIsolatedWorkspace).toHaveBeenCalledTimes(1);
  });
});
