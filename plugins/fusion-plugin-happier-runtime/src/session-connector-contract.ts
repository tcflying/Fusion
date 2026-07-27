/**
 * FNXC:HappierMcp 2026-07-19-19:52:
 * Keep the public connector identity in a lightweight module so plugin
 * registration never starts or evaluates an MCP bridge before it is used.
 */

export const HAPPIER_SESSION_CONNECTOR_ID = "happier";
export const HAPPIER_SESSION_CONNECTOR_VERSION = "0.3.0";
export const HAPPIER_OFFICIAL_MCP_SOURCE_REVISION =
  "local-custom-adapter-v1+happier-session-control-6e059c4";
