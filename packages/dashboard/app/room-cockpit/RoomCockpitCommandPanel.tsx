import { useEffect, useState, type FormEvent } from "react";
import { withTokenHeader } from "../auth";
import styles from "./RoomCockpitCommandPanel.module.css";

export type RoomCockpitCommandFetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

type RoomCockpitCommandOperation = "create" | "attach" | "remove" | "restore" | "send";
type RoomCockpitSessionHealth =
  | "healthy"
  | "degraded"
  | "authentication_required"
  | "rate_limited"
  | "host_unavailable"
  | "unavailable"
  | "unknown";

interface ExistingSessionDraft {
  readonly seatId: string;
  readonly bindingId: string;
  readonly role: string;
  readonly connectorId: string;
  readonly canonicalSessionUri: string;
  readonly requiredHostId: string;
  readonly serverProfileId: string;
  readonly machineId: string;
  readonly providerId: string;
  readonly nativeSessionId: string;
  readonly model: string;
  readonly permissionScope: string;
  readonly health: RoomCockpitSessionHealth;
  readonly idempotencyKey: string;
}

interface PendingRoomCommand {
  readonly operation: RoomCockpitCommandOperation;
  readonly roomId: string;
  readonly commandId: string;
  readonly expectedAggregateVersion: number;
  readonly path: string;
  readonly body: Readonly<Record<string, unknown>>;
  readonly evidenceSummary: string;
}

interface RoomCommandAuditRecord {
  readonly operation: RoomCockpitCommandOperation;
  readonly commandId: string;
  readonly expectedAggregateVersion: number;
  readonly state: "accepted" | "rejected";
  readonly recordedAt: string;
  readonly httpStatus: number;
  readonly aggregateVersion: number | null;
  readonly currentAggregateVersion: number | null;
  readonly code: string | null;
}

export interface RoomCockpitCommandPanelProps {
  readonly projectId?: string;
  readonly activeRoomId?: string | null;
  readonly initiallyExpanded?: boolean;
  readonly fetchCommand?: RoomCockpitCommandFetcher;
  readonly commandIdFactory?: (operation: RoomCockpitCommandOperation) => string;
  readonly now?: () => string;
}

const SESSION_HEALTH_OPTIONS: readonly RoomCockpitSessionHealth[] = [
  "healthy",
  "degraded",
  "authentication_required",
  "rate_limited",
  "host_unavailable",
  "unavailable",
  "unknown",
];
const ROOM_MESSAGE_INTENTS = [
  "instruction",
  "proposal",
  "question",
  "critique",
  "challenge",
  "verdict",
  "handoff",
  "help_request",
] as const;
type RoomCockpitMessageIntent = typeof ROOM_MESSAGE_INTENTS[number];

const initialSession = (): ExistingSessionDraft => ({
  seatId: "",
  bindingId: "",
  role: "participant",
  connectorId: "happier-runtime",
  canonicalSessionUri: "",
  requiredHostId: "",
  serverProfileId: "",
  machineId: "",
  providerId: "",
  nativeSessionId: "",
  model: "",
  permissionScope: "",
  health: "unknown",
  idempotencyKey: "",
});

function defaultCommandIdFactory(operation: RoomCockpitCommandOperation): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  return uuid ? `room-cockpit:${operation}:${uuid}` : "";
}

function parseJsonObject(value: string): Readonly<Record<string, unknown>> | null {
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function parsePermissionScope(value: string): readonly string[] {
  return [...new Set(value.split(",").map((entry) => entry.trim()).filter(Boolean))];
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readNonNegativeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function readResponseCode(payload: unknown): string | null {
  if (!isRecord(payload)) return null;
  const details = isRecord(payload.details) ? payload.details : null;
  return typeof details?.code === "string" ? details.code : null;
}

function readCurrentAggregateVersion(payload: unknown): number | null {
  if (!isRecord(payload)) return null;
  const details = isRecord(payload.details) ? payload.details : null;
  return readNonNegativeInteger(details?.currentAggregateVersion);
}

async function readResponsePayload(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function evidenceSummary(session: ExistingSessionDraft): string {
  return [
    session.serverProfileId,
    session.machineId,
    session.providerId,
    session.nativeSessionId,
    session.model,
    session.permissionScope,
    session.health,
  ].join(" / ");
}

function toExactSessionRequest(session: ExistingSessionDraft): Readonly<Record<string, unknown>> {
  return {
    seatId: session.seatId,
    bindingId: session.bindingId,
    role: session.role,
    permissionScope: parsePermissionScope(session.permissionScope),
    connectorId: session.connectorId,
    canonicalSessionUri: session.canonicalSessionUri,
    requiredHostId: session.requiredHostId,
    requiredMachineId: session.machineId,
    idempotencyKey: session.idempotencyKey,
  };
}

function confirmationTitle(operation: RoomCockpitCommandOperation): string {
  if (operation === "create") return "Confirm create from existing sessions";
  if (operation === "attach") return "Confirm attach / add existing Session";
  if (operation === "remove") return "Confirm remove / exit participant";
  if (operation === "send") return "Confirm send operator action";
  return "Confirm restore existing Sessions";
}

/*
FNXC:RoomCockpitCommandConsole 2026-07-27-06:34:
Every Room mutation starts as an operator-visible command with an explicit commandId and operator-entered aggregate-version CAS, then crosses a separate review and confirmation boundary before any request is sent. Existing-session server, machine, provider, native Session, model, permission, and health observations stay visible, but the Cockpit excludes those evidence-only fields from the mutation contract and never converts them into capability certification. Create requires an operator-supplied capability snapshot and role constraints; the trusted backend remains responsible for validating them.
*/
export function RoomCockpitCommandPanel({
  projectId,
  activeRoomId,
  initiallyExpanded = true,
  fetchCommand = globalThis.fetch,
  commandIdFactory = defaultCommandIdFactory,
  now = () => new Date().toISOString(),
}: RoomCockpitCommandPanelProps) {
  const [expanded, setExpanded] = useState(initiallyExpanded);
  const [operation, setOperation] = useState<RoomCockpitCommandOperation>("create");
  const [commandId, setCommandId] = useState(() => initiallyExpanded ? commandIdFactory("create") : "");
  const [expectedAggregateVersion, setExpectedAggregateVersion] = useState("0");
  const [roomId, setRoomId] = useState("");
  const [targetRoomId, setTargetRoomId] = useState(activeRoomId ?? "");
  const [expectedMembershipVersion, setExpectedMembershipVersion] = useState("");
  const [membershipChangeId, setMembershipChangeId] = useState("");
  const [membershipReason, setMembershipReason] = useState("");
  const [seatIdToRemove, setSeatIdToRemove] = useState("");
  const [sendSeatId, setSendSeatId] = useState("");
  const [sendIntent, setSendIntent] = useState<RoomCockpitMessageIntent>("instruction");
  const [sendContent, setSendContent] = useState("");
  const [authorityEnvelope, setAuthorityEnvelope] = useState("");
  const [objective, setObjective] = useState("");
  const [protocolId, setProtocolId] = useState("fusion-room");
  const [protocolVersion, setProtocolVersion] = useState("1");
  const [session, setSession] = useState<ExistingSessionDraft>(initialSession);
  const [additionalSessions, setAdditionalSessions] = useState<readonly ExistingSessionDraft[]>([]);
  const [capabilitySnapshot, setCapabilitySnapshot] = useState("");
  const [roleConstraints, setRoleConstraints] = useState("");
  const [validationDetail, setValidationDetail] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingRoomCommand | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [audits, setAudits] = useState<readonly RoomCommandAuditRecord[]>([]);

  const updateSession = <Key extends keyof ExistingSessionDraft>(
    key: Key,
    value: ExistingSessionDraft[Key],
  ): void => {
    setSession((current) => ({ ...current, [key]: value }));
  };

  const updateAdditionalSession = <Key extends keyof ExistingSessionDraft>(
    index: number,
    key: Key,
    value: ExistingSessionDraft[Key],
  ): void => {
    setAdditionalSessions((current) => current.map((entry, entryIndex) => (
      entryIndex === index ? { ...entry, [key]: value } : entry
    )));
  };

  useEffect(() => {
    if (activeRoomId) setTargetRoomId(activeRoomId);
  }, [activeRoomId]);

  const selectOperation = (nextOperation: RoomCockpitCommandOperation): void => {
    setExpanded(true);
    setOperation(nextOperation);
    setCommandId(commandIdFactory(nextOperation));
    setExpectedAggregateVersion(nextOperation === "create" ? "0" : "");
    setValidationDetail(null);
    setPending(null);
  };

  const reviewCreate = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const expectedVersion = Number(expectedAggregateVersion);
    const parsedProtocolVersion = Number(protocolVersion);
    const createSessions = [session, ...additionalSessions];
    const parsedCapabilitySnapshot = parseJsonObject(capabilitySnapshot);
    const parsedRoleConstraints = parseJsonObject(roleConstraints);
    const requiredValues = [commandId, roomId, objective, protocolId];
    const hasIncompleteSession = createSessions.some((entry) => [
      entry.seatId,
      entry.bindingId,
      entry.role,
      entry.connectorId,
      entry.canonicalSessionUri,
      entry.requiredHostId,
      entry.serverProfileId,
      entry.machineId,
      entry.providerId,
      entry.nativeSessionId,
      entry.model,
      entry.idempotencyKey,
    ].some((value) => value.trim().length === 0) || parsePermissionScope(entry.permissionScope).length === 0);

    if (!projectId) {
      setValidationDetail("Select a project before reviewing a Room command.");
      return;
    }
    if (requiredValues.some((value) => value.trim().length === 0) || hasIncompleteSession) {
      setValidationDetail("Complete every identity, model, permission, health, Room, and command field before review.");
      return;
    }
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(commandId)) {
      setValidationDetail("Command ID must be a bounded canonical identifier.");
      return;
    }
    if (expectedVersion !== 0) {
      setValidationDetail("Creating a Room requires expected aggregate version 0.");
      return;
    }
    if (!Number.isSafeInteger(parsedProtocolVersion) || parsedProtocolVersion <= 0) {
      setValidationDetail("Protocol version must be a positive integer.");
      return;
    }
    if (parsedCapabilitySnapshot === null || parsedRoleConstraints === null) {
      setValidationDetail("Capability snapshot and role constraints must be explicit JSON objects.");
      return;
    }

    const body = {
      expectedAggregateVersion: 0,
      commandId,
      payload: {
        room: {
          id: roomId,
          objective,
          protocolId,
          protocolVersion: parsedProtocolVersion,
        },
        sessions: createSessions.map(toExactSessionRequest),
        roleAssignment: {
          capabilitySnapshot: parsedCapabilitySnapshot,
          constraints: parsedRoleConstraints,
        },
      },
    } as const;

    setValidationDetail(null);
    setPending({
      operation: "create",
      roomId,
      commandId,
      expectedAggregateVersion: 0,
      path: `/api/rooms?${new URLSearchParams({ projectId }).toString()}`,
      body,
      evidenceSummary: createSessions.map(evidenceSummary).join(" | "),
    });
  };

  const reviewAttach = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const expectedVersion = Number(expectedAggregateVersion);
    const membershipVersion = Number(expectedMembershipVersion);
    const permissionScope = parsePermissionScope(session.permissionScope);
    const requiredValues = [
      commandId,
      targetRoomId,
      membershipChangeId,
      membershipReason,
      session.seatId,
      session.bindingId,
      session.role,
      session.connectorId,
      session.canonicalSessionUri,
      session.requiredHostId,
      session.serverProfileId,
      session.machineId,
      session.providerId,
      session.nativeSessionId,
      session.model,
      session.idempotencyKey,
    ];

    if (!projectId) {
      setValidationDetail("Select a project before reviewing a Room command.");
      return;
    }
    if (requiredValues.some((value) => value.trim().length === 0) || permissionScope.length === 0) {
      setValidationDetail("Complete every identity, model, permission, health, membership, and command field before review.");
      return;
    }
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(commandId)) {
      setValidationDetail("Command ID must be a bounded canonical identifier.");
      return;
    }
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0) {
      setValidationDetail("Expected aggregate version must be a non-negative integer.");
      return;
    }
    if (!Number.isSafeInteger(membershipVersion) || membershipVersion < 0) {
      setValidationDetail("Expected membership version must be a non-negative integer.");
      return;
    }

    const body = {
      expectedAggregateVersion: expectedVersion,
      commandId,
      action: "request_add_existing_session",
      payload: {
        expectedMembershipVersion: membershipVersion,
        changeId: membershipChangeId,
        reason: membershipReason,
        session: toExactSessionRequest(session),
      },
    } as const;

    setValidationDetail(null);
    setPending({
      operation: "attach",
      roomId: targetRoomId,
      commandId,
      expectedAggregateVersion: expectedVersion,
      path: `/api/rooms/${encodeURIComponent(targetRoomId)}/actions?${new URLSearchParams({ projectId }).toString()}`,
      body,
      evidenceSummary: evidenceSummary(session),
    });
  };

  const reviewRestore = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const expectedVersion = Number(expectedAggregateVersion);
    if (!projectId) {
      setValidationDetail("Select a project before reviewing a Room command.");
      return;
    }
    if (!targetRoomId.trim() || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(commandId)) {
      setValidationDetail("Restore requires a bounded target Room ID and command ID.");
      return;
    }
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0) {
      setValidationDetail("Expected aggregate version must be a non-negative integer.");
      return;
    }
    const body = {
      expectedAggregateVersion: expectedVersion,
      commandId,
      action: "restore_existing_sessions",
      payload: {},
    } as const;
    setValidationDetail(null);
    setPending({
      operation: "restore",
      roomId: targetRoomId,
      commandId,
      expectedAggregateVersion: expectedVersion,
      path: `/api/rooms/${encodeURIComponent(targetRoomId)}/actions?${new URLSearchParams({ projectId }).toString()}`,
      body,
      evidenceSummary: "Restore uses only the Room's durable canonical bindings; no Session is imported, attached, replaced, or capability-certified by the Cockpit.",
    });
  };

  const reviewRemove = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const expectedVersion = Number(expectedAggregateVersion);
    const membershipVersion = Number(expectedMembershipVersion);

    if (!projectId) {
      setValidationDetail("Select a project before reviewing a Room command.");
      return;
    }
    if ([commandId, targetRoomId, membershipChangeId, membershipReason, seatIdToRemove]
      .some((value) => value.trim().length === 0)) {
      setValidationDetail("Remove requires explicit Room, participant, membership, reason, CAS, and command fields.");
      return;
    }
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(commandId)) {
      setValidationDetail("Command ID must be a bounded canonical identifier.");
      return;
    }
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0) {
      setValidationDetail("Expected aggregate version must be a non-negative integer.");
      return;
    }
    if (!Number.isSafeInteger(membershipVersion) || membershipVersion < 0) {
      setValidationDetail("Expected membership version must be a non-negative integer.");
      return;
    }

    const body = {
      expectedAggregateVersion: expectedVersion,
      commandId,
      action: "request_remove_existing_session",
      payload: {
        expectedMembershipVersion: membershipVersion,
        changeId: membershipChangeId,
        reason: membershipReason,
        seatId: seatIdToRemove,
      },
    } as const;

    setValidationDetail(null);
    setPending({
      operation: "remove",
      roomId: targetRoomId,
      commandId,
      expectedAggregateVersion: expectedVersion,
      path: `/api/rooms/${encodeURIComponent(targetRoomId)}/actions?${new URLSearchParams({ projectId }).toString()}`,
      body,
      evidenceSummary: `Participant ${seatIdToRemove} exits only after the trusted backend accepts CAS and activates the staged membership change at a completed turn boundary.`,
    });
  };

  const reviewSend = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const expectedVersion = Number(expectedAggregateVersion);
    const parsedAuthorityEnvelope = parseJsonObject(authorityEnvelope);

    if (!projectId) {
      setValidationDetail("Select a project before reviewing a Room command.");
      return;
    }
    if ([commandId, targetRoomId, sendSeatId, sendContent].some((value) => value.trim().length === 0)) {
      setValidationDetail("Operator action requires explicit Room, seat, message, CAS, and command fields.");
      return;
    }
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(commandId)) {
      setValidationDetail("Command ID must be a bounded canonical identifier.");
      return;
    }
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0) {
      setValidationDetail("Expected aggregate version must be a non-negative integer.");
      return;
    }
    if (parsedAuthorityEnvelope === null) {
      setValidationDetail("Authority envelope must be an explicit operator-provided JSON object.");
      return;
    }

    const body = {
      expectedAggregateVersion: expectedVersion,
      commandId,
      action: "send_to_seat",
      payload: {
        seatId: sendSeatId,
        intent: sendIntent,
        content: sendContent,
        authorityEnvelope: parsedAuthorityEnvelope,
      },
    } as const;

    setValidationDetail(null);
    setPending({
      operation: "send",
      roomId: targetRoomId,
      commandId,
      expectedAggregateVersion: expectedVersion,
      path: `/api/rooms/${encodeURIComponent(targetRoomId)}/actions?${new URLSearchParams({ projectId }).toString()}`,
      body,
      evidenceSummary: `${sendSeatId} / ${sendIntent} / operator-provided authority envelope / ${sendContent}`,
    });
  };

  const executePending = async (): Promise<void> => {
    if (!pending || submitting) return;
    setSubmitting(true);
    try {
      const response = await fetchCommand(pending.path, {
        method: "POST",
        headers: withTokenHeader({
          accept: "application/json",
          "content-type": "application/json",
        }),
        body: JSON.stringify(pending.body),
      });
      const payload = await readResponsePayload(response);
      const aggregateVersion = isRecord(payload) && payload.accepted === true
        ? readNonNegativeInteger(payload.aggregateVersion)
        : null;
      const accepted = response.ok && aggregateVersion !== null;
      const audit: RoomCommandAuditRecord = {
        operation: pending.operation,
        commandId: pending.commandId,
        expectedAggregateVersion: pending.expectedAggregateVersion,
        state: accepted ? "accepted" : "rejected",
        recordedAt: now(),
        httpStatus: response.status,
        aggregateVersion,
        currentAggregateVersion: readCurrentAggregateVersion(payload),
        code: readResponseCode(payload),
      };
      setAudits((current) => [audit, ...current].slice(0, 12));
      if (accepted) {
        setPending(null);
        setCommandId(commandIdFactory(pending.operation));
      }
    } catch {
      const audit: RoomCommandAuditRecord = {
        operation: pending.operation,
        commandId: pending.commandId,
        expectedAggregateVersion: pending.expectedAggregateVersion,
        state: "rejected",
        recordedAt: now(),
        httpStatus: 0,
        aggregateVersion: null,
        currentAggregateVersion: null,
        code: "ROOM_COMMAND_TRANSPORT_UNAVAILABLE",
      };
      setAudits((current) => [audit, ...current].slice(0, 12));
    } finally {
      setSubmitting(false);
    }
  };

  if (!expanded) {
    return (
      <section className={styles.panel} aria-labelledby="room-command-console-title">
        {/*
        FNXC:RoomCockpitCommandLauncher 2026-07-27-15:22:
        The compact route surface does not construct a commandId or render operation forms. One explicit operator click opens the full console and creates the first local command draft; no preflight data or Session binding crosses this launcher.
        */}
        <header className={styles.heading}>
          <div>
            <p className={styles.eyebrow}>Explicit command / CAS / audit</p>
            <h2 id="room-command-console-title">Room command console</h2>
            <p>Open the command surface explicitly; preflight results are never imported or attached here.</p>
          </div>
        </header>
        <div className={styles.compactBoundary}>
          <p role="status">No command draft or commandId exists until this control is opened.</p>
          <button
            type="button"
            className={styles.primaryButton}
            disabled={!projectId}
            onClick={() => selectOperation("create")}
          >
            Open Room command console
          </button>
        </div>
      </section>
    );
  }

  return (
    <section className={styles.panel} aria-labelledby="room-command-console-title">
      <header className={styles.heading}>
        <div>
          <p className={styles.eyebrow}>Explicit command / CAS / audit</p>
          <h2 id="room-command-console-title">Room command console</h2>
          <p>Build a Room from existing Sessions without importing, attaching, or certifying anything in the background.</p>
        </div>
        <span className={styles.boundary}>review → confirm → receipt</span>
      </header>

      <nav className={styles.operationTabs} aria-label="Room command operations">
        <button
          type="button"
          aria-pressed={operation === "create"}
          disabled={submitting}
          onClick={() => selectOperation("create")}
        >
          Create from existing sessions
        </button>
        <button
          type="button"
          aria-pressed={operation === "attach"}
          disabled={submitting}
          onClick={() => selectOperation("attach")}
        >
          Attach / add existing Session
        </button>
        <button
          type="button"
          aria-pressed={operation === "remove"}
          disabled={submitting}
          onClick={() => selectOperation("remove")}
        >
          Remove / exit participant
        </button>
        <button
          type="button"
          aria-pressed={operation === "restore"}
          disabled={submitting}
          onClick={() => selectOperation("restore")}
        >
          Restore existing Sessions
        </button>
        <button
          type="button"
          aria-pressed={operation === "send"}
          disabled={submitting}
          onClick={() => selectOperation("send")}
        >
          Send operator action
        </button>
      </nav>

      {pending ? (
        <section className={styles.confirmation} aria-labelledby="room-command-confirmation-title">
          <div>
            <p className={styles.eyebrow}>Second confirmation</p>
            <h3 id="room-command-confirmation-title">{confirmationTitle(pending.operation)}</h3>
          </div>
          <dl className={styles.reviewLedger}>
            <div><dt>Command ID</dt><dd>{pending.commandId}</dd></div>
            <div><dt>Expected aggregate version</dt><dd>{pending.expectedAggregateVersion}</dd></div>
            <div><dt>Room</dt><dd>{pending.roomId}</dd></div>
            <div><dt>Review evidence</dt><dd>{pending.evidenceSummary}</dd></div>
          </dl>
          <p className={styles.certificateBoundary}>
            {pending.operation === "create"
              ? "The displayed observations are not capability certification. Only the operator-supplied snapshot is forwarded for trusted backend validation."
              : pending.operation === "attach"
                ? "The displayed observations are not capability certification. The trusted connector and backend must revalidate the canonical Session."
                : pending.operation === "send"
                  ? "The Cockpit forwards only the operator-provided authority envelope; it does not mint, sign, expand, or validate authority."
                  : "This command does not infer participant identity, Session bindings, authority, or capability certification."}
          </p>
          <div className={styles.actions}>
            <button type="button" className={styles.secondaryButton} onClick={() => setPending(null)} disabled={submitting}>
              Back to edit
            </button>
            <button type="button" className={styles.primaryButton} onClick={() => void executePending()} disabled={submitting}>
              {submitting ? "Executing…" : `Confirm and execute ${pending.operation}`}
            </button>
          </div>
        </section>
      ) : (
        <form
          className={styles.form}
          onSubmit={
            operation === "create"
              ? reviewCreate
              : operation === "attach"
                ? reviewAttach
                : operation === "remove"
                  ? reviewRemove
                  : operation === "send"
                    ? reviewSend
                    : reviewRestore
          }
        >
          <fieldset className={styles.fieldset} disabled={!projectId}>
            <legend>Command and compare-and-set</legend>
            <div className={styles.formGrid}>
              <TextField label="Command ID" value={commandId} onChange={setCommandId} />
              <NumberField
                label="Expected aggregate version (CAS)"
                value={expectedAggregateVersion}
                onChange={setExpectedAggregateVersion}
                minimum={0}
              />
              {operation === "create" ? (
                <>
                  <TextField label="New Room ID" value={roomId} onChange={setRoomId} />
                  <TextField label="Objective" value={objective} onChange={setObjective} />
                  <TextField label="Protocol ID" value={protocolId} onChange={setProtocolId} />
                  <NumberField label="Protocol version" value={protocolVersion} onChange={setProtocolVersion} minimum={1} />
                </>
              ) : operation === "attach" || operation === "remove" ? (
                <>
                  <TextField label="Target Room ID" value={targetRoomId} onChange={setTargetRoomId} />
                  <NumberField
                    label="Expected membership version"
                    value={expectedMembershipVersion}
                    onChange={setExpectedMembershipVersion}
                    minimum={0}
                  />
                  <TextField label="Membership change ID" value={membershipChangeId} onChange={setMembershipChangeId} />
                  <TextField label="Reason" value={membershipReason} onChange={setMembershipReason} />
                  {operation === "remove" ? (
                    <TextField label="Seat ID to remove" value={seatIdToRemove} onChange={setSeatIdToRemove} />
                  ) : null}
                </>
              ) : operation === "send" ? (
                <>
                  <TextField label="Target Room ID" value={targetRoomId} onChange={setTargetRoomId} />
                  <TextField label="Target Seat ID" value={sendSeatId} onChange={setSendSeatId} />
                  <label className={styles.field}>
                    <span>Message intent</span>
                    <select
                      value={sendIntent}
                      onChange={(event) => setSendIntent(event.target.value as RoomCockpitMessageIntent)}
                    >
                      {ROOM_MESSAGE_INTENTS.map((intent) => <option key={intent} value={intent}>{intent}</option>)}
                    </select>
                  </label>
                </>
              ) : (
                <TextField label="Target Room ID" value={targetRoomId} onChange={setTargetRoomId} />
              )}
            </div>
          </fieldset>

          {operation === "create" || operation === "attach" ? (
            <>
              <ExistingSessionFieldset
                ordinal={1}
                session={session}
                onChange={updateSession}
                disabled={!projectId}
              />
              {operation === "create" ? additionalSessions.map((additionalSession, index) => (
                <ExistingSessionFieldset
                  key={`existing-session-draft:${index}`}
                  ordinal={index + 2}
                  session={additionalSession}
                  onChange={(key, value) => updateAdditionalSession(index, key, value)}
                  onRemove={() => setAdditionalSessions((current) => current.filter(
                    (_entry, entryIndex) => entryIndex !== index,
                  ))}
                  disabled={!projectId}
                />
              )) : null}
              {operation === "create" ? (
                <>
                  <p className={styles.certificateBoundary}>
                    Session drafts appear only after this explicit operator action. Preflight results are never copied or attached in the background.
                  </p>
                  <div className={styles.actions}>
                    <button
                      type="button"
                      className={styles.secondaryButton}
                      disabled={!projectId}
                      onClick={() => setAdditionalSessions((current) => [...current, initialSession()])}
                    >
                      Add another existing Session
                    </button>
                  </div>
                </>
              ) : null}
            </>
          ) : null}

          {operation === "create" ? (
            <fieldset className={styles.fieldset} disabled={!projectId}>
              <legend>Operator-supplied policy evidence</legend>
              <p className={styles.certificateBoundary}>
                This console never auto-creates capability certification. Paste the exact certified snapshot and role constraints from the trusted policy path.
              </p>
              <div className={styles.policyGrid}>
                <TextAreaField label="Capability snapshot JSON" value={capabilitySnapshot} onChange={setCapabilitySnapshot} />
                <TextAreaField label="Role constraints JSON" value={roleConstraints} onChange={setRoleConstraints} />
              </div>
            </fieldset>
          ) : operation === "attach" ? (
            <p className={styles.certificateBoundary}>
              Session evidence remains operator-entered and visible. Attach requests do not mint capability certification; the trusted connector and backend revalidate the canonical Session before staging membership.
            </p>
          ) : operation === "remove" ? (
            <p className={styles.certificateBoundary}>
              Exit is an explicit staged membership request. The Cockpit neither infers a participant from the current view nor claims removal before the trusted backend accepts CAS and activates the change at a completed turn boundary.
            </p>
          ) : operation === "send" ? (
            <fieldset className={styles.fieldset} disabled={!projectId}>
              <legend>Operator-supplied action and authority</legend>
              <p className={styles.certificateBoundary}>
                This console never creates, mints, or infers an authority envelope. Paste the exact envelope from the trusted authority path for backend validation.
              </p>
              <div className={styles.policyGrid}>
                <TextAreaField label="Operator message" value={sendContent} onChange={setSendContent} />
                <TextAreaField label="Authority envelope JSON" value={authorityEnvelope} onChange={setAuthorityEnvelope} />
              </div>
            </fieldset>
          ) : (
            <p className={styles.certificateBoundary}>
              Restore uses only the Room&apos;s durable canonical bindings. It does not accept or infer a replacement Session, model, permission, health state, or capability certificate.
            </p>
          )}

          {!projectId ? <p className={styles.validation} role="status">Select a project before building a Room command.</p> : null}
          {validationDetail ? <p className={styles.validation} role="alert">{validationDetail}</p> : null}
          <div className={styles.actions}>
            <button type="submit" className={styles.primaryButton} disabled={!projectId}>
              {operation === "create"
                ? "Review create command"
                : operation === "attach"
                  ? "Review attach command"
                  : operation === "remove"
                    ? "Review remove command"
                    : operation === "send"
                      ? "Review operator action"
                      : "Review restore command"}
            </button>
          </div>
        </form>
      )}

      {audits.length > 0 ? (
        <section className={styles.auditSection} aria-labelledby="room-command-audit-title">
          <div className={styles.auditHeading}>
            <p className={styles.eyebrow}>Visible command receipts</p>
            <h3 id="room-command-audit-title">Local audit results</h3>
          </div>
          <ol className={styles.auditList} aria-label="Room command audit results">
            {audits.map((audit) => (
              <li key={`${audit.recordedAt}:${audit.commandId}`} data-state={audit.state}>
                <strong>{audit.operation} / {audit.commandId}</strong>
                <span>{audit.state === "accepted" && audit.aggregateVersion !== null
                  ? `accepted at aggregate version ${audit.aggregateVersion}`
                  : audit.currentAggregateVersion !== null
                    ? `rejected by CAS; current aggregate version ${audit.currentAggregateVersion}`
                    : `rejected (${audit.code ?? `HTTP ${audit.httpStatus}`})`}</span>
                <small>expected {audit.expectedAggregateVersion} · {audit.recordedAt}</small>
              </li>
            ))}
          </ol>
        </section>
      ) : null}
    </section>
  );
}

function ExistingSessionFieldset({
  ordinal,
  session,
  onChange,
  onRemove,
  disabled,
}: {
  readonly ordinal: number;
  readonly session: ExistingSessionDraft;
  readonly onChange: <Key extends keyof ExistingSessionDraft>(
    key: Key,
    value: ExistingSessionDraft[Key],
  ) => void;
  readonly onRemove?: () => void;
  readonly disabled: boolean;
}) {
  return (
    <fieldset className={styles.fieldset} disabled={disabled}>
      <legend>Existing Session {ordinal}</legend>
      {onRemove ? (
        <div className={styles.actions}>
          <button type="button" className={styles.secondaryButton} onClick={onRemove}>
            Remove Existing Session {ordinal}
          </button>
        </div>
      ) : null}
      <div className={styles.formGrid}>
        <TextField label="Seat ID" value={session.seatId} onChange={(value) => onChange("seatId", value)} />
        <TextField label="Binding ID" value={session.bindingId} onChange={(value) => onChange("bindingId", value)} />
        <TextField label="Role" value={session.role} onChange={(value) => onChange("role", value)} />
        <TextField label="Connector ID" value={session.connectorId} onChange={(value) => onChange("connectorId", value)} />
        <TextField label="Canonical Session URI" value={session.canonicalSessionUri} onChange={(value) => onChange("canonicalSessionUri", value)} />
        <TextField label="Host ID" value={session.requiredHostId} onChange={(value) => onChange("requiredHostId", value)} />
        <TextField label="Server profile" value={session.serverProfileId} onChange={(value) => onChange("serverProfileId", value)} />
        <TextField label="Machine" value={session.machineId} onChange={(value) => onChange("machineId", value)} />
        <TextField label="Provider" value={session.providerId} onChange={(value) => onChange("providerId", value)} />
        <TextField label="Native Session" value={session.nativeSessionId} onChange={(value) => onChange("nativeSessionId", value)} />
        <TextField label="Model" value={session.model} onChange={(value) => onChange("model", value)} />
        <TextField label="Permission scope" value={session.permissionScope} onChange={(value) => onChange("permissionScope", value)} />
        <label className={styles.field}>
          <span>Health</span>
          <select
            value={session.health}
            onChange={(event) => onChange("health", event.target.value as RoomCockpitSessionHealth)}
          >
            {SESSION_HEALTH_OPTIONS.map((health) => <option key={health} value={health}>{health}</option>)}
          </select>
        </label>
        <TextField
          label="Session idempotency key"
          value={session.idempotencyKey}
          onChange={(value) => onChange("idempotencyKey", value)}
        />
      </div>
    </fieldset>
  );
}

function TextField({
  label,
  value,
  onChange,
}: {
  readonly label: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
}) {
  return (
    <label className={styles.field}>
      <span>{label}</span>
      <input type="text" value={value} onChange={(event) => onChange(event.target.value)} />
    </label>
  );
}

function NumberField({
  label,
  value,
  onChange,
  minimum,
}: {
  readonly label: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly minimum: number;
}) {
  return (
    <label className={styles.field}>
      <span>{label}</span>
      <input type="number" min={minimum} step={1} value={value} onChange={(event) => onChange(event.target.value)} />
    </label>
  );
}

function TextAreaField({
  label,
  value,
  onChange,
}: {
  readonly label: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
}) {
  return (
    <label className={styles.field}>
      <span>{label}</span>
      <textarea value={value} onChange={(event) => onChange(event.target.value)} spellCheck={false} />
    </label>
  );
}
