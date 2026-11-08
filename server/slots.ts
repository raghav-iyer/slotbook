import { Temporal } from "@js-temporal/polyfill";
import type { PoolClient } from "pg";
import { pool, withHostLock } from "./db.js";
import {
  AppError,
  eventFromRow,
  hostFromRow,
  type EventType,
  type Host,
  type Slot,
  type Window,
} from "./types.js";

type GeneratorInput = {
  zone: string;
  durationMinutes: number;
  capacity: number;
  weekly: (Window & { weekday: number })[];
  overrides: Record<string, Window[]>;
  from: string;
  to: string;
  now: string;
  minNoticeMinutes: number;
  horizonDays: number;
};

export function validZone(zone: string) {
  if (typeof zone !== "string" || /^[+-]/.test(zone)) return false;
  try {
    Temporal.Instant.from("2026-01-01T00:00Z").toZonedDateTimeISO(zone);
    return true;
  } catch {
    return false;
  }
}
export function canonicalInstant(value: string) {
  try {
    return Temporal.Instant.from(value).toString();
  } catch {
    throw new AppError(400, "Use an ISO timestamp with a UTC offset");
  }
}
function atMinute(day: Temporal.PlainDate, minute: number) {
  return day.toPlainDateTime("00:00").add({ minutes: minute });
}

// Slot generation is a pure function; all authoritative callers provide database time.
export function generateCandidateSlots(input: GeneratorInput): Slot[] {
  const from = Temporal.Instant.from(input.from);
  const to = Temporal.Instant.from(input.to);
  const now = Temporal.Instant.from(input.now);
  const earliest = now.add({ minutes: input.minNoticeMinutes });
  // Horizon is measured in host calendar days, including DST-short/long days.
  const latest = now
    .toZonedDateTimeISO(input.zone)
    .add({ days: input.horizonDays })
    .toInstant();
  let day = from.toZonedDateTimeISO(input.zone).toPlainDate();
  const lastDay = to.toZonedDateTimeISO(input.zone).toPlainDate();
  const slots = new Map<string, Slot>();
  while (Temporal.PlainDate.compare(day, lastDay) <= 0) {
    const windows =
      input.overrides[day.toString()] ??
      input.weekly.filter((w) => w.weekday === day.dayOfWeek);
    for (const window of windows) {
      const windowEnd = atMinute(day, window.end_minute)
        .toZonedDateTime(input.zone, { disambiguation: "later" })
        .toInstant();
      for (
        let minute = window.start_minute;
        minute < window.end_minute;
        minute += input.durationMinutes
      ) {
        const wall = atMinute(day, minute);
        const zoned = wall.toZonedDateTime(input.zone, {
          disambiguation: "earlier",
        });
        // A nonexistent spring-forward time round-trips to a different wall time.
        if (!zoned.toPlainDateTime().equals(wall)) continue;
        const start = zoned.toInstant();
        const end = start.add({ minutes: input.durationMinutes });
        if (
          Temporal.Instant.compare(start, from) < 0 ||
          Temporal.Instant.compare(start, to) >= 0 ||
          Temporal.Instant.compare(start, earliest) < 0 ||
          Temporal.Instant.compare(start, latest) >= 0 ||
          Temporal.Instant.compare(end, windowEnd) > 0
        )
          continue;
        slots.set(start.toString(), {
          start: start.toString(),
          end: end.toString(),
          remaining: input.capacity,
        });
      }
    }
    day = day.add({ days: 1 });
  }
  return [...slots.values()].sort((a, b) => a.start.localeCompare(b.start));
}

export async function contextForEvent(
  client: PoolClient,
  eventId: number,
): Promise<{ host: Host; event: EventType }> {
  const result = await client.query(
    `SELECT e.*, row_to_json(h) AS host FROM event_types e JOIN hosts h ON h.id=e.host_id WHERE e.id=$1`,
    [eventId],
  );
  if (!result.rowCount) throw new AppError(404, "Event type not found");
  return {
    host: hostFromRow(result.rows[0].host),
    event: eventFromRow(result.rows[0]),
  };
}
export async function candidateSlots(
  client: PoolClient,
  host: Host,
  event: EventType,
  from: string,
  to: string,
  now: Date,
) {
  const weekly = (
    await client.query(
      "SELECT weekday,start_minute,end_minute FROM availability_windows WHERE host_id=$1",
      [host.id],
    )
  ).rows;
  const rows = (
    await client.query(
      "SELECT local_date::text,windows FROM date_overrides WHERE host_id=$1",
      [host.id],
    )
  ).rows;
  const overrides = Object.fromEntries(
    rows.map((row) => [row.local_date, row.windows]),
  );
  return generateCandidateSlots({
    zone: host.timeZone,
    durationMinutes: event.durationMinutes,
    capacity: event.capacity,
    weekly,
    overrides,
    from,
    to,
    now: now.toISOString(),
    minNoticeMinutes: event.minNoticeMinutes,
    horizonDays: event.horizonDays,
  });
}
function rangeInstant(
  value: string | undefined,
  fallback: string,
  zone: string,
) {
  if (!value) return fallback;
  try {
    return /^\d{4}-\d{2}-\d{2}$/.test(value)
      ? Temporal.PlainDate.from(value)
          .toZonedDateTime(zone)
          .toInstant()
          .toString()
      : Temporal.Instant.from(value).toString();
  } catch {
    throw new AppError(400, "Invalid date range");
  }
}
export async function listSlots(
  hostSlug: string,
  eventSlug: string,
  from?: string,
  to?: string,
  tz?: string,
  excludeBookingId?: string,
) {
  const found = await pool.query(
    "SELECT e.id,e.host_id FROM event_types e JOIN hosts h ON h.id=e.host_id WHERE h.slug=$1 AND e.slug=$2",
    [hostSlug, eventSlug],
  );
  if (!found.rowCount) throw new AppError(404, "Event type not found");
  return withHostLock(found.rows[0].host_id, async (client, now) => {
    const { host, event } = await contextForEvent(client, found.rows[0].id);
    if (excludeBookingId) {
      const booking = await client.query(
        "SELECT id FROM bookings WHERE id=$1 AND host_id=$2 AND event_id=$3 AND status='confirmed'",
        [excludeBookingId, host.id, event.id],
      );
      if (!booking.rowCount)
        throw new AppError(409, "Only confirmed bookings can be rescheduled");
    }
    const displayZone = tz ?? host.timeZone;
    if (!validZone(displayZone)) throw new AppError(400, "Unknown time zone");
    const first = rangeInstant(from, now.toISOString(), host.timeZone);
    let defaultLast: string;
    try {
      defaultLast = Temporal.Instant.from(first)
        .add({ hours: 24 * 30 })
        .toString();
    } catch {
      throw new AppError(400, "Date range is outside the supported calendar");
    }
    const last = rangeInstant(to, defaultLast, host.timeZone);
    const span =
      Temporal.Instant.from(last).epochMilliseconds -
      Temporal.Instant.from(first).epochMilliseconds;
    if (span <= 0 || span > 31 * 86400000)
      throw new AppError(400, "Request a date range of at most 31 days");
    const candidates = await candidateSlots(
      client,
      host,
      event,
      first,
      last,
      now,
    );
    const occupied = (
      await client.query(
        `SELECT s.*, lower(s.occupied) AS occupied_start, upper(s.occupied) AS occupied_end, count(b.id)::integer AS used
      FROM sessions s LEFT JOIN bookings b ON b.session_id=s.id AND b.status IN ('held','confirmed') AND b.id IS DISTINCT FROM $2::uuid
      WHERE s.host_id=$1 AND s.active GROUP BY s.id`,
        [host.id, excludeBookingId ?? null],
      )
    ).rows;
    const slots = candidates.flatMap((slot) => {
      const start = new Date(slot.start).getTime() - event.bufferBefore * 60000;
      const end = new Date(slot.end).getTime() + event.bufferAfter * 60000;
      let remaining = event.capacity;
      for (const session of occupied) {
        // A reschedule preview hypothetically removes only this guest, without changing the database.
        if (session.used === 0) continue;
        // Querying occupied bounds separately avoids parsing Postgres's range string.
        const own =
          session.event_id === event.id &&
          session.starts_at.getTime() === new Date(slot.start).getTime() &&
          session.ends_at.getTime() === new Date(slot.end).getTime();
        if (own) {
          remaining = session.capacity - session.used;
          continue;
        }
        // Existing session buffers are snapshots, not the current event settings.
        const occupiedStart = session.occupied_start.getTime();
        const occupiedEnd = session.occupied_end.getTime();
        if (start < occupiedEnd && end > occupiedStart) {
          remaining = 0;
          break;
        }
      }
      return remaining > 0 ? [{ ...slot, remaining }] : [];
    });
    return {
      host,
      event,
      slots,
      serverNow: now.toISOString(),
      timeZone: displayZone,
    };
  });
}
