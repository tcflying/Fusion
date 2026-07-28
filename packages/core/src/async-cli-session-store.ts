import { randomUUID } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { isCliAgentState, isCliTerminationReason } from "./cli-session-types.js";
import type {
  CliAutonomyPosture,
  CliSession,
  CliSessionCreateInput,
  CliSessionUpdateInput,
} from "./cli-session-types.js";
import type { AsyncDataLayer } from "./postgres/data-layer.js";
import * as schema from "./postgres/schema/index.js";

type CliSessionRow = typeof schema.project.cliSessions.$inferSelect;

function parseAutonomyPosture(value: string | null): CliAutonomyPosture | null {
  if (!value) return null;
  try {
    return JSON.parse(value) as CliAutonomyPosture;
  } catch {
    return null;
  }
}

function rowToSession(row: CliSessionRow): CliSession {
  return {
    id: row.id,
    taskId: row.taskId ?? null,
    chatSessionId: row.chatSessionId ?? null,
    purpose: row.purpose as CliSession["purpose"],
    projectId: row.ownerProjectId ?? "",
    adapterId: row.adapterId,
    agentState: row.agentState as CliSession["agentState"],
    terminationReason: (row.terminationReason as CliSession["terminationReason"]) ?? null,
    nativeSessionId: row.nativeSessionId ?? null,
    resumeAttempts: row.resumeAttempts ?? 0,
    autonomyPosture: parseAutonomyPosture(row.autonomyPosture),
    worktreePath: row.worktreePath ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * FNXC:HappierRuntime 2026-07-14-13:34:
 * Fusion 0.60 removed the synchronous SQLite runtime. Happier's canonical
 * native-session owner therefore persists through the PostgreSQL
 * `project.cli_sessions` table while retaining the same atomic claim contract.
 */
export class AsyncCliSessionStore {
  constructor(private readonly layer: Pick<AsyncDataLayer, "db">) {}

  async getSession(id: string): Promise<CliSession | undefined> {
    const rows = await this.layer.db
      .select()
      .from(schema.project.cliSessions)
      .where(eq(schema.project.cliSessions.id, id));
    return rows[0] ? rowToSession(rows[0]) : undefined;
  }

  async createSession(input: CliSessionCreateInput): Promise<CliSession> {
    const now = new Date().toISOString();
    const id = input.id ?? `cli-${randomUUID().slice(0, 8)}`;
    await this.layer.db
      .insert(schema.project.cliSessions)
      .values({
        id,
        taskId: input.taskId ?? null,
        chatSessionId: input.chatSessionId ?? null,
        purpose: input.purpose,
        // project_id is the trigger/GUC-owned RLS partition. The caller's
        // domain project belongs in owner_project_id (migration 0011), matching
        // CliSessionStore and keeping project-scoped hydration interoperable.
        ownerProjectId: input.projectId,
        adapterId: input.adapterId,
        agentState: input.agentState ?? "starting",
        terminationReason: input.terminationReason ?? null,
        nativeSessionId: input.nativeSessionId ?? null,
        resumeAttempts: input.resumeAttempts ?? 0,
        autonomyPosture: input.autonomyPosture ? JSON.stringify(input.autonomyPosture) : null,
        worktreePath: input.worktreePath ?? null,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing();

    const session = await this.getSession(id);
    if (!session) throw new Error(`Failed to create CLI session: ${id}`);
    return session;
  }

  async updateSession(
    id: string,
    input: CliSessionUpdateInput,
  ): Promise<CliSession | undefined> {
    const existing = await this.getSession(id);
    if (!existing) return undefined;

    if (input.agentState !== undefined && !isCliAgentState(input.agentState)) {
      throw new Error(`Invalid CLI agent state: ${JSON.stringify(input.agentState)}`);
    }
    if (
      input.terminationReason !== undefined
      && input.terminationReason !== null
      && !isCliTerminationReason(input.terminationReason)
    ) {
      throw new Error(
        `Invalid CLI termination reason: ${JSON.stringify(input.terminationReason)}`,
      );
    }

    const updates: Partial<CliSessionRow> = {
      updatedAt: new Date().toISOString(),
    };
    if (input.taskId !== undefined) updates.taskId = input.taskId;
    if (input.chatSessionId !== undefined) updates.chatSessionId = input.chatSessionId;
    if (input.agentState !== undefined) updates.agentState = input.agentState;
    if (input.terminationReason !== undefined) {
      updates.terminationReason = input.terminationReason;
    }
    if (input.nativeSessionId !== undefined) {
      updates.nativeSessionId = input.nativeSessionId;
    }
    if (input.resumeAttempts !== undefined) updates.resumeAttempts = input.resumeAttempts;
    if (input.autonomyPosture !== undefined) {
      updates.autonomyPosture = input.autonomyPosture === null
        ? null
        : JSON.stringify(input.autonomyPosture);
    }
    if (input.worktreePath !== undefined) updates.worktreePath = input.worktreePath;

    await this.layer.db
      .update(schema.project.cliSessions)
      .set(updates)
      .where(eq(schema.project.cliSessions.id, id))
      .returning({ id: schema.project.cliSessions.id });
    return this.getSession(id);
  }

  async claimNativeSessionId(
    id: string,
    candidate: string,
  ): Promise<{ claimed: boolean; nativeSessionId: string } | undefined> {
    const nativeSessionId = candidate.trim();
    if (!nativeSessionId) throw new Error("Native session id is required");
    const claimedRows = await this.layer.db
      .update(schema.project.cliSessions)
      .set({ nativeSessionId, updatedAt: new Date().toISOString() })
      .where(and(
        eq(schema.project.cliSessions.id, id),
        isNull(schema.project.cliSessions.nativeSessionId),
      ))
      .returning({ id: schema.project.cliSessions.id });
    const session = await this.getSession(id);
    if (!session) return undefined;
    if (!session.nativeSessionId) {
      throw new Error(`CLI session ${id} has no native session id after claim`);
    }
    return {
      claimed: claimedRows.length === 1,
      nativeSessionId: session.nativeSessionId,
    };
  }
}
