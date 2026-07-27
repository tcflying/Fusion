import { HappierCliError } from "./types.js";

export type HappierRuntimePermissionMode = "read-only" | "safe-yolo";

export function resolveHappierRuntimePermissionMode(
  tools: "coding" | "readonly" | undefined,
): HappierRuntimePermissionMode | undefined {
  if (tools === "readonly") return "read-only";
  if (tools === "coding") return "safe-yolo";
  return undefined;
}

export function resolveHappierRuntimeModelId(
  value: string | undefined,
): string | undefined {
  if (value === undefined) return undefined;
  const modelId = value.trim();
  if (
    !modelId
    || modelId.length > 512
    || /[\u0000-\u001f\u007f]/u.test(modelId)
  ) {
    throw new HappierCliError("session", "Happier runtime modelId is invalid");
  }
  return modelId;
}

export function buildHappierTransportMessage(
  systemPrompt: string | undefined,
  userMessage: string,
): string {
  const normalizedUserMessage = userMessage.trim();
  if (!normalizedUserMessage) {
    throw new HappierCliError("session", "Happier message is required");
  }
  const normalizedSystemPrompt = systemPrompt?.trim();
  if (!normalizedSystemPrompt) return normalizedUserMessage;
  return [
    "[Fusion runtime envelope v1]",
    JSON.stringify({
      systemInstructions: normalizedSystemPrompt,
      userMessage: normalizedUserMessage,
    }),
  ].join("\n");
}
