/**
 * FNXC:WindowsNativeRoomHostComposition 2026-07-21-02:17:
 * Keep the CLI module path stable for the daemon while the canonical Windows
 * host-composition registry lives in @fusion/engine.
 */
export {
  WINDOWS_NATIVE_ROOM_HOST_COMPOSITION_ADAPTER_BINDINGS_V1,
  createWindowsNativeRoomHostCompositionAdapterRegistry,
} from "@fusion/engine";
export type {
  CreateWindowsNativeRoomHostCompositionAdapterRegistryInputV1,
} from "@fusion/engine";
