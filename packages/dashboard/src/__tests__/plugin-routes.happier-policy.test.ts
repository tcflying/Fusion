// @vitest-environment node

import express from "express";
import type { PluginLoader, PluginStore } from "@fusion/core";
import { describe, expect, it, vi } from "vitest";

import { createPluginRouter } from "../plugin-routes.js";
import { request } from "../test-request.js";

describe("createPluginRouter Happier settings policy", () => {
  it("rejects undeclared settings before the generic route reaches PluginStore", async () => {
    const updatePluginSettings = vi.fn();
    const pluginStore = { updatePluginSettings } as unknown as PluginStore;
    const pluginLoader = {} as PluginLoader;
    const app = express();
    app.use(express.json());
    app.use("/plugins", createPluginRouter(pluginStore, pluginLoader));

    const res = await request(
      app,
      "PUT",
      "/plugins/fusion-plugin-happier-runtime/settings",
      JSON.stringify({ settings: { token: "must-not-store" } }),
      { "content-type": "application/json" },
    );

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: expect.stringContaining("Unsupported Happier setting") });
    expect(updatePluginSettings).not.toHaveBeenCalled();
  });
});
