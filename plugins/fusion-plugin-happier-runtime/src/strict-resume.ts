import {
  getHappierSessionStatus,
  resolveHappierCliSettings,
  startHappierResumeProcess,
  type HappierResumeProcessLease,
} from "./cli-spawn.js";
import type { HappierStopIdentity } from "./stop-state-store.js";
import {
  HappierCliError,
  type HappierCliSettings,
  type HappierSessionStatusResult,
} from "./types.js";

export interface StrictHappierResumeInput {
  readonly expectedIdentity: HappierStopIdentity;
  readonly settings: HappierCliSettings;
  readonly signal?: AbortSignal;
  readonly readCurrentIdentity: () => Promise<HappierStopIdentity>;
}

export interface StrictHappierResumeDependencies {
  readonly startResumeProcess?: (
    sessionId: string,
    settings?: HappierCliSettings,
    signal?: AbortSignal,
  ) => Promise<HappierResumeProcessLease>;
  readonly getStatus?: (
    sessionId: string,
    settings?: HappierCliSettings,
    signal?: AbortSignal,
  ) => Promise<HappierSessionStatusResult>;
  readonly delay?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  readonly now?: () => number;
}

function identitiesMatch(
  left: HappierStopIdentity,
  right: HappierStopIdentity,
): boolean {
  return left.keyHash === right.keyHash
    && left.happierSessionId === right.happierSessionId
    && left.serverProfileId === right.serverProfileId
    && left.machineId === right.machineId
    && left.providerId === right.providerId
    && left.providerSessionId === right.providerSessionId
    && left.canonicalSessionUri === right.canonicalSessionUri;
}

function assertExactIdentity(identity: HappierStopIdentity): void {
  if (
    !identity.serverProfileId
    || !identity.machineId
    || !identity.providerSessionId
    || !identity.canonicalSessionUri
  ) {
    throw new HappierCliError(
      "session",
      "Happier strict resume requires exact server, machine, Provider Session, and canonical URI identity",
      undefined,
      "resume_identity_incomplete",
    );
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new HappierCliError("timeout", "Happier strict resume aborted");
  }
}

function defaultDelay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  return new Promise<void>((resolveDelay, rejectDelay) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      rejectDelay(new HappierCliError("timeout", "Happier strict resume aborted"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolveDelay();
    }, milliseconds);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * FNXC:HappierStrictResume 2026-07-27-16:31:
 * An inactive canonical Session is resumed only through upstream
 * `happier resume <exact-id>`. The immutable Fusion binding supplies the
 * server/machine/provider-thread proof that upstream status does not expose;
 * it is checked both immediately before spawn and after exact active status.
 */
export async function resumeHappierSessionStrictly(
  input: StrictHappierResumeInput,
  dependencies: StrictHappierResumeDependencies = {},
): Promise<HappierResumeProcessLease> {
  const expected = input.expectedIdentity;
  assertExactIdentity(expected);
  const startResumeProcess = dependencies.startResumeProcess ?? startHappierResumeProcess;
  const getStatus = dependencies.getStatus ?? getHappierSessionStatus;
  const delay = dependencies.delay ?? defaultDelay;
  const now = dependencies.now ?? Date.now;
  const timeoutMs = resolveHappierCliSettings(input.settings).connectTimeoutMs!;
  const deadline = now() + timeoutMs;
  const before = await input.readCurrentIdentity();
  if (!identitiesMatch(expected, before)) {
    throw new HappierCliError(
      "session",
      "Happier strict resume identity drifted before Provider spawn",
      undefined,
      "resume_identity_drift",
    );
  }

  let lease: HappierResumeProcessLease | undefined;
  try {
    throwIfAborted(input.signal);
    lease = await startResumeProcess(
      expected.happierSessionId,
      input.settings,
      input.signal,
    );
    if (lease.sessionId !== expected.happierSessionId) {
      throw new HappierCliError(
        "session",
        "Happier resume lease returned a mismatched Session id",
        undefined,
        "resume_identity_drift",
      );
    }

    while (true) {
      throwIfAborted(input.signal);
      const status = await getStatus(
        expected.happierSessionId,
        input.settings,
        input.signal,
      );
      if (
        status.sessionId !== expected.happierSessionId
        || status.session.id !== expected.happierSessionId
      ) {
        throw new HappierCliError(
          "session",
          "Happier resume status returned a mismatched Session id",
          undefined,
          "resume_identity_drift",
        );
      }
      if (status.session.active === true) break;
      if (status.session.active !== false) {
        throw new HappierCliError(
          "session",
          "Happier resume status did not expose an exact active flag",
          undefined,
          "resume_status_unproven",
        );
      }
      if (now() >= deadline) {
        throw new HappierCliError(
          "timeout",
          "Happier resume did not become active before the connection deadline",
          undefined,
          "resume_active_timeout",
        );
      }
      await delay(Math.min(250, Math.max(1, deadline - now())), input.signal);
    }

    const after = await input.readCurrentIdentity();
    if (!identitiesMatch(expected, after)) {
      throw new HappierCliError(
        "session",
        "Happier strict resume identity drifted after Provider activation",
        undefined,
        "resume_identity_drift",
      );
    }
    return lease;
  } catch (error) {
    if (lease && !await lease.stop()) {
      throw new HappierCliError(
        "process",
        "Happier resume failed and Provider process tree exit was not confirmed",
        undefined,
        "process_tree_exit_unconfirmed",
      );
    }
    throw error;
  }
}
