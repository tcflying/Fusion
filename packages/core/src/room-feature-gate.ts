import type { Settings } from "./types.js";

export const SESSION_ROOM_CONTROL_PLANE_FLAG = "sessionRoomControlPlane" as const;

/*
FNXC:SessionRoomControlPlane 2026-07-17-02:46:
Operational Rooms stay fail-closed until their real same-session and recovery
gates pass. Only an explicit project setting may enable the new control plane;
missing, inherited, malformed, or false values must preserve the legacy paths.
*/
export function isSessionRoomControlPlaneEnabled(
  settings: Pick<Settings, "experimentalFeatures"> | undefined,
): boolean {
  return settings?.experimentalFeatures?.[SESSION_ROOM_CONTROL_PLANE_FLAG] === true;
}
