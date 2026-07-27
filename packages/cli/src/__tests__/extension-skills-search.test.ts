/*
 * FNXC:CliSkillsSearchFallback 2026-07-27-06:49:
 * Keep fallback observability coverage in a focused suite so new CLI behavior does not keep growing the grandfathered extension integration test.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { executeExtensionSkillsSearch } from "../extension-skills-search.js";

describe("fn_skills_search fallback observability", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns the fallback warning and SQLite FTS source with degraded results", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce({
        ok: false,
        status: 503,
        statusText: "Semantic index unavailable",
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          searchType: "fts",
          skills: [
            {
              id: "db/skills/database-tuning",
              skillId: "database-tuning",
              name: "Database Tuning",
              installs: 120,
              source: "db/skills",
            },
          ],
        }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          searchType: "fuzzy",
          skills: [],
        }),
      } as Response);
    vi.stubGlobal("fetch", fetchMock);

    const result = await executeExtensionSkillsSearch({
      query: "database optimization",
      limit: 10,
    });

    expect(result.content[0]?.text).toContain(
      "Semantic skill search was unavailable; showing keyword fallback results.",
    );
    expect(result.content[0]?.text).toContain("sqlite-fts");
    expect(result.details).toMatchObject({
      search: {
        source: "brute-force",
        fallbackUsed: true,
        fallbackSource: "sqlite-fts",
      },
    });
  });
});
