import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ROOM_EVOLUTION_ISOLATED_CANDIDATE_COORDINATOR_CONTRACT_VERSION,
  type RoomEvolutionIsolatedCandidateGitWorktreeRequestV1,
} from "../room-evolution-isolated-candidate-coordinator.js";
import {
  RoomEvolutionGitWorktreePort,
  RoomEvolutionGitWorktreePortError,
} from "../room-evolution-git-worktree-port.js";

const hasGit = spawnSync("git", ["--version"], { stdio: "pipe" }).status === 0;
const describeIfGit = hasGit ? describe : describe.skip;
const gitAvailabilitySuffix = hasGit ? "" : " (skipped: native Git is unavailable)";

interface GitFixture {
  readonly workspaceRootPath: string;
  readonly repositoryRootPath: string;
  readonly baseRevision: string;
  readonly rollbackRevision: string;
  readonly rollbackBranchRef: string;
  cleanup(): void;
}

function git(cwd: string, args: readonly string[]): string {
  return execFileSync("git", [...args], {
    cwd,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function createFixture(): GitFixture {
  const workspaceRootPath = mkdtempSync(join(tmpdir(), "fusion-room-evolution-git-"));
  const repositoryRootPath = join(workspaceRootPath, "repository");
  mkdirSync(repositoryRootPath, { recursive: true });
  git(repositoryRootPath, ["init", "-b", "main"]);
  git(repositoryRootPath, ["config", "user.email", "test@example.com"]);
  git(repositoryRootPath, ["config", "user.name", "Fusion Test"]);
  writeFileSync(join(repositoryRootPath, "README.md"), "# room evolution\n", "utf-8");
  git(repositoryRootPath, ["add", "README.md"]);
  git(repositoryRootPath, ["commit", "-m", "initial"]);
  const baseRevision = git(repositoryRootPath, ["rev-parse", "HEAD"]);
  const rollbackBranchRef = "refs/heads/fusion/evolution/candidate-prior";
  git(repositoryRootPath, ["branch", rollbackBranchRef.slice("refs/heads/".length), baseRevision]);

  return {
    workspaceRootPath,
    repositoryRootPath,
    baseRevision,
    rollbackRevision: baseRevision,
    rollbackBranchRef,
    cleanup: () => {
      const candidatePath = join(workspaceRootPath, ".room-evolution-worktrees", "evolution-candidate-next");
      spawnSync("git", ["worktree", "remove", "--force", candidatePath], { cwd: repositoryRootPath, stdio: "ignore" });
      spawnSync("git", ["worktree", "prune"], { cwd: repositoryRootPath, stdio: "ignore" });
      rmSync(workspaceRootPath, { recursive: true, force: true });
    },
  };
}

async function withFixture(run: (fixture: GitFixture) => Promise<void>): Promise<void> {
  const fixture = createFixture();
  try {
    await run(fixture);
  } finally {
    fixture.cleanup();
  }
}

function request(fixture: GitFixture): RoomEvolutionIsolatedCandidateGitWorktreeRequestV1 {
  return {
    contractVersion: ROOM_EVOLUTION_ISOLATED_CANDIDATE_COORDINATOR_CONTRACT_VERSION,
    command: {
      commandId: "command-001",
      idempotencyKey: "idempotency-001",
      correlationId: "correlation-001",
      causationId: null,
    },
    scope: { projectId: "project-001", roomId: "room-001" },
    candidateId: "candidate-next",
    hypothesisId: "hypothesis-001",
    candidateKind: "source",
    riskClass: "moderate",
    mechanism: "source_code",
    declaredScope: ["packages/engine/src"],
    repositoryRootPath: fixture.repositoryRootPath,
    baseRevision: fixture.baseRevision,
    rollbackTarget: {
      candidateVersionId: "candidate-prior",
      revision: fixture.rollbackRevision,
      candidateRef: fixture.rollbackBranchRef,
    },
    branchRef: "fusion/evolution/candidate-next",
    worktreeName: "evolution-candidate-next",
    approval: null,
  };
}

describeIfGit(`RoomEvolutionGitWorktreePort real Git worktree scenarios${gitAvailabilitySuffix}`, { timeout: 30_000 }, () => {
  it("creates a clean dedicated branch worktree without mutating the base checkout", async () => {
    await withFixture(async (fixture) => {
      const port = new RoomEvolutionGitWorktreePort({ workspaceRootPath: fixture.workspaceRootPath });
      const receipt = await port.createDedicatedCandidate(request(fixture));
      const expectedWorktreePath = join(
        fixture.workspaceRootPath,
        ".room-evolution-worktrees",
        "evolution-candidate-next",
      );

      expect(receipt.worktreePath).toBe(expectedWorktreePath);
      expect(receipt.baseRevision).toBe(fixture.baseRevision);
      expect(receipt.rollbackTarget).toEqual(request(fixture).rollbackTarget);
      expect(receipt.checkout).toEqual({
        kind: "linked_worktree",
        cleanliness: "clean",
        occupancy: "dedicated",
        mutationTarget: "candidate_worktree",
      });
      expect(git(fixture.repositoryRootPath, ["rev-parse", "HEAD"])).toBe(fixture.baseRevision);
      expect(git(fixture.repositoryRootPath, ["branch", "--show-current"])).toBe("main");
      expect(git(fixture.repositoryRootPath, ["status", "--porcelain=v1"])).toBe("");
      expect(git(receipt.worktreePath, ["rev-parse", "HEAD"])).toBe(fixture.baseRevision);
      expect(git(receipt.worktreePath, ["branch", "--show-current"])).toBe("fusion/evolution/candidate-next");
      expect(git(receipt.worktreePath, ["status", "--porcelain=v1"])).toBe("");
    });
  });

  it("rejects a stale base revision before creating a branch or worktree", async () => {
    await withFixture(async (fixture) => {
      writeFileSync(join(fixture.repositoryRootPath, "advanced.txt"), "advance\n", "utf-8");
      git(fixture.repositoryRootPath, ["add", "advanced.txt"]);
      git(fixture.repositoryRootPath, ["commit", "-m", "advance base"]);
      const port = new RoomEvolutionGitWorktreePort({ workspaceRootPath: fixture.workspaceRootPath });

      await expect(port.createDedicatedCandidate(request(fixture))).rejects.toMatchObject<Partial<RoomEvolutionGitWorktreePortError>>({
        code: "base_revision_mismatch",
      });
      expect(git(fixture.repositoryRootPath, ["branch", "--list", "fusion/evolution/candidate-next"])).toBe("");
      expect(git(fixture.repositoryRootPath, ["worktree", "list", "--porcelain"])).not.toContain("evolution-candidate-next");
    });
  });

  it("rejects a dirty base worktree without changing it", async () => {
    await withFixture(async (fixture) => {
      writeFileSync(join(fixture.repositoryRootPath, "dirty.txt"), "dirty\n", "utf-8");
      const port = new RoomEvolutionGitWorktreePort({ workspaceRootPath: fixture.workspaceRootPath });

      await expect(port.createDedicatedCandidate(request(fixture))).rejects.toMatchObject<Partial<RoomEvolutionGitWorktreePortError>>({
        code: "base_worktree_dirty",
      });
      expect(git(fixture.repositoryRootPath, ["status", "--porcelain=v1"])).toContain("?? dirty.txt");
      expect(git(fixture.repositoryRootPath, ["branch", "--list", "fusion/evolution/candidate-next"])).toBe("");
    });
  });

  it("rejects a rollback target whose branch does not resolve to its claimed revision", async () => {
    await withFixture(async (fixture) => {
      const input = request(fixture);
      const port = new RoomEvolutionGitWorktreePort({ workspaceRootPath: fixture.workspaceRootPath });
      const mismatchedRollback = {
        ...input,
        rollbackTarget: { ...input.rollbackTarget, revision: "0".repeat(40) },
      };

      await expect(port.createDedicatedCandidate(mismatchedRollback)).rejects.toMatchObject<Partial<RoomEvolutionGitWorktreePortError>>({
        code: "rollback_target_mismatch",
      });
      expect(git(fixture.repositoryRootPath, ["branch", "--list", "fusion/evolution/candidate-next"])).toBe("");
    });
  });

  it("rejects a branch name that is not derived from the candidate identity", async () => {
    await withFixture(async (fixture) => {
      const port = new RoomEvolutionGitWorktreePort({ workspaceRootPath: fixture.workspaceRootPath });
      const invalidBranch = { ...request(fixture), branchRef: "fusion/other/candidate-next" };

      await expect(port.createDedicatedCandidate(invalidBranch)).rejects.toMatchObject<Partial<RoomEvolutionGitWorktreePortError>>({
        code: "branch_invalid",
      });
      expect(git(fixture.repositoryRootPath, ["status", "--porcelain=v1"])).toBe("");
      expect(git(fixture.repositoryRootPath, ["worktree", "list", "--porcelain"])).not.toContain("evolution-candidate-next");
    });
  });

  it("rejects a workspace root that would place a candidate worktree inside the base checkout", async () => {
    await withFixture(async (fixture) => {
      const unsafePort = new RoomEvolutionGitWorktreePort({ workspaceRootPath: fixture.repositoryRootPath });
      await expect(unsafePort.createDedicatedCandidate(request(fixture))).rejects.toMatchObject<Partial<RoomEvolutionGitWorktreePortError>>({
        code: "destination_unsafe",
      });
      expect(git(fixture.repositoryRootPath, ["status", "--porcelain=v1"])).toBe("");
      expect(git(fixture.repositoryRootPath, ["worktree", "list", "--porcelain"])).not.toContain("evolution-candidate-next");
    });
  });

  it("rejects a malformed high-risk approval without touching the base checkout", async () => {
    await withFixture(async (fixture) => {
      const input = {
        ...request(fixture),
        riskClass: "high" as const,
        approval: undefined,
      } as unknown as RoomEvolutionIsolatedCandidateGitWorktreeRequestV1;
      const port = new RoomEvolutionGitWorktreePort({ workspaceRootPath: fixture.workspaceRootPath });

      await expect(port.createDedicatedCandidate(input)).rejects.toMatchObject<Partial<RoomEvolutionGitWorktreePortError>>({
        code: "human_approval_required",
      });
      expect(git(fixture.repositoryRootPath, ["status", "--porcelain=v1"])).toBe("");
      expect(git(fixture.repositoryRootPath, ["branch", "--list", "fusion/evolution/candidate-next"])).toBe("");
    });
  });
});
