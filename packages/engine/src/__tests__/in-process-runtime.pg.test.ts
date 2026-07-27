/*
FNXC:PostgresRuntimeComposition 2026-07-14-18:49:
The production InProcessRuntime must compose one owned PostgreSQL backend across TaskStore, central claims, and missions, then release that backend exactly once. This real-database lifecycle test guards the wiring seam that component-only tests cannot cover.
*/

import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import {
  createTaskStoreForTest,
  pgDescribe,
} from "../../../core/src/__test-utils__/pg-test-harness.js";

const lifecycle = vi.hoisted(() => ({ shutdownCalls: 0 }));

vi.mock("@fusion/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@fusion/core")>();
  return {
    ...actual,
    createTaskStoreForBackend: async (
      options: Parameters<typeof actual.createTaskStoreForBackend>[0],
    ) => {
      const boot = await actual.createTaskStoreForBackend(options);
      const shutdown = boot.shutdown;
      return {
        ...boot,
        shutdown: async () => {
          lifecycle.shutdownCalls += 1;
          await shutdown();
        },
      };
    },
  };
});

import {
  CentralCore,
  createConnectionSetFromUrl,
  type AsyncCentralClaimStore,
} from "@fusion/core";
import { MissionExecutionLoop } from "../mission-execution-loop.js";
import { InProcessRuntime } from "../runtimes/in-process-runtime.js";
import type { GlobalCapacityLegacyDispatchControlV1 } from "../global-capacity-legacy-dispatch-control.js";

/*
FNXC:PostgresRuntimeStepDeadline 2026-07-27-03:20:
Keep real-database composition failures attributable to the exact lifecycle
boundary instead of allowing the outer Vitest timeout to hide the blocked call.
*/
async function withStepDeadline<T>(
  label: string,
  operation: Promise<T>,
  timeoutMs = 15_000,
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error(`PostgreSQL runtime composition step timed out: ${label}`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

/*
FNXC:PostgresRuntimeDatabaseCleanup 2026-07-27-18:05:
A passing runtime lifecycle test must prove its disposable PostgreSQL database
was dropped, not only that the runtime-owned pools reported shutdown.
*/
async function expectDatabaseDropped(testUrl: string): Promise<void> {
  const connections = await createConnectionSetFromUrl({
    mode: "external",
    runtimeUrl: testUrl,
    migrationUrl: testUrl,
    migrationUrlOverridden: false,
  }, {
    poolMax: 1,
    connectTimeoutSeconds: 5,
  });
  try {
    await expect(connections.ping()).rejects.toMatchObject({ code: "3D000" });
  } finally {
    await connections.close();
  }
}

pgDescribe("InProcessRuntime PostgreSQL composition", () => {
  it("shares its PostgreSQL layer with claims and missions and shuts it down once", async () => {
    /*
    FNXC:PostgresRuntimeComposition 2026-07-14-21:33:
    Runtime composition coverage must use the controlled PostgreSQL harness so availability gating and database administration share the repository's bounded asynchronous lifecycle. Runtime and central connections must close in a finally block before the harness drops the database, including when an assertion fails early.
    */
    lifecycle.shutdownCalls = 0;
    const harness = await withStepDeadline(
      "create test database",
      createTaskStoreForTest({ prefix: "fusion_runtime" }),
      60_000,
    );
    const priorDatabaseUrl = process.env.DATABASE_URL;
    let projectDir = "";
    let globalDir = "";
    let central: CentralCore | undefined;
    let runtime: InProcessRuntime | undefined;
    let restartCentral: CentralCore | undefined;
    let restartRuntime: InProcessRuntime | undefined;
    let restartValidationSpy: { mockRestore(): void } | undefined;

    try {
      projectDir = await mkdtemp(join(tmpdir(), "fusion-runtime-pg-project-"));
      globalDir = await mkdtemp(join(tmpdir(), "fusion-runtime-pg-global-"));
      execFileSync("git", ["init", "-q", projectDir], { stdio: "pipe" });
      process.env.DATABASE_URL = harness.testUrl;

      /*
      FNXC:GlobalCapacityProductionComposition 2026-07-27-04:09:
      Install the authority through the unscoped host layer before runtime
      composition and retain two normal slots beside verifier/recovery
      reservations. This is the real restart contract: projects consume one
      central policy; they never synthesize a local fallback.
      */
      const authorityCentral = new CentralCore(globalDir, { asyncLayer: harness.layer });
      await authorityCentral.init();
      try {
        await authorityCentral.updateGlobalConcurrency({ globalMaxConcurrent: 4 });
        await authorityCentral.installGlobalCapacityPolicyAuthorityV1({
          expectedRevision: 0,
          policy: {
            reservations: {
              verifierSlots: 1,
              recoverySlots: 1,
              legacyTaskTriageSlots: 0,
            },
            snapshotTtlMs: 60_000,
            leaseTtlMs: 300_000,
          },
        });
        await authorityCentral.markLocalNodeOffline();
      } finally {
        await authorityCentral.close();
      }

      central = new CentralCore(globalDir);
      runtime = new InProcessRuntime({
        projectId: "runtime-composition",
        workingDirectory: projectDir,
        isolationMode: "in-process",
        maxConcurrent: 1,
        maxWorktrees: 1,
      }, central);
      runtime.on("error", () => undefined);

      await withStepDeadline("start runtime", runtime.start());
      const taskStore = runtime.getTaskStore();
      const layer = taskStore.getAsyncLayer();
      expect(runtime.getStatus()).toBe("active");
      expect(taskStore.isBackendMode()).toBe(true);
      expect(layer?.projectId).toBe("runtime-composition");
      expect(runtime.getMissionExecutionLoop()).toBeDefined();
      const runtimeInternals = runtime as unknown as {
        usageLimitPauser?: unknown;
        triageProcessor?: { options?: { usageLimitPauser?: unknown } };
      };
      expect(runtimeInternals.usageLimitPauser).toBeDefined();
      expect(runtimeInternals.triageProcessor?.options?.usageLimitPauser)
        .toBe(runtimeInternals.usageLimitPauser);

      const capacityInternals = runtime as unknown as {
        executor?: {
          options?: {
            globalCapacityLegacyDispatchControl?: GlobalCapacityLegacyDispatchControlV1;
          };
        };
        triageProcessor?: {
          options?: {
            globalCapacityLegacyDispatchControl?: GlobalCapacityLegacyDispatchControlV1;
          };
        };
      };
      const executorCapacity = capacityInternals.executor?.options?.globalCapacityLegacyDispatchControl;
      const triageCapacity = capacityInternals.triageProcessor?.options?.globalCapacityLegacyDispatchControl;
      expect(executorCapacity).toBeDefined();
      expect(triageCapacity).toBe(executorCapacity);

      const executorGrant = await withStepDeadline(
        "grant executor capacity",
        executorCapacity!.begin({
          resourceKind: "legacy_task",
          resourceId: "FN-RUNTIME-CAPACITY-EXECUTOR",
          workClass: "normal",
          slots: 1,
        }),
      );
      expect(executorGrant.state).toBe("execution_granted");
      if (executorGrant.state !== "execution_granted") {
        throw new Error(`Executor capacity was not granted: ${executorGrant.state}`);
      }

      const triageGrant = await withStepDeadline(
        "grant triage capacity",
        triageCapacity!.begin({
          resourceKind: "legacy_triage",
          resourceId: "FN-RUNTIME-CAPACITY-TRIAGE",
          workClass: "normal",
          slots: 1,
        }),
      );
      expect(triageGrant.state).toBe("execution_granted");
      if (triageGrant.state !== "execution_granted") {
        throw new Error(`Triage capacity was not granted: ${triageGrant.state}`);
      }
      await expect(withStepDeadline("release executor capacity", executorGrant.handle.finish()))
        .resolves.toMatchObject({ state: "released" });
      await expect(withStepDeadline("release triage capacity", triageGrant.handle.finish()))
        .resolves.toMatchObject({ state: "released" });

      const missionStore = taskStore.getMissionStore();
      const mission = await withStepDeadline(
        "create mission",
        missionStore.createMission({ title: "Runtime composition" }),
      );
      expect((await withStepDeadline("read mission", missionStore.getMission(mission.id)))?.title)
        .toBe("Runtime composition");

      /*
      FNXC:PostgresMissionRuntimeParity 2026-07-27-05:05:
      A validation pass in the production PostgreSQL runtime is not complete
      until the awaited mission callback has advanced the next pending slice.
      This exercises the real AsyncMissionStore rather than a promise-shaped mock.
      */
      const validationMission = await withStepDeadline(
        "create validation mission",
        missionStore.createMission({
          title: "PostgreSQL validation and slice advance",
          autopilotEnabled: true,
        }),
      );
      await withStepDeadline(
        "activate validation mission",
        missionStore.updateMission(validationMission.id, {
          status: "active",
          autoAdvance: true,
          autopilotEnabled: true,
        }),
      );
      const validationMilestone = await withStepDeadline(
        "create validation milestone",
        missionStore.addMilestone(validationMission.id, { title: "Validation milestone" }),
      );
      const validationSlice = await withStepDeadline(
        "create active validation slice",
        missionStore.addSlice(validationMilestone.id, { title: "Active slice" }),
      );
      const nextValidationSlice = await withStepDeadline(
        "create pending validation slice",
        missionStore.addSlice(validationMilestone.id, { title: "Next slice" }),
      );
      await withStepDeadline(
        "activate validation slice",
        missionStore.updateSlice(validationSlice.id, { status: "active" }),
      );
      const validationFeature = await withStepDeadline(
        "create validation feature",
        missionStore.addFeature(validationSlice.id, {
          title: "Validate PostgreSQL mission path",
          acceptanceCriteria: "The PostgreSQL validation path passes.",
        }),
      );
      const validationTask = await withStepDeadline(
        "create completed validation task",
        taskStore.createTask({
          title: validationFeature.title,
          description: "Completed implementation for PostgreSQL mission validation",
          column: "done",
          missionId: validationMission.id,
          sliceId: validationSlice.id,
        }),
      );
      await withStepDeadline(
        "link validation feature task",
        missionStore.linkFeatureToTask(validationFeature.id, validationTask.id),
      );
      const [validationAssertion] = await withStepDeadline(
        "ensure validation assertion",
        missionStore.ensureFeatureAssertionLinked(validationFeature.id),
      );
      expect(validationAssertion).toBeDefined();

      const missionExecutionLoop = runtime.getMissionExecutionLoop();
      expect(missionExecutionLoop).toBeDefined();
      const missionAutopilot = (runtime as unknown as {
        missionAutopilot?: {
          isWatching(missionId: string): boolean;
          unwatchMission(missionId: string): Promise<void>;
          watchMission(missionId: string): Promise<void>;
          handleTaskCompletion(taskId: string): Promise<void>;
        };
      }).missionAutopilot;
      expect(missionAutopilot).toBeDefined();
      await missionAutopilot!.unwatchMission(validationMission.id);
      expect(missionAutopilot!.isWatching(validationMission.id)).toBe(false);

      let watchMissionPersisted = false;
      let releaseWatchMission!: () => void;
      const watchMissionGate = new Promise<void>((resolve) => {
        releaseWatchMission = resolve;
      });
      let markWatchMissionObserved!: () => void;
      const watchMissionObserved = new Promise<void>((resolve) => {
        markWatchMissionObserved = resolve;
      });
      const originalIsWatching = missionAutopilot!.isWatching.bind(missionAutopilot);
      const isWatchingSpy = vi.spyOn(missionAutopilot!, "isWatching")
        .mockImplementation((missionId) => (
          watchMissionPersisted && originalIsWatching(missionId)
        ));
      const originalWatchMission = missionAutopilot!.watchMission.bind(missionAutopilot);
      const watchMissionSpy = vi.spyOn(missionAutopilot!, "watchMission")
        .mockImplementation(async (missionId) => {
          markWatchMissionObserved();
          await watchMissionGate;
          await originalWatchMission(missionId);
          watchMissionPersisted = true;
        });
      const handleTaskCompletionSpy = vi.spyOn(missionAutopilot!, "handleTaskCompletion");
      const validationRunnerSpy = vi.spyOn(missionExecutionLoop as any, "runValidation")
        .mockResolvedValue({
        result: {
          status: "pass",
          assertions: [{
            assertionId: validationAssertion!.id,
            verdict: "pass",
            passed: true,
            message: "PostgreSQL validation passed",
            evidence: [{ kind: "test-output", text: "real PostgreSQL integration fixture" }],
          }],
          summary: "PostgreSQL validation passed",
        },
        inspection: {
          inspectionRoot: projectDir,
          landedSha: undefined,
          fallbackUsed: true,
          workspaceStale: false,
        },
      });
      const validationOutcome = withStepDeadline(
        "process PostgreSQL validation",
        missionExecutionLoop!.processTaskOutcome(validationTask.id),
      );
      let completionStartedBeforeWatchPersisted = false;
      try {
        await withStepDeadline("observe mission watch callback", watchMissionObserved);
        expect(watchMissionSpy).toHaveBeenCalledWith(validationMission.id);
        completionStartedBeforeWatchPersisted = handleTaskCompletionSpy.mock.calls.length > 0;
      } finally {
        releaseWatchMission();
      }
      await validationOutcome;
      await withStepDeadline(
        "persist mission watch callback",
        Promise.all(watchMissionSpy.mock.results.map(async (result) => result.value)),
      );
      expect(completionStartedBeforeWatchPersisted).toBe(false);

      expect(await withStepDeadline(
        "read validated feature",
        missionStore.getFeature(validationFeature.id),
      )).toMatchObject({
        status: "done",
        loopState: "passed",
        lastValidatorStatus: "passed",
      });
      expect(await withStepDeadline(
        "read passed assertion",
        missionStore.getContractAssertion(validationAssertion!.id),
      )).toMatchObject({ status: "passed" });
      expect(await withStepDeadline(
        "read completed validation slice",
        missionStore.getSlice(validationSlice.id),
      )).toMatchObject({ status: "complete" });
      expect(await withStepDeadline(
        "read advanced validation slice",
        missionStore.getSlice(nextValidationSlice.id),
      )).toMatchObject({ status: "active" });
      watchMissionSpy.mockRestore();
      handleTaskCompletionSpy.mockRestore();
      isWatchingSpy.mockRestore();

      /*
      FNXC:PostgresMissionValidationFailure 2026-07-27-06:01:
      A real PostgreSQL validator failure must durably settle the validator run,
      linked assertion, and feature loop before processTaskOutcome resolves.
      Supervised missions remain report-only and must not mint remediation.
      */
      const validatorFailureMission = await withStepDeadline(
        "create validator failure mission",
        missionStore.createMission({
          title: "PostgreSQL validator failure",
          autopilotEnabled: false,
        }),
      );
      const validatorFailureMilestone = await withStepDeadline(
        "create validator failure milestone",
        missionStore.addMilestone(validatorFailureMission.id, {
          title: "Validator failure milestone",
        }),
      );
      const validatorFailureSlice = await withStepDeadline(
        "create validator failure slice",
        missionStore.addSlice(validatorFailureMilestone.id, {
          title: "Validator failure slice",
        }),
      );
      await withStepDeadline(
        "activate validator failure slice",
        missionStore.updateSlice(validatorFailureSlice.id, { status: "active" }),
      );
      const validatorFailureFeature = await withStepDeadline(
        "create validator failure feature",
        missionStore.addFeature(validatorFailureSlice.id, {
          title: "Reject invalid PostgreSQL mission output",
          acceptanceCriteria: "The validator records the observed mismatch.",
        }),
      );
      const validatorFailureTask = await withStepDeadline(
        "create completed validator failure task",
        taskStore.createTask({
          title: validatorFailureFeature.title,
          description: "Completed implementation that fails mission validation",
          column: "done",
          missionId: validatorFailureMission.id,
          sliceId: validatorFailureSlice.id,
        }),
      );
      await withStepDeadline(
        "link validator failure task",
        missionStore.linkFeatureToTask(validatorFailureFeature.id, validatorFailureTask.id),
      );
      const [validatorFailureAssertion] = await withStepDeadline(
        "ensure validator failure assertion",
        missionStore.ensureFeatureAssertionLinked(validatorFailureFeature.id),
      );
      expect(validatorFailureAssertion).toBeDefined();
      await withStepDeadline(
        "activate validator failure mission",
        missionStore.updateMission(validatorFailureMission.id, {
          status: "active",
          autoAdvance: false,
          autopilotEnabled: false,
        }),
      );
      validationRunnerSpy.mockResolvedValueOnce({
        result: {
          status: "fail",
          assertions: [{
            assertionId: validatorFailureAssertion!.id,
            verdict: "fail",
            passed: false,
            message: "Observed PostgreSQL mission output did not satisfy the contract",
            expected: "contract satisfied",
            actual: "contract violated",
            evidence: [{ kind: "test-output", text: "real PostgreSQL failure fixture" }],
          }],
          summary: "PostgreSQL validation failed",
        },
        inspection: {
          inspectionRoot: projectDir,
          landedSha: undefined,
          fallbackUsed: true,
          workspaceStale: false,
        },
      });
      await withStepDeadline(
        "process PostgreSQL validation failure",
        missionExecutionLoop!.processTaskOutcome(validatorFailureTask.id),
      );
      const validatorFailureRuns = await withStepDeadline(
        "read failed validator runs",
        missionStore.getValidatorRunsByFeature(validatorFailureFeature.id),
      );
      expect(validatorFailureRuns).toHaveLength(1);
      expect(validatorFailureRuns[0]).toMatchObject({
        status: "failed",
        taskId: validatorFailureTask.id,
      });
      expect(await withStepDeadline(
        "read failed validator assertion",
        missionStore.getContractAssertion(validatorFailureAssertion!.id),
      )).toMatchObject({ status: "failed" });
      expect(await withStepDeadline(
        "read failed validator feature",
        missionStore.getFeature(validatorFailureFeature.id),
      )).toMatchObject({
        loopState: "needs_fix",
        lastValidatorStatus: "failed",
      });
      expect((await withStepDeadline(
        "list report-only failure features",
        missionStore.listFeatures(validatorFailureSlice.id),
      )).filter((feature) => feature.generatedFromFeatureId === validatorFailureFeature.id))
        .toHaveLength(0);

      /*
      FNXC:PostgresMissionFailureReconciliation 2026-07-27-05:15:
      Scheduler reconciliation may report a failed task as repaired only after
      the runtime's awaited autopilot failure path has durably blocked the
      feature. A fire-and-forget callback is not PostgreSQL completion evidence.
      */
      const failureMission = await withStepDeadline(
        "create failure mission",
        missionStore.createMission({
          title: "PostgreSQL failure reconciliation",
          autopilotEnabled: true,
        }),
      );
      await withStepDeadline(
        "enable failure mission autopilot",
        missionStore.updateMission(failureMission.id, { autopilotEnabled: true }),
      );
      const failureMilestone = await withStepDeadline(
        "create failure milestone",
        missionStore.addMilestone(failureMission.id, { title: "Failure milestone" }),
      );
      const failureSlice = await withStepDeadline(
        "create active failure slice",
        missionStore.addSlice(failureMilestone.id, { title: "Failure slice" }),
      );
      await withStepDeadline(
        "activate failure slice",
        missionStore.updateSlice(failureSlice.id, { status: "active" }),
      );
      const failureFeature = await withStepDeadline(
        "create failure feature",
        missionStore.addFeature(failureSlice.id, { title: "Rejected provider credential" }),
      );
      const failureTask = await withStepDeadline(
        "create failed mission task",
        taskStore.createTask({
          title: failureFeature.title,
          description: "A mission task with an operator-actionable provider failure",
          column: "done",
          status: "failed",
          error: "401 invalid x-api-key",
          missionId: failureMission.id,
          sliceId: failureSlice.id,
        }),
      );
      await withStepDeadline(
        "link failed mission task",
        missionStore.linkFeatureToTask(failureFeature.id, failureTask.id),
      );
      await withStepDeadline(
        "reactivate failure slice after linkage",
        missionStore.updateSlice(failureSlice.id, { status: "active" }),
      );
      await withStepDeadline(
        "activate failure mission after hierarchy setup",
        missionStore.updateMission(failureMission.id, {
          status: "active",
          autopilotEnabled: true,
        }),
      );
      await missionAutopilot!.watchMission(failureMission.id);

      let releaseFailureHandling!: () => void;
      const failureHandlingGate = new Promise<void>((resolve) => {
        releaseFailureHandling = resolve;
      });
      let markFailureHandlingObserved!: () => void;
      const failureHandlingObserved = new Promise<void>((resolve) => {
        markFailureHandlingObserved = resolve;
      });
      const handleTaskFailureSpy = vi.spyOn(missionAutopilot!, "handleTaskFailure")
        .mockImplementation(async (taskId) => {
          markFailureHandlingObserved();
          await failureHandlingGate;
          await missionStore.updateFeatureStatus(failureFeature.id, "blocked");
          expect(taskId).toBe(failureTask.id);
        });
      const scheduler = (runtime as unknown as {
        scheduler: {
          options: { onTaskFailed?: (taskId: string) => void | Promise<void> };
          reconcileAllMissionFeatures(): Promise<number>;
        };
      }).scheduler;
      expect(scheduler.options.onTaskFailed).toBeDefined();
      let failureCallbackSettled = false;
      const failureCallback = Promise.resolve(scheduler.options.onTaskFailed!(failureTask.id))
        .finally(() => {
          failureCallbackSettled = true;
        });
      let callbackReturnedBeforeFailurePersisted = false;
      try {
        await withStepDeadline("observe failure callback", failureHandlingObserved);
        expect(handleTaskFailureSpy).toHaveBeenCalledWith(failureTask.id);
        await new Promise<void>((resolve) => setImmediate(resolve));
        callbackReturnedBeforeFailurePersisted = failureCallbackSettled;
      } finally {
        releaseFailureHandling();
      }
      await withStepDeadline("finish failure callback", failureCallback);
      await withStepDeadline(
        "persist failure callback writes",
        Promise.all(handleTaskFailureSpy.mock.results.map(async (result) => result.value)),
      );
      expect(callbackReturnedBeforeFailurePersisted).toBe(false);
      expect(await withStepDeadline(
        "read blocked failure feature",
        missionStore.getFeature(failureFeature.id),
      )).toMatchObject({ status: "blocked" });
      handleTaskFailureSpy.mockRestore();

      await withStepDeadline(
        "retire completed mission fixtures before reconciliation",
        Promise.all([
          missionStore.updateMission(validationMission.id, { status: "complete" }),
          missionStore.updateMission(validatorFailureMission.id, { status: "complete" }),
          missionStore.updateMission(failureMission.id, { status: "complete" }),
        ]),
      );

      /*
      FNXC:PostgresMissionFeatureTaskReconciliation 2026-07-27-06:01:
      Startup reconciliation must await the PostgreSQL title-match repair,
      persist both directions of the feature/task link, and then derive the
      feature's terminal state from the same durable task.
      */
      const reconciliationMission = await withStepDeadline(
        "create reconciliation mission",
        missionStore.createMission({
          title: "PostgreSQL feature task reconciliation",
          autopilotEnabled: false,
        }),
      );
      const reconciliationMilestone = await withStepDeadline(
        "create reconciliation milestone",
        missionStore.addMilestone(reconciliationMission.id, {
          title: "Reconciliation milestone",
        }),
      );
      const reconciliationSlice = await withStepDeadline(
        "create reconciliation slice",
        missionStore.addSlice(reconciliationMilestone.id, {
          title: "Reconciliation slice",
        }),
      );
      await withStepDeadline(
        "activate reconciliation slice",
        missionStore.updateSlice(reconciliationSlice.id, { status: "active" }),
      );
      const reconciliationFeature = await withStepDeadline(
        "create unlinked reconciliation feature",
        missionStore.addFeature(reconciliationSlice.id, {
          title: "Repair PostgreSQL feature backlink",
        }),
      );
      const reconciliationTask = await withStepDeadline(
        "create title-matched reconciliation task",
        taskStore.createTask({
          title: reconciliationFeature.title,
          description: "Completed task whose one-way mission link requires repair",
          column: "done",
          missionId: reconciliationMission.id,
          sliceId: reconciliationSlice.id,
        }),
      );
      await withStepDeadline(
        "reactivate reconciliation slice after feature derivation",
        missionStore.updateSlice(reconciliationSlice.id, { status: "active" }),
      );
      await withStepDeadline(
        "activate reconciliation mission",
        missionStore.updateMission(reconciliationMission.id, {
          status: "active",
          autoAdvance: false,
          autopilotEnabled: false,
        }),
      );
      const reconciledFeatureCount = await withStepDeadline(
        "reconcile PostgreSQL feature task state",
        scheduler.reconcileAllMissionFeatures(),
      );
      expect(reconciledFeatureCount).toBeGreaterThanOrEqual(2);
      expect(await withStepDeadline(
        "read reconciled PostgreSQL feature",
        missionStore.getFeature(reconciliationFeature.id),
      )).toMatchObject({
        taskId: reconciliationTask.id,
        status: "in-progress",
      });
      expect(await withStepDeadline(
        "read reconciled PostgreSQL task backlink",
        taskStore.getTask(reconciliationTask.id),
      )).toMatchObject({
        missionId: reconciliationMission.id,
        sliceId: reconciliationSlice.id,
      });
      await withStepDeadline(
        "retire reconciliation mission before restart",
        missionStore.updateMission(reconciliationMission.id, { status: "complete" }),
      );

      /*
      FNXC:PostgresMissionRestartRecovery 2026-07-27-06:01:
      Persist a mid-validation crash shape before the runtime closes. The next
      runtime must await AsyncMissionStore recovery, re-run validation for the
      already-completed linked task, and settle every durable mission record.
      */
      const recoveryMission = await withStepDeadline(
        "create restart recovery mission",
        missionStore.createMission({
          title: "PostgreSQL mission restart recovery",
          autopilotEnabled: false,
        }),
      );
      const recoveryMilestone = await withStepDeadline(
        "create restart recovery milestone",
        missionStore.addMilestone(recoveryMission.id, {
          title: "Restart recovery milestone",
        }),
      );
      const recoverySlice = await withStepDeadline(
        "create restart recovery slice",
        missionStore.addSlice(recoveryMilestone.id, {
          title: "Restart recovery slice",
        }),
      );
      await withStepDeadline(
        "activate restart recovery slice",
        missionStore.updateSlice(recoverySlice.id, { status: "active" }),
      );
      const recoveryFeature = await withStepDeadline(
        "create restart recovery feature",
        missionStore.addFeature(recoverySlice.id, {
          title: "Resume PostgreSQL validation after restart",
          acceptanceCriteria: "Recovery settles the interrupted validation.",
        }),
      );
      const recoveryTask = await withStepDeadline(
        "create completed restart recovery task",
        taskStore.createTask({
          title: recoveryFeature.title,
          description: "Completed implementation awaiting crash recovery validation",
          column: "done",
          missionId: recoveryMission.id,
          sliceId: recoverySlice.id,
        }),
      );
      await withStepDeadline(
        "link restart recovery task",
        missionStore.linkFeatureToTask(recoveryFeature.id, recoveryTask.id),
      );
      const [recoveryAssertion] = await withStepDeadline(
        "ensure restart recovery assertion",
        missionStore.ensureFeatureAssertionLinked(recoveryFeature.id),
      );
      expect(recoveryAssertion).toBeDefined();
      await withStepDeadline(
        "persist interrupted validation state",
        missionStore.updateFeature(recoveryFeature.id, {
          status: "in-progress",
          loopState: "validating",
        }),
      );
      await withStepDeadline(
        "activate restart recovery mission",
        missionStore.updateMission(recoveryMission.id, {
          status: "active",
          autoAdvance: false,
          autopilotEnabled: false,
        }),
      );
      validationRunnerSpy.mockRestore();

      const claimStore = (runtime as unknown as { leaseCentralClaimStore: AsyncCentralClaimStore })
        .leaseCentralClaimStore;
      const claimed = await withStepDeadline(
        "claim task",
        claimStore.tryClaimTask({
          projectId: "runtime-composition",
          taskId: "FN-RUNTIME-COMPOSITION",
          nodeId: "node-test",
          agentId: "agent-test",
          runId: "run-test",
          renewedAt: new Date().toISOString(),
        }),
      );
      expect(claimed.ok).toBe(true);

      await withStepDeadline("persist local node offline", central.markLocalNodeOffline());
      await withStepDeadline("first runtime stop", runtime.stop());
      await withStepDeadline("idempotent runtime stop", runtime.stop());
      expect(runtime.getStatus()).toBe("stopped");
      await withStepDeadline("close first central core", central.close());
      central = undefined;
      runtime = undefined;

      restartValidationSpy = vi.spyOn(MissionExecutionLoop.prototype as any, "runValidation")
        .mockImplementation(async (...args: unknown[]) => {
          const assertions = args[1] as Array<{ id: string }>;
          return {
            result: {
              status: "pass",
              assertions: assertions.map((assertion) => ({
                assertionId: assertion.id,
                verdict: "pass",
                passed: true,
                message: "Recovered PostgreSQL validation passed",
                evidence: [{
                  kind: "test-output",
                  text: "real PostgreSQL restart recovery fixture",
                }],
              })),
              summary: "Recovered PostgreSQL validation passed",
            },
            inspection: {
              inspectionRoot: projectDir,
              landedSha: undefined,
              fallbackUsed: true,
              workspaceStale: false,
            },
          };
        });
      restartCentral = new CentralCore(globalDir);
      restartRuntime = new InProcessRuntime({
        projectId: "runtime-composition",
        workingDirectory: projectDir,
        isolationMode: "in-process",
        maxConcurrent: 1,
        maxWorktrees: 1,
      }, restartCentral);
      restartRuntime.on("error", () => undefined);
      await withStepDeadline("restart runtime", restartRuntime.start());
      await withStepDeadline(
        "drain restarted mission recovery",
        (restartRuntime as unknown as {
          drainStartupBackgroundTasks(timeoutMs: number): Promise<void>;
        }).drainStartupBackgroundTasks(60_000),
        75_000,
      );
      const restartMissionStore = restartRuntime.getTaskStore().getMissionStore();
      expect(restartValidationSpy).toHaveBeenCalled();
      expect(await withStepDeadline(
        "read restart-recovered feature",
        restartMissionStore.getFeature(recoveryFeature.id),
      )).toMatchObject({
        status: "done",
        loopState: "passed",
        lastValidatorStatus: "passed",
      });
      expect(await withStepDeadline(
        "read restart-recovered assertion",
        restartMissionStore.getContractAssertion(recoveryAssertion!.id),
      )).toMatchObject({ status: "passed" });
      const recoveryRuns = await withStepDeadline(
        "read restart recovery validator runs",
        restartMissionStore.getValidatorRunsByFeature(recoveryFeature.id),
      );
      expect(recoveryRuns).toHaveLength(1);
      expect(recoveryRuns[0]).toMatchObject({
        status: "passed",
        taskId: recoveryTask.id,
      });
      restartValidationSpy.mockRestore();
      restartValidationSpy = undefined;

      const restartedCapacity = (restartRuntime as unknown as {
        executor?: {
          options?: {
            globalCapacityLegacyDispatchControl?: GlobalCapacityLegacyDispatchControlV1;
          };
        };
      }).executor?.options?.globalCapacityLegacyDispatchControl;
      expect(restartedCapacity).toBeDefined();
      const restartGrant = await withStepDeadline(
        "grant capacity after restart",
        restartedCapacity!.begin({
          resourceKind: "legacy_task",
          resourceId: "FN-RUNTIME-CAPACITY-RESTART",
          workClass: "normal",
          slots: 1,
        }),
      );
      expect(restartGrant.state).toBe("execution_granted");
      if (restartGrant.state !== "execution_granted") {
        throw new Error(`Restart capacity was not granted: ${restartGrant.state}`);
      }
      await expect(withStepDeadline("release capacity after restart", restartGrant.handle.finish()))
        .resolves.toMatchObject({ state: "released" });
      await withStepDeadline("persist restarted local node offline", restartCentral.markLocalNodeOffline());
      await withStepDeadline("stop restarted runtime", restartRuntime.stop());
      await withStepDeadline("close restarted central core", restartCentral.close());
      restartCentral = undefined;
      restartRuntime = undefined;
      expect(lifecycle.shutdownCalls).toBe(2);
      await withStepDeadline("teardown disposable test database", harness.teardown());
      await withStepDeadline(
        "verify disposable test database was dropped",
        expectDatabaseDropped(harness.testUrl),
      );
    } finally {
      restartValidationSpy?.mockRestore();
      if (restartCentral) {
        await restartCentral.markLocalNodeOffline().catch(() => undefined);
      }
      try {
        await restartRuntime?.stop();
      } finally {
        try {
          await restartCentral?.close();
        } finally {
          if (central) {
            await central.markLocalNodeOffline().catch(() => undefined);
          }
          try {
            await runtime?.stop();
          } finally {
            try {
              await central?.close();
            } finally {
              try {
                await harness.teardown();
              } finally {
                if (priorDatabaseUrl === undefined) delete process.env.DATABASE_URL;
                else process.env.DATABASE_URL = priorDatabaseUrl;
                await Promise.all([
                  projectDir ? rm(projectDir, { recursive: true, force: true }) : Promise.resolve(),
                  globalDir ? rm(globalDir, { recursive: true, force: true }) : Promise.resolve(),
                ]);
                lifecycle.shutdownCalls = 0;
              }
            }
          }
        }
      }
    }
  }, 240_000);
});
