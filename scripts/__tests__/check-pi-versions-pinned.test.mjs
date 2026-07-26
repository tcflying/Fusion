import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  scanTrackedManifests,
  validateManifestSet,
} from "../check-pi-versions-pinned.mjs";

const pinnedManifest = {
  dependencies: {
    "@earendil-works/pi-ai": "0.82.0",
    "@earendil-works/pi-coding-agent": "0.82.0",
  },
};

function validate(manifest) {
  return validateManifestSet([{ filePath: "packages/cli/package.json", manifest }]);
}

describe("check-pi-versions-pinned", () => {
  it("passes against every guarded repository manifest", () => {
    assert.deepEqual(scanTrackedManifests(), []);
  });

  it("rejects caret, tilde, wildcard, x, and comparator ranges", () => {
    for (const version of ["^0.82.0", "~0.82.0", "*", "0.82.x", ">=0.82.0"]) {
      const violations = validate({
        ...pinnedManifest,
        dependencies: { ...pinnedManifest.dependencies, "@earendil-works/pi-ai": version },
      });
      assert.equal(violations.length > 0, true, `${version} must be rejected`);
    }
  });

  it("rejects a matched-set version mismatch", () => {
    const violations = validate({
      ...pinnedManifest,
      dependencies: { ...pinnedManifest.dependencies, "@earendil-works/pi-coding-agent": "0.82.1" },
    });
    assert.equal(violations.some((violation) => violation.includes("same exact version")), true);
  });

  it("accepts a clean exact matched pair", () => {
    assert.deepEqual(validate(pinnedManifest), []);
  });
});
