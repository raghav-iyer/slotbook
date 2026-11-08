CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE TABLE IF NOT EXISTS hosts (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  slug text UNIQUE NOT NULL,
  name text NOT NULL,
  time_zone text NOT NULL
);
CREATE TABLE IF NOT EXISTS event_types (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  host_id integer NOT NULL REFERENCES hosts(id),
  name text NOT NULL, slug text NOT NULL,
  duration_minutes integer NOT NULL CHECK (duration_minutes BETWEEN 15 AND 120),
  capacity integer NOT NULL CHECK (capacity BETWEEN 1 AND 100),
  buffer_before integer NOT NULL DEFAULT 0 CHECK (buffer_before BETWEEN 0 AND 30),
  buffer_after integer NOT NULL DEFAULT 0 CHECK (buffer_after BETWEEN 0 AND 30),
  min_notice_minutes integer NOT NULL DEFAULT 0 CHECK (min_notice_minutes BETWEEN 0 AND 43200),
  horizon_days integer NOT NULL DEFAULT 30 CHECK (horizon_days BETWEEN 1 AND 365),
  UNIQUE (host_id, slug), UNIQUE (id, host_id)
);
CREATE TABLE IF NOT EXISTS availability_windows (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  host_id integer NOT NULL REFERENCES hosts(id),
  weekday integer NOT NULL CHECK (weekday BETWEEN 1 AND 7),
  start_minute integer NOT NULL CHECK (start_minute BETWEEN 0 AND 1439),
  end_minute integer NOT NULL CHECK (end_minute BETWEEN 1 AND 1440),
  CHECK (end_minute > start_minute),
  UNIQUE (host_id, weekday, start_minute, end_minute)
);
CREATE TABLE IF NOT EXISTS date_overrides (
  host_id integer NOT NULL REFERENCES hosts(id),
  local_date date NOT NULL,
  windows jsonb NOT NULL CHECK (jsonb_typeof(windows) = 'array'),
  PRIMARY KEY (host_id, local_date)
);

-- One row is one occurrence, shared by every attendee of a group session.
-- Buffers are part of the half-open [start,end) resource occupancy range.
CREATE TABLE IF NOT EXISTS sessions (
  id uuid PRIMARY KEY,
  host_id integer NOT NULL REFERENCES hosts(id),
  event_id integer NOT NULL,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  occupied tstzrange NOT NULL,
  capacity integer NOT NULL CHECK (capacity BETWEEN 1 AND 100),
  active boolean NOT NULL DEFAULT true,
  CHECK (ends_at > starts_at),
  CHECK (NOT isempty(occupied) AND NOT lower_inf(occupied) AND NOT upper_inf(occupied)
    AND lower_inc(occupied) AND NOT upper_inc(occupied)
    AND lower(occupied) <= starts_at AND upper(occupied) >= ends_at),
  FOREIGN KEY (event_id, host_id) REFERENCES event_types(id, host_id),
  UNIQUE (id, host_id, event_id, capacity),
  CONSTRAINT no_host_overlap EXCLUDE USING gist (host_id WITH =, occupied WITH &&) WHERE (active)
);
CREATE TABLE IF NOT EXISTS bookings (
  id uuid PRIMARY KEY,
  host_id integer NOT NULL,
  event_id integer NOT NULL,
  session_id uuid NOT NULL,
  capacity integer NOT NULL,
  seat integer NOT NULL CHECK (seat >= 1 AND seat <= capacity),
  status text NOT NULL CHECK (status IN ('held', 'confirmed', 'cancelled', 'expired')),
  expires_at timestamptz NOT NULL,
  name text, email text, manage_token_hash text UNIQUE, reason text,
  version integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (session_id, host_id, event_id, capacity) REFERENCES sessions(id, host_id, event_id, capacity),
  CHECK (status <> 'confirmed' OR (name IS NOT NULL AND email IS NOT NULL AND manage_token_hash IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS one_active_booking_per_seat ON bookings(session_id, seat)
  WHERE status IN ('held', 'confirmed');
CREATE INDEX IF NOT EXISTS bookings_host_status ON bookings(host_id, status);
CREATE TABLE IF NOT EXISTS idempotency_keys (
  host_id integer NOT NULL REFERENCES hosts(id),
  operation text NOT NULL,
  key text NOT NULL,
  request jsonb NOT NULL,
  booking_id uuid NOT NULL REFERENCES bookings(id),
  response jsonb,
  PRIMARY KEY (host_id, operation, key)
);
CREATE TABLE IF NOT EXISTS notifications (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  booking_id uuid NOT NULL REFERENCES bookings(id),
  version integer NOT NULL,
  kind text NOT NULL CHECK (kind IN ('confirmed', 'rescheduled', 'cancelled')),
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (booking_id, version, kind)
);
