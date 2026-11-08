import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test, type TestContext } from "node:test";
import { pool } from "../server/db.js";
import { migrate } from "../server/migrate.js";
import { saveSettings } from "../server/host.js";
import {
  createHold,
  confirmHold,
  getBooking,
  listRescheduleSlots,
  rescheduleBooking,
  cancelBooking,
} from "../server/booking.js";

// Every test gets its own host; running this suite never resets the demo host.
before(async () => {
  await migrate();
});
after(async () => {
  await pool.end();
});

async function fixture(t: TestContext, capacity = 1) {
  const slug = `test-${randomUUID()}`;
  const {
    rows: [host],
  } = await pool.query(
    "INSERT INTO hosts(slug,name,time_zone) VALUES($1,'Reliability test','UTC') RETURNING id",
    [slug],
  );
  t.after(async () => {
    await pool.query(
      "DELETE FROM notifications WHERE booking_id IN (SELECT id FROM bookings WHERE host_id=$1)",
      [host.id],
    );
    for (const table of [
      "idempotency_keys",
      "bookings",
      "sessions",
      "date_overrides",
      "availability_windows",
      "event_types",
    ]) {
      await pool.query(`DELETE FROM ${table} WHERE host_id=$1`, [host.id]);
    }
    await pool.query("DELETE FROM hosts WHERE id=$1", [host.id]);
  });
  await pool.query(
    `INSERT INTO availability_windows(host_id,weekday,start_minute,end_minute)
    SELECT $1, day, 0, 1439 FROM generate_series(1,7) day`,
    [host.id],
  );
  const {
    rows: [event],
  } = await pool.query(
    `INSERT INTO event_types
    (host_id,name,slug,duration_minutes,capacity,buffer_before,buffer_after,min_notice_minutes,horizon_days)
    VALUES($1,'Test event','test',30,$2,0,0,0,30) RETURNING id`,
    [host.id, capacity],
  );
  const {
    rows: [clock],
  } = await pool.query(
    "SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC' + interval '2 days', 'YYYY-MM-DD') || 'T12:00:00Z' AS start",
  );
  const start = new Date(clock.start).toISOString();
  return {
    hostId: host.id as number,
    eventId: event.id as number,
    slug,
    start,
  };
}

function later(start: string, minutes: number) {
  return new Date(Date.parse(start) + minutes * 60_000).toISOString();
}
const details = { name: "Test Guest", email: "guest@example.com" };
const statusError = (status: number) => (error: unknown) => {
  assert.ok(error && typeof error === "object");
  assert.equal((error as { status: number }).status, status);
  return true;
};
const conflict = statusError(409);
const expired = statusError(410);

async function activeCount(hostId: number) {
  const {
    rows: [row],
  } = await pool.query(
    "SELECT count(*)::int AS count FROM bookings WHERE host_id=$1 AND status IN ('held','confirmed')",
    [hostId],
  );
  return row.count as number;
}

test("30 simultaneous requests for one seat: exactly one succeeds", async (t) => {
  const f = await fixture(t);
  const results = await Promise.allSettled(
    Array.from({ length: 30 }, () =>
      createHold({ eventId: f.eventId, start: f.start }, randomUUID()),
    ),
  );
  const successes = results.filter((result) => result.status === "fulfilled");
  const failures = results.filter((result) => result.status === "rejected");
  assert.equal(successes.length, 1);
  assert.equal(failures.length, 29);
  for (const failure of failures)
    if (failure.status === "rejected") conflict(failure.reason);
  assert.equal(await activeCount(f.hostId), 1);
});

test("group capacity counts held and confirmed seats, never exceeds three", async (t) => {
  const f = await fixture(t, 3);
  const first = await createHold(
    { eventId: f.eventId, start: f.start },
    randomUUID(),
  );
  await confirmHold(first.id, details);
  const results = await Promise.allSettled(
    Array.from({ length: 30 }, () =>
      createHold({ eventId: f.eventId, start: f.start }, randomUUID()),
    ),
  );
  assert.equal(
    results.filter((result) => result.status === "fulfilled").length,
    2,
  );
  for (const result of results)
    if (result.status === "rejected") conflict(result.reason);
  assert.equal(await activeCount(f.hostId), 3);
});

test("lost hold response: simultaneous retries return one hold; changed payload is rejected", async (t) => {
  const f = await fixture(t);
  const key = randomUUID();
  const results = await Promise.all(
    Array.from({ length: 20 }, () =>
      createHold({ eventId: f.eventId, start: f.start }, key),
    ),
  );
  assert.equal(new Set(results.map((result) => result.id)).size, 1);
  assert.equal(await activeCount(f.hostId), 1);
  await assert.rejects(
    createHold({ eventId: f.eventId, start: later(f.start, 30) }, key),
    conflict,
  );
});

test("expiry race: an expired hold cannot confirm when a replacement claims its seat", async (t) => {
  const f = await fixture(t);
  const old = await createHold(
    { eventId: f.eventId, start: f.start },
    randomUUID(),
  );
  await pool.query(
    "UPDATE bookings SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",
    [old.id],
  );
  const [confirm, replacement] = await Promise.allSettled([
    confirmHold(old.id, details),
    createHold({ eventId: f.eventId, start: f.start }, randomUUID()),
  ]);
  assert.equal(confirm.status, "rejected");
  if (confirm.status === "rejected") expired(confirm.reason);
  assert.equal(replacement.status, "fulfilled");
  assert.equal(await activeCount(f.hostId), 1);
  const {
    rows: [row],
  } = await pool.query("SELECT status FROM bookings WHERE id=$1", [old.id]);
  assert.equal(row.status, "expired");
});

test("a confirmation waiting for a lock uses database time after the wait", async (t) => {
  const f = await fixture(t);
  const hold = await createHold(
    { eventId: f.eventId, start: f.start },
    randomUUID(),
  );
  const lock = await pool.connect();
  try {
    await lock.query("BEGIN");
    await lock.query("SELECT id FROM hosts WHERE id=$1 FOR UPDATE", [f.hostId]);
    await lock.query(
      "UPDATE bookings SET expires_at=clock_timestamp()+interval '200 milliseconds' WHERE id=$1",
      [hold.id],
    );
    // Attach the rejection handler immediately: the operation must finish only after COMMIT.
    const confirmation = assert.rejects(confirmHold(hold.id, details), expired);
    await lock.query("SELECT pg_sleep(0.35)");
    await lock.query("COMMIT");
    await confirmation;
    const {
      rows: [expiredHold],
    } = await pool.query("SELECT status FROM bookings WHERE id=$1", [hold.id]);
    assert.equal(expiredHold.status, "expired"); // A rejected operation must still persist terminal expiry.
  } finally {
    await lock.query("ROLLBACK");
    lock.release();
  }
});

test("terminal expiry cannot resurrect after the expiry timestamp moves back into the future", async (t) => {
  const f = await fixture(t);
  const key = randomUUID();
  const old = await createHold({ eventId: f.eventId, start: f.start }, key);
  await pool.query(
    "UPDATE bookings SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",
    [old.id],
  );
  await createHold({ eventId: f.eventId, start: f.start }, randomUUID());
  // Equivalent to clock moving backwards relative to the old deadline; state stays terminal.
  await pool.query(
    "UPDATE bookings SET expires_at=clock_timestamp()+interval '1 day' WHERE id=$1",
    [old.id],
  );
  await assert.rejects(confirmHold(old.id, details), expired);
  const replay = await createHold({ eventId: f.eventId, start: f.start }, key);
  assert.equal(replay.id, old.id);
  assert.equal(replay.status, "expired");
  assert.equal(await activeCount(f.hostId), 1);
});

test("a failed reschedule rolls back and preserves the original confirmed booking", async (t) => {
  const f = await fixture(t);
  const hold = await createHold(
    { eventId: f.eventId, start: f.start },
    randomUUID(),
  );
  const confirmed = await confirmHold(hold.id, details);
  await createHold(
    { eventId: f.eventId, start: later(f.start, 60) },
    randomUUID(),
  );
  await assert.rejects(
    rescheduleBooking(
      confirmed.manageToken,
      { start: later(f.start, 60) },
      randomUUID(),
    ),
    conflict,
  );
  const current = await getBooking(confirmed.manageToken);
  assert.equal(current.status, "confirmed");
  assert.equal(Date.parse(current.start), Date.parse(f.start));
  assert.equal(await activeCount(f.hostId), 2);
});

test("host conflicts apply across event types, including buffers", async (t) => {
  const f = await fixture(t);
  await pool.query("UPDATE event_types SET buffer_after=15 WHERE id=$1", [
    f.eventId,
  ]);
  const {
    rows: [other],
  } = await pool.query(
    `INSERT INTO event_types
    (host_id,name,slug,duration_minutes,capacity,buffer_before,buffer_after,min_notice_minutes,horizon_days)
    VALUES($1,'Other event','other',30,1,0,0,0,30) RETURNING id`,
    [f.hostId],
  );
  await createHold({ eventId: f.eventId, start: f.start }, randomUUID());
  await assert.rejects(
    createHold({ eventId: other.id, start: later(f.start, 30) }, randomUUID()),
    conflict,
  );
  await createHold(
    { eventId: other.id, start: later(f.start, 60) },
    randomUUID(),
  );
  assert.equal(await activeCount(f.hostId), 2);
});

test("confirm and cancel retries are idempotent and do not duplicate notification events", async (t) => {
  const f = await fixture(t);
  const hold = await createHold(
    { eventId: f.eventId, start: f.start },
    randomUUID(),
  );
  const confirmations = await Promise.all(
    Array.from({ length: 10 }, () => confirmHold(hold.id, details)),
  );
  const token = confirmations[0].manageToken;
  assert.ok(token);
  assert.equal(
    new Set(confirmations.map((result) => result.manageToken)).size,
    1,
  );
  await Promise.all(
    Array.from({ length: 10 }, () => cancelBooking(token, "Changed plans")),
  );
  assert.equal(await activeCount(f.hostId), 0);
  const { rows } = await pool.query(
    "SELECT kind, count(*)::int AS count FROM notifications WHERE booking_id=$1 GROUP BY kind ORDER BY kind",
    [hold.id],
  );
  assert.deepEqual(rows, [
    { kind: "cancelled", count: 1 },
    { kind: "confirmed", count: 1 },
  ]);
});

test("Postgres rejects overlapping sessions, duplicate seats and invented capacity even without the service lock", async (t) => {
  const f = await fixture(t);
  const hold = await createHold(
    { eventId: f.eventId, start: f.start },
    randomUUID(),
  );
  const sqlState = (code: string) => (error: unknown) => {
    assert.equal((error as { code: string }).code, code);
    return true;
  };
  await assert.rejects(
    pool.query(
      `INSERT INTO sessions
    (id,host_id,event_id,starts_at,ends_at,occupied,capacity,active)
    SELECT $1,host_id,event_id,starts_at,ends_at,occupied,capacity,true FROM sessions
    WHERE id=(SELECT session_id FROM bookings WHERE id=$2)`,
      [randomUUID(), hold.id],
    ),
    sqlState("23P01"),
  );
  await assert.rejects(
    pool.query(
      `INSERT INTO bookings
    (id,host_id,event_id,session_id,capacity,seat,status,expires_at)
    SELECT $1,host_id,event_id,session_id,capacity,seat,'held',expires_at FROM bookings WHERE id=$2`,
      [randomUUID(), hold.id],
    ),
    sqlState("23505"),
  );
  await assert.rejects(
    pool.query(
      `INSERT INTO bookings
    (id,host_id,event_id,session_id,capacity,seat,status,expires_at)
    SELECT $1,host_id,event_id,session_id,capacity+1,seat+1,'held',expires_at FROM bookings WHERE id=$2`,
      [randomUUID(), hold.id],
    ),
    sqlState("23503"),
  );
});

test("application clock skew cannot change the database hold deadline or booking horizon", async (t) => {
  const f = await fixture(t);
  const realDateNow = Date.now;
  try {
    for (const [offset, fakeTime] of [
      [0, 0],
      [60, Date.parse("2099-01-01T00:00:00Z")],
    ]) {
      Date.now = () => fakeTime;
      const hold = await createHold(
        { eventId: f.eventId, start: later(f.start, offset) },
        randomUUID(),
      );
      assert.equal(
        Date.parse(hold.expiresAt) - Date.parse(hold.serverNow),
        5 * 60_000,
      );
      assert.ok(Math.abs(Date.parse(hold.serverNow) - realDateNow()) < 10_000);
      const confirmed = await confirmHold(hold.id, details);
      assert.equal(confirmed.status, "confirmed");
    }
  } finally {
    Date.now = realDateNow;
  }
});

test("a confirm retry with different guest details cannot overwrite the original guest", async (t) => {
  const f = await fixture(t);
  const hold = await createHold(
    { eventId: f.eventId, start: f.start },
    randomUUID(),
  );
  const confirmed = await confirmHold(hold.id, details);
  await assert.rejects(
    confirmHold(hold.id, { name: "Someone Else", email: "else@example.com" }),
    conflict,
  );
  const unchanged = await getBooking(confirmed.manageToken);
  assert.equal(unchanged.name, details.name);
  assert.equal(unchanged.email, details.email);
  const {
    rows: [notifications],
  } = await pool.query(
    "SELECT count(*)::int AS count FROM notifications WHERE booking_id=$1",
    [hold.id],
  );
  assert.equal(notifications.count, 1);
});

test("idempotency is scoped to the host and binds the event as well as the canonical instant", async (t) => {
  const f = await fixture(t);
  const {
    rows: [other],
  } = await pool.query(
    `INSERT INTO event_types
    (host_id,name,slug,duration_minutes,capacity,buffer_before,buffer_after,min_notice_minutes,horizon_days)
    VALUES($1,'Another event','another',30,1,0,0,0,30) RETURNING id`,
    [f.hostId],
  );
  const key = randomUUID();
  const hold = await createHold({ eventId: f.eventId, start: f.start }, key);
  const equivalent = await createHold(
    { eventId: f.eventId, start: f.start.replace("Z", "+00:00") },
    key,
  );
  assert.equal(equivalent.id, hold.id);
  await assert.rejects(
    createHold({ eventId: other.id, start: f.start }, key),
    conflict,
  );
  assert.equal(await activeCount(f.hostId), 1);
});

test("successful reschedule retries move one seat once and emit one notification", async (t) => {
  const f = await fixture(t);
  const hold = await createHold(
    { eventId: f.eventId, start: f.start },
    randomUUID(),
  );
  const confirmed = await confirmHold(hold.id, details);
  const key = randomUUID(),
    target = later(f.start, 60);
  const moved = await Promise.all(
    Array.from({ length: 10 }, () =>
      rescheduleBooking(confirmed.manageToken, { start: target }, key),
    ),
  );
  assert.ok(
    moved.every((result) => Date.parse(result.start) === Date.parse(target)),
  );
  assert.equal(await activeCount(f.hostId), 1);
  const { rows } = await pool.query(
    "SELECT kind, count(*)::int AS count FROM notifications WHERE booking_id=$1 GROUP BY kind ORDER BY kind",
    [hold.id],
  );
  assert.deepEqual(rows, [
    { kind: "confirmed", count: 1 },
    { kind: "rescheduled", count: 1 },
  ]);
  // Old capacity is released; the target still belongs to the original booking.
  await createHold({ eventId: f.eventId, start: f.start }, randomUUID());
  await assert.rejects(
    createHold({ eventId: f.eventId, start: target }, randomUUID()),
    conflict,
  );
  await assert.rejects(
    rescheduleBooking(confirmed.manageToken, { start: later(target, 60) }, key),
    conflict,
  );
  assert.equal(
    Date.parse((await getBooking(confirmed.manageToken)).start),
    Date.parse(target),
  );
});

test("rescheduling can overlap its own old buffer because release and reserve are atomic", async (t) => {
  const f = await fixture(t);
  await pool.query("UPDATE event_types SET buffer_after=15 WHERE id=$1", [
    f.eventId,
  ]);
  const hold = await createHold(
    { eventId: f.eventId, start: f.start },
    randomUUID(),
  );
  const confirmed = await confirmHold(hold.id, details);
  const target = later(f.start, 30); // Falls inside the old session's after-buffer.
  const moved = await rescheduleBooking(
    confirmed.manageToken,
    { start: target },
    randomUUID(),
  );
  assert.equal(Date.parse(moved.start), Date.parse(target));
  assert.equal(await activeCount(f.hostId), 1);
  const {
    rows: [sessions],
  } = await pool.query(
    "SELECT count(*)::int AS count FROM sessions WHERE host_id=$1 AND active",
    [f.hostId],
  );
  assert.equal(sessions.count, 1);
});

test("rescheduling one group attendee cannot release the remaining attendee’s host occupancy", async (t) => {
  const f = await fixture(t, 3);
  await pool.query("UPDATE event_types SET buffer_after=15 WHERE id=$1", [
    f.eventId,
  ]);
  const first = await createHold(
    { eventId: f.eventId, start: f.start },
    randomUUID(),
  );
  const second = await createHold(
    { eventId: f.eventId, start: f.start },
    randomUUID(),
  );
  const confirmed = await confirmHold(first.id, details);
  await assert.rejects(
    rescheduleBooking(
      confirmed.manageToken,
      { start: later(f.start, 30) },
      randomUUID(),
    ),
    conflict,
  );
  assert.equal(
    Date.parse((await getBooking(confirmed.manageToken)).start),
    Date.parse(f.start),
  );
  const {
    rows: [remaining],
  } = await pool.query("SELECT status FROM bookings WHERE id=$1", [second.id]);
  assert.equal(remaining.status, "held");
  assert.equal(await activeCount(f.hostId), 2);
});

test("invalid host dates, weekdays and windows are rejected without changing existing settings", async (t) => {
  const f = await fixture(t);
  const base = {
    timeZone: "UTC",
    availability: [{ weekday: 1, start: "09:00", end: "12:00" }],
    overrides: [],
  };
  const invalid = [
    { ...base, timeZone: "+05:30" },
    { ...base, availability: [{ weekday: 0, start: "09:00", end: "12:00" }] },
    { ...base, availability: [{ weekday: 1, start: "12:00", end: "09:00" }] },
    {
      ...base,
      availability: [
        ...base.availability,
        { weekday: 1, start: "11:00", end: "13:00" },
      ],
    },
    { ...base, overrides: [{ date: "2026-02-30", windows: [] }] },
    {
      ...base,
      overrides: [
        { date: "2026-11-09", windows: [] },
        { date: "2026-11-09", windows: [] },
      ],
    },
  ];
  for (const settings of invalid)
    await assert.rejects(saveSettings(f.hostId, settings), statusError(400));
  const {
    rows: [host],
  } = await pool.query("SELECT time_zone FROM hosts WHERE id=$1", [f.hostId]);
  const {
    rows: [weekly],
  } = await pool.query(
    "SELECT count(*)::int AS count FROM availability_windows WHERE host_id=$1",
    [f.hostId],
  );
  assert.equal(host.time_zone, "UTC");
  assert.equal(weekly.count, 7);
});

test("changing the host zone or availability preserves previously confirmed booking instants", async (t) => {
  const f = await fixture(t);
  const hold = await createHold(
    { eventId: f.eventId, start: f.start },
    randomUUID(),
  );
  const confirmed = await confirmHold(hold.id, details);
  const settings = {
    timeZone: "Asia/Kolkata",
    availability: [
      { weekday: 1, start: "09:00", end: "12:00" },
      { weekday: 1, start: "13:00", end: "24:00" },
    ],
    overrides: [{ date: f.start.slice(0, 10), windows: [] }],
  };
  const saved = await saveSettings(f.hostId, settings);
  assert.equal(saved.host.timeZone, settings.timeZone);
  assert.deepEqual(saved.availability, settings.availability);
  assert.deepEqual(saved.overrides, settings.overrides);
  const booking = await getBooking(confirmed.manageToken);
  assert.equal(booking.status, "confirmed");
  assert.equal(Date.parse(booking.start), Date.parse(f.start));
  assert.equal(await activeCount(f.hostId), 1);
});

test("reschedule slot discovery ignores the moving booking but preserves other group attendees", async (t) => {
  for (const capacity of [1, 3]) {
    const f = await fixture(t, capacity);
    await pool.query("UPDATE event_types SET buffer_after=30 WHERE id=$1", [
      f.eventId,
    ]);
    const hold = await createHold(
      { eventId: f.eventId, start: f.start },
      randomUUID(),
    );
    const confirmed = await confirmHold(hold.id, details);
    if (capacity > 1)
      await createHold({ eventId: f.eventId, start: f.start }, randomUUID());
    const target = later(f.start, 30);
    const available = await listRescheduleSlots(confirmed.manageToken, "UTC");
    const targetListed = available.slots.some(
      (slot) => Date.parse(slot.start) === Date.parse(target),
    );
    assert.equal(
      targetListed,
      capacity === 1,
      capacity === 1
        ? "the old booking must not block its own move"
        : "the other attendee must retain host occupancy",
    );
  }
});
