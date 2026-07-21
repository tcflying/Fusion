import { describe, expect, it } from "vitest";

import {
  bootstrapRoomSessionConnectors,
  evaluateRoomSessionConnectorBootstrap,
} from "../in-process-runtime.js";

describe("InProcessRuntime Room Session Connector bootstrap", () => {
  it("withholds a selected connector until an enabled plugin has actually loaded its registration", () => {
    const status = evaluateRoomSessionConnectorBootstrap({
      requiredConnectorIds: ["happier"],
      loadedConnectorRegistrations: [],
    });

    expect(status).toEqual({
      state: "withheld",
      reasonCode: "required_session_connector_not_loaded",
      requiredConnectorIds: ["happier"],
      loadedConnectorIds: [],
      missingConnectorIds: ["happier"],
    });
  });

  it("accepts a Room only after every selected connector is present in the loaded registration set", () => {
    const status = evaluateRoomSessionConnectorBootstrap({
      requiredConnectorIds: ["claude", "happier"],
      loadedConnectorRegistrations: [
        { pluginId: "fusion-plugin-happier-runtime", connectorId: "happier" },
        { pluginId: "fusion-plugin-claude-runtime", connectorId: "claude" },
      ],
    });

    expect(status).toEqual({
      state: "ready",
      reasonCode: null,
      requiredConnectorIds: ["claude", "happier"],
      loadedConnectorIds: ["claude", "happier"],
      missingConnectorIds: [],
    });
  });

  it("does not impose a connector requirement before a Room host policy selects one", () => {
    const status = evaluateRoomSessionConnectorBootstrap({
      requiredConnectorIds: [],
      loadedConnectorRegistrations: [
        { pluginId: "fusion-plugin-happier-runtime", connectorId: "happier" },
      ],
    });

    expect(status).toEqual({
      state: "not_required",
      reasonCode: null,
      requiredConnectorIds: [],
      loadedConnectorIds: ["happier"],
      missingConnectorIds: [],
    });
  });

  it("resolves the selected connectors before loading plugins and withholds when init leaves one unloaded", async () => {
    const calls: string[] = [];
    const pluginRunner = {
      init: async () => {
        calls.push("runner.init");
      },
      getPluginSessionConnectors: () => {
        calls.push("runner.loaded-registrations");
        return [];
      },
      getStore: () => ({
        getPlugin: async () => {
          calls.push("store.get-plugin");
          throw new Error("not reached without a loaded registration");
        },
      }),
    };

    const status = await bootstrapRoomSessionConnectors({
      resolveRequiredConnectorIds: async () => {
        calls.push("policy.read");
        return ["happier"];
      },
      pluginRunner,
    });

    expect(calls).toEqual([
      "policy.read",
      "runner.init",
      "runner.loaded-registrations",
    ]);
    expect(status).toMatchObject({
      state: "withheld",
      reasonCode: "required_session_connector_not_loaded",
      missingConnectorIds: ["happier"],
    });
  });

  it("withholds a bundled connector registration when its installed plugin is disabled", async () => {
    const calls: string[] = [];
    const pluginRunner = {
      init: async () => {
        calls.push("runner.init");
      },
      getPluginSessionConnectors: () => {
        calls.push("runner.loaded-registrations");
        return [{
          pluginId: "fusion-plugin-happier-runtime",
          sessionConnector: { metadata: { connectorId: "happier" } },
        }];
      },
      getStore: () => ({
        getPlugin: async (pluginId: string) => {
          calls.push(`store.get-plugin:${pluginId}`);
          return { id: pluginId, enabled: false };
        },
      }),
    };

    const status = await bootstrapRoomSessionConnectors({
      resolveRequiredConnectorIds: async () => ["happier"],
      pluginRunner,
    });

    expect(calls).toEqual([
      "runner.init",
      "runner.loaded-registrations",
      "store.get-plugin:fusion-plugin-happier-runtime",
    ]);
    expect(status).toMatchObject({
      state: "withheld",
      reasonCode: "required_session_connector_not_loaded",
      missingConnectorIds: ["happier"],
    });
  });

  it("withholds a selected registration when the PluginStore cannot prove its install record", async () => {
    const pluginRunner = {
      init: async () => undefined,
      getPluginSessionConnectors: () => [{
        pluginId: "fusion-plugin-happier-runtime",
        sessionConnector: { metadata: { connectorId: "happier" } },
      }],
      getStore: () => ({
        getPlugin: async () => {
          throw new Error('Plugin "fusion-plugin-happier-runtime" not found');
        },
      }),
    };

    const status = await bootstrapRoomSessionConnectors({
      resolveRequiredConnectorIds: async () => ["happier"],
      pluginRunner,
    });

    expect(status).toMatchObject({
      state: "withheld",
      reasonCode: "required_session_connector_not_loaded",
      missingConnectorIds: ["happier"],
    });
  });
});
