import {
  createAsyncDataLayer,
  createConnectionSetFromUrl,
  AsyncRoomStore,
  TaskStore,
  type SessionConnectorIdentityV1,
} from "@fusion/core";
import { describe, expect, it } from "vitest";

import {
  createTaskStoreForTest,
  pgDescribe,
  type PgTestHarness,
} from "../../../core/src/__test-utils__/pg-test-harness.js";
import { HAPPIER_SESSION_CONNECTOR_ID } from "../../../../plugins/fusion-plugin-happier-runtime/src/session-connector-contract.js";
import { HappierSessionConnector } from "../../../../plugins/fusion-plugin-happier-runtime/src/session-connector-facade.js";
import type { HappierCliSettings } from "../../../../plugins/fusion-plugin-happier-runtime/src/types.js";
import { RoomParticipantRunTaskProjector } from "../room-participant-run-task-projection.js";
import { SessionConnectorRegistry } from "../session-connector-registry.js";

const LIVE_E2E_ENABLED =
  process.env.FUSION_HAPPIER_LIVE_RESTART_RESTORE_E2E === "1";
const liveE2EDescribe = LIVE_E2E_ENABLED ? pgDescribe : describe.skip;
const PROJECT_ID = "project-happier-live-restart-restore";
const ROOM_ID = "room-happier-live-restart-restore";
const OBSERVED_AT = "2026-07-27T09:05:00.000Z";
const CONNECTOR_ID = HAPPIER_SESSION_CONNECTOR_ID;

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(
      `${name} is required when FUSION_HAPPIER_LIVE_RESTART_RESTORE_E2E=1`,
    );
  }
  return value;
}

function externalBackend(url: string) {
  return {
    mode: "external" as const,
    runtimeUrl: url,
    migrationUrl: url,
    migrationUrlOverridden: false,
  };
}

function liveSettings(): HappierCliSettings {
  const serverProfileId = requiredEnv("FUSION_HAPPIER_E2E_SERVER_PROFILE_ID");
  const machineId = requiredEnv("FUSION_HAPPIER_E2E_MACHINE_ID");
  return {
    executable: requiredEnv("FUSION_HAPPIER_E2E_EXECUTABLE"),
    entrypoint: requiredEnv("FUSION_HAPPIER_E2E_ENTRYPOINT"),
    allowedCliRoots: [requiredEnv("FUSION_HAPPIER_E2E_CLI_ROOT")],
    homeDir: requiredEnv("FUSION_HAPPIER_E2E_HOME_DIR"),
    activeServerId: serverProfileId,
    serverUrl: requiredEnv("FUSION_HAPPIER_E2E_SERVER_URL"),
    backend: "codex",
    spawnTimeoutMs: 20_000,
    connectTimeoutMs: 20_000,
    toolTimeoutMs: 20_000,
    happierSessionBindings: [
      {
        canonicalSessionUri: requiredEnv("FUSION_HAPPIER_E2E_CANONICAL_URI_1"),
        happierSessionId: requiredEnv("FUSION_HAPPIER_E2E_SESSION_ID_1"),
        serverProfileId,
        machineId,
      },
      {
        canonicalSessionUri: requiredEnv("FUSION_HAPPIER_E2E_CANONICAL_URI_2"),
        happierSessionId: requiredEnv("FUSION_HAPPIER_E2E_SESSION_ID_2"),
        serverProfileId,
        machineId,
      },
    ],
  };
}

function createLiveConnector(settings: HappierCliSettings): HappierSessionConnector {
  return new HappierSessionConnector({ settings });
}

function registryWith(connector: HappierSessionConnector): SessionConnectorRegistry {
  const registry = new SessionConnectorRegistry();
  registry.register(connector);
  return registry;
}

function sessionRequests(settings: HappierCliSettings) {
  const bindings = settings.happierSessionBindings!;
  const hostId = requiredEnv("FUSION_HAPPIER_E2E_HOST_ID");
  const machineId = requiredEnv("FUSION_HAPPIER_E2E_MACHINE_ID");
  return bindings.map((binding, index) => ({
    seatId: `seat-happier-live-${index + 1}`,
    bindingId: `binding-happier-live-${index + 1}`,
    role: index === 0 ? "producer" : "reviewer",
    permissionScope: ["room:message"],
    connectorId: CONNECTOR_ID,
    canonicalSessionUri: binding.canonicalSessionUri,
    requiredHostId: hostId,
    requiredMachineId: machineId,
    idempotencyKey: `ensure-happier-live-${index + 1}`,
  }));
}

/*
 * FNXC:HappierPostgresRestartRestoreE2E 2026-07-27-17:05:
 * This opt-in test uses the checked-in real Happier connector, official MCP
 * reads, and an isolated real PostgreSQL database. It closes every first-run
 * store/pool, constructs a fresh connector/registry/store process generation,
 * and then restores the two exact persisted Sessions. CI stays explicit and
 * fail-closed unless the operator supplies authenticated live bindings.
 *
 * This is the connector identity + durable recovery boundary. It does not
 * replace SessionConnectorRegistry capability certification: an unavailable
 * ensureExisting certification must still withhold the higher-level
 * RoomExistingSessionSpine path rather than being bypassed in production.
 */
liveE2EDescribe("real Happier connector + PostgreSQL restart/restore", () => {
  it("restores exact Sessions and participant run/task state after all first-run stores close", async () => {
    const settings = liveSettings();
    const sessions = sessionRequests(settings);
    let harness: PgTestHarness | undefined;
    let firstTaskStore: TaskStore | undefined;
    let firstLayer: ReturnType<typeof createAsyncDataLayer> | undefined;
    let restartedTaskStore: TaskStore | undefined;
    let restartedLayer: ReturnType<typeof createAsyncDataLayer> | undefined;

    try {
      harness = await createTaskStoreForTest({
        prefix: "fusion_happier_restart_restore",
        copyFromGolden: true,
      });
      await harness.store.close();
      await harness.layer.close();

      const firstConnections = await createConnectionSetFromUrl(
        externalBackend(harness.testUrl),
        { poolMax: 4, connectTimeoutSeconds: 5 },
      );
      firstLayer = createAsyncDataLayer(firstConnections, { projectId: PROJECT_ID });
      firstTaskStore = new TaskStore(
        harness.rootDir,
        undefined,
        { asyncLayer: firstLayer },
      );
      await firstTaskStore.init();

      const firstConnector = createLiveConnector(settings);
      const firstRegistry = registryWith(firstConnector);
      expect(firstRegistry.get(CONNECTOR_ID)).toBe(firstConnector);
      const ensuredIdentities: SessionConnectorIdentityV1[] = [];
      for (const session of sessions) {
        const ensured = await firstConnector.ensureExisting({
          contractVersion: 1,
          canonicalSessionUri: session.canonicalSessionUri,
          requiredHostId: session.requiredHostId,
          requiredMachineId: session.requiredMachineId,
          idempotencyKey: session.idempotencyKey,
        });
        expect(ensured).toMatchObject({
          ok: true,
          value: {
            identity: {
              connectorId: CONNECTOR_ID,
              nativeSessionId: session.canonicalSessionUri.split("/").at(-1),
              happierSessionId: settings.happierSessionBindings!
                .find((binding) =>
                  binding.canonicalSessionUri === session.canonicalSessionUri
                )!.happierSessionId,
              serverProfileId: settings.activeServerId,
              machineId: session.requiredMachineId,
              hostId: session.requiredHostId,
            },
            createdLink: false,
            providerTurnStarted: false,
          },
        });
        if (!ensured.ok) {
          throw new Error(`Live Happier ensureExisting failed: ${ensured.error.code}`);
        }
        ensuredIdentities.push(ensured.value.identity);
      }

      const firstRoomStore = new AsyncRoomStore(firstLayer);
      const created = await firstRoomStore.createRoomWithExistingBindings({
        room: {
          id: ROOM_ID,
          objective: "Restore two exact live Happier Sessions after a Fusion restart",
          protocolId: "implementation",
          protocolVersion: 1,
        },
        participants: sessions.map((session, index) => {
          const identity = ensuredIdentities[index]!;
          return {
            seat: {
              id: session.seatId,
              role: session.role,
              permissionScope: [...session.permissionScope],
            },
            binding: {
              id: session.bindingId,
              connectorId: identity.connectorId,
              providerId: identity.providerId,
              nativeSessionId: identity.nativeSessionId,
              happierSessionId: identity.happierSessionId,
              serverProfileId: identity.serverProfileId,
              machineId: identity.machineId,
              hostId: identity.hostId,
            },
          };
        }),
        entryRoleAssignment: {
          capabilitySnapshot: {
            contractVersion: 1,
            snapshotId: "happier-live-restart-capabilities-r1",
            revision: 1,
            capturedAt: OBSERVED_AT,
            bindings: sessions.map((session) => ({
              bindingId: session.bindingId,
              availability: "eligible" as const,
              capabilityRevision: `happier-live-${session.bindingId}-r1`,
              capabilities: [
                { name: "source_read", state: "verified" as const },
                { name: "workspace_write", state: "verified" as const },
                { name: "test", state: "verified" as const },
              ],
            })),
          },
          constraints: {
            locks: [
              { roleId: "implementer", bindingId: sessions[0]!.bindingId },
            ],
            forbids: [],
          },
        },
        now: OBSERVED_AT,
      }, {
        eventId: "room-happier-live-restart-created",
        actorType: "system",
        actorId: "room-happier-live-restart-e2e",
        correlationId: "room-happier-live-restart",
        causationId: null,
        occurredAt: OBSERVED_AT,
      });

      const task = await firstTaskStore.createTask({
        description: "Own the live Happier participant projection",
      });
      const participantProjector = new RoomParticipantRunTaskProjector({
        projectId: PROJECT_ID,
        store: firstTaskStore,
      });
      for (const [index, operation] of (
        ["review", "plan", "delegate"] as const
      ).entries()) {
        await participantProjector.record({
          roomId: ROOM_ID,
          taskId: task.id,
          fusionRunId: "fusion-run-happier-live-1",
          fusionAgentId: "room-controller",
          operation,
          participantKey: `agent:live-${operation}`,
          participantState: "running",
          participantRunId: `happier-participant-live-${operation}-1`,
          bindingId: sessions[index % sessions.length]!.bindingId,
          observedAt: OBSERVED_AT,
          evidenceRef: `e2e://official-mcp/session-status/${operation}-running`,
        });
      }

      await firstTaskStore.close();
      firstTaskStore = undefined;
      await firstLayer.close();
      firstLayer = undefined;

      const restartedConnections = await createConnectionSetFromUrl(
        externalBackend(harness.testUrl),
        { poolMax: 4, connectTimeoutSeconds: 5 },
      );
      restartedLayer = createAsyncDataLayer(
        restartedConnections,
        { projectId: PROJECT_ID },
      );
      restartedTaskStore = new TaskStore(
        harness.rootDir,
        undefined,
        { asyncLayer: restartedLayer },
      );
      await restartedTaskStore.init();

      const restartedConnector = createLiveConnector(settings);
      const restartedRegistry = registryWith(restartedConnector);
      expect(restartedRegistry.get(CONNECTOR_ID)).toBe(restartedConnector);
      const restartedRoomStore = new AsyncRoomStore(restartedLayer);
      const restored = await restartedRoomStore.getRoom(ROOM_ID);
      expect(restored).toBeDefined();
      if (!restored) throw new Error("Restarted PostgreSQL Room projection was not restored");
      expect(restored.room.aggregateVersion).toBe(created.room.aggregateVersion);
      expect(restored.membershipVersion).toBe(created.membershipVersion);
      for (const session of sessions) {
        const ensured = await restartedConnector.ensureExisting({
          contractVersion: 1,
          canonicalSessionUri: session.canonicalSessionUri,
          requiredHostId: session.requiredHostId,
          requiredMachineId: session.requiredMachineId,
          idempotencyKey: `restart:${session.idempotencyKey}`,
        });
        expect(ensured).toMatchObject({
          ok: true,
          value: {
            createdLink: false,
            providerTurnStarted: false,
          },
        });
        if (!ensured.ok) {
          throw new Error(`Restarted Happier ensureExisting failed: ${ensured.error.code}`);
        }
        const restoredBinding = restored.bindings.find(
          (binding) => binding.id === session.bindingId,
        );
        expect(restoredBinding).toMatchObject(ensured.value.identity);
      }

      expect(restored.bindings.map((binding) => ({
        connectorId: binding.connectorId,
        providerId: binding.providerId,
        nativeSessionId: binding.nativeSessionId,
        happierSessionId: binding.happierSessionId,
        serverProfileId: binding.serverProfileId,
        machineId: binding.machineId,
        hostId: binding.hostId,
      })).toSorted((left, right) =>
        left.nativeSessionId.localeCompare(right.nativeSessionId)
      )).toEqual(
        sessions.map((session, index): SessionConnectorIdentityV1 => ({
          connectorId: CONNECTOR_ID,
          providerId: "codex",
          nativeSessionId: session.canonicalSessionUri.split("/").at(-1)!,
          happierSessionId: settings.happierSessionBindings![index]!.happierSessionId,
          serverProfileId: settings.activeServerId!,
          machineId: session.requiredMachineId,
          hostId: session.requiredHostId,
        })).toSorted((left, right) =>
          left.nativeSessionId.localeCompare(right.nativeSessionId)
        ),
      );

      const restoredTask = await restartedTaskStore.getTask(task.id);
      for (const operation of ["review", "plan", "delegate"] as const) {
        expect(restoredTask.log).toContainEqual(expect.objectContaining({
          action: `[room-participant] ${operation}/agent:live-${operation}: running`,
          runContext: {
            runId: "fusion-run-happier-live-1",
            agentId: "room-controller",
          },
        }));
      }
      const restoredRunAudit = await restartedTaskStore.getRunAuditEventsAsync({
        taskId: task.id,
        runId: "fusion-run-happier-live-1",
        mutationType: "task:log",
      });
      for (const operation of ["review", "plan", "delegate"] as const) {
        expect(restoredRunAudit).toContainEqual(expect.objectContaining({
          taskId: task.id,
          runId: "fusion-run-happier-live-1",
          mutationType: "task:log",
          metadata: expect.objectContaining({
            action: `[room-participant] ${operation}/agent:live-${operation}: running`,
          }),
        }));
      }
    } finally {
      await restartedTaskStore?.close().catch(() => undefined);
      await restartedLayer?.close().catch(() => undefined);
      await firstTaskStore?.close().catch(() => undefined);
      await firstLayer?.close().catch(() => undefined);
      await harness?.teardown();
    }
  }, 180_000);
});
