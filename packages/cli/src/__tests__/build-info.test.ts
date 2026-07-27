import { describe, expect, it } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// The committed launcher and tsup config share this dependency-free module.
// @ts-expect-error JavaScript runtime helper intentionally ships beside bin.mjs.
import {
  assessDistFreshness,
  sha256,
  validateLauncherArtifacts,
  writeBuildGenerationArtifacts,
} from "../../build-info.mjs";

/*
FNXC:CliBuildGeneration 2026-07-27-04:56:
A source checkout must reject a CLI dist built from another source HEAD before
the bundled command can touch PostgreSQL or load Dashboard/plugin code.
*/
describe("CLI dist build-info freshness", () => {
  it("reports dist stale when source HEAD differs from the recorded build HEAD", () => {
    const result = assessDistFreshness({
      buildInfo: {
        formatVersion: 1,
        sourceHead: "a".repeat(40),
        schemaVersion: "0084",
        cliVersion: "0.74.0-beta.3",
        cliDistSha256: "b".repeat(64),
        compatibilityMatrixSha256: "c".repeat(64),
        generationId: "sha256:" + "d".repeat(64),
        builtAt: "2026-07-27T00:00:00.000Z",
      },
      actualDistSha256: "b".repeat(64),
      actualCompatibilityMatrixSha256: "c".repeat(64),
      sourceHead: "e".repeat(40),
      sourceSchemaVersion: "0084",
    });

    expect(result).toEqual({
      ok: false,
      reason:
        `Fusion CLI dist stale: source HEAD ${"e".repeat(40)} does not match dist build-info HEAD ${"a".repeat(40)}.`,
    });
  });

  it("reports dist stale when source schema is newer than the dist build-info schema", () => {
    const result = assessDistFreshness({
      buildInfo: {
        formatVersion: 1,
        sourceHead: "a".repeat(40),
        schemaVersion: "0074",
        cliVersion: "0.74.0-beta.3",
        cliDistSha256: "b".repeat(64),
        compatibilityMatrixSha256: "c".repeat(64),
        generationId: "sha256:" + "d".repeat(64),
        builtAt: "2026-07-27T00:00:00.000Z",
      },
      actualDistSha256: "b".repeat(64),
      actualCompatibilityMatrixSha256: "c".repeat(64),
      sourceHead: "a".repeat(40),
      sourceSchemaVersion: "0084",
    });

    expect(result).toEqual({
      ok: false,
      reason: "Fusion CLI dist stale: source schema 0084 does not match dist build-info schema 0074.",
    });
  });

  it("reports dist stale when build-info does not attest the current CLI bundle bytes", () => {
    const result = assessDistFreshness({
      buildInfo: {
        formatVersion: 1,
        sourceHead: "a".repeat(40),
        schemaVersion: "0084",
        cliVersion: "0.74.0-beta.3",
        cliDistSha256: "b".repeat(64),
        compatibilityMatrixSha256: "c".repeat(64),
        generationId: "sha256:" + "d".repeat(64),
        builtAt: "2026-07-27T00:00:00.000Z",
      },
      actualDistSha256: "e".repeat(64),
      actualCompatibilityMatrixSha256: "c".repeat(64),
      sourceHead: "a".repeat(40),
      sourceSchemaVersion: "0084",
    });

    expect(result).toEqual({
      ok: false,
      reason: "Fusion CLI dist stale: dist/bin.js SHA-256 does not match dist/build-info.json.",
    });
  });

  it("reports dist stale when the compatibility matrix is not the build-info-attested artifact", () => {
    const result = assessDistFreshness({
      buildInfo: {
        formatVersion: 1,
        sourceHead: "a".repeat(40),
        schemaVersion: "0084",
        cliVersion: "0.74.0-beta.3",
        cliDistSha256: "b".repeat(64),
        compatibilityMatrixSha256: "c".repeat(64),
        generationId: "sha256:" + "d".repeat(64),
        builtAt: "2026-07-27T00:00:00.000Z",
      },
      actualDistSha256: "b".repeat(64),
      actualCompatibilityMatrixSha256: "e".repeat(64),
      sourceHead: "a".repeat(40),
      sourceSchemaVersion: "0084",
    });

    expect(result).toEqual({
      ok: false,
      reason:
        "Fusion CLI dist stale: dist/compatibility-matrix.json SHA-256 does not match dist/build-info.json.",
    });
  });

  it("writes one generation matrix spanning CLI, Dashboard, plugins, and PostgreSQL schema", async () => {
    const root = mkdtempSync(join(tmpdir(), "fusion-build-generation-"));
    const cliRoot = join(root, "packages", "cli");
    const dashboardRoot = join(root, "packages", "dashboard");
    const distRoot = join(cliRoot, "dist");
    mkdirSync(join(distRoot, "client"), { recursive: true });
    mkdirSync(join(distRoot, "migrations"), { recursive: true });
    mkdirSync(join(distRoot, "plugins", "example-plugin"), { recursive: true });
    mkdirSync(dashboardRoot, { recursive: true });
    writeFileSync(join(cliRoot, "package.json"), JSON.stringify({
      name: "@runfusion/fusion",
      version: "1.2.3",
    }));
    writeFileSync(join(dashboardRoot, "package.json"), JSON.stringify({
      name: "@fusion/dashboard",
      version: "1.2.3",
    }));
    writeFileSync(join(distRoot, "bin.js"), "console.log('cli');\n");
    writeFileSync(join(distRoot, "client", "index.html"), "<main>dashboard</main>\n");
    writeFileSync(
      join(distRoot, "client", "version.json"),
      JSON.stringify({ version: "aaaaaaa-12345678" }),
    );
    writeFileSync(join(distRoot, "migrations", "0084.sql"), "select 84;\n");
    writeFileSync(
      join(distRoot, "plugins", "example-plugin", "manifest.json"),
      JSON.stringify({ id: "example-plugin", version: "4.5.6" }),
    );
    writeFileSync(
      join(distRoot, "plugins", "example-plugin", "bundled.js"),
      "export default {};\n",
    );

    try {
      const artifacts = await writeBuildGenerationArtifacts({
        cliRoot,
        workspaceRoot: root,
        sourceHead: "a".repeat(40),
        schemaVersion: "0084",
        packagingMode: "full",
        pluginIds: ["example-plugin"],
        builtAt: "2026-07-27T00:00:00.000Z",
      });
      const buildInfo = JSON.parse(
        readFileSync(join(distRoot, "build-info.json"), "utf8"),
      );
      const matrix = JSON.parse(
        readFileSync(join(distRoot, "compatibility-matrix.json"), "utf8"),
      );

      expect(artifacts.buildInfo).toEqual(buildInfo);
      expect(artifacts.compatibilityMatrix).toEqual(matrix);
      expect(buildInfo).toMatchObject({
        sourceHead: "a".repeat(40),
        schemaVersion: "0084",
        cliVersion: "1.2.3",
        generationId: matrix.generationId,
      });
      expect(matrix).toMatchObject({
        sourceHead: "a".repeat(40),
        packagingMode: "full",
        components: {
          cli: { package: "@runfusion/fusion", version: "1.2.3" },
          dashboard: {
            package: "@fusion/dashboard",
            version: "1.2.3",
            buildVersion: "aaaaaaa-12345678",
          },
          schema: { version: "0084" },
          plugins: [
            { id: "example-plugin", version: "4.5.6", included: true },
          ],
        },
      });
      expect(buildInfo.cliDistSha256).toMatch(/^[a-f0-9]{64}$/);
      expect(buildInfo.compatibilityMatrixSha256).toMatch(/^[a-f0-9]{64}$/);
      expect(matrix.components.dashboard.sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(matrix.components.schema.sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(matrix.components.plugins[0].sha256).toMatch(/^[a-f0-9]{64}$/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses a full compatibility artifact built from another Dashboard source HEAD", async () => {
    const root = mkdtempSync(join(tmpdir(), "fusion-dashboard-generation-"));
    const cliRoot = join(root, "packages", "cli");
    const distRoot = join(cliRoot, "dist");
    mkdirSync(join(root, "packages", "dashboard"), { recursive: true });
    mkdirSync(join(distRoot, "client"), { recursive: true });
    mkdirSync(join(distRoot, "migrations"), { recursive: true });
    writeFileSync(join(cliRoot, "package.json"), JSON.stringify({
      name: "@runfusion/fusion",
      version: "1.2.3",
    }));
    writeFileSync(
      join(root, "packages", "dashboard", "package.json"),
      JSON.stringify({ name: "@fusion/dashboard", version: "1.2.3" }),
    );
    writeFileSync(join(distRoot, "bin.js"), "console.log('cli');\n");
    writeFileSync(join(distRoot, "client", "index.html"), "<main>dashboard</main>\n");
    writeFileSync(
      join(distRoot, "client", "version.json"),
      JSON.stringify({ version: "bbbbbbb-12345678" }),
    );
    writeFileSync(join(distRoot, "migrations", "0084.sql"), "select 84;\n");

    try {
      await expect(writeBuildGenerationArtifacts({
        cliRoot,
        workspaceRoot: root,
        sourceHead: "a".repeat(40),
        schemaVersion: "0084",
        packagingMode: "full",
        pluginIds: [],
      })).rejects.toThrow(
        "Cannot write full Fusion compatibility matrix: Dashboard build bbbbbbb-12345678 does not match source HEAD",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses a full compatibility artifact with only partial Dashboard output", async () => {
    const root = mkdtempSync(join(tmpdir(), "fusion-dashboard-partial-"));
    const cliRoot = join(root, "packages", "cli");
    const distRoot = join(cliRoot, "dist");
    mkdirSync(join(root, "packages", "dashboard"), { recursive: true });
    mkdirSync(join(distRoot, "client"), { recursive: true });
    mkdirSync(join(distRoot, "migrations"), { recursive: true });
    writeFileSync(join(cliRoot, "package.json"), JSON.stringify({
      name: "@runfusion/fusion",
      version: "1.2.3",
    }));
    writeFileSync(
      join(root, "packages", "dashboard", "package.json"),
      JSON.stringify({ name: "@fusion/dashboard", version: "1.2.3" }),
    );
    writeFileSync(join(distRoot, "bin.js"), "console.log('cli');\n");
    writeFileSync(
      join(distRoot, "client", "version.json"),
      JSON.stringify({ version: "aaaaaaa-12345678" }),
    );
    writeFileSync(join(distRoot, "migrations", "0084.sql"), "select 84;\n");

    try {
      await expect(writeBuildGenerationArtifacts({
        cliRoot,
        workspaceRoot: root,
        sourceHead: "a".repeat(40),
        schemaVersion: "0084",
        packagingMode: "full",
        pluginIds: [],
      })).rejects.toThrow(
        "Cannot write full Fusion compatibility matrix: Dashboard entrypoint is missing",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("launcher preflight refuses stale schema before handing back build metadata", () => {
    const distSource = "console.log('DIST_EXECUTED');\n";
    const matrixJson = `${JSON.stringify({
      formatVersion: 1,
      generationId: "sha256:" + "d".repeat(64),
      sourceHead: "a".repeat(40),
      packagingMode: "full",
      components: {},
    }, null, 2)}\n`;
    const buildInfoJson = `${JSON.stringify({
        formatVersion: 1,
        sourceHead: "a".repeat(40),
        schemaVersion: "0074",
        cliVersion: "1.2.3",
        cliDistSha256: sha256(distSource),
        compatibilityMatrixSha256: sha256(matrixJson),
        generationId: "sha256:" + "d".repeat(64),
        builtAt: "2026-07-27T00:00:00.000Z",
      }, null, 2)}\n`;

    expect(() => validateLauncherArtifacts({
      buildInfoJson,
      compatibilityMatrixJson: matrixJson,
      distBytes: Buffer.from(distSource),
      sourceHead: "a".repeat(40),
      sourceSchemaVersion: "0084",
    })).toThrow(
        "Fusion CLI dist stale: source schema 0084 does not match dist build-info schema 0074.",
    );
  });

  it("launcher preflight rejects a compatibility matrix from another generation", () => {
    const distSource = "console.log('cli');\n";
    const matrixJson = `${JSON.stringify({
      formatVersion: 1,
      generationId: "sha256:" + "e".repeat(64),
      sourceHead: "a".repeat(40),
      packagingMode: "full",
      components: {
        cli: { version: "1.2.3", sha256: sha256(distSource) },
        schema: { version: "0084" },
      },
    }, null, 2)}\n`;
    const buildInfoJson = `${JSON.stringify({
      formatVersion: 1,
      sourceHead: "a".repeat(40),
      schemaVersion: "0084",
      cliVersion: "1.2.3",
      cliDistSha256: sha256(distSource),
      compatibilityMatrixSha256: sha256(matrixJson),
      generationId: "sha256:" + "d".repeat(64),
      builtAt: "2026-07-27T00:00:00.000Z",
    }, null, 2)}\n`;

    expect(() => validateLauncherArtifacts({
      buildInfoJson,
      compatibilityMatrixJson: matrixJson,
      distBytes: Buffer.from(distSource),
    })).toThrow(
      "Fusion CLI dist stale: build-info and compatibility matrix generation IDs differ.",
    );
  });

  it("launcher preflight rejects a matrix that declares another schema generation", () => {
    const distSource = "console.log('cli');\n";
    const generationId = "sha256:" + "d".repeat(64);
    const matrixJson = `${JSON.stringify({
      formatVersion: 1,
      generationId,
      sourceHead: "a".repeat(40),
      packagingMode: "full",
      components: {
        cli: { version: "1.2.3", sha256: sha256(distSource) },
        schema: { version: "0074" },
      },
    }, null, 2)}\n`;
    const buildInfoJson = `${JSON.stringify({
      formatVersion: 1,
      sourceHead: "a".repeat(40),
      schemaVersion: "0084",
      cliVersion: "1.2.3",
      cliDistSha256: sha256(distSource),
      compatibilityMatrixSha256: sha256(matrixJson),
      generationId,
      builtAt: "2026-07-27T00:00:00.000Z",
    }, null, 2)}\n`;

    expect(() => validateLauncherArtifacts({
      buildInfoJson,
      compatibilityMatrixJson: matrixJson,
      distBytes: Buffer.from(distSource),
    })).toThrow(
      "Fusion CLI dist stale: compatibility matrix schema 0074 does not match build-info schema 0084.",
    );
  });

  it("launcher preflight rejects a matrix that declares another CLI version", () => {
    const distSource = "console.log('cli');\n";
    const generationId = "sha256:" + "d".repeat(64);
    const matrixJson = `${JSON.stringify({
      formatVersion: 1,
      generationId,
      sourceHead: "a".repeat(40),
      packagingMode: "full",
      components: {
        cli: { version: "1.2.2", sha256: sha256(distSource) },
        schema: { version: "0084" },
      },
    }, null, 2)}\n`;
    const buildInfoJson = `${JSON.stringify({
      formatVersion: 1,
      sourceHead: "a".repeat(40),
      schemaVersion: "0084",
      cliVersion: "1.2.3",
      cliDistSha256: sha256(distSource),
      compatibilityMatrixSha256: sha256(matrixJson),
      generationId,
      builtAt: "2026-07-27T00:00:00.000Z",
    }, null, 2)}\n`;

    expect(() => validateLauncherArtifacts({
      buildInfoJson,
      compatibilityMatrixJson: matrixJson,
      distBytes: Buffer.from(distSource),
    })).toThrow(
      "Fusion CLI dist stale: compatibility matrix CLI 1.2.2 does not match build-info CLI 1.2.3.",
    );
  });

  it("launcher preflight rejects a matrix that declares another source HEAD", () => {
    const distSource = "console.log('cli');\n";
    const generationId = "sha256:" + "d".repeat(64);
    const matrixJson = `${JSON.stringify({
      formatVersion: 1,
      generationId,
      sourceHead: "e".repeat(40),
      packagingMode: "full",
      components: {
        cli: { version: "1.2.3", sha256: sha256(distSource) },
        schema: { version: "0084" },
      },
    }, null, 2)}\n`;
    const buildInfoJson = `${JSON.stringify({
      formatVersion: 1,
      sourceHead: "a".repeat(40),
      schemaVersion: "0084",
      cliVersion: "1.2.3",
      cliDistSha256: sha256(distSource),
      compatibilityMatrixSha256: sha256(matrixJson),
      generationId,
      builtAt: "2026-07-27T00:00:00.000Z",
    }, null, 2)}\n`;

    expect(() => validateLauncherArtifacts({
      buildInfoJson,
      compatibilityMatrixJson: matrixJson,
      distBytes: Buffer.from(distSource),
    })).toThrow(
      "Fusion CLI dist stale: compatibility matrix source HEAD does not match build-info source HEAD.",
    );
  });

  it("launcher preflight rejects a matrix that attests other CLI bytes", () => {
    const distSource = "console.log('cli');\n";
    const generationId = "sha256:" + "d".repeat(64);
    const matrixJson = `${JSON.stringify({
      formatVersion: 1,
      generationId,
      sourceHead: "a".repeat(40),
      packagingMode: "full",
      components: {
        cli: { version: "1.2.3", sha256: "e".repeat(64) },
        schema: { version: "0084" },
      },
    }, null, 2)}\n`;
    const buildInfoJson = `${JSON.stringify({
      formatVersion: 1,
      sourceHead: "a".repeat(40),
      schemaVersion: "0084",
      cliVersion: "1.2.3",
      cliDistSha256: sha256(distSource),
      compatibilityMatrixSha256: sha256(matrixJson),
      generationId,
      builtAt: "2026-07-27T00:00:00.000Z",
    }, null, 2)}\n`;

    expect(() => validateLauncherArtifacts({
      buildInfoJson,
      compatibilityMatrixJson: matrixJson,
      distBytes: Buffer.from(distSource),
    })).toThrow(
      "Fusion CLI dist stale: compatibility matrix CLI SHA-256 does not match build-info CLI SHA-256.",
    );
  });

  it("refuses a full compatibility artifact when Dashboard is only the build stub", async () => {
    const root = mkdtempSync(join(tmpdir(), "fusion-full-stub-"));
    const cliRoot = join(root, "packages", "cli");
    const distRoot = join(cliRoot, "dist");
    mkdirSync(join(root, "packages", "dashboard"), { recursive: true });
    mkdirSync(join(distRoot, "client"), { recursive: true });
    mkdirSync(join(distRoot, "migrations"), { recursive: true });
    writeFileSync(join(cliRoot, "package.json"), JSON.stringify({
      name: "@runfusion/fusion",
      version: "1.2.3",
    }));
    writeFileSync(
      join(root, "packages", "dashboard", "package.json"),
      JSON.stringify({ name: "@fusion/dashboard", version: "1.2.3" }),
    );
    writeFileSync(join(distRoot, "bin.js"), "console.log('cli');\n");
    writeFileSync(
      join(distRoot, "client", "index.html"),
      "<p>Dashboard assets not built</p>\n",
    );
    writeFileSync(join(distRoot, "migrations", "0084.sql"), "select 84;\n");

    try {
      await expect(writeBuildGenerationArtifacts({
        cliRoot,
        workspaceRoot: root,
        sourceHead: "a".repeat(40),
        schemaVersion: "0084",
        packagingMode: "full",
        pluginIds: [],
      })).rejects.toThrow(
        "Cannot write full Fusion compatibility matrix: Dashboard assets are a build stub.",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
