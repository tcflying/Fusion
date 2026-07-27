export type RoomSessionConnectorBootstrapStateV1 = "not_required" | "ready" | "withheld";

export interface RoomSessionConnectorBootstrapStatusV1 {
  readonly state: RoomSessionConnectorBootstrapStateV1;
  readonly reasonCode: "required_session_connector_not_loaded" | null;
  readonly requiredConnectorIds: readonly string[];
  readonly loadedConnectorIds: readonly string[];
  readonly missingConnectorIds: readonly string[];
}

export interface RoomSessionConnectorBootstrapInputV1 {
  readonly requiredConnectorIds: readonly string[];
  readonly loadedConnectorRegistrations: readonly Readonly<{
    pluginId: string;
    connectorId: string;
  }>[];
}

export interface RoomSessionConnectorBootstrapRunnerV1 {
  init(): Promise<void>;
  getPluginSessionConnectors(): readonly Readonly<{
    pluginId: string;
    sessionConnector: Readonly<{
      metadata: Readonly<{
        connectorId: string;
      }>;
    }>;
  }>[];
  getStore(): Readonly<{
    getPlugin(pluginId: string): Promise<Readonly<{
      id: string;
      enabled: boolean;
    }>>;
  }>;
}

export interface BootstrapRoomSessionConnectorsInputV1 {
  readonly resolveRequiredConnectorIds: () => Promise<readonly string[]>;
  readonly pluginRunner: RoomSessionConnectorBootstrapRunnerV1;
}

export function normalizeRoomSessionConnectorIds(ids: unknown): string[] {
  if (!Array.isArray(ids)) return [];
  return [...new Set(ids.filter((id): id is string => typeof id === "string" && id.length > 0))]
    .sort((left, right) => left.localeCompare(right));
}

/*
 * FNXC:RoomSessionConnectorBootstrap 2026-07-20-22:39:
 * A bundled manifest or persisted install record is not authority to use a
 * Session Connector. A Room-selected connector is usable only when its
 * installed plugin is still enabled and has loaded a registration; the check
 * completes before ProjectEngine can freeze the Room registry or start provider delivery.
 */
export function evaluateRoomSessionConnectorBootstrap(
  input: RoomSessionConnectorBootstrapInputV1,
): RoomSessionConnectorBootstrapStatusV1 {
  const requiredConnectorIds = normalizeRoomSessionConnectorIds(input.requiredConnectorIds);
  const loadedConnectorIds = normalizeRoomSessionConnectorIds(
    input.loadedConnectorRegistrations.map((registration) => registration.connectorId),
  );
  const missingConnectorIds = requiredConnectorIds.filter(
    (connectorId) => !loadedConnectorIds.includes(connectorId),
  );

  if (requiredConnectorIds.length === 0) {
    return {
      state: "not_required",
      reasonCode: null,
      requiredConnectorIds,
      loadedConnectorIds,
      missingConnectorIds,
    };
  }

  if (missingConnectorIds.length > 0) {
    return {
      state: "withheld",
      reasonCode: "required_session_connector_not_loaded",
      requiredConnectorIds,
      loadedConnectorIds,
      missingConnectorIds,
    };
  }

  return {
    state: "ready",
    reasonCode: null,
    requiredConnectorIds,
    loadedConnectorIds,
    missingConnectorIds,
  };
}

async function collectEnabledLoadedRoomSessionConnectors(
  pluginRunner: RoomSessionConnectorBootstrapRunnerV1,
): Promise<Array<{ pluginId: string; connectorId: string }>> {
  const registrations = pluginRunner.getPluginSessionConnectors();
  const verified = await Promise.all(registrations.map(async (registration) => {
    try {
      const installation = await pluginRunner.getStore().getPlugin(registration.pluginId);
      if (!installation.enabled || installation.id !== registration.pluginId) return null;
      return {
        pluginId: registration.pluginId,
        connectorId: registration.sessionConnector.metadata.connectorId,
      };
    } catch {
      // Missing install state is not equivalent to an enabled bundled manifest.
      return null;
    }
  }));
  return verified.filter(
    (registration): registration is { pluginId: string; connectorId: string } => registration !== null,
  );
}

export async function bootstrapRoomSessionConnectors(
  input: BootstrapRoomSessionConnectorsInputV1,
): Promise<RoomSessionConnectorBootstrapStatusV1> {
  const requiredConnectorIds = await input.resolveRequiredConnectorIds();
  await input.pluginRunner.init();
  return evaluateRoomSessionConnectorBootstrap({
    requiredConnectorIds,
    loadedConnectorRegistrations: await collectEnabledLoadedRoomSessionConnectors(input.pluginRunner),
  });
}
