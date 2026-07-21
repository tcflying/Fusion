import { describe, expect, it, vi } from "vitest";

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
  FusionRoomWorkspaceRuntime,
  type FusionRoomWorkspaceAuthorityStore,
  type PrepareFusionRoomWorkspaceInputV1,
} from "../fusion-room-workspace-runtime.js";

const PROJECT_ID = "project-room-workspace-runtime";
const ROOM_ID = "room-workspace-runtime";
const ROOT = "G:\\repos\\fusion";
const WORKER_ID = "room-worker-runtime";
const HOST_ID = "windows-host-runtime";
const NOW = "2026-07-19T09:00:00.000Z";

function roomWorkerLease(overrides: Partial<StoredRoomLeaseV1> = {}): StoredRoomLeaseV1 {
  return {
    contractVersion: 1,
    id: "room-worker-lease-runtime",
    roomId: ROOM_ID,
    kind: "room_worker",
    resourceId: ROOM_ID,
    holderId: WORKER_ID,
    hostId: HOST_ID,
    epoch: 7,
    acquiredAt: NOW,
    heartbeatAt: NOW,
    expiresAt: "2026-07-19T09:10:00.000Z",
    releasedAt: null,
    ...overrides,
  };
}

function task(id: string, overrides: Partial<Task> = {}): Task {
  return {
    id,
    column: "todo",
    branch: null,
    worktree: null,
    branchContext: undefined,
    checkedOutBy: null,
    checkoutNodeId: null,
    checkoutRunId: null,
    checkoutLeaseEpoch: 0,
    ...overrides,
  } as unknown as Task;
}

function input(
  taskId: string,
  candidateId: string,
  agentId = "fusion-agent-runtime",
): PrepareFusionRoomWorkspaceInputV1 {
  return {
    workspace: {
      roomId: ROOM_ID,
      taskId,
      candidateId,
      repositoryRoot: ROOT,
      worker: { lease: roomWorkerLease() },
      binding: { seatId: "seat-runtime", bindingId: "binding-runtime", generation: 1 },
      node: {
        nodeId: `node-${candidateId}`,
        parentNodeId: null,
        dagVersion: 3,
        nodeVersion: 2,
        origin: { kind: "created" },
      },
    },
    checkout: {
      agentId,
      nodeId: `executor-${candidateId}`,
      runId: `run-${candidateId}`,
    },
  };
}

function fixture(initialTasks: readonly Task[]) {
  const tasks = new Map(initialTasks.map((candidate) => [candidate.id, { ...candidate }]));
  const groups = new Map<string, BranchGroup>();
  const activeWorkspaceLeases = new Map<string, StoredRoomLeaseV1>();
  let roomAuthorityCurrent = true;
  let groupSequence = 0;
  let workspaceEpoch = 0;

  const getTask = vi.fn(async (id: string) => tasks.get(id) ?? null);
  const getSettings = vi.fn(async () => ({
    worktreesDir: "G:\\room-worktrees",
  } as Settings));
  const updateTask = vi.fn(async (id: string, patch: Partial<Task>) => {
    const current = tasks.get(id);
    if (!current) throw new Error(`missing task ${id}`);
    const next = { ...current, ...patch } as Task;
    tasks.set(id, next);
    return next;
  });
  const ensureBranchGroupForSource = vi.fn(async (
    sourceType: BranchGroup["sourceType"],
    sourceId: string,
    init: Omit<Parameters<TaskStore["ensureBranchGroupForSource"]>[2], "sourceType" | "sourceId">,
  ) => {
    const existing = groups.get(sourceId);
    if (existing) return existing;
    const created: BranchGroup = {
      id: `BG-room-${++groupSequence}`,
      sourceType,
      sourceId,
      branchName: init.branchName,
      worktreePath: init.worktreePath,
      autoMerge: init.autoMerge ?? false,
      prState: init.prState ?? "none",
      status: init.status ?? "open",
      createdAt: Date.parse(NOW),
      updatedAt: Date.parse(NOW),
    };
    groups.set(sourceId, created);
    return created;
  });
  const getBranchGroupBySource = vi.fn(async (
    _sourceType: BranchGroup["sourceType"],
    sourceId: string,
  ) => groups.get(sourceId) ?? null);
  const updateBranchGroup = vi.fn(async (id: string, patch: Partial<BranchGroup>) => {
    const current = [...groups.values()].find((candidate) => candidate.id === id);
    if (!current) throw new Error(`missing group ${id}`);
    const updated = { ...current, ...patch, updatedAt: Date.parse(NOW) } as BranchGroup;
    groups.set(updated.sourceId, updated);
    return updated;
  });
  const taskStore = {
    getTask,
    getSettings,
    updateTask,
    ensureBranchGroupForSource,
    getBranchGroupBySource,
    updateBranchGroup,
  } as unknown as Pick<
    TaskStore,
    "getTask" | "getSettings" | "updateTask" | "ensureBranchGroupForSource" | "getBranchGroupBySource" | "updateBranchGroup"
  >;

  const checkoutTask = vi.fn(async (
    agentId: string,
    taskId: string,
    context?: { nodeId?: string; runId?: string; leaseEpoch?: number },
  ) => {
    const current = tasks.get(taskId);
    if (!current) throw new Error(`missing task ${taskId}`);
    if (current.checkedOutBy && current.checkedOutBy !== agentId) throw new Error("checkout conflict");
    const renewal = current.checkedOutBy === agentId
      && current.checkoutNodeId === context?.nodeId
      && context?.leaseEpoch === current.checkoutLeaseEpoch;
    const next = {
      ...current,
      checkedOutBy: agentId,
      checkoutNodeId: context?.nodeId ?? null,
      checkoutRunId: context?.runId ?? null,
      checkoutLeaseEpoch: renewal ? current.checkoutLeaseEpoch : (current.checkoutLeaseEpoch ?? 0) + 1,
    } as Task;
    tasks.set(taskId, next);
    return next;
  });
  const agentStore = { checkoutTask } as unknown as Pick<AgentStore, "checkoutTask">;

  const roomStore: FusionRoomWorkspaceAuthorityStore = {
    getRoom: vi.fn(async (roomId) => roomId === ROOM_ID ? {
      room: { id: ROOM_ID, projectId: PROJECT_ID, aggregateVersion: 11 },
    } : null),
    assertWorkerAuthority: vi.fn(async ({ lease }) => {
      if (!roomAuthorityCurrent) throw new Error("room worker was superseded");
      if (lease.id !== roomWorkerLease().id || lease.epoch !== roomWorkerLease().epoch) {
        throw new Error("wrong room worker lease");
      }
      return { lease };
    }),
  };

  const leaseStore = {
    getActiveLease: vi.fn(async (_kind: string, resourceId: string) => activeWorkspaceLeases.get(resourceId) ?? null),
    acquireLease: vi.fn(async (request: {
      leaseId: string;
      roomId: string;
      kind: "workspace";
      resourceId: string;
      holderId: string;
      hostId: string;
      expectedEpoch: number | null;
      now: string;
      expiresAt: string;
    }) => {
      const current = activeWorkspaceLeases.get(request.resourceId);
      if (current && Date.parse(current.expiresAt) > Date.parse(request.now)) {
        return { ok: false as const, reason: "active" as const, current };
      }
      if (current && request.expectedEpoch !== current.epoch) {
        return { ok: false as const, reason: "stale_epoch" as const, current };
      }
      const lease: StoredRoomLeaseV1 = {
        contractVersion: 1,
        id: request.leaseId,
        roomId: request.roomId,
        kind: "workspace",
        resourceId: request.resourceId,
        holderId: request.holderId,
        hostId: request.hostId,
        epoch: ++workspaceEpoch,
        acquiredAt: request.now,
        heartbeatAt: request.now,
        expiresAt: request.expiresAt,
        releasedAt: null,
      };
      activeWorkspaceLeases.set(request.resourceId, lease);
      return { ok: true as const, action: "acquired" as const, lease };
    }),
    assertFence: vi.fn(async (request: {
      leaseId: string;
      resourceId: string;
      expectedEpoch: number;
    }) => {
      const current = activeWorkspaceLeases.get(request.resourceId);
      if (!current || current.id !== request.leaseId || current.epoch !== request.expectedEpoch) {
        throw new Error("stale workspace lease");
      }
      return current;
    }),
    releaseLease: vi.fn(async (request: {
      leaseId: string;
      resourceId: string;
      expectedEpoch: number;
    }) => {
      const current = activeWorkspaceLeases.get(request.resourceId);
      if (!current || current.id !== request.leaseId || current.epoch !== request.expectedEpoch) {
        return { ok: false as const, reason: "stale_fence" as const, current: current ?? null };
      }
      activeWorkspaceLeases.delete(request.resourceId);
      return { ok: true as const, lease: { ...current, releasedAt: NOW } };
    }),
  } as unknown as Pick<AsyncRoomLeaseStore, "acquireLease" | "getActiveLease" | "assertFence" | "releaseLease">;

  const acquireTaskWorktree = vi.fn(async ({ task: current }: { task: Task }) => ({
    worktreePath: current.worktree!,
    branch: current.branch!,
    source: "fresh" as const,
    hydrated: false,
    isResume: false,
  }));
  const runtime = new FusionRoomWorkspaceRuntime({
    projectId: PROJECT_ID,
    workerId: WORKER_ID,
    hostId: HOST_ID,
    rootDir: ROOT,
    roomStore,
    leaseStore,
    taskStore,
    agentStore,
    now: () => NOW,
    acquireTaskWorktree: acquireTaskWorktree as typeof import("../worktree-acquisition.js").acquireTaskWorktree,
  });

  return {
    runtime,
    tasks,
    groups,
    activeWorkspaceLeases,
    checkoutTask,
    ensureBranchGroupForSource,
    acquireTaskWorktree,
    roomStore,
    setRoomAuthority: (value: boolean) => { roomAuthorityCurrent = value; },
  };
}

describe("FusionRoomWorkspaceRuntime", () => {
  it("uses real Fusion checkout, branch-group, worktree, and independent workspace lease seams for isolated candidates", async () => {
    const fake = fixture([task("FN-room-a"), task("FN-room-b")]);

    const [first, second] = await Promise.all([
      fake.runtime.prepare(input("FN-room-a", "candidate-a", "fusion-agent-a")),
      fake.runtime.prepare(input("FN-room-b", "candidate-b", "fusion-agent-b")),
    ]);

    expect(fake.checkoutTask).toHaveBeenCalledTimes(2);
    expect(fake.ensureBranchGroupForSource).toHaveBeenCalledTimes(2);
    expect(fake.acquireTaskWorktree).toHaveBeenCalledTimes(2);
    expect(first.allocation.branchName).not.toBe(second.allocation.branchName);
    expect(first.allocation.worktreePath).not.toBe(second.allocation.worktreePath);
    expect(first.workspace.workspace.workspaceLease.resourceId).toBe(first.allocation.worktreePath);
    expect(second.workspace.workspace.workspaceLease.resourceId).toBe(second.allocation.worktreePath);
    expect(fake.groups.size).toBe(2);

    const publication = await fake.runtime.assertPublicationAuthority(first);
    expect(publication).toMatchObject({
      taskId: "FN-room-a",
      candidateId: "candidate-a",
      worktreePath: first.allocation.worktreePath,
      checkout: { agentId: "fusion-agent-a", epoch: 1 },
    });
  });

  it("rejects a task already allocated to a different Room candidate before it can be checked out", async () => {
    const fake = fixture([task("FN-room-conflict", {
      branch: "fusion/other-room-candidate",
      worktree: "G:\\room-worktrees\\other-room-candidate",
    })]);

    await expect(fake.runtime.prepare(input("FN-room-conflict", "candidate-conflict"))).rejects.toMatchObject({
      code: "room_workspace_runtime_allocation_conflict",
    });
    expect(fake.checkoutTask).not.toHaveBeenCalled();
    expect(fake.acquireTaskWorktree).not.toHaveBeenCalled();
  });

  it("does not persist a candidate task layout when its deterministic branch group is conflicting", async () => {
    const fake = fixture([task("FN-room-group-conflict")]);
    fake.ensureBranchGroupForSource.mockResolvedValueOnce({
      id: "BG-conflicting",
      sourceType: "new-task",
      sourceId: "other-room-workspace-source",
      branchName: "fusion/room/other-candidate",
      worktreePath: "G:\\room-worktrees\\other-candidate",
      autoMerge: false,
      prState: "none",
      status: "open",
      createdAt: Date.parse(NOW),
      updatedAt: Date.parse(NOW),
    } as BranchGroup);

    await expect(
      fake.runtime.prepare(input("FN-room-group-conflict", "candidate-group-conflict")),
    ).rejects.toMatchObject({ code: "room_workspace_runtime_allocation_conflict" });
    expect(fake.tasks.get("FN-room-group-conflict")).toMatchObject({
      branch: null,
      worktree: null,
    });
    expect(fake.acquireTaskWorktree).not.toHaveBeenCalled();
  });

  it("withholds a guarded publication action when the Room worker is stale", async () => {
    const fake = fixture([task("FN-room-stale")]);
    const grant = await fake.runtime.prepare(input("FN-room-stale", "candidate-stale"));
    const action = vi.fn(async () => "must-not-run");

    fake.setRoomAuthority(false);
    await expect(fake.runtime.withPublicationAuthority(grant, action)).rejects.toMatchObject({
      code: "room_workspace_runtime_authority_rejected",
    });
    expect(action).not.toHaveBeenCalled();
  });

  it("withholds publication after an independent workspace lease has been replaced", async () => {
    const fake = fixture([task("FN-room-replaced")]);
    const grant = await fake.runtime.prepare(input("FN-room-replaced", "candidate-replaced"));
    const original = grant.workspace.workspace.workspaceLease;
    fake.activeWorkspaceLeases.set(original.resourceId, {
      ...original,
      id: "workspace-lease-replacement",
      holderId: "replacement-worker",
      epoch: original.epoch + 1,
    });

    await expect(fake.runtime.assertPublicationAuthority(grant)).rejects.toMatchObject({
      code: "room_workspace_runtime_publication_fence_rejected",
    });
  });

  it("releases only the exact workspace epoch held by the candidate grant", async () => {
    const fake = fixture([task("FN-room-release")]);
    const grant = await fake.runtime.prepare(input("FN-room-release", "candidate-release"));

    await expect(fake.runtime.release(grant)).resolves.toBe(true);
    expect(fake.activeWorkspaceLeases.has(grant.allocation.worktreePath)).toBe(false);
    await expect(fake.runtime.release(grant)).resolves.toBe(false);
  });

  it("uses a fresh append-only lease id when the same Room worker takes over its expired workspace", async () => {
    const fake = fixture([task("FN-room-expired")]);
    const first = await fake.runtime.prepare(input("FN-room-expired", "candidate-expired"));
    const original = first.workspace.workspace.workspaceLease;
    fake.activeWorkspaceLeases.set(original.resourceId, {
      ...original,
      expiresAt: "2026-07-19T08:59:59.000Z",
    });

    const second = await fake.runtime.prepare(input("FN-room-expired", "candidate-expired"));

    expect(second.workspace.workspace.workspaceLease).toMatchObject({ epoch: original.epoch + 1 });
    expect(second.workspace.workspace.workspaceLease.id).not.toBe(original.id);
    expect(original.id).toContain(":workspace:1");
    expect(second.workspace.workspace.workspaceLease.id).toContain(":workspace:2");
  });

  it("rejects a forged grant whose workspace lease points outside its allocated worktree", async () => {
    const fake = fixture([task("FN-room-forged-lease")]);
    const grant = await fake.runtime.prepare(input("FN-room-forged-lease", "candidate-forged-lease"));
    const forged = {
      ...grant,
      workspace: {
        ...grant.workspace,
        workspace: {
          ...grant.workspace.workspace,
          workspaceLease: {
            ...grant.workspace.workspace.workspaceLease,
            resourceId: "G:\\room-worktrees\\forged-worktree",
          },
        },
      },
    };

    await expect(fake.runtime.assertPublicationAuthority(forged)).rejects.toMatchObject({
      code: "room_workspace_runtime_invalid_request",
    });
  });
});
