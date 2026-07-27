/*
 * FNXC:CliSkillsSearchFallback 2026-07-27-06:49:
 * FUS-P1-009 keeps the high-churn Pi extension below its grandfathered ceiling by owning skills-search execution in a focused module. Preserve degraded-search warnings and source metadata in both operator text and structured tool details so semantic-index failure cannot look like an empty success.
 */
export interface ExtensionSkillsSearchParams {
  query: string;
  limit?: number;
}

export async function executeExtensionSkillsSearch(params: ExtensionSkillsSearchParams) {
  const { searchSkillsDetailed, formatInstalls } = await import("./commands/skills.js");
  const outcome = await searchSkillsDetailed(params.query, params.limit ?? 10);
  if ("error" in outcome) {
    return {
      content: [{ type: "text" as const, text: `Skill search failed: ${outcome.error}` }],
      isError: true,
      details: {
        error: outcome.error,
        code: outcome.code,
        count: 0,
        skills: [],
      },
    };
  }

  const { skills, search } = outcome;
  const fallbackNotice = search.warning
    ? `Warning: ${search.warning} (source: ${search.fallbackSource ?? search.source})`
    : null;

  if (skills.length === 0) {
    return {
      content: [{
        type: "text" as const,
        text: [fallbackNotice, `No skills found for '${params.query}'`]
          .filter((line): line is string => Boolean(line))
          .join("\n"),
      }],
      details: { count: 0, skills: [], search },
    };
  }

  const lines: string[] = [];
  if (fallbackNotice) {
    lines.push(fallbackNotice, "");
  }
  lines.push(`Found ${skills.length} skills matching '${params.query}':\n`);

  for (let i = 0; i < skills.length; i++) {
    const skill = skills[i]!;
    const installs = formatInstalls(skill.installs);
    lines.push(`${i + 1}. ${skill.name} (${skill.source})${installs ? ` — ${installs}` : ""}`);
  }

  lines.push("\nInstall a skill with: fn_skills_install({ source: \"<owner/repo>\", skill: \"<name>\" })");

  return {
    content: [{ type: "text" as const, text: lines.join("\n") }],
    details: {
      count: skills.length,
      search,
      skills: skills.map((skill) => ({
        name: skill.name,
        source: skill.source,
        installs: skill.installs,
        installCommand: `fn skills install ${skill.source} --skill ${skill.name}`,
      })),
    },
  };
}
