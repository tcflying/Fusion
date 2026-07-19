CREATE INDEX idx_room_events_project_room_cursor
  ON project.room_events(project_id, room_id, cursor);
