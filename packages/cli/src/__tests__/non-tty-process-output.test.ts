import { describe, expect, it } from "vitest";
import {
  createTaskStoreForTest,
  pgDescribe,
} from "../../../core/src/__test-utils__/pg-test-harness.js";
import {
  type CliHostCommand,
  type CliHostProcessResult,
  NON_TTY_PROOF_LINES,
  runCliHostUntilReady,
  SEARCHABLE_SEVERITY_PROOF_LINES,
} from "./process-output-harness.js";

const liveProcessDescribe =
  process.env.FUSION_TEST_CLI_PROCESS_OUTPUT === "1"
    ? pgDescribe
    : describe.skip;
const PROCESS_TEST_TIMEOUT_MS = 180_000;

/*
FNXC:CliRedirectedOutput 2026-07-27-17:08:
FUS-P1-006 requires a real non-TTY Dashboard child, byte-level NUL rejection,
line-searchable printable severity evidence, a random port outside the
operator-reserved set, and bounded cleanup by the exact spawned process-tree
root. FUS-P1-007 additionally requires Dashboard stdout to omit the full bearer,
`?token=`, and Authorization while retaining the deterministic masked suffix.
This live-process lane is explicit opt-in so the ordinary fast CLI suite never
starts long-lived hosts; focused verification sets
FUSION_TEST_CLI_PROCESS_OUTPUT=1 and supplies the existing PostgreSQL test
authority without starting or stopping that service.
*/
function expectSearchableNonTtyOutput(
  command: CliHostCommand,
  result: CliHostProcessResult,
): void {
  expect([4040, 18287, 52211, 9871, 26965]).not.toContain(result.port);
  expect(result.stdout.includes(0)).toBe(false);
  expect(result.stderr.includes(0)).toBe(false);

  const lines = result.combinedText.split(/\r?\n/);
  for (const proofLine of SEARCHABLE_SEVERITY_PROOF_LINES[command]) {
    expect(lines).toContain(proofLine);
  }
  expect(lines).toContain(NON_TTY_PROOF_LINES[command]);
  const stdoutLines = result.stdoutText.split(/\r?\n/);
  const stderrLines = result.stderrText.split(/\r?\n/);
  expect(stdoutLines).toContain(SEARCHABLE_SEVERITY_PROOF_LINES[command][0]);
  expect(stdoutLines).toContain(NON_TTY_PROOF_LINES[command]);
  expect(stderrLines).toContain(SEARCHABLE_SEVERITY_PROOF_LINES[command][1]);
  expect(stderrLines).toContain(SEARCHABLE_SEVERITY_PROOF_LINES[command][2]);
  for (const line of lines.filter(Boolean)) {
    expect(line).not.toMatch(
      /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/,
    );
  }

  expect(result.cleanup.cleanupTimedOut).toBe(false);
  expect(result.cleanup.residualProcesses).toEqual([]);
}

liveProcessDescribe("CLI non-TTY process output", () => {
  it(
    "spawns dashboard with searchable severity and secret-safe stdout",
    async () => {
      const database = await createTaskStoreForTest({
        prefix: "fusion_cli_dashboard_output",
        copyFromGolden: true,
      });
      const token = "fn_dashboard_process_proof_NEVER_PRINT_7x9Q";

      try {
        await database.store.close();
        const result = await runCliHostUntilReady({
          command: "dashboard",
          databaseUrl: database.testUrl,
          token,
          extraArgs: ["--no-engine"],
        });

        expectSearchableNonTtyOutput("dashboard", result);

        expect(result.stdoutText).not.toContain(token);
        expect(result.stdoutText).not.toContain("?token=");
        expect(result.stdoutText).not.toContain("Authorization");
        expect(result.stdoutText).toContain("****7x9Q");
      } finally {
        await database.teardown();
      }
    },
    PROCESS_TEST_TIMEOUT_MS,
  );

  it(
    "spawns serve with searchable severity through redirected output",
    async () => {
      const database = await createTaskStoreForTest({
        prefix: "fusion_cli_serve_output",
        copyFromGolden: true,
      });

      try {
        await database.store.close();
        const result = await runCliHostUntilReady({
          command: "serve",
          databaseUrl: database.testUrl,
          token: "fn_serve_process_proof_NEVER_PRINT_2m4N",
          extraArgs: ["--paused"],
        });

        expectSearchableNonTtyOutput("serve", result);
      } finally {
        await database.teardown();
      }
    },
    PROCESS_TEST_TIMEOUT_MS,
  );

  it(
    "spawns daemon with searchable severity through redirected output",
    async () => {
      const database = await createTaskStoreForTest({
        prefix: "fusion_cli_daemon_output",
        copyFromGolden: true,
      });

      try {
        await database.store.close();
        const result = await runCliHostUntilReady({
          command: "daemon",
          databaseUrl: database.testUrl,
          token: "fn_daemon_process_proof_NEVER_PRINT_5p8R",
          extraArgs: ["--paused"],
        });

        expectSearchableNonTtyOutput("daemon", result);
      } finally {
        await database.teardown();
      }
    },
    PROCESS_TEST_TIMEOUT_MS,
  );
});
