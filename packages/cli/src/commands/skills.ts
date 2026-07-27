/**
 * Skills CLI Commands
 *
 * Provides CLI commands for browsing and importing skills from skills.sh:
 * - fn skills search <query> - Search skills.sh for agent skills
 * - fn skills install <owner/repo> - Install skills from a source
 */

import { spawn } from "node:child_process";
import {
  searchPublicSkillsWithFallback,
  type SkillsSearchMetadata,
  type UpstreamErrorCode,
} from "@fusion/dashboard/skills-search";

/**
 * Skill entry from the skills.sh /api/search endpoint.
 */
export interface SkillsShSearchResult {
  /** Full skill ID, e.g. "vercel-labs/agent-skills/vercel-react-best-practices" */
  id: string;
  /** Skill name, e.g. "vercel-react-best-practices" */
  skillId: string;
  /** Skill name, e.g. "vercel-react-best-practices" */
  name: string;
  /** Install count */
  installs: number;
  /** GitHub source owner/repo, e.g. "vercel-labs/agent-skills" */
  source: string;
}

/**
 * API base URL for skills.sh.
 * Override via SKILLS_API_URL environment variable for testing.
 */
export const SKILLS_API_BASE = process.env.SKILLS_API_URL ?? "https://skills.sh";

export type SkillsSearchOutcome =
  | {
      skills: SkillsShSearchResult[];
      search: SkillsSearchMetadata;
    }
  | {
      skills: [];
      error: string;
      code: UpstreamErrorCode;
    };

/*
 * FNXC:CliSkillsSearchFallback 2026-07-27-02:38:
 * CLI skills search must share the Dashboard's semantic-to-fuzzy/FTS fallback and expose its warning/source. A transport or index failure is an explicit error outcome, never an empty successful result that looks like "no matching skills."
 */
export async function searchSkillsDetailed(query: string, limit = 10): Promise<SkillsSearchOutcome> {
  const result = await searchPublicSkillsWithFallback({
    baseUrl: SKILLS_API_BASE,
    query,
    limit,
  });
  if ("error" in result) {
    return {
      skills: [],
      error: result.error,
      code: result.code,
    };
  }
  return {
    skills: result.skills.sort((a, b) => b.installs - a.installs),
    search: result.search,
  };
}

/**
 * Search skills.sh for skills matching the given query.
 *
 * Uses the public /api/search endpoint (no authentication required).
 *
 * @param query - Search query (framework, technology, or capability)
 * @param limit - Maximum number of results (default: 10)
 * @returns Array of matching skills sorted by install count descending
 */
export async function searchSkills(query: string, limit = 10): Promise<SkillsShSearchResult[]> {
  const result = await searchSkillsDetailed(query, limit);
  if ("error" in result) {
    console.error(`[skills] Search failed: ${result.error}`);
    return [];
  }
  return result.skills;
}

/**
 * Format install count for display.
 *
 * @param count - Number of installs
 * @returns Formatted string like "1.5M installs", "32K installs", or "" for 0
 */
export function formatInstalls(count: number): string {
  if (count === 0) return "";
  if (count >= 1_000_000) {
    return `${(count / 1_000_000).toFixed(1).replace(/\.0$/, "")}M installs`;
  }
  if (count >= 1_000) {
    return `${(count / 1_000).toFixed(1).replace(/\.0$/, "")}K installs`;
  }
  return `${count} installs`;
}

/**
 * Run the skills search command.
 *
 * @param args - Command arguments (query words)
 * @param options - Search options
 * @param options.limit - Maximum results to show (default: 10)
 */
export async function runSkillsSearch(
  args: string[],
  options?: { limit?: number },
): Promise<void> {
  const query = args.join(" ").trim();

  if (!query) {
    console.log("Usage: fn skills search <query> [--limit <n>]");
    console.log("Example: fn skills search react");
    console.log("         fn skills search firebase --limit 5");
    return;
  }

  const result = await searchSkillsDetailed(query, options?.limit ?? 10);
  if ("error" in result) {
    console.error(`[skills] Search failed: ${result.error}`);
    return;
  }
  const { skills, search } = result;
  if (search.warning) {
    console.warn(
      `[skills] Warning: ${search.warning} (source: ${search.fallbackSource ?? search.source})`,
    );
  }

  if (skills.length === 0) {
    console.log(`No skills found for '${query}'`);
    return;
  }

  console.log(`Skills matching '${query}' (${skills.length} results):\n`);

  for (let i = 0; i < skills.length; i++) {
    const skill = skills[i]!;
    const installs = formatInstalls(skill.installs);
    console.log(`${i + 1}. ${skill.name} (${skill.source})${installs ? ` — ${installs}` : ""}`);
  }

  console.log("\nInstall with: fn skills install <source> --skill <name>");
}

/**
 * Validate that a source string is in owner/repo format.
 */
function isValidSourceFormat(source: string): boolean {
  return /^[^/]+\/[^/]+$/.test(source);
}

/**
 * Run the skills install command.
 *
 * @param args - Command arguments (source owner/repo)
 * @param options - Install options
 * @param options.skill - Specific skill name to install
 */
export async function runSkillsInstall(
  args: string[],
  options?: { skill?: string },
): Promise<void> {
  const source = args[0]?.trim();

  if (!source) {
    console.log("Usage: fn skills install <owner/repo> [--skill <name>]");
    console.log("Example: fn skills install firebase/agent-skills");
    console.log("         fn skills install firebase/agent-skills --skill firebase-basics");
    return;
  }

  if (!isValidSourceFormat(source)) {
    console.error("Invalid source format. Use owner/repo (e.g., firebase/agent-skills)");
    return;
  }

  // Build npx skills add arguments
  const npxArgs = ["skills", "add", source];

  if (options?.skill) {
    npxArgs.push("--skill", options.skill);
  }

  // Non-interactive mode (-y) targeting pi agent (-a pi)
  npxArgs.push("-y", "-a", "pi");

  // Execute via spawn (async, non-blocking)
  const child = spawn("npx", npxArgs, {
    cwd: process.cwd(),
    stdio: "inherit",
    shell: true,
  });

  const exitCode = await new Promise<number>((resolve, reject) => {
    child.on("exit", (code) => {
      resolve(code ?? 1);
    });
    child.on("error", (err) => {
      reject(err);
    });
  });

  if (exitCode !== 0) {
    console.error("Failed to install skill. Make sure 'npx' is available.");
    return;
  }

  console.log(
    `Installed skill from ${source}. Skills are discovered from .fusion/skills/, legacy .pi/skills/, and .agents/skills/.`,
  );
}
