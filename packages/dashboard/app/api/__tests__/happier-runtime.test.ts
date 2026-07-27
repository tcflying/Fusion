import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../client.js", () => ({
  api: vi.fn(),
}));

import { api } from "../client.js";
import {
  confirmHappierRuntimeBinding,
  fetchHappierRuntimeSetup,
  removeHappierRuntimeBinding,
} from "../happier-runtime.js";

describe("Happier runtime setup API", () => {
  beforeEach(() => vi.clearAllMocks());

  it("keeps setup reads project scoped", async () => {
    vi.mocked(api).mockResolvedValue({ marker: "status" });

    await fetchHappierRuntimeSetup("project-a");

    expect(api).toHaveBeenCalledWith("/providers/happier/setup?projectId=project-a");
  });

  it("sends explicit confirmation, revision, and the exact four-tuple for add and remove", async () => {
    vi.mocked(api).mockResolvedValue({ bindings: [], bindingRevision: "sha256:next" });
    const input = {
      expectedRevision: "sha256:current",
      binding: {
        canonicalSessionUri: "codex://threads/native-1",
        happierSessionId: "happy-1",
        serverProfileId: "server-main",
        machineId: "machine-a",
      },
    };

    await confirmHappierRuntimeBinding("project-a", input);
    await removeHappierRuntimeBinding("project-a", input);

    expect(api).toHaveBeenNthCalledWith(
      1,
      "/providers/happier/bindings?projectId=project-a",
      {
        method: "POST",
        body: JSON.stringify({
          confirmed: true,
          expectedRevision: input.expectedRevision,
          binding: input.binding,
        }),
      },
    );
    expect(api).toHaveBeenNthCalledWith(
      2,
      "/providers/happier/bindings/remove?projectId=project-a",
      {
        method: "POST",
        body: JSON.stringify({
          confirmed: true,
          expectedRevision: input.expectedRevision,
          binding: input.binding,
        }),
      },
    );
  });
});
