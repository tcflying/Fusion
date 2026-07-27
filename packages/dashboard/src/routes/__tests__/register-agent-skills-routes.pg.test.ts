// @vitest-environment node

import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import express from "express";
import {
  TaskStore,
  type AsyncDataLayer,
  type PluginStore,
} from "@fusion/core";
import { expect, it, vi } from "vitest";
import {
  createTaskStoreForTest,
  pgDescribe,
} from "../../../../core/src/__test-utils__/pg-test-harness.js";
import * as schema from "../../../../core/src/postgres/schema/index.js";
import { createApiRoutes } from "../../routes.js";
import { createSkillsAdapter } from "../../skills-adapter.js";
import { request } from "../../test-request.js";

const TEST_RUN = `${process.pid}-${randomUUID()}`;
const LAUNCH_PROJECT = `dashboard-skills-launch-${TEST_RUN}`;
const TARGET_PROJECT = `dashboard-skills-target-${TEST_RUN}`;

function bindLayer(layer: AsyncDataLayer, projectId: string): AsyncDataLayer {
  return { ...layer, projectId };
}

async function createBoundStore(
  layer: AsyncDataLayer,
  rootDir: string,
): Promise<TaskStore> {
  await mkdir(rootDir, { recursive: true });
  const store = new TaskStore(rootDir, undefined, { asyncLayer: layer });
  Object.defineProperty(store, "listTasksForGithubTrackingReconcile", {
    value: undefined,
    configurable: true,
  });
  return store;
}

/*
 * FNXC:PluginSkillsPostgres 2026-07-27-17:08:
 * The skills route must hand the request-selected PostgreSQL TaskStore to the
 * adapter. Plugin discovery then reuses that store's AsyncDataLayer-backed
 * PluginStore; an omitted store would force the removed temporary SQLite path.
 */
pgDescribe("agent skills routes PostgreSQL store reuse", () => {
  it("reuses the target TaskStore and PluginStore without entering SQLite", async () => {
    const h = await createTaskStoreForTest({
      prefix: "fusion_dashboard_skills_routes",
      copyFromGolden: true,
    });
    const launchLayer = bindLayer(h.layer, LAUNCH_PROJECT);
    const targetLayer = bindLayer(h.layer, TARGET_PROJECT);
    const now = "2026-07-27T09:08:00.000Z";
    const launchRoot = join(h.rootDir, "launch-project");
    const targetRoot = join(h.rootDir, "target-project");
    let observedTaskStore: TaskStore | undefined;
    let observedPluginStore: PluginStore | undefined;
    let pluginRowsRead = false;
    const getDatabase = vi.spyOn(TaskStore.prototype, "getDatabase")
      .mockImplementation(() => {
        throw new Error("temporary SQLite TaskStore access is forbidden");
      });

    try {
      await h.layer.db.insert(schema.project.config).values([
        {
          id: 1,
          projectId: LAUNCH_PROJECT,
          settings: {},
          workflowSteps: [],
          updatedAt: now,
        },
        {
          id: 2,
          projectId: TARGET_PROJECT,
          settings: {},
          workflowSteps: [],
          updatedAt: now,
        },
      ]);
      const launchStore = await createBoundStore(launchLayer, launchRoot);
      const targetStore = await createBoundStore(targetLayer, targetRoot);
      const targetPluginStore = targetStore.getPluginStore();
      const skillsAdapter = createSkillsAdapter({
        packageManager: {
          resolve: async () => ({ skills: [] }),
        },
        getSettingsPath: (rootDir) => join(rootDir, ".fusion", "missing-skills-settings.json"),
        getPluginSkills: async (_rootDir, projectStore) => {
          if (!projectStore) {
            throw new Error("route omitted the PostgreSQL project TaskStore");
          }
          observedTaskStore = projectStore;
          observedPluginStore = projectStore.getPluginStore();
          await observedPluginStore.init();
          await observedPluginStore.listPlugins({ enabled: true });
          pluginRowsRead = true;
          return [];
        },
      });

      const app = express();
      app.use(express.json());
      app.use("/api", createApiRoutes(launchStore, {
        skillsAdapter,
        engineManager: {
          getEngine(projectId: string) {
            if (projectId === LAUNCH_PROJECT) {
              return { getTaskStore: () => launchStore };
            }
            if (projectId === TARGET_PROJECT) {
              return { getTaskStore: () => targetStore };
            }
            return undefined;
          },
          onProjectAccessed() {},
        },
      } as never));

      const response = await request(
        app,
        "GET",
        `/api/skills/discovered?projectId=${TARGET_PROJECT}`,
      );

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ skills: [] });
      expect(observedTaskStore).toBe(targetStore);
      expect(observedTaskStore).not.toBe(launchStore);
      expect(observedPluginStore).toBe(targetPluginStore);
      expect(observedPluginStore?.backendMode).toBe(true);
      expect(observedPluginStore?.asyncLayer).toBe(targetLayer);
      expect(pluginRowsRead).toBe(true);
      expect(getDatabase).not.toHaveBeenCalled();
    } finally {
      getDatabase.mockRestore();
      await h.teardown();
    }
  }, 120_000);
});
