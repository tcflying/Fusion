import type {
  SessionConnectorIdentityV1,
  SessionConnectorRuntimeSnapshotV1,
} from "@fusion/core";
import { describe, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({
  getRuntimeSnapshot: vi.fn(),
}));

vi.mock("../session-connector.js", () => ({
  HappierSessionConnector: class {
    getRuntimeSnapshot = mock.getRuntimeSnapshot;
  },
  createHappierSessionConnectorWithHostWriteAuthorization: () => ({
    getRuntimeSnapshot: mock.getRuntimeSnapshot,
  }),
}));

import { HappierSessionConnector } from "../session-connector-facade.js";

const identity: SessionConnectorIdentityV1 = {
  connectorId: "happier",
  providerId: "codex",
  nativeSessionId: "thread-facade-1",
  happierSessionId: "happier-facade-1",
  serverProfileId: "server-facade-1",
  machineId: "machine-facade-1",
  hostId: "host-facade-1",
};

const snapshot: SessionConnectorRuntimeSnapshotV1 = {
  contractVersion: 1,
  source: "connector_local_extension",
  identity,
  snapshotId: "snapshot-facade-1",
  revision: 1,
  capturedAt: "2026-07-20T00:00:00.000Z",
  expiresAt: "2026-07-20T00:00:30.000Z",
  providerId: "codex",
  modelId: "gpt-5.5",
  modelObservedAt: "2026-07-20T00:00:00.000Z",
  accountId: null,
  coverage: {
    providerModel: "observed",
    providerAccount: "not_reported",
    providerQuota: "not_reported",
    latency: "not_reported",
    context: "not_reported",
    tools: "not_reported",
    quality: "not_reported",
  },
};

describe("HappierSessionConnector facade", () => {
  it("forwards the accountless local runtime snapshot capability to the lazy MCP connector", async () => {
    mock.getRuntimeSnapshot.mockResolvedValueOnce({ ok: true, value: snapshot });
    const connector = new HappierSessionConnector();

    await expect(connector.getRuntimeSnapshot(identity)).resolves.toEqual({ ok: true, value: snapshot });
    expect(mock.getRuntimeSnapshot).toHaveBeenCalledWith(identity);
  });
});
