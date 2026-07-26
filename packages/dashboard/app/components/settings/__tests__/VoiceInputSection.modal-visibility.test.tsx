import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ADVANCED_SETTINGS_SECTION_IDS } from "../../SettingsModal";

/**
 * The Voice Input nav entry must remain a Basic-mode setting. The modal's
 * visibility filter is driven solely by ADVANCED_SETTINGS_SECTION_IDS, while
 * this source-level contract also protects the matching render-switch case.
 */
describe("Voice Input SettingsModal visibility", () => {
  it("keeps Voice Input visible outside Advanced settings and wires its render case", () => {
    expect(ADVANCED_SETTINGS_SECTION_IDS.has("voice-input")).toBe(false);
    const modalSource = readFileSync(resolve(__dirname, "../../SettingsModal.tsx"), "utf8");
    expect(modalSource).toContain('id: "voice-input", label: "Voice Input"');
    expect(modalSource).toContain('case "voice-input":');
    expect(modalSource).toContain("<VoiceInputSection form={form} setForm={setForm} />");
  });
});
