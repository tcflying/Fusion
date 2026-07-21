import { describe, expect, it, vi } from "vitest";

import type { StoredRoomLeaseV1 } from "@fusion/core";

import {
  FusionRoomWorkspacePrimitives,
  type FusionRoomWorkspaceAuthorityPorts,
} from "../fusion-room-workspace-primitives.js";
import type {
  RoomWorkspacePrimitiveContextV1,
  RoomWorkspacePrimitives,
} from "../room-workspace-coordinator.js";

const PROJECT_ID = "project-room-workspace";
const ROOM_ID = "room-workspace";
const WORKER_ID = "room-worker-1";
const HOST_ID = "windows-node-1";
const AGENT_ID = "fusion-agent-1";
const NOW = "2026-07-19T08:00:00.000Z";
const ROOT = "G:\\repos\\fusion";
const WORKTREE = "G:\\room-worktrees\\candidate-a";

function lease(input: {
  readonly id: string;
  readonly kind: "room_worker" | "workspace";
  readonly resourceId: string;
  readonly holderId: string;
  readonly epoch: number;
}): StoredRoomLeaseV1 {
  return {
    contractVersion: 1,
    id: input.id,
    roomId: ROOM_ID,
    kind: input.kind,
    resourceId: input.resourceId,
    holderId: input.holderId,
    hostId: HOST_ID,
    epoch: input.epoch,
    acquiredAt: NOW,
    heartbeatAt: NOW,
    expiresAt: "2026-07-19T08:10:00.000Z",
    releasedAt: null,
  };
}

function context(): RoomWorkspacePrimitiveContextV1 {
  return {
    projectId: PROJECT_ID,
    roomId: ROOM_ID,
    taskId: "task-a",
    candidateId: "candidate-a",
    repositoryRoot: ROOT,
    worker: {
      workerId: WORKER_ID,
      hostId: HOST_ID,
      lease: lease({
        id: "room-worker-lease-a",
        kind: "room_worker",
        resourceId: ROOM_ID,
        holderId: WORKER_ID,
        epoch: 7,
      }),
    },
    binding: { seatId: "seat-a", bindingId: "binding-a", generation: 1 },
    node: {
      nodeId: "node-a",
      parentNodeId: null,
      dagVersion: 2,
      nodeVersion: 3,
      origin: { kind: "created" },
    },
    isolationKey: "room-workspace/v1:opaque-candidate-a",
  };
}

function createPorts(overrides: Partial<FusionRoomWorkspaceAuthorityPorts> = {}) {
  const authorized = {
    allocationId: "allocation-a",
    isolationKey: context().isolationKey,
    branchGroupId: "branch-group-a",
    branchName: "fusion/room/candidate-a",
    repositoryRoot: ROOT,
    worktreePath: WORKTREE,
    checkout: { agentId: AGENT_ID, taskId: "task-a", nodeId: "executor-node-a", runId: "run-a", epoch: 9 },
  };
  const assertCurrentRoomWorker = vi.fn(async () => true);
  const getAuthorizedCandidateWorkspace = vi.fn(async () => authorized);
  const assertTaskCheckout = vi.fn(async () => true);
  const acquireWorkspaceLease = vi.fn(async () => lease({
    id: "workspace-lease-a",
    kind: "workspace",
    resourceId: WORKTREE,
    holderId: WORKER_ID,
    epoch: 4,
  }));
  const acquireCandidateWorktree = vi.fn(async () => ({
    id: "worktree-a",
    isolationKey: context().isolationKey,
    branchGroupId: "branch-group-a",
    branchName: "fusion/room/candidate-a",
    repositoryRoot: ROOT,
    worktreePath: WORKTREE,
    isIsolated: true,
  }));
  const releaseCandidateWorktree = vi.fn(async () => undefined);
  const releaseWorkspaceLease = vi.fn(async () => undefined);
  return {
    ports: {
      assertCurrentRoomWorker,
      getAuthorizedCandidateWorkspace,
      assertTaskCheckout,
      acquireWorkspaceLease,
      acquireCandidateWorktree,
      releaseCandidateWorktree,
      releaseWorkspaceLease,
      ...overrides,
    } satisfies FusionRoomWorkspaceAuthorityPorts,
    authorized,
    assertCurrentRoomWorker,
    getAuthorizedCandidateWorkspace,
    assertTaskCheckout,
    acquireWorkspaceLease,
    acquireCandidateWorktree,
    releaseCandidateWorktree,
    releaseWorkspaceLease,
  };
}

function subject(ports: FusionRoomWorkspaceAuthorityPorts): RoomWorkspacePrimitives {
  return new FusionRoomWorkspacePrimitives({ ports });
}

describe("FusionRoomWorkspacePrimitives", () => {
  it("grants only a persisted candidate path after posture, checkout, and independent workspace fences pass", async () => {
    const fake = createPorts();
    const primitives = subject(fake.ports);
    const input = context();

    expect(await primitives.assertCurrentRoomWorker(input)).toBe(true);
    const branchGroup = await primitives.ensureCandidateBranchGroup(input);
    const allocation = await primitives.acquireIsolatedWorkspace({ ...input, branchGroup: branchGroup! });

    expect(branchGroup).toMatchObject({ id: "branch-group-a", isolationKey: input.isolationKey });
    expect(allocation).toMatchObject({
      worktreePath: WORKTREE,
      branchGroupId: "branch-group-a",
      workspaceLease: { kind: "workspace", resourceId: WORKTREE, holderId: WORKER_ID, epoch: 4 },
    });
    expect(fake.assertCurrentRoomWorker).toHaveBeenCalled();
    expect(fake.assertTaskCheckout).toHaveBeenCalledWith(expect.objectContaining({
      context: expect.objectContaining({ roomId: ROOM_ID, taskId: "task-a" }),
      checkout: expect.objectContaining({ agentId: AGENT_ID, epoch: 9 }),
    }));
    expect(fake.acquireWorkspaceLease).toHaveBeenCalledWith(expect.objectContaining({
      resourceId: WORKTREE,
      holderId: WORKER_ID,
      expectedRoomWorkerEpoch: 7,
    }));
    expect(fake.acquireCandidateWorktree).toHaveBeenCalledWith(expect.objectContaining({
      authorization: expect.objectContaining({ allocationId: "allocation-a", worktreePath: WORKTREE }),
    }));
  });

  it("refuses an unpersisted candidate path before checkout, lease, or worktree acquisition", async () => {
    const fake = createPorts();
    fake.getAuthorizedCandidateWorkspace
      .mockResolvedValueOnce(fake.authorized)
      .mockResolvedValueOnce({
        ...fake.authorized,
        worktreePath: "G:\\room-worktrees\\other-candidate",
      });
    const primitives = subject(fake.ports);
    const input = context();

    const group = await primitives.ensureCandidateBranchGroup(input);
    await expect(primitives.acquireIsolatedWorkspace({ ...input, branchGroup: group! })).resolves.toBeNull();
    expect(fake.assertTaskCheckout).not.toHaveBeenCalled();
    expect(fake.acquireWorkspaceLease).not.toHaveBeenCalled();
    expect(fake.acquireCandidateWorktree).not.toHaveBeenCalled();
  });

  it("refuses a Room worker id forged as an agent checkout identity", async () => {
    const fake = createPorts({
      getAuthorizedCandidateWorkspace: async () => ({
        ...createPorts().authorized,
        checkout: { agentId: WORKER_ID, taskId: "task-a", nodeId: "executor-node-a", runId: "run-a", epoch: 9 },
      }),
    });
    const primitives = subject(fake.ports);
    const input = context();

    const group = await primitives.ensureCandidateBranchGroup(input);
    await expect(primitives.acquireIsolatedWorkspace({ ...input, branchGroup: group! })).resolves.toBeNull();
    expect(fake.assertTaskCheckout).not.toHaveBeenCalled();
    expect(fake.acquireWorkspaceLease).not.toHaveBeenCalled();
  });

  it("fails closed when the Room posture fence rejects the worker", async () => {
    const fake = createPorts({ assertCurrentRoomWorker: async () => false });
    const primitives = subject(fake.ports);

    await expect(primitives.assertCurrentRoomWorker(context())).resolves.toBe(false);
    expect(fake.getAuthorizedCandidateWorkspace).not.toHaveBeenCalled();
    expect(fake.assertTaskCheckout).not.toHaveBeenCalled();
  });
});
