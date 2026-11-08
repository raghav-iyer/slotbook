import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { pool } from "./db.js";

export async function migrate() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(778011)");
    await client.query(
      await readFile(
        new URL("../migrations/001_init.sql", import.meta.url),
        "utf8",
      ),
    );
    const existing = await client.query(
      "SELECT id FROM hosts WHERE slug='demo'",
    );
    if (!existing.rowCount) {
      const host = (
        await client.query(
          "INSERT INTO hosts(slug,name,time_zone) VALUES ('demo','Alex Morgan','Asia/Kolkata') RETURNING id",
        )
      ).rows[0].id;
      await client.query(
        `INSERT INTO event_types(host_id,name,slug,duration_minutes,capacity,buffer_before,buffer_after,min_notice_minutes,horizon_days)
        VALUES ($1,'Introduction','intro',30,1,0,0,0,30),($1,'Group workshop','group',60,3,0,0,0,30)`,
        [host],
      );
      await client.query(
        "INSERT INTO availability_windows(host_id,weekday,start_minute,end_minute) SELECT $1,day,540,1020 FROM generate_series(1,5) day",
        [host],
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  migrate()
    .then(() => console.log("Database migrated; demo host is ready."))
    .finally(() => pool.end());
}
