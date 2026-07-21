import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import {
  ExternalComponentProvenanceError,
  validateExternalComponentInventory,
  verifyExternalComponentInventorySources,
  type ExternalComponentProvenanceV1,
} from "../external-component-provenance.js";
import {
  SESSION_ROOM_EXTERNAL_COMPONENTS,
  VALIDATED_SESSION_ROOM_EXTERNAL_COMPONENTS,
} from "../session-room-external-components.js";

const SHA = "0123456789abcdef0123456789abcdef01234567";
const BLOB = "89abcdef0123456789abcdef0123456789abcdef";
const CONTENT_HASH = `sha256:${"ab".repeat(32)}`;
const execFileAsync = promisify(execFile);
const happierRepository = process.env.FUSION_HAPPIER_REPOSITORY;

function component(
  overrides: Partial<ExternalComponentProvenanceV1> = {},
): ExternalComponentProvenanceV1 {
  return {
    schemaVersion: 1,
    componentId: "example-orchestrator",
    repositoryUrl: "https://github.com/example/orchestrator",
    reviewedBaseRevision: SHA,
    revision: SHA,
    license: {
      spdxId: "MIT",
      disposition: "compatible",
      evidencePaths: ["LICENSE"],
    },
    integrationMode: "process_api",
    boundaryRationale: "Invoked through a versioned process protocol.",
    notice: { required: false, paths: [] },
    sourceAttestations: [{ path: "src/protocol.ts", revision: SHA, gitBlobSha1: BLOB }],
    forkRevisionLineage: [SHA],
    derivedArtifacts: [],
    ...overrides,
  };
}

describe("external component provenance gate", () => {
  it("accepts and freezes the pinned Session Room Happier inventory", () => {
    const inventory = validateExternalComponentInventory(
      SESSION_ROOM_EXTERNAL_COMPONENTS,
    );

    expect(inventory).toHaveLength(1);
    expect(inventory[0]).toMatchObject({
      componentId: "happier-direct-session-cli",
      repositoryUrl: "https://github.com/happier-dev/happier",
      reviewedBaseRevision: "f07b7317cd4c7f0cfa762189dc68d16750a48182",
      revision: "01ba80cc7c463c311510801f70200974b2bb6039",
      integrationMode: "process_api",
      license: { spdxId: "MIT", disposition: "compatible" },
    });
    expect(inventory[0]?.sourceAttestations).toHaveLength(14);
    expect(Object.isFrozen(inventory)).toBe(true);
    expect(Object.isFrozen(inventory[0]?.sourceAttestations)).toBe(true);
    expect(VALIDATED_SESSION_ROOM_EXTERNAL_COMPONENTS).toEqual(inventory);
  });

  it.each([
    ["floating revision", component({ revision: "main" })],
    ["non-HTTPS repository", component({ repositoryUrl: "git://github.com/example/orchestrator" })],
    ["path traversal", component({ license: {
      spdxId: "MIT",
      disposition: "compatible",
      evidencePaths: ["../LICENSE"],
    } })],
    ["missing source attestations", component({ sourceAttestations: [] })],
    ["malformed blob id", component({
      sourceAttestations: [{ path: "src/protocol.ts", revision: SHA, gitBlobSha1: "abc" }],
    })],
    ["missing required notice", component({ notice: { required: true, paths: [] } })],
  ])("rejects %s", (_label, value) => {
    expect(() => validateExternalComponentInventory([value])).toThrow(
      ExternalComponentProvenanceError,
    );
  });

  it("rejects duplicate component identities", () => {
    expect(() => validateExternalComponentInventory([
      component(),
      component({ revision: "fedcba9876543210fedcba9876543210fedcba98" }),
    ])).toThrow(/duplicate componentId/i);
  });

  it("permits boundary-only licenses only through an explicit process/API boundary", () => {
    const boundaryOnly = component({
      license: {
        spdxId: "AGPL-3.0-only",
        disposition: "boundary_only",
        evidencePaths: ["LICENSE"],
      },
    });
    expect(validateExternalComponentInventory([boundaryOnly])).toHaveLength(1);

    expect(() => validateExternalComponentInventory([{
      ...boundaryOnly,
      integrationMode: "package_dependency",
    }])).toThrow(/boundary_only/i);
  });

  it.each(["copied_code", "derived_strategy"] as const)(
    "requires complete modification provenance for %s",
    (integrationMode) => {
      expect(() => validateExternalComponentInventory([
        component({ integrationMode, derivedArtifacts: [] }),
      ])).toThrow(/derivedArtifacts/i);

      const validated = validateExternalComponentInventory([
        component({
          integrationMode,
          notice: { required: true, paths: ["THIRD_PARTY_NOTICES.md"] },
          derivedArtifacts: [{
            localPath: "packages/core/src/adapted-strategy.ts",
            upstreamPath: "src/strategy.ts",
            baseRevision: SHA,
            contentHash: CONTENT_HASH,
            modificationSummary: "Ported the bounded retry policy to Fusion contracts.",
          }],
        }),
      ]);
      expect(validated[0]?.derivedArtifacts).toHaveLength(1);
    },
  );

  it("fails closed on unknown fields at every contract layer", () => {
    expect(() => validateExternalComponentInventory([{
      ...component(),
      unexpected: true,
    }])).toThrow(/unknown field/i);

    expect(() => validateExternalComponentInventory([{
      ...component(),
      license: {
        ...component().license,
        inventedApproval: true,
      },
    }])).toThrow(/unknown field/i);
  });

  it("rejects symbols, accessors, sparse arrays, and reflective proxies without invoking them", () => {
    let getterInvoked = false;
    const withAccessor = component() as ExternalComponentProvenanceV1 & {
      repositoryUrl: string;
    };
    Object.defineProperty(withAccessor, "repositoryUrl", {
      enumerable: true,
      get() {
        getterInvoked = true;
        return "https://github.com/attacker/repository";
      },
    });
    expect(() => validateExternalComponentInventory([withAccessor])).toThrow(
      ExternalComponentProvenanceError,
    );
    expect(getterInvoked).toBe(false);

    const withSymbol = component() as ExternalComponentProvenanceV1 & Record<symbol, boolean>;
    withSymbol[Symbol("hidden")] = true;
    expect(() => validateExternalComponentInventory([withSymbol])).toThrow(/unknown field/i);

    const sparse = [component(), component()];
    delete sparse[0];
    expect(() => validateExternalComponentInventory(sparse)).toThrow(/sparse arrays/i);

    const proxy = new Proxy(component(), {
      ownKeys() {
        throw new Error("reflective trap");
      },
    });
    expect(() => validateExternalComponentInventory([proxy])).toThrow(
      ExternalComponentProvenanceError,
    );
  });

  it.each([
    ["revision", component({ revision: ` ${SHA}` })],
    ["path", component({
      sourceAttestations: [{ path: "src/protocol.ts ", revision: SHA, gitBlobSha1: BLOB }],
    })],
    ["content hash", component({
      integrationMode: "copied_code",
      notice: { required: true, paths: ["THIRD_PARTY_NOTICES.md"] },
      derivedArtifacts: [{
        localPath: "src/adapted.ts",
        upstreamPath: "src/original.ts",
        baseRevision: SHA,
        contentHash: `${CONTENT_HASH} `,
        modificationSummary: "Adapted implementation.",
      }],
    })],
  ])("rejects leading or trailing whitespace in exact %s tokens", (_label, value) => {
    expect(() => validateExternalComponentInventory([value])).toThrow(/whitespace/i);
  });

  it("verifies every ordered lineage edge and attested source blob", async () => {
    const inventory = validateExternalComponentInventory(SESSION_ROOM_EXTERNAL_COMPONENTS);
    const ancestry: Array<readonly [string, string]> = [];
    const blobs = new Map(
      inventory[0]!.sourceAttestations.map((entry) => [
        `${entry.revision}:${entry.path}`,
        entry.gitBlobSha1,
      ]),
    );
    await expect(verifyExternalComponentInventorySources(inventory, {
      isRevisionAncestor: async (_repository, ancestor, descendant) => {
        ancestry.push([ancestor, descendant]);
        return true;
      },
      resolveGitBlobSha1: async (_repository, revision, path) => (
        blobs.get(`${revision}:${path}`) ?? null
      ),
    })).resolves.toBeUndefined();
    expect(ancestry).toEqual([
      [
        "f07b7317cd4c7f0cfa762189dc68d16750a48182",
        "753e8bc3704e0dcdaa4b698ddbc3e96bfc0ae7a5",
      ],
      [
        "753e8bc3704e0dcdaa4b698ddbc3e96bfc0ae7a5",
        "01ba80cc7c463c311510801f70200974b2bb6039",
      ],
    ]);

    await expect(verifyExternalComponentInventorySources(inventory, {
      isRevisionAncestor: async () => false,
      resolveGitBlobSha1: async () => null,
    })).rejects.toThrow(ExternalComponentProvenanceError);
  });

  it.skipIf(!happierRepository)(
    "verifies the pinned Happier ancestry, blobs, and repository identity against a configured checkout",
    async () => {
      const cwd = happierRepository!;
      const remote = (await execFileAsync("git", ["remote", "get-url", "origin"], {
        cwd,
        encoding: "utf8",
        windowsHide: true,
      })).stdout.trim().replace(/\.git$/, "");
      expect(remote).toBe("https://github.com/happier-dev/happier");
      const trees = new Map<string, ReadonlyMap<string, string>>();

      await expect(verifyExternalComponentInventorySources(
        SESSION_ROOM_EXTERNAL_COMPONENTS,
        {
          isRevisionAncestor: async (_repository, ancestor, descendant) => {
            try {
              await execFileAsync("git", ["merge-base", "--is-ancestor", ancestor, descendant], {
                cwd,
                windowsHide: true,
              });
              return true;
            } catch (error) {
              const exitCode = (error as { code?: unknown }).code;
              if (exitCode === 1) return false;
              throw error;
            }
          },
          resolveGitBlobSha1: async (_repository, revision, path) => {
            let tree = trees.get(revision);
            if (!tree) {
              const stdout = (await execFileAsync("git", ["ls-tree", "-r", revision], {
                cwd,
                encoding: "utf8",
                maxBuffer: 16 * 1024 * 1024,
                windowsHide: true,
              })).stdout;
              const parsed = new Map<string, string>();
              for (const line of String(stdout).split(/\r?\n/)) {
                const match = /^\d+\s+blob\s+([0-9a-f]{40})\t(.+)$/.exec(line);
                if (match) parsed.set(match[2]!, match[1]!);
              }
              tree = parsed;
              trees.set(revision, tree);
            }
            return tree.get(path) ?? null;
          },
        },
      )).resolves.toBeUndefined();
    },
  );
});
