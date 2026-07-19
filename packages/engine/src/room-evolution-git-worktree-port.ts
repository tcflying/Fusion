import { execFile as execFileCallback } from "node:child_process";
import { lstat, mkdir, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import {
  ROOM_EVOLUTION_ISOLATED_CANDIDATE_COORDINATOR_CONTRACT_VERSION,
  type RoomEvolutionIsolatedCandidateGitWorktreePortV1,
  type RoomEvolutionIsolatedCandidateGitWorktreeReceiptV1,
  type RoomEvolutionIsolatedCandidateGitWorktreeRequestV1,
  type RoomEvolutionRollbackTargetV1,
} from "./room-evolution-isolated-candidate-coordinator.js";

const execFileAsync = promisify(execFileCallback);
const WORKTREE_DIRECTORY_NAME = ".room-evolution-worktrees";
const GIT_TIMEOUT_MS = 30_000;
const GIT_MAX_BUFFER_BYTES = 1024 * 1024;

export type RoomEvolutionGitWorktreePortErrorCodeV1 =
  | "invalid_options"
  | "invalid_request"
  | "human_approval_required"
  | "workspace_root_invalid"
  | "repository_root_invalid"
  | "repository_root_not_top_level"
  | "destination_unsafe"
  | "destination_occupied"
  | "branch_invalid"
  | "branch_occupied"
  | "base_worktree_dirty"
  | "base_revision_mismatch"
  | "rollback_target_invalid"
  | "rollback_target_mismatch"
  | "candidate_worktree_invalid"
  | "git_unavailable"
  | "git_command_failed";

export class RoomEvolutionGitWorktreePortError extends Error {
  public constructor(
    public readonly code: RoomEvolutionGitWorktreePortErrorCodeV1,
    message: string,
  ) {
    super(message);
    this.name = "RoomEvolutionGitWorktreePortError";
  }
}

export interface RoomEvolutionGitWorktreePortOptionsV1 {
  readonly workspaceRootPath: string;
}

interface ResolvedPaths {
  readonly workspaceRootPath: string;
  readonly repositoryRootPath: string;
  readonly worktreeParentPath: string;
  readonly worktreePath: string;
}

interface RegisteredWorktree {
  readonly path: string;
  readonly branchRef: string | null;
}

interface GitCommandOutput {
  readonly stdout: string;
  readonly stderr: string;
}

export class RoomEvolutionGitWorktreePort implements RoomEvolutionIsolatedCandidateGitWorktreePortV1 {
  private readonly workspaceRootPath: string;

  public constructor(options: RoomEvolutionGitWorktreePortOptionsV1) {
    if (!isRecord(options) || !isAbsoluteNonBlankPath(options.workspaceRootPath)) {
      throw new RoomEvolutionGitWorktreePortError(
        "invalid_options",
        "Room evolution Git worktree port requires one absolute workspace root path.",
      );
    }
    this.workspaceRootPath = options.workspaceRootPath;
  }

  public async createDedicatedCandidate(
    rawInput: RoomEvolutionIsolatedCandidateGitWorktreeRequestV1,
  ): Promise<RoomEvolutionIsolatedCandidateGitWorktreeReceiptV1> {
    const input = validateRequest(rawInput);
    const paths = await this.resolvePaths(input);
    await this.assertRepositoryRoot(paths.repositoryRootPath);
    await this.assertBaseCheckout(paths.repositoryRootPath, input.baseRevision);
    await this.assertRollbackTarget(paths.repositoryRootPath, input.rollbackTarget);
    await this.assertBranchAvailable(paths.repositoryRootPath, input.branchRef);
    await this.assertDestinationAvailable(paths);

    let creationAttempted = false;
    try {
      await this.createWorktreeParent(paths);
      creationAttempted = true;
      await this.runGit(
        ["worktree", "add", "-b", input.branchRef, paths.worktreePath, input.baseRevision],
        paths.repositoryRootPath,
      );
      await this.assertDedicatedCheckout(paths, input);
      await this.assertBaseCheckout(paths.repositoryRootPath, input.baseRevision);
      return createReceipt(input, paths.worktreePath);
    } catch (error) {
      if (creationAttempted) await this.cleanupCreatedCandidate(paths, input.branchRef);
      throw error;
    }
  }

  private async resolvePaths(input: RoomEvolutionIsolatedCandidateGitWorktreeRequestV1): Promise<ResolvedPaths> {
    const workspaceRootPath = await resolveExistingDirectory(this.workspaceRootPath, "workspace_root_invalid");
    const repositoryRootPath = await resolveExistingDirectory(input.repositoryRootPath, "repository_root_invalid");
    const worktreeParentPath = resolve(workspaceRootPath, WORKTREE_DIRECTORY_NAME);
    const worktreePath = resolve(worktreeParentPath, input.worktreeName);

    if (!isStrictDescendant(workspaceRootPath, worktreeParentPath) || !isStrictDescendant(workspaceRootPath, worktreePath)) {
      throw new RoomEvolutionGitWorktreePortError(
        "destination_unsafe",
        "The candidate worktree destination escapes the configured workspace root.",
      );
    }
    if (isSameOrDescendant(repositoryRootPath, worktreePath)) {
      throw new RoomEvolutionGitWorktreePortError(
        "destination_unsafe",
        "The candidate worktree destination is inside the base checkout and could dirty or mutate it.",
      );
    }

    return { workspaceRootPath, repositoryRootPath, worktreeParentPath, worktreePath };
  }

  private async assertRepositoryRoot(repositoryRootPath: string): Promise<void> {
    const topLevel = await this.runGit(["rev-parse", "--show-toplevel"], repositoryRootPath);
    const canonicalTopLevel = await resolveExistingDirectory(topLevel.stdout.trim(), "repository_root_invalid");
    if (!samePath(repositoryRootPath, canonicalTopLevel)) {
      throw new RoomEvolutionGitWorktreePortError(
        "repository_root_not_top_level",
        "The requested repository root is not the Git checkout top level.",
      );
    }

    const worktrees = await this.listWorktrees(repositoryRootPath);
    if (!worktrees.some((worktree) => samePath(worktree.path, repositoryRootPath))) {
      throw new RoomEvolutionGitWorktreePortError(
        "repository_root_invalid",
        "The requested repository root is not a registered Git worktree.",
      );
    }
  }

  private async assertBaseCheckout(repositoryRootPath: string, expectedRevision: string): Promise<void> {
    const status = await this.runGit(["status", "--porcelain=v1", "-z"], repositoryRootPath);
    if (status.stdout.length > 0) {
      throw new RoomEvolutionGitWorktreePortError(
        "base_worktree_dirty",
        "The base checkout is dirty, so the candidate branch must not be created from it.",
      );
    }

    const head = await this.runGit(["rev-parse", "--verify", "HEAD^{commit}"], repositoryRootPath);
    if (head.stdout.trim() !== expectedRevision) {
      throw new RoomEvolutionGitWorktreePortError(
        "base_revision_mismatch",
        "The current base checkout revision does not match the immutable candidate base revision.",
      );
    }
  }

  private async assertRollbackTarget(repositoryRootPath: string, rollbackTarget: RoomEvolutionRollbackTargetV1): Promise<void> {
    const resolved = await this.tryRunGit(["rev-parse", "--verify", `${rollbackTarget.candidateRef}^{commit}`], repositoryRootPath);
    if (resolved === null) {
      throw new RoomEvolutionGitWorktreePortError(
        "rollback_target_invalid",
        "The candidate rollback branch does not resolve to a Git commit.",
      );
    }
    if (resolved.stdout.trim() !== rollbackTarget.revision) {
      throw new RoomEvolutionGitWorktreePortError(
        "rollback_target_mismatch",
        "The candidate rollback branch does not resolve to its declared immutable revision.",
      );
    }
  }

  private async assertBranchAvailable(repositoryRootPath: string, branchRef: string): Promise<void> {
    const expectedFullRef = `refs/heads/${branchRef}`;
    const branchValid = await this.tryRunGit(["check-ref-format", "--branch", branchRef], repositoryRootPath);
    if (branchValid === null) {
      throw new RoomEvolutionGitWorktreePortError(
        "branch_invalid",
        "The candidate branch name is not accepted by native Git.",
      );
    }
    const branchExists = await this.tryRunGit(["show-ref", "--verify", "--quiet", expectedFullRef], repositoryRootPath);
    if (branchExists !== null) {
      throw new RoomEvolutionGitWorktreePortError(
        "branch_occupied",
        "The dedicated candidate branch already exists and could be shared by another workflow.",
      );
    }
    const worktrees = await this.listWorktrees(repositoryRootPath);
    if (worktrees.some((worktree) => worktree.branchRef === expectedFullRef)) {
      throw new RoomEvolutionGitWorktreePortError(
        "branch_occupied",
        "The dedicated candidate branch is already attached to an existing Git worktree.",
      );
    }
  }

  private async assertDestinationAvailable(paths: ResolvedPaths): Promise<void> {
    const parentInfo = await lstatOrNull(paths.worktreeParentPath);
    if (parentInfo !== null && (!parentInfo.isDirectory() || parentInfo.isSymbolicLink())) {
      throw new RoomEvolutionGitWorktreePortError(
        "destination_unsafe",
        "The candidate worktree parent is not a normal directory inside the configured workspace root.",
      );
    }
    if (await lstatOrNull(paths.worktreePath)) {
      throw new RoomEvolutionGitWorktreePortError(
        "destination_occupied",
        "The dedicated candidate worktree destination already exists.",
      );
    }
  }

  private async createWorktreeParent(paths: ResolvedPaths): Promise<void> {
    await mkdir(paths.worktreeParentPath, { recursive: true });
    const canonicalParentPath = await resolveExistingDirectory(paths.worktreeParentPath, "destination_unsafe");
    if (!isStrictDescendant(paths.workspaceRootPath, canonicalParentPath) && !samePath(paths.workspaceRootPath, canonicalParentPath)) {
      throw new RoomEvolutionGitWorktreePortError(
        "destination_unsafe",
        "The candidate worktree parent resolved outside the configured workspace root.",
      );
    }
    const parentInfo = await lstat(canonicalParentPath);
    if (!parentInfo.isDirectory() || parentInfo.isSymbolicLink()) {
      throw new RoomEvolutionGitWorktreePortError(
        "destination_unsafe",
        "The candidate worktree parent is not a normal directory.",
      );
    }
  }

  private async assertDedicatedCheckout(
    paths: ResolvedPaths,
    input: RoomEvolutionIsolatedCandidateGitWorktreeRequestV1,
  ): Promise<void> {
    const topLevel = await this.runGit(["rev-parse", "--show-toplevel"], paths.worktreePath);
    const canonicalTopLevel = await resolveExistingDirectory(topLevel.stdout.trim(), "candidate_worktree_invalid");
    if (!samePath(canonicalTopLevel, paths.worktreePath)) {
      throw new RoomEvolutionGitWorktreePortError(
        "candidate_worktree_invalid",
        "Git did not create the requested dedicated worktree as its own checkout root.",
      );
    }
    const head = await this.runGit(["rev-parse", "--verify", "HEAD^{commit}"], paths.worktreePath);
    if (head.stdout.trim() !== input.baseRevision) {
      throw new RoomEvolutionGitWorktreePortError(
        "candidate_worktree_invalid",
        "The candidate worktree is not checked out at the requested immutable base revision.",
      );
    }
    const branch = await this.runGit(["symbolic-ref", "--quiet", "HEAD"], paths.worktreePath);
    if (branch.stdout.trim() !== `refs/heads/${input.branchRef}`) {
      throw new RoomEvolutionGitWorktreePortError(
        "candidate_worktree_invalid",
        "The candidate worktree is not checked out on its dedicated candidate branch.",
      );
    }
    const status = await this.runGit(["status", "--porcelain=v1", "-z"], paths.worktreePath);
    if (status.stdout.length > 0) {
      throw new RoomEvolutionGitWorktreePortError(
        "candidate_worktree_invalid",
        "The newly created candidate worktree is not clean.",
      );
    }
    const worktrees = await this.listWorktrees(paths.repositoryRootPath);
    const expectedBranchRef = `refs/heads/${input.branchRef}`;
    const matches = worktrees.filter((worktree) => worktree.branchRef === expectedBranchRef);
    if (matches.length !== 1 || !samePath(matches[0].path, paths.worktreePath)) {
      throw new RoomEvolutionGitWorktreePortError(
        "candidate_worktree_invalid",
        "The candidate branch is not registered exactly once at the dedicated candidate worktree path.",
      );
    }
  }

  private async cleanupCreatedCandidate(paths: ResolvedPaths, branchRef: string): Promise<void> {
    try {
      const worktrees = await this.listWorktrees(paths.repositoryRootPath);
      const matchedWorktree = worktrees.find(
        (worktree) => samePath(worktree.path, paths.worktreePath) && worktree.branchRef === `refs/heads/${branchRef}`,
      );
      if (matchedWorktree) {
        await this.runGit(["worktree", "remove", "--force", paths.worktreePath], paths.repositoryRootPath);
      }
      const remaining = await this.listWorktrees(paths.repositoryRootPath);
      if (!remaining.some((worktree) => worktree.branchRef === `refs/heads/${branchRef}`)) {
        const branchExists = await this.tryRunGit(["show-ref", "--verify", "--quiet", `refs/heads/${branchRef}`], paths.repositoryRootPath);
        if (branchExists !== null) await this.runGit(["branch", "-D", branchRef], paths.repositoryRootPath);
      }
    } catch {
      return;
    }
  }

  private async listWorktrees(repositoryRootPath: string): Promise<readonly RegisteredWorktree[]> {
    const output = await this.runGit(["worktree", "list", "--porcelain"], repositoryRootPath);
    return parseWorktreeList(output.stdout);
  }

  private async tryRunGit(args: readonly string[], cwd: string): Promise<GitCommandOutput | null> {
    try {
      return await this.runGit(args, cwd);
    } catch (error) {
      if (error instanceof RoomEvolutionGitWorktreePortError && error.code === "git_unavailable") throw error;
      return null;
    }
  }

  private async runGit(args: readonly string[], cwd: string): Promise<GitCommandOutput> {
    try {
      const result = await execFileAsync("git", [...args], {
        cwd,
        encoding: "utf-8",
        shell: false,
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: GIT_MAX_BUFFER_BYTES,
        windowsHide: true,
      });
      return { stdout: String(result.stdout), stderr: String(result.stderr) };
    } catch (error) {
      if (isGitUnavailable(error)) {
        throw new RoomEvolutionGitWorktreePortError(
          "git_unavailable",
          "Native Git is unavailable, so no room-evolution worktree was created.",
        );
      }
      throw new RoomEvolutionGitWorktreePortError(
        "git_command_failed",
        `Native Git rejected the controlled room-evolution worktree operation: ${messageOf(error)}`,
      );
    }
  }
}

function validateRequest(value: unknown): RoomEvolutionIsolatedCandidateGitWorktreeRequestV1 {
  if (!isRecord(value) || value.contractVersion !== ROOM_EVOLUTION_ISOLATED_CANDIDATE_COORDINATOR_CONTRACT_VERSION) {
    throw new RoomEvolutionGitWorktreePortError("invalid_request", "The candidate worktree request has an unsupported contract version.");
  }
  const request = value as unknown as RoomEvolutionIsolatedCandidateGitWorktreeRequestV1;
  if (!isCommand(request.command) || !isScope(request.scope) || !isCanonicalId(request.candidateId) || !isCanonicalId(request.hypothesisId)) {
    throw new RoomEvolutionGitWorktreePortError("invalid_request", "The candidate worktree request has an invalid command, scope, or identity.");
  }
  if (request.candidateKind !== "source" || (request.mechanism !== "adapter" && request.mechanism !== "source_code")) {
    throw new RoomEvolutionGitWorktreePortError("invalid_request", "Native Git worktree isolation is restricted to source candidates.");
  }
  if (!isRiskClass(request.riskClass) || !isDeclaredScope(request.declaredScope) || !isAbsoluteNonBlankPath(request.repositoryRootPath)) {
    throw new RoomEvolutionGitWorktreePortError("invalid_request", "The candidate worktree request has an invalid risk, scope, or repository root.");
  }
  if (!isImmutableRevision(request.baseRevision) || !isRollbackTarget(request.rollbackTarget, request.candidateId)) {
    throw new RoomEvolutionGitWorktreePortError("invalid_request", "The candidate worktree request has an invalid immutable base or rollback target.");
  }
  if (request.branchRef !== `fusion/evolution/${request.candidateId}` || request.worktreeName !== `evolution-${request.candidateId}`) {
    throw new RoomEvolutionGitWorktreePortError("branch_invalid", "The candidate branch and worktree names must be derived from the candidate identity.");
  }
  if (!isApprovalBound(request.approval, request)) {
    throw new RoomEvolutionGitWorktreePortError(
      "human_approval_required",
      "High-risk and critical source candidates require a matching approved human authorization before Git is requested.",
    );
  }
  return request;
}

function isCommand(value: unknown): value is RoomEvolutionIsolatedCandidateGitWorktreeRequestV1["command"] {
  return isRecord(value)
    && isNonBlank(value.commandId)
    && isNonBlank(value.idempotencyKey)
    && isNonBlank(value.correlationId)
    && (value.causationId === null || isNonBlank(value.causationId));
}

function isScope(value: unknown): value is RoomEvolutionIsolatedCandidateGitWorktreeRequestV1["scope"] {
  return isRecord(value) && isNonBlank(value.projectId) && isNonBlank(value.roomId);
}

function isRollbackTarget(value: unknown, candidateId: string): value is RoomEvolutionRollbackTargetV1 {
  if (!isRecord(value) || !isCanonicalId(value.candidateVersionId) || value.candidateVersionId === candidateId) return false;
  if (!isImmutableRevision(value.revision)) return false;
  return value.candidateRef === `refs/heads/fusion/evolution/${value.candidateVersionId}`;
}

function isApprovalBound(
  approval: RoomEvolutionIsolatedCandidateGitWorktreeRequestV1["approval"],
  input: Pick<RoomEvolutionIsolatedCandidateGitWorktreeRequestV1, "candidateId" | "scope" | "riskClass">,
): boolean {
  if (input.riskClass === "low" || input.riskClass === "moderate") return approval === null;
  return isRecord(approval)
    && approval.status === "approved"
    && isCanonicalId(approval.id)
    && approval.candidateId === input.candidateId
    && approval.scope.projectId === input.scope.projectId
    && approval.scope.roomId === input.scope.roomId
    && approval.riskClass === input.riskClass
    && isNonBlank(approval.approvedByActorId)
    && isUtcTimestamp(approval.approvedAt);
}

function isRiskClass(value: unknown): value is "low" | "moderate" | "high" | "critical" {
  return value === "low" || value === "moderate" || value === "high" || value === "critical";
}

function isDeclaredScope(value: unknown): value is readonly string[] {
  return Array.isArray(value)
    && value.length > 0
    && new Set(value).size === value.length
    && value.every((entry) => typeof entry === "string" && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/.test(entry) && !entry.includes(".."));
}

function isCanonicalId(value: unknown): value is string {
  return typeof value === "string" && /^[a-z0-9][a-z0-9._-]{2,127}$/.test(value);
}

function isImmutableRevision(value: unknown): value is string {
  return typeof value === "string" && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value);
}

function isAbsoluteNonBlankPath(value: unknown): value is string {
  return typeof value === "string" && value.trim() === value && value.length > 1 && isAbsolute(value);
}

function isNonBlank(value: unknown): value is string {
  return typeof value === "string" && value.trim() === value && value.length > 0;
}

function isUtcTimestamp(value: unknown): value is string {
  return typeof value === "string" && value.endsWith("Z") && Number.isFinite(Date.parse(value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function resolveExistingDirectory(pathValue: string, code: "workspace_root_invalid" | "repository_root_invalid" | "destination_unsafe" | "candidate_worktree_invalid"): Promise<string> {
  try {
    const resolvedPath = await realpath(pathValue);
    const details = await stat(resolvedPath);
    if (!details.isDirectory()) throw new Error("not a directory");
    return resolvedPath;
  } catch {
    throw new RoomEvolutionGitWorktreePortError(code, `The required directory is unavailable: ${pathValue}`);
  }
}

async function lstatOrNull(pathValue: string) {
  try {
    return await lstat(pathValue);
  } catch (error) {
    if (isErrnoCode(error, "ENOENT")) return null;
    throw new RoomEvolutionGitWorktreePortError("destination_unsafe", `Unable to inspect candidate worktree path: ${pathValue}`);
  }
}

function parseWorktreeList(value: string): readonly RegisteredWorktree[] {
  const entries: RegisteredWorktree[] = [];
  for (const block of value.split("\n\n")) {
    let worktreePath: string | null = null;
    let branchRef: string | null = null;
    for (const line of block.split("\n")) {
      if (line.startsWith("worktree ")) worktreePath = line.slice("worktree ".length);
      if (line.startsWith("branch ")) branchRef = line.slice("branch ".length);
    }
    if (worktreePath !== null) entries.push({ path: worktreePath, branchRef });
  }
  return entries;
}

function createReceipt(
  input: RoomEvolutionIsolatedCandidateGitWorktreeRequestV1,
  worktreePath: string,
): RoomEvolutionIsolatedCandidateGitWorktreeReceiptV1 {
  return Object.freeze({
    contractVersion: ROOM_EVOLUTION_ISOLATED_CANDIDATE_COORDINATOR_CONTRACT_VERSION,
    candidateId: input.candidateId,
    scope: Object.freeze({ projectId: input.scope.projectId, roomId: input.scope.roomId }),
    repositoryRootPath: input.repositoryRootPath,
    branchRef: input.branchRef,
    worktreeName: input.worktreeName,
    worktreePath,
    baseRevision: input.baseRevision,
    rollbackTarget: Object.freeze({ ...input.rollbackTarget }),
    checkout: Object.freeze({
      kind: "linked_worktree" as const,
      cleanliness: "clean" as const,
      occupancy: "dedicated" as const,
      mutationTarget: "candidate_worktree" as const,
    }),
  });
}

function samePath(left: string, right: string): boolean {
  return normalizePath(left) === normalizePath(right);
}

function isStrictDescendant(rootPath: string, candidatePath: string): boolean {
  const value = relative(rootPath, candidatePath);
  return value.length > 0 && value !== ".." && !value.startsWith(`..${sep}`) && !isAbsolute(value);
}

function isSameOrDescendant(rootPath: string, candidatePath: string): boolean {
  return samePath(rootPath, candidatePath) || isStrictDescendant(rootPath, candidatePath);
}

function normalizePath(value: string): string {
  const normalized = value.replace(/\\/g, "/").replace(/\/+$/, "");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function isGitUnavailable(error: unknown): boolean {
  return isErrnoCode(error, "ENOENT");
}

function isErrnoCode(error: unknown, code: string): boolean {
  return isRecord(error) && error.code === code;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
