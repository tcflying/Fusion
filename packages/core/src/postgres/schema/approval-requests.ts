import {
  index,
  jsonb,
  pgSchema,
  primaryKey,
  text,
} from "drizzle-orm/pg-core";
import { PROJECT_SCHEMA } from "./_shared.js";

const projectSchema = pgSchema(PROJECT_SCHEMA);

/*
FNXC:SessionRoomSchema 2026-07-18-07:47:
Operational Room recovery actions can reference the pre-existing approval
ledger, but the project schema also re-exports Room tables. Keep this shared
table in an acyclic schema leaf so PostgreSQL module initialization never
depends on evaluation order of the Room re-export.
*/
export const approvalRequests = projectSchema.table("approval_requests", {
  id: text("id").notNull(),
  projectId: text("project_id").notNull(),
  status: text("status").notNull(),
  requesterActorId: text("requester_actor_id").notNull(),
  requesterActorType: text("requester_actor_type").notNull(),
  requesterActorName: text("requester_actor_name").notNull(),
  targetActionCategory: text("target_action_category").notNull(),
  targetActionOperation: text("target_action_operation").notNull(),
  targetActionSummary: text("target_action_summary").notNull(),
  targetResourceType: text("target_resource_type").notNull(),
  targetResourceId: text("target_resource_id").notNull(),
  targetContext: jsonb("target_context"),
  taskId: text("task_id"),
  runId: text("run_id"),
  requestedAt: text("requested_at").notNull(),
  decidedAt: text("decided_at"),
  completedAt: text("completed_at"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (t) => [
  primaryKey({ columns: [t.projectId, t.id] }),
  index("idxApprovalRequestsStatusCreatedAt").on(t.status, t.createdAt),
  index("idxApprovalRequestsRequesterCreatedAt").on(t.requesterActorId, t.createdAt),
  index("idxApprovalRequestsTaskCreatedAt").on(t.taskId, t.createdAt),
]);
