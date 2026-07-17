import type { RoomConfidenceBand, RoomConfidenceDimensionName } from "./evidence.js";
import type {
  EventCursor,
  IsoTimestamp,
  ProjectId,
  RoomAlertId,
  RoomBindingId,
  RoomEvidenceId,
  RoomId,
  RoomLeaseId,
  RoomProtocolId,
  RoomSeatId,
  RoomTaskEdgeId,
  RoomTaskNodeId,
} from "./ids.js";
import type { RoomLifecycleState } from "./storage.js";
import type { RoomApiVersion, RoomUiContractVersion } from "./versions.js";

export const ROOM_UI_TASK_STATES = [
  "ready",
  "running",
  "waiting_dependency",
  "waiting_approval",
  "rate_limited",
  "failed",
  "retrying",
  "accepted",
  "cancelled",
  "blocked",
] as const;

export const ROOM_UI_SEAT_HEALTH_STATES = [
  "healthy",
  "idle",
  "busy",
  "degraded",
  "lost",
  "recovering",
  "disconnected",
] as const;

export type RoomUiTaskState = (typeof ROOM_UI_TASK_STATES)[number];
export type RoomUiSeatHealthState = (typeof ROOM_UI_SEAT_HEALTH_STATES)[number];
export type RoomUiHealthState = "healthy" | "degraded" | "critical" | "paused" | "unknown";

export interface RoomUiSummaryV1 {
  readonly id: RoomId;
  readonly projectId: ProjectId;
  readonly objective: string;
  readonly lifecycleState: RoomLifecycleState;
  readonly aggregateVersion: number;
  readonly protocolId: RoomProtocolId;
  readonly protocolVersion: number;
  readonly protocolPhaseId: string;
}

export interface RoomUiCompletionV1 {
  readonly acceptedNodes: number;
  readonly totalNodes: number;
  readonly blockedNodes: number;
}

export interface RoomUiConfidenceDimensionV1 {
  readonly name: RoomConfidenceDimensionName;
  readonly band: RoomConfidenceBand;
  readonly rationale: string;
}

export interface RoomUiConfidenceSummaryV1 {
  readonly snapshotId: string;
  readonly band: RoomConfidenceBand;
  readonly dimensions: readonly RoomUiConfidenceDimensionV1[];
}

export type RoomUiIdleReason =
  | "waiting_dependency"
  | "policy"
  | "missing_capability"
  | "approval"
  | "backpressure"
  | "scheduler_defect"
  | "provider_limit"
  | "no_ready_work"
  | "recovery_reserved";

export interface RoomUiCapacityV1 {
  readonly theoreticalSlots: number;
  readonly configuredSlots: number;
  readonly activeSlots: number;
  readonly queueDepth: number;
  readonly reservedVerifierSlots: number;
  readonly reservedRecoverySlots: number;
  readonly utilizationRatio: number;
  readonly throughputPerMinute: number;
  readonly idleReasons: readonly {
    readonly reason: RoomUiIdleReason;
    readonly slots: number;
  }[];
}

export interface RoomUiHeaderV1 {
  readonly health: RoomUiHealthState;
  readonly completion: RoomUiCompletionV1;
  readonly criticalPathNodeIds: readonly RoomTaskNodeId[];
  readonly confidence: RoomUiConfidenceSummaryV1;
  readonly capacity: RoomUiCapacityV1;
}

/*
FNXC:SessionRoomCockpitDto 2026-07-17-03:04:
The DTO deliberately exposes seat, binding, provider-native Session, Happier
Session, server profile, and host as separate identities. Collapsing them would
make same-session continuity and one-click navigation impossible to audit.
*/
export interface RoomUiSeatV1 {
  readonly id: RoomSeatId;
  readonly bindingId: RoomBindingId;
  readonly bindingGeneration: number;
  readonly roleId: string;
  readonly providerId: string;
  readonly actualModelRef: string;
  readonly nativeSessionId: string;
  readonly happierSessionId: string | null;
  readonly serverProfileId: string | null;
  readonly machineId: string | null;
  readonly hostId: string;
  readonly health: RoomUiSeatHealthState;
  readonly lastHeartbeatAt: IsoTimestamp | null;
  readonly currentNodeId: RoomTaskNodeId | null;
  readonly contextUtilizationRatio: number | null;
  readonly throughputPerMinute: number;
  readonly rateLimitState: "clear" | "approaching" | "limited" | "unknown";
  readonly senderLeaseId: RoomLeaseId | null;
  readonly workspaceLeaseId: RoomLeaseId | null;
  readonly waitReason: string | null;
  readonly recoveryOwnerId: string | null;
  readonly happierDeepLink: string | null;
  readonly nativeDeepLink: string | null;
}

export interface RoomUiTaskNodeV1 {
  readonly id: RoomTaskNodeId;
  readonly parentNodeId: RoomTaskNodeId | null;
  readonly title: string;
  readonly state: RoomUiTaskState;
  readonly ownerSeatId: RoomSeatId | null;
  readonly dependencyNodeIds: readonly RoomTaskNodeId[];
  readonly critical: boolean;
  readonly attempt: number;
  readonly progressSignature: string | null;
  readonly gateIds: readonly string[];
  readonly evidenceIds: readonly RoomEvidenceId[];
  readonly waitReason: string | null;
  readonly nextRecoveryAction: string | null;
}

export interface RoomUiTaskEdgeV1 {
  readonly id: RoomTaskEdgeId;
  readonly fromNodeId: RoomTaskNodeId;
  readonly toNodeId: RoomTaskNodeId;
  readonly kind: "depends_on" | "blocks" | "informs" | "invalidates";
}

export interface RoomUiAlertActionV1 {
  readonly id: string;
  readonly label: string;
  readonly commandType: string;
  readonly requiresConfirmation: boolean;
}

export interface RoomUiAlertV1 {
  readonly id: RoomAlertId;
  readonly severity: "info" | "warning" | "severe" | "critical";
  readonly state: "open" | "acknowledged" | "resolved";
  readonly deduplicationKey: string;
  readonly rootCause: string;
  readonly impact: string;
  readonly evidenceIds: readonly RoomEvidenceId[];
  readonly attemptedRecovery: readonly string[];
  readonly nextRetryAt: IsoTimestamp | null;
  readonly actions: readonly RoomUiAlertActionV1[];
  readonly resolvedAt: IsoTimestamp | null;
}

export interface RoomCockpitDtoV1 {
  readonly contractVersion: RoomUiContractVersion;
  readonly apiVersion: RoomApiVersion;
  readonly generatedAt: IsoTimestamp;
  readonly latestEventCursor: EventCursor;
  readonly room: RoomUiSummaryV1;
  readonly header: RoomUiHeaderV1;
  readonly seats: readonly RoomUiSeatV1[];
  readonly tasks: readonly RoomUiTaskNodeV1[];
  readonly edges: readonly RoomUiTaskEdgeV1[];
  readonly alerts: readonly RoomUiAlertV1[];
}
