/*
FNXC:SessionRoomContracts 2026-07-17-02:53:
Room subsystems evolve independently across parallel worktrees. Every persisted
or externally exchanged record carries the owning surface version; a single
unversioned catch-all contract would make safe migration and rollback opaque.
*/
export const ROOM_CONTRACT_VERSIONS = {
  storage: 1,
  sessionConnector: 1,
  controller: 1,
  protocol: 1,
  evidence: 1,
  ui: 1,
  api: "room.v1",
} as const;

export type RoomStorageContractVersion = typeof ROOM_CONTRACT_VERSIONS.storage;
export type SessionConnectorContractVersion = typeof ROOM_CONTRACT_VERSIONS.sessionConnector;
export type RoomControllerContractVersion = typeof ROOM_CONTRACT_VERSIONS.controller;
export type RoomProtocolContractVersion = typeof ROOM_CONTRACT_VERSIONS.protocol;
export type RoomEvidenceContractVersion = typeof ROOM_CONTRACT_VERSIONS.evidence;
export type RoomUiContractVersion = typeof ROOM_CONTRACT_VERSIONS.ui;
export type RoomApiVersion = typeof ROOM_CONTRACT_VERSIONS.api;
