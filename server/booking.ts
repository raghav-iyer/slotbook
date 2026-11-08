import { createHash, createHmac, randomUUID } from "node:crypto";
import { Temporal } from "@js-temporal/polyfill";
import type { PoolClient } from "pg";
import { pool, withHostLock } from "./db.js";
import {
  candidateSlots,
  canonicalInstant,
  contextForEvent,
  listSlots,
} from "./slots.js";
import { AppError, type EventType, type Host } from "./types.js";

const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const manageToken = (id: string) =>
  createHmac(
    "sha256",
    process.env.MANAGE_TOKEN_SECRET ??
      "local-demo-only-change-before-deploying",
  )
    .update(id)
    .digest("hex");
function checkKey(key: string) {
  if (typeof key !== "string" || key.length < 8 || key.length > 200)
    throw new AppError(
      400,
      "Send an Idempotency-Key header of 8–200 characters",
    );
}
function checkId(id: string) {
  if (
    typeof id !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)
  )
    throw new AppError(404, "Booking not found");
}
function checkToken(token: string) {
  if (typeof token !== "string" || !/^[0-9a-f]{64}$/.test(token))
    throw new AppError(404, "Booking not found");
}

async function bookingView(client: PoolClient, id: string, now: Date) {
  const result = await client.query(
    `SELECT b.*, s.starts_at,s.ends_at,e.name AS event_name,e.slug AS event_slug,
    h.slug AS host_slug,h.name AS host_name,h.time_zone FROM bookings b
    JOIN sessions s ON s.id=b.session_id JOIN event_types e ON e.id=b.event_id JOIN hosts h ON h.id=b.host_id WHERE b.id=$1`,
    [id],
  );
  if (!result.rowCount) throw new AppError(404, "Booking not found");
  const b = result.rows[0];
  return {
    id: b.id,
    status: b.status,
    eventId: b.event_id,
    eventName: b.event_name,
    eventSlug: b.event_slug,
    hostSlug: b.host_slug,
    hostName: b.host_name,
    hostTimeZone: b.time_zone,
    start: b.starts_at.toISOString(),
    end: b.ends_at.toISOString(),
    expiresAt: b.expires_at.toISOString(),
    name: b.name,
    email: b.email,
    reason: b.reason,
    serverNow: now.toISOString(),
  };
}
async function recordNotification(
  client: PoolClient,
  id: string,
  kind: string,
  now: Date,
) {
  const payload = await bookingView(client, id, now);
  await client.query(
    `INSERT INTO notifications(booking_id,version,kind,payload)
    SELECT id,version,$2,$3::jsonb FROM bookings WHERE id=$1`,
    [id, kind, JSON.stringify(payload)],
  );
}
async function idempotency(
  client: PoolClient,
  hostId: number,
  operation: string,
  key: string,
  request: object,
) {
  const result = await client.query(
    "SELECT *,request=$4::jsonb AS matches FROM idempotency_keys WHERE host_id=$1 AND operation=$2 AND key=$3",
    [hostId, operation, key, JSON.stringify(request)],
  );
  if (result.rowCount && !result.rows[0].matches)
    throw new AppError(
      409,
      "This idempotency key was already used with different input",
    );
  return result.rows[0];
}
async function remember(
  client: PoolClient,
  hostId: number,
  operation: string,
  key: string,
  request: object,
  bookingId: string,
  response?: object,
) {
  await client.query(
    "INSERT INTO idempotency_keys(host_id,operation,key,request,booking_id,response) VALUES ($1,$2,$3,$4::jsonb,$5,$6::jsonb)",
    [
      hostId,
      operation,
      key,
      JSON.stringify(request),
      bookingId,
      response ? JSON.stringify(response) : null,
    ],
  );
}
async function reserve(
  client: PoolClient,
  host: Host,
  event: EventType,
  start: string,
  now: Date,
) {
  const requested = Temporal.Instant.from(start),
    current = Temporal.Instant.from(now.toISOString());
  if (
    Temporal.Instant.compare(
      requested,
      current.add({ minutes: event.minNoticeMinutes }),
    ) < 0 ||
    Temporal.Instant.compare(
      requested,
      current
        .toZonedDateTimeISO(host.timeZone)
        .add({ days: event.horizonDays })
        .toInstant(),
    ) >= 0
  )
    throw new AppError(
      409,
      "Slot does not satisfy minimum notice or booking horizon",
    );
  const oneMillisecondLater = Temporal.Instant.from(start)
    .add({ milliseconds: 1 })
    .toString();
  const candidates = await candidateSlots(
    client,
    host,
    event,
    start,
    oneMillisecondLater,
    now,
  );
  const slot = candidates.find((slot) => slot.start === start);
  if (!slot)
    throw new AppError(
      409,
      "Slot does not satisfy availability, notice, or booking horizon",
    );
  const existing = await client.query(
    `SELECT * FROM sessions WHERE host_id=$1 AND event_id=$2 AND starts_at=$3 AND ends_at=$4 AND active`,
    [host.id, event.id, slot.start, slot.end],
  );
  let session = existing.rows[0];
  if (!session) {
    session = (
      await client.query(
        `INSERT INTO sessions(id,host_id,event_id,starts_at,ends_at,occupied,capacity)
      VALUES ($1,$2,$3,$4,$5,tstzrange($4::timestamptz - $6 * interval '1 minute',$5::timestamptz + $7 * interval '1 minute','[)'),$8) RETURNING *`,
        [
          randomUUID(),
          host.id,
          event.id,
          slot.start,
          slot.end,
          event.bufferBefore,
          event.bufferAfter,
          event.capacity,
        ],
      )
    ).rows[0];
  }
  const available = await client.query(
    `SELECT n AS seat FROM generate_series(1,$2::integer) n WHERE NOT EXISTS (
    SELECT 1 FROM bookings WHERE session_id=$1 AND seat=n AND status IN ('held','confirmed')) ORDER BY n LIMIT 1`,
    [session.id, session.capacity],
  );
  if (!available.rowCount) throw new AppError(409, "That session is full");
  return {
    sessionId: session.id,
    capacity: session.capacity,
    seat: available.rows[0].seat,
  };
}
async function releaseEmptySession(client: PoolClient, sessionId: string) {
  await client.query(
    `UPDATE sessions SET active=false WHERE id=$1 AND NOT EXISTS (
    SELECT 1 FROM bookings WHERE session_id=$1 AND status IN ('held','confirmed'))`,
    [sessionId],
  );
}
async function hostForHold(id: string) {
  checkId(id);
  const result = await pool.query("SELECT host_id FROM bookings WHERE id=$1", [
    id,
  ]);
  if (!result.rowCount) throw new AppError(404, "Booking not found");
  return result.rows[0].host_id as number;
}
async function identityForToken(token: string) {
  checkToken(token);
  const result = await pool.query(
    "SELECT id,host_id FROM bookings WHERE manage_token_hash=$1",
    [hash(token)],
  );
  if (!result.rowCount) throw new AppError(404, "Booking not found");
  return {
    id: result.rows[0].id as string,
    hostId: result.rows[0].host_id as number,
  };
}

export async function createHold(
  input: { eventId: number; start: string },
  key: string,
) {
  checkKey(key);
  if (!Number.isSafeInteger(input.eventId) || input.eventId <= 0)
    throw new AppError(400, "Invalid event ID");
  const start = canonicalInstant(input.start);
  const found = await pool.query(
    "SELECT host_id FROM event_types WHERE id=$1",
    [input.eventId],
  );
  if (!found.rowCount) throw new AppError(404, "Event type not found");
  const request = { eventId: input.eventId, start };
  return withHostLock(found.rows[0].host_id, async (client, now) => {
    const replay = await idempotency(
      client,
      found.rows[0].host_id,
      "hold",
      key,
      request,
    );
    if (replay) return bookingView(client, replay.booking_id, now);
    const { host, event } = await contextForEvent(client, input.eventId);
    const reservation = await reserve(client, host, event, start, now);
    const id = randomUUID();
    await client.query(
      `INSERT INTO bookings(id,host_id,event_id,session_id,capacity,seat,status,expires_at)
      VALUES ($1,$2,$3,$4,$5,$6,'held',$7::timestamptz + interval '5 minutes')`,
      [
        id,
        host.id,
        event.id,
        reservation.sessionId,
        reservation.capacity,
        reservation.seat,
        now,
      ],
    );
    await remember(client, host.id, "hold", key, request, id);
    return bookingView(client, id, now);
  });
}

export async function confirmHold(
  id: string,
  input: { name: string; email: string },
) {
  if (
    typeof input.name !== "string" ||
    !input.name.trim() ||
    input.name.length > 120 ||
    typeof input.email !== "string" ||
    input.email.length > 254 ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.email)
  )
    throw new AppError(400, "Enter a name and valid email");
  const name = input.name.trim(),
    email = input.email.trim().toLowerCase();
  const hostId = await hostForHold(id);
  return withHostLock(hostId, async (client, now) => {
    const booking = (
      await client.query("SELECT * FROM bookings WHERE id=$1", [id])
    ).rows[0];
    if (booking.status === "expired")
      throw new AppError(410, "This hold expired; choose a slot again");
    if (booking.status === "cancelled")
      throw new AppError(409, "This booking was cancelled");
    if (booking.status === "confirmed") {
      if (booking.name !== name || booking.email !== email)
        throw new AppError(
          409,
          "This hold was already confirmed with different guest details",
        );
    } else {
      await client.query(
        "UPDATE bookings SET status='confirmed',name=$2,email=$3,manage_token_hash=$4,version=version+1 WHERE id=$1",
        [id, name, email, hash(manageToken(id))],
      );
      await recordNotification(client, id, "confirmed", now);
    }
    return {
      ...(await bookingView(client, id, now)),
      manageToken: manageToken(id),
    };
  });
}
export async function getBooking(token: string) {
  const { id, hostId } = await identityForToken(token);
  return withHostLock(hostId, (client, now) => bookingView(client, id, now));
}
export async function listRescheduleSlots(token: string, tz?: string) {
  const { id, hostId } = await identityForToken(token);
  const result = await pool.query(
    `SELECT h.slug AS host_slug,e.slug AS event_slug FROM bookings b
    JOIN hosts h ON h.id=b.host_id JOIN event_types e ON e.id=b.event_id WHERE b.id=$1 AND b.host_id=$2`,
    [id, hostId],
  );
  if (!result.rowCount) throw new AppError(404, "Booking not found");
  // The exclusion is internal and capability-authorized; public slot routes cannot request it.
  return listSlots(
    result.rows[0].host_slug,
    result.rows[0].event_slug,
    undefined,
    undefined,
    tz,
    id,
  );
}
export async function rescheduleBooking(
  token: string,
  input: { start: string },
  key: string,
) {
  checkKey(key);
  const start = canonicalInstant(input.start);
  const { id, hostId } = await identityForToken(token);
  const operation = `reschedule:${id}`,
    request = { start };
  return withHostLock(hostId, async (client, now) => {
    const replay = await idempotency(client, hostId, operation, key, request);
    if (replay) return replay.response;
    const booking = (
      await client.query(
        "SELECT b.*,s.starts_at FROM bookings b JOIN sessions s ON s.id=b.session_id WHERE b.id=$1",
        [id],
      )
    ).rows[0];
    if (booking.status !== "confirmed")
      throw new AppError(409, "Only confirmed bookings can be rescheduled");
    if (booking.starts_at.getTime() !== new Date(start).getTime()) {
      const { host, event } = await contextForEvent(client, booking.event_id);
      // Release and reserve in ONE transaction. A conflict rolls this release back.
      await client.query("UPDATE bookings SET status='cancelled' WHERE id=$1", [
        id,
      ]);
      await releaseEmptySession(client, booking.session_id);
      const reservation = await reserve(client, host, event, start, now);
      await client.query(
        `UPDATE bookings SET session_id=$2,capacity=$3,seat=$4,status='confirmed',version=version+1 WHERE id=$1`,
        [id, reservation.sessionId, reservation.capacity, reservation.seat],
      );
      await recordNotification(client, id, "rescheduled", now);
    }
    const response = await bookingView(client, id, now);
    await remember(client, hostId, operation, key, request, id, response);
    return response;
  });
}
async function cancelLocked(
  client: PoolClient,
  id: string,
  reason: string,
  now: Date,
) {
  const booking = (
    await client.query("SELECT * FROM bookings WHERE id=$1", [id])
  ).rows[0];
  if (!booking) throw new AppError(404, "Booking not found");
  if (booking.status === "expired")
    throw new AppError(410, "This hold expired");
  if (booking.status !== "cancelled") {
    await client.query(
      "UPDATE bookings SET status='cancelled',reason=$2,version=version+1 WHERE id=$1",
      [id, reason],
    );
    await releaseEmptySession(client, booking.session_id);
    await recordNotification(client, id, "cancelled", now);
  }
  return bookingView(client, id, now);
}
function cancellationReason(reason?: string) {
  if (
    reason !== undefined &&
    (typeof reason !== "string" || reason.length > 500)
  )
    throw new AppError(
      400,
      "Cancellation reason must be at most 500 characters",
    );
  return reason?.trim() ?? "";
}
export async function cancelBooking(token: string, reason?: string) {
  const text = cancellationReason(reason),
    { id, hostId } = await identityForToken(token);
  return withHostLock(hostId, (client, now) =>
    cancelLocked(client, id, text, now),
  );
}
export async function cancelByHost(
  hostId: number,
  bookingId: string,
  reason: string,
) {
  checkId(bookingId);
  const text = cancellationReason(reason);
  if (!text) throw new AppError(400, "Give the guest a cancellation reason");
  return withHostLock(hostId, async (client, now) => {
    const found = await client.query(
      "SELECT id FROM bookings WHERE id=$1 AND host_id=$2",
      [bookingId, hostId],
    );
    if (!found.rowCount) throw new AppError(404, "Booking not found");
    return cancelLocked(client, bookingId, text, now);
  });
}
