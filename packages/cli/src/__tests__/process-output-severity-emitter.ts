import { DashboardLogSink } from "../commands/dashboard-tui/log-sink.js";

/*
FNXC:CliRedirectedOutput 2026-07-27-17:28:
Emit all three levels through the production DashboardLogSink while stdout and
stderr are inherited from the real CLI child's non-TTY pipes. The parent test
then proves the exact printable lines survive redirection and remain
independently searchable.
*/
const command = process.env.FUSION_CLI_OUTPUT_PROOF_COMMAND;
if (command !== "dashboard" && command !== "serve" && command !== "daemon") {
  throw new Error(`Unsupported CLI output proof command: ${String(command)}`);
}

const sink = new DashboardLogSink();
sink.log(`${command}:info`, "cli-process-output-proof");
sink.warn(`${command}:warn`, "cli-process-output-proof");
sink.error(`${command}:error`, "cli-process-output-proof");
sink.log(
  `${command}:stdio stdoutTTY=${Boolean(process.stdout.isTTY)} stderrTTY=${Boolean(process.stderr.isTTY)}`,
  "cli-process-output-proof",
);
