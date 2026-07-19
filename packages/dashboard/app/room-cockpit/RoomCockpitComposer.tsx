import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import styles from "./RoomCockpitComposer.module.css";

export const ROOM_COCKPIT_COMPOSER_TARGET_MODES = [
  "controller",
  "all",
  "group",
  "selection",
] as const;

export type RoomCockpitComposerTargetModeV1 = (typeof ROOM_COCKPIT_COMPOSER_TARGET_MODES)[number];

export interface RoomCockpitComposerParticipantV1 {
  readonly seatId: string;
  readonly label: string;
  readonly verification: {
    readonly state: "verified";
    readonly recordId: string;
  };
}

export interface RoomCockpitComposerGroupV1 {
  readonly id: string;
  readonly label: string;
  readonly memberSeatIds: readonly string[];
}

export interface RoomCockpitComposerTargetV1 {
  readonly mode: RoomCockpitComposerTargetModeV1;
  readonly groupId?: string;
  readonly seatIds: readonly string[];
}

export interface RoomCockpitComposerDraftV1 {
  readonly body: string;
  readonly target: RoomCockpitComposerTargetV1;
}

export type RoomCockpitComposerSubmitResultV1 =
  | {
    readonly state: "accepted";
    readonly receiptId: string;
    readonly detail?: string;
  }
  | {
    readonly state: "withheld";
    readonly reason: string;
  }
  | {
    readonly state: "failed";
    readonly reason: string;
  };

export interface RoomCockpitComposerProps {
  readonly participants: readonly RoomCockpitComposerParticipantV1[];
  readonly controllerSeatId?: string;
  readonly groups?: readonly RoomCockpitComposerGroupV1[];
  readonly initialTargetMode?: RoomCockpitComposerTargetModeV1;
  readonly initialGroupId?: string;
  readonly initialSelectedSeatIds?: readonly string[];
  readonly onGuardedSubmit: (
    draft: RoomCockpitComposerDraftV1,
  ) => Promise<RoomCockpitComposerSubmitResultV1> | RoomCockpitComposerSubmitResultV1;
}

interface VerifiedParticipant {
  readonly seatId: string;
  readonly label: string;
}

interface VerifiedGroup {
  readonly id: string;
  readonly label: string;
  readonly memberSeatIds: readonly string[];
}

interface TargetResolution {
  readonly target: RoomCockpitComposerTargetV1 | null;
  readonly label: string;
  readonly reason: string | null;
}

type ComposerResult =
  | {
    readonly kind: "accepted";
    readonly message: string;
  }
  | {
    readonly kind: "withheld" | "failed";
    readonly message: string;
  }
  | null;

function readText(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function normalizeParticipants(participants: readonly RoomCockpitComposerParticipantV1[]): readonly VerifiedParticipant[] {
  const candidates = participants.flatMap((participant) => {
    const seatId = readText(participant?.seatId);
    const label = readText(participant?.label);
    const recordId = readText(participant?.verification?.recordId);

    if (!seatId || !label || !recordId || participant?.verification?.state !== "verified") {
      return [];
    }

    return [{ seatId, label }];
  });
  const occurrences = new Map<string, number>();

  for (const participant of candidates) {
    occurrences.set(participant.seatId, (occurrences.get(participant.seatId) ?? 0) + 1);
  }

  return candidates.filter((participant) => occurrences.get(participant.seatId) === 1);
}

function normalizeGroups(
  groups: readonly RoomCockpitComposerGroupV1[],
  participantIds: ReadonlySet<string>,
): readonly VerifiedGroup[] {
  const candidates = groups.flatMap((group) => {
    const id = readText(group?.id);
    const label = readText(group?.label);
    const memberSeatIds = (Array.isArray(group?.memberSeatIds) ? group.memberSeatIds : [])
      ?.map((memberSeatId) => readText(memberSeatId))
      .filter((memberSeatId): memberSeatId is string => memberSeatId !== null);

    if (!id || !label || !memberSeatIds || memberSeatIds.length === 0) {
      return [];
    }

    const distinctMemberSeatIds = [...new Set(memberSeatIds)];
    if (distinctMemberSeatIds.length !== memberSeatIds.length || !distinctMemberSeatIds.every((seatId) => participantIds.has(seatId))) {
      return [];
    }

    return [{ id, label, memberSeatIds: distinctMemberSeatIds }];
  });
  const occurrences = new Map<string, number>();

  for (const group of candidates) {
    occurrences.set(group.id, (occurrences.get(group.id) ?? 0) + 1);
  }

  return candidates.filter((group) => occurrences.get(group.id) === 1);
}

function freezeTarget(
  mode: RoomCockpitComposerTargetModeV1,
  seatIds: readonly string[],
  groupId?: string,
): RoomCockpitComposerTargetV1 {
  const target = {
    mode,
    ...(groupId ? { groupId } : {}),
    seatIds: Object.freeze([...seatIds]),
  };

  return Object.freeze(target);
}

function resolveTarget(input: {
  readonly mode: RoomCockpitComposerTargetModeV1;
  readonly controllerSeatId: string | null;
  readonly participants: readonly VerifiedParticipant[];
  readonly groups: readonly VerifiedGroup[];
  readonly selectedGroupId: string | null;
  readonly selectedSeatIds: ReadonlySet<string>;
}): TargetResolution {
  const participantById = new Map(input.participants.map((participant) => [participant.seatId, participant]));

  if (input.mode === "controller") {
    const controller = input.controllerSeatId ? participantById.get(input.controllerSeatId) : undefined;
    if (!controller) {
      return {
        target: null,
        label: "Controller target unavailable",
        reason: "The configured controller is not a verified participant.",
      };
    }

    return {
      target: freezeTarget("controller", [controller.seatId]),
      label: `Controller · ${controller.label}`,
      reason: null,
    };
  }

  if (input.mode === "all") {
    if (input.participants.length === 0) {
      return {
        target: null,
        label: "All verified participants unavailable",
        reason: "No verified participant targets are available.",
      };
    }

    return {
      target: freezeTarget("all", input.participants.map((participant) => participant.seatId)),
      label: `All verified participants · ${input.participants.length}`,
      reason: null,
    };
  }

  if (input.mode === "group") {
    const group = input.groups.find((candidate) => candidate.id === input.selectedGroupId);
    if (!group) {
      return {
        target: null,
        label: "Group target unavailable",
        reason: "Select a verified target group.",
      };
    }

    return {
      target: freezeTarget("group", group.memberSeatIds, group.id),
      label: `Group · ${group.label} · ${group.memberSeatIds.length}`,
      reason: null,
    };
  }

  const selectedSeatIds = input.participants
    .map((participant) => participant.seatId)
    .filter((seatId) => input.selectedSeatIds.has(seatId));

  if (selectedSeatIds.length === 0) {
    return {
      target: null,
      label: "Selected participants · none",
      reason: "Select at least one verified participant.",
    };
  }

  return {
    target: freezeTarget("selection", selectedSeatIds),
    label: `Selected participants · ${selectedSeatIds.length}`,
    reason: null,
  };
}

function readSubmitResult(value: unknown): ComposerResult {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { kind: "failed", message: "The external guard returned an invalid result." };
  }

  const result = value as Record<string, unknown>;
  if (result.state === "accepted") {
    const receiptId = readText(result.receiptId);
    if (!receiptId) {
      return { kind: "failed", message: "The external guard returned an invalid acceptance receipt." };
    }
    const detail = readText(result.detail);
    return { kind: "accepted", message: detail ?? `Draft accepted by the guard. Receipt ${receiptId}.` };
  }

  const reason = readText(result.reason);
  if (result.state === "withheld" && reason) {
    return { kind: "withheld", message: reason };
  }
  if (result.state === "failed" && reason) {
    return { kind: "failed", message: reason };
  }

  return { kind: "failed", message: "The external guard returned an invalid result." };
}

export function RoomCockpitComposer({
  participants,
  controllerSeatId,
  groups = [],
  initialTargetMode = "controller",
  initialGroupId,
  initialSelectedSeatIds = [],
  onGuardedSubmit,
}: RoomCockpitComposerProps) {
  const verifiedParticipants = useMemo(() => normalizeParticipants(participants), [participants]);
  const verifiedParticipantIds = useMemo(
    () => new Set(verifiedParticipants.map((participant) => participant.seatId)),
    [verifiedParticipants],
  );
  const verifiedGroups = useMemo(
    () => normalizeGroups(groups, verifiedParticipantIds),
    [groups, verifiedParticipantIds],
  );
  const normalizedControllerSeatId = readText(controllerSeatId);
  const participantIdKey = verifiedParticipants.map((participant) => participant.seatId).join("\u0000");
  const [mode, setMode] = useState<RoomCockpitComposerTargetModeV1>(initialTargetMode);
  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(initialGroupId ?? null);
  const [selectedSeatIds, setSelectedSeatIds] = useState<ReadonlySet<string>>(
    () => new Set(initialSelectedSeatIds.flatMap((seatId) => readText(seatId))),
  );
  const [body, setBody] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<ComposerResult>(null);

  useEffect(() => {
    setSelectedSeatIds((current) => {
      const next = new Set([...current].filter((seatId) => verifiedParticipantIds.has(seatId)));
      return next.size === current.size ? current : next;
    });
  }, [participantIdKey, verifiedParticipantIds]);

  const activeGroupId = verifiedGroups.some((group) => group.id === selectedGroupId)
    ? selectedGroupId
    : (verifiedGroups[0]?.id ?? null);
  const target = resolveTarget({
    mode,
    controllerSeatId: normalizedControllerSeatId,
    participants: verifiedParticipants,
    groups: verifiedGroups,
    selectedGroupId: activeGroupId,
    selectedSeatIds,
  });
  const trimmedBody = body.trim();
  const bodyError = trimmedBody.length === 0 ? "Write a non-blank draft before guarded delivery." : null;
  const validationMessage = target.reason ?? bodyError;
  const canSubmit = !submitting && target.target !== null && bodyError === null;

  const toggleParticipant = useCallback((seatId: string) => {
    setSelectedSeatIds((current) => {
      const next = new Set(current);
      if (next.has(seatId)) {
        next.delete(seatId);
      } else {
        next.add(seatId);
      }
      return next;
    });
  }, []);

  const submitDraft = useCallback(async () => {
    if (!target.target || body.trim().length === 0 || submitting) {
      return;
    }

    const draft = Object.freeze({
      body: body.trim(),
      target: target.target,
    });
    setSubmitting(true);
    setResult(null);

    try {
      const guardedResult = await onGuardedSubmit(draft);
      setResult(readSubmitResult(guardedResult));
    } catch (error) {
      setResult({
        kind: "failed",
        message: error instanceof Error && error.message ? error.message : "The external guard could not complete delivery.",
      });
    } finally {
      setSubmitting(false);
    }
  }, [body, onGuardedSubmit, submitting, target.target]);

  const handleSubmit = useCallback((event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void submitDraft();
  }, [submitDraft]);

  return (
    <section className={styles.composer} aria-labelledby="room-cockpit-composer-title">
      <header className={styles.header}>
        <div>
          <p className={styles.eyebrow}>Guarded handoff</p>
          <h2 id="room-cockpit-composer-title">Compose Room draft</h2>
        </div>
        <p className={styles.targetReadout} role="status" aria-label="Current Room target" aria-live="polite">
          <span>Current target</span>
          <strong>{target.label}</strong>
        </p>
      </header>

      <p className={styles.guardNotice}>
        This editor creates a draft only. Text and target selection do not grant authority; the external guard decides delivery.
      </p>

      <form className={styles.form} onSubmit={handleSubmit} aria-describedby="room-cockpit-composer-validation">
        <fieldset className={styles.targetModes}>
          <legend>Target route</legend>
          <div className={styles.modeGrid}>
            <label className={styles.modeOption} data-active={mode === "controller"}>
              <input
                type="radio"
                name="room-cockpit-target-mode"
                value="controller"
                checked={mode === "controller"}
                onChange={() => setMode("controller")}
                disabled={submitting || !normalizedControllerSeatId || !verifiedParticipantIds.has(normalizedControllerSeatId)}
              />
              <span>Controller</span>
            </label>
            <label className={styles.modeOption} data-active={mode === "all"}>
              <input
                type="radio"
                name="room-cockpit-target-mode"
                value="all"
                checked={mode === "all"}
                onChange={() => setMode("all")}
                disabled={submitting || verifiedParticipants.length === 0}
              />
              <span>All verified</span>
            </label>
            <label className={styles.modeOption} data-active={mode === "group"}>
              <input
                type="radio"
                name="room-cockpit-target-mode"
                value="group"
                checked={mode === "group"}
                onChange={() => setMode("group")}
                disabled={submitting || verifiedGroups.length === 0}
              />
              <span>Verified group</span>
            </label>
            <label className={styles.modeOption} data-active={mode === "selection"}>
              <input
                type="radio"
                name="room-cockpit-target-mode"
                value="selection"
                checked={mode === "selection"}
                onChange={() => setMode("selection")}
                disabled={submitting || verifiedParticipants.length === 0}
              />
              <span>Multi-select</span>
            </label>
          </div>
        </fieldset>

        {mode === "group" ? (
          <label className={styles.groupControl}>
            <span>Verified group</span>
            <select
              value={activeGroupId ?? ""}
              onChange={(event) => setSelectedGroupId(event.target.value || null)}
              disabled={submitting || verifiedGroups.length === 0}
              aria-label="Verified target group"
            >
              {verifiedGroups.length === 0 ? <option value="">No verified groups</option> : null}
              {verifiedGroups.map((group) => (
                <option key={group.id} value={group.id}>{group.label} · {group.memberSeatIds.length}</option>
              ))}
            </select>
          </label>
        ) : null}

        {mode === "selection" ? (
          <fieldset className={styles.participantSelection}>
            <legend>Verified participant seats</legend>
            {verifiedParticipants.length === 0 ? (
              <p className={styles.emptySelection} role="status">No verified participant targets are available.</p>
            ) : (
              <ul aria-label="Verified participant targets">
                {verifiedParticipants.map((participant) => (
                  <li key={participant.seatId}>
                    <label>
                      <input
                        type="checkbox"
                        checked={selectedSeatIds.has(participant.seatId)}
                        onChange={() => toggleParticipant(participant.seatId)}
                        disabled={submitting}
                      />
                      <span>{participant.label}</span>
                      <code>{participant.seatId}</code>
                    </label>
                  </li>
                ))}
              </ul>
            )}
          </fieldset>
        ) : null}

        <label className={styles.messageControl}>
          <span>Draft message</span>
          <textarea
            value={body}
            onChange={(event) => setBody(event.target.value)}
            placeholder="Describe the next bounded action, evidence, or question."
            aria-label="Draft message"
            aria-required="true"
            rows={5}
            disabled={submitting}
          />
        </label>

        <p
          id="room-cockpit-composer-validation"
          className={styles.validation}
          role={validationMessage ? "alert" : "status"}
          aria-live="polite"
        >
          {validationMessage ?? "Target resolved from verified participant records. Delivery remains guard-controlled."}
        </p>

        <div className={styles.actions}>
          <button type="submit" disabled={!canSubmit}>
            {submitting ? "Submitting to guard…" : "Submit guarded draft"}
          </button>
          <span>Only the external guard may accept, withhold, or fail this draft.</span>
        </div>
      </form>

      {result ? (
        <p
          className={styles.result}
          data-state={result.kind}
          role={result.kind === "accepted" ? "status" : "alert"}
          aria-live="assertive"
        >
          {result.kind === "accepted" ? "Guard accepted delivery: " : result.kind === "withheld" ? "Delivery withheld: " : "Delivery failed: "}
          {result.message}
        </p>
      ) : null}
    </section>
  );
}
