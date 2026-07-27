import { HAPPIER_RUNTIME_COMPATIBILITY } from "./cli-attestation.js";

/**
 * This identifies the adapter distribution, not Happier itself. The pinned
 * upstream source and protocol remain independently attested at runtime.
 */
export const HAPPIER_RUNTIME_PROVENANCE = Object.freeze({
  distribution: "local_custom_integration",
  officialHappierPlugin: false,
  maintainer: "tcflying",
  repository: "https://github.com/tcflying/Fusion",
  upstreamRepository: "https://github.com/happier-dev/happier",
  upstreamSourceCommit: HAPPIER_RUNTIME_COMPATIBILITY.happierSourceCommit,
  upstreamProtocolContract: HAPPIER_RUNTIME_COMPATIBILITY.officialProtocolContract,
} as const);
