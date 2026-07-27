// @vitest-environment node

import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import express from "express";
import { TaskStore, type AsyncDataLayer } from "@fusion/core";
import { expect, it } from "vitest";
import {
  createTaskStoreForTest,
  pgDescribe,
} from "../../../../core/src/__test-utils__/pg-test-harness.js";
import { recordRunAuditEvent } from "../../../../core/src/postgres/data-layer.js";
import * as schema from "../../../../core/src/postgres/schema/index.js";
import { createApiRoutes } from "../../routes.js";
import { request } from "../../test-request.js";

const TEST_RUN = `${process.pid}-${randomUUID()}`;
const PROJECT_A = `dashboard-route-project-a-${TEST_RUN}`;
const PROJECT_B = `dashboard-route-project-b-${TEST_RUN}`;

function bindLayer(layer: AsyncDataLayer, projectId: string): AsyncDataLayer {
  return { ...layer, projectId };
}

async function createBoundStore(
  layer: AsyncDataLayer,
  rootDir: string,
): Promise<TaskStore> {
  await mkdir(rootDir, { recursive: true });
  const store = new TaskStore(rootDir, undefined, { asyncLayer: layer });
  (
    store as TaskStore & {
      getProjectScopedPluginMcpServers: () => Promise<unknown[]>;
    }
  ).getProjectScopedPluginMcpServers = async () => [];
  Object.defineProperty(store, "listTasksForGithubTrackingReconcile", {
    value: undefined,
    configurable: true,
  });
  return store;
}

function createRouteApp(projectStores: ReadonlyMap<string, TaskStore>) {
  const launchStore = projectStores.get(PROJECT_A);
  if (!launchStore) throw new Error("launch project store missing");

  const app = express();
  app.use(express.json());
  app.use("/api", createApiRoutes(launchStore, {
    engineManager: {
      getEngine(projectId: string) {
        const store = projectStores.get(projectId);
        return store ? { getTaskStore: () => store } : undefined;
      },
      onProjectAccessed() {},
    },
  } as never));
  return app;
}

/*
 * FNXC:RunAuditProjectScope 2026-07-27-16:57:
 * Dashboard runtime-fallback and merge-advance routes must prove their project-bound PostgreSQL behavior through the real registrar and TaskStore, not a mocked audit reader.
 */
pgDescribe("task workflow routes PostgreSQL project scope", () => {
  it("serves only the requested project's runtime-fallback and merge-advance events", async () => {
    const h = await createTaskStoreForTest({
      prefix: "fusion_dashboard_workflow_routes",
      copyFromGolden: true,
    });
    const layerA = bindLayer(h.layer, PROJECT_A);
    const layerB = bindLayer(h.layer, PROJECT_B);
    const storeA = await createBoundStore(layerA, join(h.rootDir, "project-a"));
    const storeB = await createBoundStore(layerB, join(h.rootDir, "project-b"));
    const now = "2026-07-27T08:43:00.000Z";
    const app = createRouteApp(new Map([
      [PROJECT_A, storeA],
      [PROJECT_B, storeB],
    ]));

    try {
      await h.layer.db.insert(schema.project.config).values([
        {
          id: 1,
          projectId: PROJECT_A,
          settings: {},
          workflowSteps: [],
          updatedAt: now,
        },
        {
          id: 2,
          projectId: PROJECT_B,
          settings: {},
          workflowSteps: [],
          updatedAt: now,
        },
      ]);
      await h.layer.db.insert(schema.project.tasks).values([
        {
          id: "FN-PG-A",
          projectId: PROJECT_A,
          description: "Project A route task",
          column: "todo",
          createdAt: now,
          updatedAt: now,
        },
        {
          id: "FN-PG-B",
          projectId: PROJECT_B,
          description: "Project B route task",
          column: "todo",
          createdAt: now,
          updatedAt: now,
        },
      ]);
      await recordRunAuditEvent(layerA, {
        id: `audit-runtime-a-${TEST_RUN}`,
        timestamp: now,
        taskId: "FN-PG-A",
        agentId: "agent-a",
        runId: "run-a",
        domain: "database",
        mutationType: "session:runtime-resolved",
        target: "FN-PG-A",
        metadata: {
          wasConfigured: false,
          runtimeHint: "happier",
          reason: "not_found",
        },
      });
      await recordRunAuditEvent(layerB, {
        id: `audit-runtime-b-${TEST_RUN}`,
        timestamp: "2026-07-27T08:44:00.000Z",
        taskId: "FN-PG-B",
        agentId: "agent-b",
        runId: "run-b",
        domain: "database",
        mutationType: "session:runtime-resolved",
        target: "FN-PG-B",
        metadata: {
          wasConfigured: false,
          runtimeHint: "codex",
          reason: "not_found",
        },
      });
      await recordRunAuditEvent(layerA, {
        id: `audit-merge-a-${TEST_RUN}`,
        timestamp: "2026-07-27T08:45:00.000Z",
        taskId: "FN-PG-A",
        agentId: "agent-a",
        runId: "run-a",
        domain: "git",
        mutationType: "merge:integration-ref-advance",
        target: "refs/heads/project-a",
        metadata: {
          integrationBranch: "project-a",
          refName: "refs/heads/project-a",
          fromSha: "aaaaaaa",
          toSha: "aaaaaab",
          advanceMode: "update-ref",
          succeeded: true,
        },
      });
      await recordRunAuditEvent(layerB, {
        id: `audit-merge-b-${TEST_RUN}`,
        timestamp: "2026-07-27T08:46:00.000Z",
        taskId: "FN-PG-B",
        agentId: "agent-b",
        runId: "run-b",
        domain: "git",
        mutationType: "merge:integration-ref-advance",
        target: "refs/heads/project-b",
        metadata: {
          integrationBranch: "project-b",
          refName: "refs/heads/project-b",
          fromSha: "bbbbbbb",
          toSha: "bbbbbbc",
          advanceMode: "update-ref",
          succeeded: true,
        },
      });

      const runtimeResponse = await request(
        app,
        "GET",
        `/api/tasks/FN-PG-A/runtime-fallback?projectId=${PROJECT_A}`,
      );

      expect(runtimeResponse.status).toBe(200);
      expect(runtimeResponse.body).toEqual(expect.objectContaining({
        taskId: "FN-PG-A",
        eventId: `audit-runtime-a-${TEST_RUN}`,
        runtimeHint: "happier",
        showFallbackBadge: true,
      }));

      const crossProjectRuntimeResponse = await request(
        app,
        "GET",
        `/api/tasks/FN-PG-B/runtime-fallback?projectId=${PROJECT_A}`,
      );
      expect(crossProjectRuntimeResponse.status).toBe(404);

      const mergeResponseA = await request(
        app,
        "GET",
        `/api/tasks/merge-advance-events?projectId=${PROJECT_A}`,
      );
      expect(mergeResponseA.status).toBe(200);
      expect(mergeResponseA.body).toEqual({
        events: [
          expect.objectContaining({
            taskId: "FN-PG-A",
            integrationBranch: "project-a",
            refName: "refs/heads/project-a",
            toSha: "aaaaaab",
          }),
        ],
      });

      const mergeResponseB = await request(
        app,
        "GET",
        `/api/tasks/merge-advance-events?projectId=${PROJECT_B}`,
      );
      expect(mergeResponseB.status).toBe(200);
      expect(mergeResponseB.body).toEqual({
        events: [
          expect.objectContaining({
            taskId: "FN-PG-B",
            integrationBranch: "project-b",
            refName: "refs/heads/project-b",
            toSha: "bbbbbbc",
          }),
        ],
      });
    } finally {
      await h.teardown();
    }
  }, 120_000);
});
