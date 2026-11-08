import express, {
  type Request,
  type Response,
  type NextFunction,
} from "express";
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { pool, withHostLock } from "./db.js";
import { migrate } from "./migrate.js";
import { AppError } from "./types.js";
import { listSlots } from "./slots.js";
import {
  createHold,
  confirmHold,
  getBooking,
  listRescheduleSlots,
  rescheduleBooking,
  cancelBooking,
  cancelByHost,
} from "./booking.js";
import {
  publicEvents,
  dashboard,
  saveSettings,
  createEvent,
  textField,
} from "./host.js";

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "32kb" }));
app.use((req, res, next) => {
  const requestId = randomUUID(),
    started = performance.now();
  res.setHeader("X-Request-ID", requestId);
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Content-Type-Options", "nosniff");
  if (req.path.startsWith("/api/")) res.setHeader("Cache-Control", "no-store");
  res.on("finish", () => {
    if (req.path.startsWith("/api/") || req.path === "/health")
      console.log(
        JSON.stringify({
          requestId,
          method: req.method,
          route: req.route?.path ?? "unmatched",
          status: res.statusCode,
          durationMs: Math.round(performance.now() - started),
        }),
      );
  });
  if (!["GET", "HEAD", "OPTIONS"].includes(req.method)) {
    if (!req.body || typeof req.body !== "object" || Array.isArray(req.body))
      return res.status(400).json({ error: "Send a JSON object" });
    const origin = req.get("origin");
    if (req.get("sec-fetch-site") === "cross-site")
      return res
        .status(403)
        .json({ error: "Cross-site requests are not allowed" });
    try {
      if (origin && new URL(origin).host !== req.get("host"))
        return res
          .status(403)
          .json({ error: "Origin does not match this app" });
    } catch {
      return res.status(403).json({ error: "Invalid origin" });
    }
  }
  next();
});
const secret =
  process.env.SESSION_SECRET ??
  "local-demo-session-secret-change-before-deploy";
const password = process.env.HOST_PASSWORD ?? "slotbook-demo";
const sign = (value: string) =>
  createHmac("sha256", secret).update(value).digest("hex");
const equal = (a: string, b: string) => {
  const first = Buffer.from(a),
    second = Buffer.from(b);
  return first.length === second.length && timingSafeEqual(first, second);
};
const cookieOptions = {
  httpOnly: true,
  sameSite: "strict" as const,
  secure: process.env.COOKIE_SECURE === "true",
  path: "/",
};
function auth(req: Request, res: Response, next: NextFunction) {
  const cookie =
    (req.headers.cookie ?? "")
      .split("; ")
      .find((v) => v.startsWith("slotbook_session="))
      ?.slice("slotbook_session=".length) ?? "";
  const [id, expiry, signature] = cookie.split(".");
  if (
    !id ||
    !expiry ||
    !signature ||
    !/^\d+$/.test(id) ||
    !equal(signature, sign(`${id}.${expiry}`)) ||
    Number(expiry) <= Date.now()
  )
    return res.status(401).json({ error: "Sign in to the host dashboard" });
  res.locals.hostId = Number(id);
  next();
}
const param = (req: Request, name: string) => String(req.params[name]);
function query(req: Request, name: string) {
  const value = req.query[name];
  if (value !== undefined && typeof value !== "string")
    throw new AppError(400, `Invalid ${name}`);
  return value;
}
function key(req: Request) {
  return textField(req.get("Idempotency-Key"), "Idempotency-Key header", 128);
}

app.get("/health", async (_req, res) => {
  await pool.query("SELECT 1");
  res.json({ status: "ok", database: "ok" });
});
app.get("/api/hosts/:host/events", async (req, res) =>
  res.json(await publicEvents(param(req, "host"))),
);
app.get("/api/hosts/:host/events/:slug/slots", async (req, res) =>
  res.json(
    await listSlots(
      param(req, "host"),
      param(req, "slug"),
      query(req, "from"),
      query(req, "to"),
      query(req, "tz"),
    ),
  ),
);
app.post("/api/holds", async (req, res) => {
  if (!Number.isInteger(req.body.eventId) || req.body.eventId < 1)
    throw new AppError(400, "Invalid eventId");
  res
    .status(201)
    .json(
      await createHold(
        {
          eventId: req.body.eventId,
          start: textField(req.body.start, "start"),
        },
        key(req),
      ),
    );
});
app.post("/api/holds/:id/confirm", async (req, res) =>
  res.json(
    await confirmHold(param(req, "id"), {
      name: textField(req.body.name, "name"),
      email: textField(req.body.email, "email", 254),
    }),
  ),
);
app.get("/api/bookings/:token", async (req, res) =>
  res.json(await getBooking(param(req, "token"))),
);
app.get("/api/bookings/:token/slots", async (req, res) =>
  res.json(await listRescheduleSlots(param(req, "token"), query(req, "tz"))),
);
app.post("/api/bookings/:token/reschedule", async (req, res) =>
  res.json(
    await rescheduleBooking(
      param(req, "token"),
      { start: textField(req.body.start, "start") },
      key(req),
    ),
  ),
);
app.post("/api/bookings/:token/cancel", async (req, res) =>
  res.json(
    await cancelBooking(
      param(req, "token"),
      req.body.reason === undefined || req.body.reason === ""
        ? undefined
        : textField(req.body.reason, "reason", 500),
    ),
  ),
);
app.post("/api/host/login", async (req, res) => {
  const provided =
    typeof req.body.password === "string" ? req.body.password : "";
  if (!equal(sign(provided), sign(password)))
    throw new AppError(401, "Incorrect password");
  const host = (await pool.query("SELECT id FROM hosts WHERE slug='demo'"))
    .rows[0];
  const value = `${host.id}.${Date.now() + 8 * 3600000}`;
  res
    .cookie("slotbook_session", `${value}.${sign(value)}`, {
      ...cookieOptions,
      maxAge: 8 * 3600000,
    })
    .json({ ok: true });
});
app.post("/api/host/logout", (_req, res) =>
  res.clearCookie("slotbook_session", cookieOptions).json({ ok: true }),
);
app.get("/api/host", auth, async (_req, res) =>
  res.json(await dashboard(res.locals.hostId)),
);
app.put("/api/host/settings", auth, async (req, res) =>
  res.json(await saveSettings(res.locals.hostId, req.body)),
);
app.post("/api/host/events", auth, async (req, res) =>
  res.status(201).json(await createEvent(res.locals.hostId, req.body)),
);
app.post("/api/host/bookings/:id/cancel", auth, async (req, res) =>
  res.json(
    await cancelByHost(
      res.locals.hostId,
      param(req, "id"),
      textField(req.body.reason, "reason", 500),
    ),
  ),
);
app.get("/api/host/metrics", auth, async (_req, res) => {
  const hostId = res.locals.hostId;
  res.json(
    await withHostLock(hostId, async (c) => {
      const statuses = (
        await c.query(
          "SELECT status,count(*)::integer AS count FROM bookings WHERE host_id=$1 GROUP BY status",
          [hostId],
        )
      ).rows;
      const notifications = (
        await c.query(
          "SELECT count(*)::integer AS count FROM notifications n JOIN bookings b ON b.id=n.booking_id WHERE b.host_id=$1",
          [hostId],
        )
      ).rows[0].count;
      return {
        bookings: Object.fromEntries(statuses.map((s) => [s.status, s.count])),
        notificationEvents: notifications,
        notificationSink: "transactional table",
      };
    }),
  );
});
app.use("/api", (_req, res) =>
  res.status(404).json({ error: "API endpoint not found" }),
);
app.use((error: any, _req: Request, res: Response, _next: NextFunction) => {
  const status =
    error instanceof AppError
      ? error.status
      : error.type === "entity.parse.failed" || error.code === "22P02"
        ? 400
        : error.type === "entity.too.large"
          ? 413
          : 500;
  if (status === 500)
    console.error(
      JSON.stringify({
        error: "request_failed",
        code: error.code ?? error.name,
      }),
    );
  res
    .status(status)
    .json({
      error:
        status === 500 ? "Something went wrong. Please retry." : error.message,
    });
});

await migrate();
if (process.env.NODE_ENV === "production") {
  app.use(express.static(path.resolve("dist")));
  app.get("/{*path}", (_req, res) =>
    res.sendFile(path.resolve("dist/index.html")),
  );
} else {
  const { createServer } = await import("vite");
  const vite = await createServer({
    server: { middlewareMode: true },
    appType: "custom",
  });
  app.use(vite.middlewares);
  app.get("/{*path}", async (req, res) =>
    res
      .type("html")
      .send(
        await vite.transformIndexHtml(
          req.originalUrl,
          await readFile("index.html", "utf8"),
        ),
      ),
  );
}
const server = app.listen(Number(process.env.PORT ?? 3000), "0.0.0.0", () =>
  console.log(`Slotbook ready at http://localhost:${process.env.PORT ?? 3000}`),
);
async function stop() {
  server.close();
  await pool.end();
  process.exit(0);
}
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
