import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  function makeConstructibleMock<T extends (...args: any[]) => unknown>(impl?: T) {
    const mock = vi.fn(function () {});
    const originalMockImplementation = mock.mockImplementation.bind(mock);
    const wrap = (nextImpl: T) => function (this: unknown, ...args: Parameters<T>) {
      return nextImpl(...args);
    };
    mock.mockImplementation = ((nextImpl: T) => originalMockImplementation(wrap(nextImpl))) as typeof mock.mockImplementation;
    if (impl) {
      mock.mockImplementation(impl);
    }
    return mock;
  }

  const mockCentralInit = vi.fn();
  const mockCentralClose = vi.fn();
  const mockHostInstall = vi.fn();
  const mockHostRevoke = vi.fn();
  const mockCapacityInstall = vi.fn();
  const mockCapacityUpdate = vi.fn();
  const mockBackendShutdown = vi.fn();
  const mockCreateTaskStoreForBackend = vi.fn();
  return {
    CentralCore: makeConstructibleMock(() => ({
      init: mockCentralInit,
      close: mockCentralClose,
      installRoomHostCompositionOperatorPolicyAuthorityV1: mockHostInstall,
      revokeRoomHostCompositionOperatorPolicyAuthorityV1: mockHostRevoke,
      installGlobalCapacityPolicyAuthorityV1: mockCapacityInstall,
      updateGlobalCapacityPolicyAuthorityV1: mockCapacityUpdate,
    })),
    mockCentralInit,
    mockCentralClose,
    mockHostInstall,
    mockHostRevoke,
    mockCapacityInstall,
    mockCapacityUpdate,
    mockBackendShutdown,
    mockCreateTaskStoreForBackend,
  };
});

vi.mock("@fusion/core", () => ({
  CentralCore: mocks.CentralCore,
  createTaskStoreForBackend: mocks.mockCreateTaskStoreForBackend,
}));

import {
  RoomControlPlanePolicyCommandError,
  parseRoomControlPlanePolicyCommandArgs,
  runRoomControlPlanePolicy,
} from "../room-control-plane.js";

const HOST_INSTALL = {
  projectId: "project-1",
  hostId: "windows-host-1",
  expectedRevision: 0,
  bundleId: "windows-happier-bundle-1",
  issuer: "operator-1",
  expiresAt: "2030-01-01T00:00:00.000Z",
  policy: {
    connectorIds: ["happier"],
    controllerAdmission: {
      workClass: "normal",
      slots: 4,
    },
    adapterBindings: {
      capabilityObservationAdapterId: "windows-happier-capability-v1",
      providerAdmissionSnapshotAdapterId: "windows-happier-provider-admission-v1",
      capacityTelemetryAdapterId: "windows-happier-capacity-telemetry-v1",
      roomWorkerAuthorityAdapterId: "windows-room-worker-authority-v1",
    },
  },
} as const;

const HOST_REVOKE = {
  projectId: "project-1",
  hostId: "windows-host-1",
  expectedRevision: 1,
  reason: "operator_requested",
} as const;

const CAPACITY_INSTALL = {
  expectedRevision: 0,
  policy: {
    reservations: {
      verifierSlots: 2,
      recoverySlots: 1,
      legacyTaskTriageSlots: 1,
    },
    snapshotTtlMs: 30_000,
    leaseTtlMs: 60_000,
  },
} as const;

describe("room-control-plane policy commands", () => {
  let tempDir: string;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    vi.clearAllMocks();
    tempDir = await mkdtemp(join(tmpdir(), "fusion-room-policy-cli-"));
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    mocks.mockCentralInit.mockResolvedValue(undefined);
    mocks.mockCentralClose.mockResolvedValue(undefined);
    mocks.mockBackendShutdown.mockResolvedValue(undefined);
    mocks.mockCreateTaskStoreForBackend.mockResolvedValue({
      taskStore: {},
      asyncLayer: { projectId: "project-1" },
      hostAsyncLayer: { projectId: undefined },
      shutdown: mocks.mockBackendShutdown,
    });
    mocks.mockHostInstall.mockResolvedValue({
      revision: 1,
      policyHash: "host-policy-hash",
      expiresAt: HOST_INSTALL.expiresAt,
    });
    mocks.mockHostRevoke.mockResolvedValue({
      revision: 2,
      policyHash: "host-policy-hash",
      revokedAt: "2029-01-01T00:00:00.000Z",
    });
    mocks.mockCapacityInstall.mockResolvedValue({
      revision: 1,
      policyHash: "capacity-policy-hash",
      updatedAt: "2029-01-01T00:00:00.000Z",
    });
    mocks.mockCapacityUpdate.mockResolvedValue({
      revision: 2,
      policyHash: "capacity-policy-hash-2",
      updatedAt: "2029-01-02T00:00:00.000Z",
    });
  });

  afterEach(async () => {
    logSpy.mockRestore();
    await rm(tempDir, { recursive: true, force: true });
  });

  async function writeInput(name: string, input: unknown): Promise<string> {
    const file = join(tempDir, name);
    await writeFile(file, JSON.stringify(input), "utf8");
    return file;
  }

  it("parses only an explicit supported command and exactly one file", () => {
    expect(parseRoomControlPlanePolicyCommandArgs([
      "host-policy",
      "install",
      "--file",
      "policy.json",
    ])).toEqual({ action: "host-install", file: "policy.json" });
    expect(() => parseRoomControlPlanePolicyCommandArgs([
      "host-policy",
      "install",
      "--file",
      "policy.json",
      "--file",
      "other.json",
    ])).toThrow(new RoomControlPlanePolicyCommandError("Room control-plane policy command requires exactly one --file input"));
    expect(() => parseRoomControlPlanePolicyCommandArgs([
      "host-policy",
      "install",
      "--expires-at",
      HOST_INSTALL.expiresAt,
    ])).toThrow(new RoomControlPlanePolicyCommandError("Room control-plane policy command requires exactly one --file input"));
  });

  it("installs a canonical host policy through the unscoped CentralCore authority only", async () => {
    const file = await writeInput("host-install.json", HOST_INSTALL);

    await runRoomControlPlanePolicy({ action: "host-install", file, rootDir: tempDir });

    expect(mocks.mockCreateTaskStoreForBackend).toHaveBeenCalledWith({ rootDir: tempDir });
    expect(mocks.mockHostInstall).toHaveBeenCalledWith(HOST_INSTALL);
    expect(mocks.mockCapacityInstall).not.toHaveBeenCalled();
    expect(mocks.mockCentralClose).toHaveBeenCalledTimes(1);
    expect(mocks.mockBackendShutdown).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(logSpy.mock.calls[0]?.[0]))).toEqual({
      action: "host-install",
      authority: "room-host-composition",
      revision: 1,
      policyHash: "host-policy-hash",
      expiresAt: HOST_INSTALL.expiresAt,
    });
  });

  it("rejects provider facts, unsorted connector IDs, and expired host authority before booting a CentralCore", async () => {
    const providerFact = await writeInput("provider-fact.json", {
      ...HOST_INSTALL,
      provider: "should-not-be-here",
    });
    const unsorted = await writeInput("unsorted.json", {
      ...HOST_INSTALL,
      policy: { ...HOST_INSTALL.policy, connectorIds: ["z", "a"] },
    });
    const expired = await writeInput("expired.json", {
      ...HOST_INSTALL,
      expiresAt: "2020-01-01T00:00:00.000Z",
    });

    await expect(runRoomControlPlanePolicy({ action: "host-install", file: providerFact, rootDir: tempDir }))
      .rejects.toThrow(new RoomControlPlanePolicyCommandError("Room host policy input is invalid"));
    await expect(runRoomControlPlanePolicy({ action: "host-install", file: unsorted, rootDir: tempDir }))
      .rejects.toThrow(new RoomControlPlanePolicyCommandError("Room host policy input is invalid"));
    await expect(runRoomControlPlanePolicy({ action: "host-install", file: expired, rootDir: tempDir }))
      .rejects.toThrow(new RoomControlPlanePolicyCommandError("Room host policy input is invalid"));

    expect(mocks.mockCreateTaskStoreForBackend).not.toHaveBeenCalled();
    expect(mocks.mockHostInstall).not.toHaveBeenCalled();
  });

  it("reuses only the immutable host revoke authority and preserves the exact requested revision", async () => {
    const file = await writeInput("host-revoke.json", HOST_REVOKE);

    await runRoomControlPlanePolicy({ action: "host-revoke", file, rootDir: tempDir });

    expect(mocks.mockHostRevoke).toHaveBeenCalledWith(HOST_REVOKE);
    expect(mocks.mockHostInstall).not.toHaveBeenCalled();
    expect(JSON.parse(String(logSpy.mock.calls[0]?.[0]))).toEqual({
      action: "host-revoke",
      authority: "room-host-composition",
      revision: 2,
      policyHash: "host-policy-hash",
    });
  });

  it("installs and updates capacity only from a complete canonical policy file", async () => {
    const install = await writeInput("capacity-install.json", CAPACITY_INSTALL);
    const update = await writeInput("capacity-update.json", {
      ...CAPACITY_INSTALL,
      expectedRevision: 1,
      policy: { ...CAPACITY_INSTALL.policy, snapshotTtlMs: 45_000 },
    });

    await runRoomControlPlanePolicy({ action: "capacity-install", file: install, rootDir: tempDir });
    await runRoomControlPlanePolicy({ action: "capacity-update", file: update, rootDir: tempDir });

    expect(mocks.mockCapacityInstall).toHaveBeenCalledWith(CAPACITY_INSTALL);
    expect(mocks.mockCapacityUpdate).toHaveBeenCalledWith({
      expectedRevision: 1,
      policy: { ...CAPACITY_INSTALL.policy, snapshotTtlMs: 45_000 },
    });
  });

  it("redacts backend and authority failures instead of exposing source paths or credentials", async () => {
    const file = await writeInput("host-install.json", HOST_INSTALL);
    mocks.mockCreateTaskStoreForBackend.mockRejectedValueOnce(new Error("postgres://operator:super-secret@example.test/fusion"));

    await expect(runRoomControlPlanePolicy({ action: "host-install", file, rootDir: tempDir }))
      .rejects.toThrow(new RoomControlPlanePolicyCommandError("Room control-plane policy authority is unavailable"));
    await expect(runRoomControlPlanePolicy({ action: "host-install", file: join(tempDir, "missing.json"), rootDir: tempDir }))
      .rejects.toThrow(new RoomControlPlanePolicyCommandError("Room control-plane policy input could not be read"));

    mocks.mockHostInstall.mockRejectedValueOnce(new Error("authorization failed for postgres://operator:super-secret@example.test/fusion"));
    await expect(runRoomControlPlanePolicy({ action: "host-install", file, rootDir: tempDir }))
      .rejects.toThrow(new RoomControlPlanePolicyCommandError("Room control-plane policy authority rejected the requested operation"));
  });

  it("fails closed when the backend does not expose the canonical unscoped host layer", async () => {
    const file = await writeInput("host-install.json", HOST_INSTALL);
    mocks.mockCreateTaskStoreForBackend.mockResolvedValueOnce({
      taskStore: {},
      asyncLayer: { projectId: "project-1" },
      hostAsyncLayer: undefined,
      shutdown: mocks.mockBackendShutdown,
    });

    await expect(runRoomControlPlanePolicy({ action: "host-install", file, rootDir: tempDir }))
      .rejects.toThrow(new RoomControlPlanePolicyCommandError("Room control-plane policy authority is unavailable"));

    expect(mocks.mockHostInstall).not.toHaveBeenCalled();
  });
});
