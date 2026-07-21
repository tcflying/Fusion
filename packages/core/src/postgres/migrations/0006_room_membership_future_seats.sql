-- A queued add-participant command names the seat that will be created only at
-- the next durable turn boundary. Keep room ownership referential integrity,
-- but do not require that future seat to exist while the request is pending.
ALTER TABLE project.room_membership_changes
  DROP CONSTRAINT IF EXISTS room_membership_changes_seat_fkey;
