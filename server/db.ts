import pg, { type PoolClient } from "pg";
import { AppError } from "./types.js";

export const pool = new pg.Pool({
  connectionString:
    process.env.DATABASE_URL ??
    "postgres://slotbook:slotbook@localhost:55432/slotbook",
  max: 30,
});

export async function expireHolds(
  client: PoolClient,
  hostId: number,
  now: Date,
) {
  await client.query(
    "UPDATE bookings SET status='expired' WHERE host_id=$1 AND status='held' AND expires_at <= $2",
    [hostId, now],
  );
  await client.query(
    `UPDATE sessions s SET active=false WHERE s.host_id=$1 AND s.active
    AND NOT EXISTS (SELECT 1 FROM bookings b WHERE b.session_id=s.id AND b.status IN ('held','confirmed'))`,
    [hostId],
  );
}

export async function withHostLock<T>(
  hostId: number,
  fn: (client: PoolClient, now: Date) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  let finished = false;
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL lock_timeout = '10s'");
    await client.query("SET LOCAL statement_timeout = '15s'");
    // ponytail: one transaction at a time per host; split by resource only if measured contention warrants it.
    const result = await client.query(
      "SELECT id FROM hosts WHERE id=$1 FOR UPDATE",
      [hostId],
    );
    if (!result.rowCount) throw new AppError(404, "Host not found");
    // now() is transaction-start time and can be stale after waiting for the lock.
    const now: Date = (await client.query("SELECT clock_timestamp() AS now"))
      .rows[0].now;
    await expireHolds(client, hostId, now);
    await client.query("SAVEPOINT operation");
    let value: T;
    try {
      value = await fn(client, now);
    } catch (error) {
      // Expiration is terminal even when the attempted operation is rejected.
      // Roll back its changes (especially a reschedule's release), retain expiry.
      await client.query("ROLLBACK TO SAVEPOINT operation");
      await client.query("COMMIT");
      finished = true;
      throw error;
    }
    await client.query("COMMIT");
    finished = true;
    return value;
  } catch (error: any) {
    if (!finished) await client.query("ROLLBACK");
    if (error.code === "23P01" || error.code === "23505")
      throw new AppError(409, "That slot is no longer available");
    if (error.code === "55P03" || error.code === "57014")
      throw new AppError(
        503,
        "Booking service is busy; retry with the same idempotency key",
      );
    throw error;
  } finally {
    client.release();
  }
}
