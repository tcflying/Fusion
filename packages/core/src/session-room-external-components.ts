import {
  validateExternalComponentInventory,
  type ExternalComponentProvenanceV1,
} from "./external-component-provenance.js";

/**
 * Machine-auditable source and license inventory for the external components
 * the Session Room control plane actually reuses. Happier remains a separate
 * CLI/process boundary: no Happier source file is copied into Fusion.
 */
export const SESSION_ROOM_EXTERNAL_COMPONENTS = [
  {
    schemaVersion: 1,
    componentId: "happier-direct-session-cli",
    repositoryUrl: "https://github.com/happier-dev/happier",
    reviewedBaseRevision: "f07b7317cd4c7f0cfa762189dc68d16750a48182",
    revision: "01ba80cc7c463c311510801f70200974b2bb6039",
    license: {
      spdxId: "MIT",
      disposition: "compatible",
      evidencePaths: ["apps/cli/package.json", "apps/ui/LICENSE"],
    },
    integrationMode: "process_api",
    boundaryRationale:
      "Fusion invokes the pinned Happier CLI artifact through the versioned Direct Session process contract; provider credentials and native Session state remain owned by Happier and the official provider CLIs.",
    notice: {
      required: false,
      paths: [],
    },
    sourceAttestations: [
      {
        path: "apps/cli/package.json",
        revision: "f07b7317cd4c7f0cfa762189dc68d16750a48182",
        gitBlobSha1: "586fd657fbc6ac2de2d12edc6a80790afad2a71f",
      },
      {
        path: "apps/cli/src/api/directSessions/ensure/ensureDirectSessionFromUri.ts",
        revision: "f07b7317cd4c7f0cfa762189dc68d16750a48182",
        gitBlobSha1: "43cae752de60fbf9593b7058828819ac623b8992",
      },
      {
        path: "apps/cli/src/backends/claude/directSessions/providerOps.ts",
        revision: "f07b7317cd4c7f0cfa762189dc68d16750a48182",
        gitBlobSha1: "9cdba651c54bdc1c479c6268c4b12abb01106a98",
      },
      {
        path: "apps/cli/src/backends/codex/directSessions/providerOps.ts",
        revision: "f07b7317cd4c7f0cfa762189dc68d16750a48182",
        gitBlobSha1: "e9b112149ae67a4ac782f7301e8f222948db9417",
      },
      {
        path: "apps/cli/src/backends/opencode/directSessions/providerOps.ts",
        revision: "f07b7317cd4c7f0cfa762189dc68d16750a48182",
        gitBlobSha1: "aa43552913c9bdc73e8cd1f2401d657f489e09a6",
      },
      {
        path: "apps/cli/src/cli/commands/directSession.ts",
        revision: "f07b7317cd4c7f0cfa762189dc68d16750a48182",
        gitBlobSha1: "350b5d2d214b559e718ee65493a7ef51ec8945f8",
      },
      {
        path: "apps/cli/src/cli/commands/directSession/contract.ts",
        revision: "f07b7317cd4c7f0cfa762189dc68d16750a48182",
        gitBlobSha1: "e78fd844c9579b1fdedfe732e3a4e4d8fa4f0733",
      },
      {
        path: "apps/cli/src/cli/commands/session/create.ts",
        revision: "f07b7317cd4c7f0cfa762189dc68d16750a48182",
        gitBlobSha1: "61aaba58edfc5fe0922ff2884620b4a640733d85",
      },
      {
        path: "apps/cli/src/cli/commands/session/send.ts",
        revision: "f07b7317cd4c7f0cfa762189dc68d16750a48182",
        gitBlobSha1: "f6ad5fff09b683d23bcbedcdbf538effa291cf5f",
      },
      {
        path: "apps/cli/src/cli/commands/session/status.ts",
        revision: "f07b7317cd4c7f0cfa762189dc68d16750a48182",
        gitBlobSha1: "6e5b1fd900cf37f040a4b13e2dcb6e0169451a30",
      },
      {
        path: "apps/ui/LICENSE",
        revision: "f07b7317cd4c7f0cfa762189dc68d16750a48182",
        gitBlobSha1: "9055a5ed4f667c8730bd8a395fb9d22496348ba6",
      },
      {
        path: "apps/cli/src/cli/commands/directSession.ts",
        revision: "01ba80cc7c463c311510801f70200974b2bb6039",
        gitBlobSha1: "ec45feb694e92fa50d1885f4c1fd20d183625a94",
      },
      {
        path: "apps/cli/src/cli/commands/directSession/capabilities.ts",
        revision: "01ba80cc7c463c311510801f70200974b2bb6039",
        gitBlobSha1: "2e588434820ae8e8617832804b1a5190a2ad359e",
      },
      {
        path: "apps/cli/src/cli/commands/directSession/runtimeBuildAttestation.ts",
        revision: "01ba80cc7c463c311510801f70200974b2bb6039",
        gitBlobSha1: "a09a0adc9db72af5aed78ee8a73112d8633ae2dc",
      },
    ],
    forkRevisionLineage: [
      "f07b7317cd4c7f0cfa762189dc68d16750a48182",
      "753e8bc3704e0dcdaa4b698ddbc3e96bfc0ae7a5",
      "01ba80cc7c463c311510801f70200974b2bb6039",
    ],
    derivedArtifacts: [],
  },
] as const satisfies readonly ExternalComponentProvenanceV1[];

/** Startup/import-time fail-closed form used by runtime and promotion gates. */
export const VALIDATED_SESSION_ROOM_EXTERNAL_COMPONENTS =
  validateExternalComponentInventory(SESSION_ROOM_EXTERNAL_COMPONENTS);
