/*
FNXC:HappierProjectBindingPersistence 2026-07-20-01:52:
Happier session mappings are project-owned runtime state, not global plugin
installation configuration. A dedicated per-project JSONB field prevents one
project's binding update from read-modify-writing or exposing another project's
bindings. The connector still requires separate host-issued write authorization.
*/
ALTER TABLE central.project_plugin_states
  ADD COLUMN IF NOT EXISTS settings jsonb NOT NULL DEFAULT '{}';
