/**
 * FNXC:HappierRuntime 2026-07-13-14:48:
 * Task 1 exposes only the official Happier JSON CLI contract. Authentication,
 * encryption, provider credentials, and transcripts remain owned by Happier;
 * these types deliberately contain no credential-setting surface.
 */

export const HAPPIER_BACKENDS = ["codex", "claude", "opencode"] as const;

export type HappierBackend = (typeof HAPPIER_BACKENDS)[number];

export interface HappierCliSettings {
  executable?: string;
  entrypoint?: string;
  serverUrl?: string;
  webappUrl?: string;
  profile?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
}

export interface HappierCliInvocation {
  command: string;
  args: string[];
}

export type HappierErrorCode =
  | "process"
  | "timeout"
  | "invalid-json"
  | "authentication"
  | "server"
  | "daemon"
  | "backend"
  | "session";

export class HappierCliError extends Error {
  readonly name = "HappierCliError";

  constructor(
    readonly code: HappierErrorCode,
    message: string,
    readonly details?: {
      exitCode?: number | null;
      stdout?: string;
      stderr?: string;
    },
  ) {
    super(message);
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export type HappierJsonRecord = Record<string, unknown>;

export interface HappierSessionCreateInput {
  cwd: string;
  backend: HappierBackend;
  title: string;
}

export interface HappierMessageInput {
  sessionId: string;
  message: string;
  timeoutSeconds: number;
}

export type HappierSessionCreateResult = HappierJsonRecord & { sessionId: string };
export type HappierSessionMessageResult = HappierJsonRecord & { sessionId: string };
export type HappierSessionStatusResult = HappierJsonRecord & { sessionId: string };
export type HappierSessionHistoryResult = HappierJsonRecord & { sessionId: string };
