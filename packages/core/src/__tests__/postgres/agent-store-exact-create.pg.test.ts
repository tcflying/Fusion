import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import {
  createSharedPgTaskStoreTestHarness,
  pgDescribe,
} from "../../__test-utils__/pg-test-harness.js";
import { AgentStore } from "../../agent-store.js";

const describe = pgDescribe;

describe("AgentStore exact runtime-config creation", () => {
  const h = createSharedPgTaskStoreTestHarness({ prefix: "agent_exact_create" });
  let store: AgentStore;

  beforeAll(h.beforeAll);
  afterAll(h.afterAll);
  afterEach(h.afterEach);

  beforeEach(async () => {
    await h.beforeEach();
    store = new AgentStore({
      rootDir: h.store().getFusionDir(),
      taskStore: h.store(),
      asyncLayer: h.layer(),
    });
    await store.init();
  });

  it("persists exact runtime config in one atomic named create and admits only one concurrent winner", async () => {
    const runtimeConfig = {
      runtimeHint: "happier",
      assignmentPolicy: "explicit-only",
      allowParallelExecution: true,
      autoClaimRelevantTasks: false,
    };
    const create = () => store.createAgentWithExactRuntimeConfig({
      name: "Happier Session Bridge",
      role: "executor",
      runtimeConfig,
    });

    const results = await Promise.allSettled([create(), create()]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);

    const matching = (await store.listAgents({ includeEphemeral: false }))
      .filter((agent) => agent.name === "Happier Session Bridge");
    expect(matching).toHaveLength(1);
    expect(matching[0]).toMatchObject({
      role: "executor",
      runtimeConfig,
    });
    expect(Object.keys(matching[0]?.runtimeConfig ?? {}).sort()).toEqual(Object.keys(runtimeConfig).sort());
  });

  it("serializes ordinary and exact durable creation under the same name", async () => {
    const name = "Mixed Named Agent";
    const results = await Promise.allSettled([
      store.createAgent({
        name,
        role: "executor",
        runtimeConfig: { runtimeHint: "ordinary" },
      }),
      store.createAgentWithExactRuntimeConfig({
        name,
        role: "executor",
        runtimeConfig: {
          runtimeHint: "happier",
          assignmentPolicy: "explicit-only",
          allowParallelExecution: true,
          autoClaimRelevantTasks: false,
        },
      }),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    const matching = (await store.listAgents({ includeEphemeral: false }))
      .filter((agent) => agent.name === name);
    expect(matching).toHaveLength(1);
  });
});
