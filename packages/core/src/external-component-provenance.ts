export type ExternalComponentIntegrationMode =
  | "process_api"
  | "package_dependency"
  | "copied_code"
  | "derived_strategy";

export type ExternalLicenseDisposition =
  | "compatible"
  | "boundary_only"
  | "incompatible";

export interface ExternalLicenseProvenanceV1 {
  readonly spdxId: string;
  readonly disposition: ExternalLicenseDisposition;
  readonly evidencePaths: readonly string[];
}

export interface ExternalNoticeProvenanceV1 {
  readonly required: boolean;
  readonly paths: readonly string[];
}

export interface ExternalSourceAttestationV1 {
  readonly path: string;
  readonly revision: string;
  readonly gitBlobSha1: string;
}

export interface ExternalDerivedArtifactV1 {
  readonly localPath: string;
  readonly upstreamPath: string;
  readonly baseRevision: string;
  readonly contentHash: string;
  readonly modificationSummary: string;
}

export interface ExternalComponentProvenanceV1 {
  readonly schemaVersion: 1;
  readonly componentId: string;
  readonly repositoryUrl: string;
  readonly reviewedBaseRevision: string;
  readonly revision: string;
  readonly license: ExternalLicenseProvenanceV1;
  readonly integrationMode: ExternalComponentIntegrationMode;
  readonly boundaryRationale: string;
  readonly notice: ExternalNoticeProvenanceV1;
  readonly sourceAttestations: readonly ExternalSourceAttestationV1[];
  readonly forkRevisionLineage: readonly string[];
  readonly derivedArtifacts: readonly ExternalDerivedArtifactV1[];
}

export interface ExternalComponentProvenanceIssue {
  readonly path: string;
  readonly message: string;
}

export interface ExternalComponentSourceVerifier {
  readonly isRevisionAncestor: (
    repositoryUrl: string,
    ancestorRevision: string,
    descendantRevision: string,
  ) => Promise<boolean>;
  readonly resolveGitBlobSha1: (
    repositoryUrl: string,
    revision: string,
    path: string,
  ) => Promise<string | null>;
}

export class ExternalComponentProvenanceError extends Error {
  readonly code = "external_component_provenance_invalid" as const;
  readonly issues: readonly ExternalComponentProvenanceIssue[];

  constructor(issues: readonly ExternalComponentProvenanceIssue[]) {
    super(issues.map((issue) => `${issue.path}: ${issue.message}`).join("; "));
    this.name = "ExternalComponentProvenanceError";
    this.issues = issues;
  }
}

const ROOT_FIELDS = new Set([
  "schemaVersion",
  "componentId",
  "repositoryUrl",
  "reviewedBaseRevision",
  "revision",
  "license",
  "integrationMode",
  "boundaryRationale",
  "notice",
  "sourceAttestations",
  "forkRevisionLineage",
  "derivedArtifacts",
]);
const LICENSE_FIELDS = new Set(["spdxId", "disposition", "evidencePaths"]);
const NOTICE_FIELDS = new Set(["required", "paths"]);
const ATTESTATION_FIELDS = new Set(["path", "revision", "gitBlobSha1"]);
const DERIVED_FIELDS = new Set([
  "localPath",
  "upstreamPath",
  "baseRevision",
  "contentHash",
  "modificationSummary",
]);
const INTEGRATION_MODES = new Set<ExternalComponentIntegrationMode>([
  "process_api",
  "package_dependency",
  "copied_code",
  "derived_strategy",
]);
const LICENSE_DISPOSITIONS = new Set<ExternalLicenseDisposition>([
  "compatible",
  "boundary_only",
  "incompatible",
]);
const GIT_SHA1 = /^[0-9a-f]{40}$/;
const SHA256 = /^sha256:[0-9a-f]{64}$/;
const GITHUB_REPOSITORY = /^https:\/\/github\.com\/[^\s/#]+\/[^\s/#]+(?:\.git)?$/;
const DEFAULT_LICENSE_POLICY = new Map<string, ExternalLicenseDisposition>([
  ["MIT", "compatible"],
  ["Apache-2.0", "compatible"],
  ["BSD-2-Clause", "compatible"],
  ["BSD-3-Clause", "compatible"],
  ["ISC", "compatible"],
  ["MPL-2.0", "boundary_only"],
  ["LGPL-2.1-only", "boundary_only"],
  ["LGPL-3.0-only", "boundary_only"],
  ["GPL-2.0-only", "boundary_only"],
  ["GPL-3.0-only", "boundary_only"],
  ["AGPL-3.0-only", "boundary_only"],
  ["SSPL-1.0", "boundary_only"],
  ["LicenseRef-Proprietary", "incompatible"],
]);

function issue(
  issues: ExternalComponentProvenanceIssue[],
  path: string,
  message: string,
): void {
  issues.push({ path, message });
}

function objectAt(
  value: unknown,
  path: string,
  fields: ReadonlySet<string>,
  issues: ExternalComponentProvenanceIssue[],
): Record<string, unknown> | null {
  try {
    if (
      value === null
      || typeof value !== "object"
      || Array.isArray(value)
      || Object.getPrototypeOf(value) !== Object.prototype
    ) {
      issue(issues, path, "must be a plain object");
      return null;
    }
    const safe: Record<string, unknown> = {};
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string" || !fields.has(key)) {
        issue(issues, path, `unknown field ${String(key)}`);
        continue;
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
        issue(issues, `${path}.${key}`, "must be an enumerable data field");
        continue;
      }
      safe[key] = descriptor.value;
    }
    return safe;
  } catch {
    issue(issues, path, "could not be inspected safely");
    return null;
  }
}

function stringAt(
  value: unknown,
  path: string,
  issues: ExternalComponentProvenanceIssue[],
): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    issue(issues, path, "must be a non-empty string");
    return "";
  }
  if (value !== value.trim()) {
    issue(issues, path, "must not contain leading or trailing whitespace");
  }
  return value;
}

function arrayAt(
  value: unknown,
  path: string,
  issues: ExternalComponentProvenanceIssue[],
): readonly unknown[] {
  try {
    if (!Array.isArray(value)) {
      issue(issues, path, "must be an array");
      return [];
    }
    const safe: unknown[] = [];
    for (const key of Reflect.ownKeys(value)) {
      if (key === "length") continue;
      if (typeof key !== "string" || !/^(0|[1-9][0-9]*)$/.test(key)) {
        issue(issues, path, `unknown field ${String(key)}`);
        continue;
      }
    }
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor) {
        issue(issues, `${path}[${index}]`, "sparse arrays are not allowed");
        continue;
      }
      if (!("value" in descriptor) || !descriptor.enumerable) {
        issue(issues, `${path}[${index}]`, "must be an enumerable data item");
        continue;
      }
      safe.push(descriptor.value);
    }
    return safe;
  } catch {
    issue(issues, path, "could not be inspected safely");
    return [];
  }
}

function pathAt(
  value: unknown,
  path: string,
  issues: ExternalComponentProvenanceIssue[],
): string {
  const candidate = stringAt(value, path, issues);
  if (
    !candidate
    || candidate.includes("\\")
    || candidate.startsWith("/")
    || /^[A-Za-z]:/.test(candidate)
    || candidate.split("/").some((segment) => !segment || segment === "." || segment === "..")
  ) {
    issue(issues, path, "must be a normalized repository-relative path");
  }
  return candidate;
}

function stringArrayAt(
  value: unknown,
  path: string,
  issues: ExternalComponentProvenanceIssue[],
  parser: (item: unknown, itemPath: string, issues: ExternalComponentProvenanceIssue[]) => string,
): readonly string[] {
  const items = arrayAt(value, path, issues).map((item, index) => (
    parser(item, `${path}[${index}]`, issues)
  ));
  if (new Set(items).size !== items.length) {
    issue(issues, path, "must not contain duplicates");
  }
  return items;
}

function revisionAt(
  value: unknown,
  path: string,
  issues: ExternalComponentProvenanceIssue[],
): string {
  const revision = stringAt(value, path, issues);
  if (!GIT_SHA1.test(revision)) {
    issue(issues, path, "must be a pinned 40-character lowercase Git SHA-1");
  }
  return revision;
}

function deepFreeze<T>(value: T): Readonly<T> {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const nested of Object.values(value as Record<string, unknown>)) {
      deepFreeze(nested);
    }
    Object.freeze(value);
  }
  return value;
}

function parseComponent(
  value: unknown,
  index: number,
  issues: ExternalComponentProvenanceIssue[],
): ExternalComponentProvenanceV1 {
  const basePath = `components[${index}]`;
  const root = objectAt(value, basePath, ROOT_FIELDS, issues) ?? {};
  if (root.schemaVersion !== 1) {
    issue(issues, `${basePath}.schemaVersion`, "must equal 1");
  }
  const componentId = stringAt(root.componentId, `${basePath}.componentId`, issues);
  const repositoryUrl = stringAt(root.repositoryUrl, `${basePath}.repositoryUrl`, issues);
  if (!GITHUB_REPOSITORY.test(repositoryUrl)) {
    issue(issues, `${basePath}.repositoryUrl`, "must be a canonical HTTPS GitHub repository URL");
  }
  const reviewedBaseRevision = revisionAt(
    root.reviewedBaseRevision,
    `${basePath}.reviewedBaseRevision`,
    issues,
  );
  const revision = revisionAt(root.revision, `${basePath}.revision`, issues);

  const rawLicense = objectAt(root.license, `${basePath}.license`, LICENSE_FIELDS, issues) ?? {};
  const spdxId = stringAt(rawLicense.spdxId, `${basePath}.license.spdxId`, issues);
  const disposition = stringAt(
    rawLicense.disposition,
    `${basePath}.license.disposition`,
    issues,
  ) as ExternalLicenseDisposition;
  if (!LICENSE_DISPOSITIONS.has(disposition)) {
    issue(issues, `${basePath}.license.disposition`, "has an unsupported disposition");
  }
  const requiredDisposition = DEFAULT_LICENSE_POLICY.get(spdxId);
  if (!requiredDisposition) {
    issue(issues, `${basePath}.license.spdxId`, "is not present in the approved license policy");
  } else if (requiredDisposition !== disposition) {
    issue(
      issues,
      `${basePath}.license.disposition`,
      `must be ${requiredDisposition} for ${spdxId}`,
    );
  }
  const evidencePaths = stringArrayAt(
    rawLicense.evidencePaths,
    `${basePath}.license.evidencePaths`,
    issues,
    pathAt,
  );
  if (evidencePaths.length === 0) {
    issue(issues, `${basePath}.license.evidencePaths`, "must include license evidence");
  }

  const integrationMode = stringAt(
    root.integrationMode,
    `${basePath}.integrationMode`,
    issues,
  ) as ExternalComponentIntegrationMode;
  if (!INTEGRATION_MODES.has(integrationMode)) {
    issue(issues, `${basePath}.integrationMode`, "has an unsupported integration mode");
  }
  const boundaryRationale = stringAt(
    root.boundaryRationale,
    `${basePath}.boundaryRationale`,
    issues,
  );

  const rawNotice = objectAt(root.notice, `${basePath}.notice`, NOTICE_FIELDS, issues) ?? {};
  const noticeRequired = rawNotice.required;
  if (typeof noticeRequired !== "boolean") {
    issue(issues, `${basePath}.notice.required`, "must be a boolean");
  }
  const noticePaths = stringArrayAt(
    rawNotice.paths,
    `${basePath}.notice.paths`,
    issues,
    pathAt,
  );
  if (noticeRequired === true && noticePaths.length === 0) {
    issue(issues, `${basePath}.notice.paths`, "must include every required NOTICE path");
  }

  const sourceAttestations = arrayAt(
    root.sourceAttestations,
    `${basePath}.sourceAttestations`,
    issues,
  ).map((entry, attestationIndex) => {
    const entryPath = `${basePath}.sourceAttestations[${attestationIndex}]`;
    const raw = objectAt(entry, entryPath, ATTESTATION_FIELDS, issues) ?? {};
    const sourcePath = pathAt(raw.path, `${entryPath}.path`, issues);
    const attestedRevision = revisionAt(raw.revision, `${entryPath}.revision`, issues);
    const gitBlobSha1 = stringAt(raw.gitBlobSha1, `${entryPath}.gitBlobSha1`, issues);
    if (!GIT_SHA1.test(gitBlobSha1)) {
      issue(issues, `${entryPath}.gitBlobSha1`, "must be a 40-character lowercase Git blob SHA-1");
    }
    return { path: sourcePath, revision: attestedRevision, gitBlobSha1 };
  });
  if (sourceAttestations.length === 0) {
    issue(issues, `${basePath}.sourceAttestations`, "must include at least one pinned source file");
  }
  if (
    new Set(sourceAttestations.map((entry) => `${entry.revision}:${entry.path}`)).size
    !== sourceAttestations.length
  ) {
    issue(issues, `${basePath}.sourceAttestations`, "must not contain duplicate revision/path pairs");
  }

  const forkRevisionLineage = stringArrayAt(
    root.forkRevisionLineage,
    `${basePath}.forkRevisionLineage`,
    issues,
    revisionAt,
  );
  if (forkRevisionLineage.length === 0) {
    issue(issues, `${basePath}.forkRevisionLineage`, "must include the reviewed base and effective revision");
  } else {
    if (forkRevisionLineage[0] !== reviewedBaseRevision) {
      issue(issues, `${basePath}.forkRevisionLineage[0]`, "must equal reviewedBaseRevision");
    }
    if (forkRevisionLineage.at(-1) !== revision) {
      issue(issues, `${basePath}.forkRevisionLineage`, "must end at the effective revision");
    }
  }
  for (const [attestationIndex, attestation] of sourceAttestations.entries()) {
    if (!forkRevisionLineage.includes(attestation.revision)) {
      issue(
        issues,
        `${basePath}.sourceAttestations[${attestationIndex}].revision`,
        "must appear in forkRevisionLineage",
      );
    }
  }
  const derivedArtifacts = arrayAt(
    root.derivedArtifacts,
    `${basePath}.derivedArtifacts`,
    issues,
  ).map((entry, artifactIndex) => {
    const entryPath = `${basePath}.derivedArtifacts[${artifactIndex}]`;
    const raw = objectAt(entry, entryPath, DERIVED_FIELDS, issues) ?? {};
    const contentHash = stringAt(raw.contentHash, `${entryPath}.contentHash`, issues);
    if (!SHA256.test(contentHash)) {
      issue(issues, `${entryPath}.contentHash`, "must be a lowercase sha256:<64 hex> digest");
    }
    return {
      localPath: pathAt(raw.localPath, `${entryPath}.localPath`, issues),
      upstreamPath: pathAt(raw.upstreamPath, `${entryPath}.upstreamPath`, issues),
      baseRevision: revisionAt(raw.baseRevision, `${entryPath}.baseRevision`, issues),
      contentHash,
      modificationSummary: stringAt(
        raw.modificationSummary,
        `${entryPath}.modificationSummary`,
        issues,
      ),
    };
  });

  if (
    (disposition === "boundary_only" || disposition === "incompatible")
    && integrationMode !== "process_api"
  ) {
    issue(
      issues,
      `${basePath}.license.disposition`,
      `${disposition} components may be used only through process_api`,
    );
  }
  if (
    (integrationMode === "copied_code" || integrationMode === "derived_strategy")
    && derivedArtifacts.length === 0
  ) {
    issue(issues, `${basePath}.derivedArtifacts`, `must describe provenance for ${integrationMode}`);
  }
  if (
    (integrationMode === "copied_code" || integrationMode === "derived_strategy")
    && noticeRequired !== true
  ) {
    issue(issues, `${basePath}.notice.required`, `must be true for ${integrationMode}`);
  }
  for (const [artifactIndex, artifact] of derivedArtifacts.entries()) {
    if (artifact.baseRevision !== revision) {
      issue(
        issues,
        `${basePath}.derivedArtifacts[${artifactIndex}].baseRevision`,
        "must equal the component revision",
      );
    }
  }

  return {
    schemaVersion: 1,
    componentId,
    repositoryUrl,
    reviewedBaseRevision,
    revision,
    license: { spdxId, disposition, evidencePaths },
    integrationMode,
    boundaryRationale,
    notice: { required: noticeRequired === true, paths: noticePaths },
    sourceAttestations,
    forkRevisionLineage,
    derivedArtifacts,
  };
}

/**
 * Fail-closed provenance gate for every external component or strategy reused
 * by Fusion. Callers receive a detached deeply-frozen inventory so a passing
 * gate cannot be invalidated through later mutation of the input object.
 */
export function validateExternalComponentInventory(
  input: unknown,
): readonly Readonly<ExternalComponentProvenanceV1>[] {
  const issues: ExternalComponentProvenanceIssue[] = [];
  const items = arrayAt(input, "components", issues);
  const parsed = items.map((item, index) => parseComponent(item, index, issues));
  const componentIds = new Set<string>();
  for (const [index, component] of parsed.entries()) {
    if (componentIds.has(component.componentId)) {
      issue(issues, `components[${index}].componentId`, `duplicate componentId ${component.componentId}`);
    }
    componentIds.add(component.componentId);
  }
  if (issues.length > 0) {
    throw new ExternalComponentProvenanceError(issues);
  }
  return deepFreeze(parsed);
}

/**
 * Verify repository-backed claims that cannot be proven from a static manifest
 * alone. Production/CI callers provide a shell-free Git or source-host adapter;
 * every lineage edge and attested blob must resolve exactly.
 */
export async function verifyExternalComponentInventorySources(
  inventory: readonly ExternalComponentProvenanceV1[],
  verifier: ExternalComponentSourceVerifier,
): Promise<void> {
  const validated = validateExternalComponentInventory(inventory);
  const issues: ExternalComponentProvenanceIssue[] = [];
  for (const [componentIndex, component] of validated.entries()) {
    for (let index = 1; index < component.forkRevisionLineage.length; index += 1) {
      const ancestor = component.forkRevisionLineage[index - 1]!;
      const descendant = component.forkRevisionLineage[index]!;
      let isAncestor = false;
      try {
        isAncestor = await verifier.isRevisionAncestor(
          component.repositoryUrl,
          ancestor,
          descendant,
        );
      } catch {
        issue(
          issues,
          `components[${componentIndex}].forkRevisionLineage[${index}]`,
          "ancestry could not be verified",
        );
        continue;
      }
      if (!isAncestor) {
        issue(
          issues,
          `components[${componentIndex}].forkRevisionLineage[${index}]`,
          `${ancestor} is not an ancestor of ${descendant}`,
        );
      }
    }
    for (const [attestationIndex, attestation] of component.sourceAttestations.entries()) {
      let actual: string | null = null;
      try {
        actual = await verifier.resolveGitBlobSha1(
          component.repositoryUrl,
          attestation.revision,
          attestation.path,
        );
      } catch {
        actual = null;
      }
      if (actual !== attestation.gitBlobSha1) {
        issue(
          issues,
          `components[${componentIndex}].sourceAttestations[${attestationIndex}]`,
          `expected blob ${attestation.gitBlobSha1} but resolved ${actual ?? "missing"}`,
        );
      }
    }
  }
  if (issues.length > 0) {
    throw new ExternalComponentProvenanceError(issues);
  }
}
