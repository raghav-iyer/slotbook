export class AppError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export type Window = { start_minute: number; end_minute: number };
export type Host = { id: number; slug: string; name: string; timeZone: string };
export type EventType = {
  id: number;
  hostId: number;
  name: string;
  slug: string;
  durationMinutes: number;
  capacity: number;
  bufferBefore: number;
  bufferAfter: number;
  minNoticeMinutes: number;
  horizonDays: number;
};
export type Slot = { start: string; end: string; remaining: number };
export function hostFromRow(row: any): Host {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    timeZone: row.time_zone,
  };
}
export function eventFromRow(row: any): EventType {
  return {
    id: row.id,
    hostId: row.host_id,
    name: row.name,
    slug: row.slug,
    durationMinutes: row.duration_minutes,
    capacity: row.capacity,
    bufferBefore: row.buffer_before,
    bufferAfter: row.buffer_after,
    minNoticeMinutes: row.min_notice_minutes,
    horizonDays: row.horizon_days,
  };
}
