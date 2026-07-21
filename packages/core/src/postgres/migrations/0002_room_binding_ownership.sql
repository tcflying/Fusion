-- A provider-native Session and a Happier Session may have historical Room
-- binding generations, but only one live ownership record inside a project.
-- Detached/replaced/failed rows remain as immutable lineage and do not block a
-- later explicit rebind.

CREATE UNIQUE INDEX IF NOT EXISTS idx_room_bindings_active_native_session
  ON project.room_bindings(project_id, provider_id, native_session_id)
  WHERE state IN (
    'pending',
    'attached',
    'paused',
    'authentication_blocked',
    'host_unavailable',
    'delivery_uncertain'
  );

CREATE UNIQUE INDEX IF NOT EXISTS idx_room_bindings_active_happier_session
  ON project.room_bindings(project_id, connector_id, happier_session_id)
  WHERE happier_session_id IS NOT NULL
    AND state IN (
      'pending',
      'attached',
      'paused',
      'authentication_blocked',
      'host_unavailable',
      'delivery_uncertain'
    );
