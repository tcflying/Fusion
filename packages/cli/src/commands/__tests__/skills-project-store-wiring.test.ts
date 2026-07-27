import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function readSkillResolver(command: "dashboard" | "serve"): string {
  const source = readFileSync(new URL(`../${command}.ts`, import.meta.url), "utf8");
  const start = source.indexOf("const getProjectScopedPluginSkills");
  const end = source.indexOf("const skillsAdapter", start);
  if (start < 0 || end < 0) {
    throw new Error(`Could not locate ${command} skill resolver`);
  }
  return source.slice(start, end);
}

describe("project-scoped plugin skill discovery", () => {
  it.each(["dashboard", "serve"] as const)(
    "%s reuses the resolved PostgreSQL TaskStore without opening SQLite compatibility stores",
    (command) => {
      const resolver = readSkillResolver(command);

      expect(resolver).toContain("resolvedProjectStore?: TaskStore");
      expect(resolver).toContain("targetStore.getPluginStore()");
      expect(resolver).toContain("persistRuntimeState: false");
      expect(resolver).not.toContain("new TaskStore(");
      expect(resolver).not.toContain("new PluginStore(");
    },
  );
});
