/*
FNXC:PostgresCutover 2026-07-12:
Mesh task replication is REMOVED — all replication is handled at the
PostgreSQL level (nodes share the database). This module used to carry the
replicated-create payload builders/matchers; only buildBootstrapPrompt
survives because task creation, comments, and title/description sync use it
to write the human-visible PROMPT.md stub.
*/

export function buildBootstrapPrompt(taskId: string, title: string | undefined, description: string): string {
  const heading = title ? `${taskId}: ${title}` : taskId;
  return `# ${heading}\n\n${description}\n`;
}

/*
FNXC:TaskRefinementWorkflow 2026-07-13-12:00:
The single source of truth for the refinement seed shape. TaskStore.refineTask writes this
exact content and isUnplannedSeedPrompt detects it by byte-equality — keep both on this
builder or the detector silently stops matching when the seed format changes, and unplanned
refinements release into execution again.
*/
export function buildRefinementSeedPrompt(title: string, description: string): string {
  return `# ${title}\n\n${description}\n`;
}

/*
FNXC:WorkflowScheduling 2026-07-25-11:20:
Seed detection compares NORMALIZED text, not raw bytes. Symptom it fixes: a Coding (Ideas) card
promoted to Todo was never planned — triage's todo-discovery only admits a card whose PROMPT.md
still reads as a seed, and any byte-level drift from the builder output silently reclassified the
card as "already planned", so it sat in Todo forever with no log line. Drift sources are all
benign and outside the writer's control: a CRLF checkout/editor round-trip, an editor that adds or
strips the trailing newline, or trailing spaces. Normalization is line-ending + trailing-whitespace
only — the heading and body text still must match exactly, so a REAL spec can never normalize into
a seed (it carries Mission/Steps/File Scope sections the seed does not have).
*/
function normalizeSeedText(content: string): string {
  return content.replace(/\r\n/g, "\n").replace(/[ \t]+$/gm, "").trimEnd();
}

/*
FNXC:WorkflowScheduling 2026-07-12-22:55:
"Unplanned" detection must recognize BOTH seed-prompt shapes or unplanned cards slip into
execution with a non-spec prompt:
1. The createTask bootstrap stub (`# {id}: {title}\n\n{description}\n`).
2. The refineTask seed (buildRefinementSeedPrompt — no task-id prefix), which previously
   failed the strict stub-equality check, so a refinement promoted out of a manual intake
   column (Coding (Ideas)) was treated as already planned and released straight into
   execution carrying only the operator's feedback text.

FNXC:WorkflowScheduling 2026-07-25-11:20:
This is the SINGLE seed predicate for every scheduling decision. The dispatch filter in
scheduler.ts used to open-code strict `content === buildBootstrapPrompt(...)`, which disagreed
with this function on the refinement seed: triage called such a card unplanned (so it planned it)
while the scheduler called it planned (so it was also a dispatch candidate), leaving hold-release
as the only thing between a refinement seed and an executor running on the operator's feedback
text. Callers: triage todo-discovery (plan-in-place workflows), the scheduler dispatch filter, and
hold-release's isUnplannedForExecution guard. Do not re-open-code either equality check.
*/
export function isUnplannedSeedPrompt(
  content: string,
  taskId: string,
  title: string | undefined,
  description: string,
): boolean {
  const normalized = normalizeSeedText(content);
  if (normalized === normalizeSeedText(buildBootstrapPrompt(taskId, title, description))) return true;
  return title !== undefined
    && normalized === normalizeSeedText(buildRefinementSeedPrompt(title, description));
}
