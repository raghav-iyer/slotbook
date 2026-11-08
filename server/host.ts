import { Temporal } from "@js-temporal/polyfill";
import { pool, withHostLock } from "./db.js";
import { AppError, eventFromRow, hostFromRow } from "./types.js";

export function textField(value: unknown, name: string, max = 120): string {
  if (typeof value !== "string" || !value.trim() || value.length > max)
    throw new AppError(400, `Invalid ${name}`);
  return value.trim();
}
function integer(value: unknown, name: string, min: number, max: number) {
  if (
    !Number.isInteger(value) ||
    (value as number) < min ||
    (value as number) > max
  )
    throw new AppError(400, `Invalid ${name}: use ${min}–${max}`);
  return value as number;
}
function minute(value: unknown, end = false) {
  if (typeof value !== "string" || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value)) {
    if (end && value === "24:00") return 1440;
    throw new AppError(400, "Hours must use HH:mm");
  }
  return Number(value.slice(0, 2)) * 60 + Number(value.slice(3));
}
function clock(value: number) {
  return `${Math.floor(value / 60)
    .toString()
    .padStart(2, "0")}:${(value % 60).toString().padStart(2, "0")}`;
}
function windows(value: unknown) {
  if (!Array.isArray(value) || value.length > 12)
    throw new AppError(400, "Use at most 12 windows per day");
  const result = value
    .map((w) => {
      const start_minute = minute(w?.start),
        end_minute = minute(w?.end, true);
      if (end_minute <= start_minute)
        throw new AppError(400, "Each window must end after it starts");
      return { start_minute, end_minute };
    })
    .sort((a, b) => a.start_minute - b.start_minute);
  if (result.some((w, i) => i > 0 && w.start_minute < result[i - 1].end_minute))
    throw new AppError(400, "Availability windows must not overlap");
  return result;
}

export async function publicEvents(slug: string) {
  const host = (await pool.query("SELECT * FROM hosts WHERE slug=$1", [slug]))
    .rows[0];
  if (!host) throw new AppError(404, "Host not found");
  return {
    host: hostFromRow(host),
    events: (
      await pool.query(
        "SELECT * FROM event_types WHERE host_id=$1 ORDER BY id",
        [host.id],
      )
    ).rows.map(eventFromRow),
  };
}

export async function dashboard(hostId: number) {
  return withHostLock(hostId, async (c, now) => {
    const host = (await c.query("SELECT * FROM hosts WHERE id=$1", [hostId]))
      .rows[0];
    const events = (
      await c.query("SELECT * FROM event_types WHERE host_id=$1 ORDER BY id", [
        hostId,
      ])
    ).rows.map(eventFromRow);
    const availability = (
      await c.query(
        "SELECT * FROM availability_windows WHERE host_id=$1 ORDER BY weekday,start_minute",
        [hostId],
      )
    ).rows.map((w) => ({
      weekday: w.weekday,
      start: clock(w.start_minute),
      end: clock(w.end_minute),
    }));
    const overrides = (
      await c.query(
        "SELECT local_date::text AS date,windows FROM date_overrides WHERE host_id=$1 ORDER BY local_date",
        [hostId],
      )
    ).rows.map((o) => ({
      date: o.date,
      windows: o.windows.map((w: any) => ({
        start: clock(w.start_minute),
        end: clock(w.end_minute),
      })),
    }));
    const bookings = (
      await c.query(
        `SELECT b.id,b.status,b.name,b.email,b.reason,b.expires_at,s.starts_at,s.ends_at,e.name AS event_name,e.slug AS event_slug,b.event_id
      FROM bookings b JOIN sessions s ON s.id=b.session_id JOIN event_types e ON e.id=b.event_id
      WHERE b.host_id=$1 AND b.status IN ('held','confirmed') AND s.ends_at >= $2 ORDER BY s.starts_at LIMIT 500`,
        [hostId, now],
      )
    ).rows.map((b) => ({
      id: b.id,
      status: b.status,
      name: b.name,
      email: b.email,
      reason: b.reason,
      expiresAt: b.expires_at.toISOString(),
      start: b.starts_at.toISOString(),
      end: b.ends_at.toISOString(),
      eventId: b.event_id,
      eventName: b.event_name,
      eventSlug: b.event_slug,
      hostSlug: host.slug,
      hostTimeZone: host.time_zone,
    }));
    return {
      host: hostFromRow(host),
      events,
      availability,
      overrides,
      bookings,
      serverNow: now.toISOString(),
    };
  });
}

export async function saveSettings(hostId: number, body: any) {
  const timeZone = textField(body.timeZone, "time zone");
  try {
    Temporal.Instant.from("2026-01-01T00:00Z").toZonedDateTimeISO(timeZone);
  } catch {
    throw new AppError(400, "Use a valid IANA time zone");
  }
  if (/^[+-]/.test(timeZone))
    throw new AppError(400, "Use an IANA zone such as Asia/Kolkata");
  if (!Array.isArray(body.availability) || body.availability.length > 84)
    throw new AppError(400, "Invalid weekly availability");
  const days = Array.from({ length: 7 }, (_, i) => ({
    weekday: i + 1,
    windows: windows(
      body.availability.filter((w: any) => w?.weekday === i + 1),
    ),
  }));
  for (const row of body.availability) integer(row?.weekday, "weekday", 1, 7);
  if (!Array.isArray(body.overrides) || body.overrides.length > 366)
    throw new AppError(400, "Invalid date overrides");
  const dates = new Set<string>();
  const overrides = body.overrides.map((o: any) => {
    let date: string;
    if (typeof o?.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(o.date))
      throw new AppError(400, "Use a YYYY-MM-DD override date");
    try {
      date = Temporal.PlainDate.from(o?.date).toString();
    } catch {
      throw new AppError(400, "Invalid override date");
    }
    if (date !== o.date || dates.has(date))
      throw new AppError(400, "Use one override per YYYY-MM-DD date");
    dates.add(date);
    return { date, windows: windows(o.windows) };
  });
  await withHostLock(hostId, async (c) => {
    await c.query("UPDATE hosts SET time_zone=$2 WHERE id=$1", [
      hostId,
      timeZone,
    ]);
    await c.query("DELETE FROM availability_windows WHERE host_id=$1", [
      hostId,
    ]);
    for (const d of days)
      for (const w of d.windows)
        await c.query(
          "INSERT INTO availability_windows(host_id,weekday,start_minute,end_minute) VALUES($1,$2,$3,$4)",
          [hostId, d.weekday, w.start_minute, w.end_minute],
        );
    await c.query("DELETE FROM date_overrides WHERE host_id=$1", [hostId]);
    for (const o of overrides)
      await c.query(
        "INSERT INTO date_overrides(host_id,local_date,windows) VALUES($1,$2,$3)",
        [hostId, o.date, JSON.stringify(o.windows)],
      );
  });
  return dashboard(hostId);
}

export async function createEvent(hostId: number, b: any) {
  const name = textField(b.name, "name"),
    slug = textField(b.slug, "slug", 80);
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug))
    throw new AppError(
      400,
      "Slug must use lowercase letters, numbers and hyphens",
    );
  const values = [
    hostId,
    name,
    slug,
    integer(b.durationMinutes, "duration", 15, 120),
    integer(b.capacity, "capacity", 1, 100),
    integer(b.bufferBefore, "buffer before", 0, 30),
    integer(b.bufferAfter, "buffer after", 0, 30),
    integer(b.minNoticeMinutes, "minimum notice", 0, 43200),
    integer(b.horizonDays, "horizon", 1, 365),
  ];
  return withHostLock(hostId, async (c) => {
    if (
      (
        await c.query(
          "SELECT id FROM event_types WHERE host_id=$1 AND slug=$2",
          [hostId, slug],
        )
      ).rowCount
    )
      throw new AppError(409, "An event with this URL slug already exists");
    return eventFromRow(
      (
        await c.query(
          `INSERT INTO event_types(host_id,name,slug,duration_minutes,capacity,buffer_before,buffer_after,min_notice_minutes,horizon_days) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
          values,
        )
      ).rows[0],
    );
  });
}
