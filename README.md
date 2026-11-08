# Slotbook

A full-stack TypeScript booking app with React, Express and Postgres 16. Hosts publish availability; guests reserve a five-minute hold, confirm, reschedule and cancel. Group events share a session with numbered seats.

**The reliability decision:** every booking mutation first locks the host row in Postgres. It then reads fresh database time, expires old holds and changes the booking inside the same transaction. Exclusion and uniqueness constraints protect host occupancy and seats. Browser clocks, application clocks and retrying requests do not decide who owns a slot.

This is an interview implementation, with an explicitly documented operating boundary: all application writers follow the host-lock protocol. A privileged database operator can alter lifecycle flags or bypass application policy. The tests exercise specific failure cases; they are evidence, not a proof against every possible failure.

## Run

Install Docker with Compose, then run from this directory:

```sh
docker compose up --build
```

The app builds, waits for Postgres, runs the migration and seeds the demo host automatically. Open [http://localhost:3000](http://localhost:3000).

| Surface                     | URL / credentials                                             |
| --------------------------- | ------------------------------------------------------------- |
| One-to-one introduction     | [localhost:3000/demo/intro](http://localhost:3000/demo/intro) |
| Three-person group workshop | [localhost:3000/demo/group](http://localhost:3000/demo/group) |
| Host dashboard              | [localhost:3000/host](http://localhost:3000/host)             |
| Demo host password          | `slotbook-demo`                                               |
| Database on your computer   | `postgres://slotbook:slotbook@localhost:55432/slotbook`       |

The host is Alex Morgan, slug `demo`, in `Asia/Kolkata`, initially available Monday–Friday, 09:00–17:00. Both seeded event types have zero minimum notice, no buffers and a 30-day horizon. The database volume preserves data between restarts. `docker compose down` stops the app without deleting that volume.

For local development, use Node 22.12+ or a current supported Node release:

```sh
npm ci
docker compose up -d db
npm run dev
```

Do not run the Compose app and development server on port 3000 at the same time. `npm run migrate` is available separately; normal application startup runs it already. `npm run build` type-checks and builds the browser app, and `npm start` serves that build.

Environment variables: `DATABASE_URL`, `PORT` (default `3000`), `HOST_PASSWORD`, `SESSION_SECRET`, `MANAGE_TOKEN_SECRET`, and `COOKIE_SECURE=true` when serving over HTTPS. Compose includes local demonstration credentials. Supply private, persistent secrets and replace the seeded login before any real deployment. Keep `MANAGE_TOKEN_SECRET` stable: confirm retries derive the same manage token from it. Development and Compose use the same local demonstration fallback.

## A 60-second UI tour

1. Open `/demo/intro`. Change the guest time zone and select an available time.
2. Watch the five-minute hold countdown, enter a name and email, and confirm.
3. Save the private manage link. Open it to reschedule or cancel. This demo records notifications in Postgres; it sends no email.
4. Open `/host`, sign in, and inspect upcoming bookings. Try cancellation with a reason.
5. In **Availability**, change the home zone, add weekly windows or add a date with no hours for a day off. In **Event types**, create an event with capacity, buffers, notice and horizon settings.

## Tests

With the Compose database running:

```sh
npm test
npm run check
npm run build
```

Alternatively, with the full Compose app running, run `docker compose exec app npm test`. Tests use isolated hosts and remove their own records; they do not reset the demo host. `DATABASE_URL` can point to another disposable Postgres 15+ database. The migration requires permission to create the `btree_gist` extension.

Verified result during development: **24 tests passed**: 19 real-Postgres reliability tests and 5 deterministic time-zone tests. The suite covers simultaneous capacity claims, group capacity, lost-response retries, changed idempotency payloads, expiry races, confirmation waiting past its deadline, terminal expiry, application-clock skew, buffer overlaps, rescheduling rollback, self-overlapping moves, notification deduplication and DST behavior. The [captured test output](docs/test-results.txt) records the run and environment. No load throughput or p95 claim is made.

The packaged Node 22 Docker app also passed all 24 tests; its [captured output](docs/test-results-docker.txt) is included. A browser check covered booking, confirmation, rescheduling, cancellation, host login, availability saving and a 390px mobile layout. A final HTTP check against the Docker app covered authentication, invalid input, hold retries, the private reschedule-slot preview and the complete booking lifecycle. Test bookings were cancelled afterward.

For the interview demonstration:

```sh
node --import tsx --test --test-name-pattern='30 simultaneous requests' tests/reliability.test.ts
```

That test starts 30 requests with different keys for the same one-seat slot. It asserts exactly one success, 29 conflicts and one active database booking. See [the test source](tests/reliability.test.ts) and [the practice walkthrough](docs/WALKTHROUGH.md).

## API

JSON request and response bodies use camelCase. State-changing requests require a JSON object and `Content-Type: application/json`. Errors use `{ "error": "message" }`. Common statuses: `400` invalid input, `401` host login required, `404` unknown resource, `409` conflict, `410` expired hold, and `503` database contention timeout. Reattempt an uncertain operation with its original idempotency key.

| Method | Path                                               | Input / purpose                                                |
| ------ | -------------------------------------------------- | -------------------------------------------------------------- |
| GET    | `/api/hosts/{host}/events`                         | Public host and event types                                    |
| GET    | `/api/hosts/{host}/events/{slug}/slots?from&to&tz` | Available UTC instants; optional display zone                  |
| POST   | `/api/holds`                                       | `{eventId,start}`; `Idempotency-Key` required                  |
| POST   | `/api/holds/{id}/confirm`                          | `{name,email}`; returns private `manageToken`                  |
| GET    | `/api/bookings/{token}`                            | Current booking details                                        |
| GET    | `/api/bookings/{token}/slots?tz`                   | Reschedule choices, excluding only this booking's current seat |
| POST   | `/api/bookings/{token}/reschedule`                 | `{start}`; `Idempotency-Key` required                          |
| POST   | `/api/bookings/{token}/cancel`                     | `{reason?}`                                                    |
| POST   | `/api/host/login`                                  | `{password}`; sets signed HTTP-only session cookie             |
| POST   | `/api/host/logout`                                 | `{}`; clears cookie                                            |
| GET    | `/api/host`                                        | Authenticated dashboard                                        |
| PUT    | `/api/host/settings`                               | `{timeZone,availability,overrides}`; replaces settings         |
| POST   | `/api/host/events`                                 | Create an event type; fields below                             |
| POST   | `/api/host/bookings/{id}/cancel`                   | Authenticated cancellation; `{reason}` required                |
| GET    | `/api/host/metrics`                                | Authenticated booking-state and notification counts            |
| GET    | `/health`                                          | Database connectivity check                                    |

`from` and `to` are an inclusive/exclusive range of offset-bearing ISO timestamps, or `YYYY-MM-DD` values interpreted as host-local midnight. Requests are bounded to 31 elapsed days. The default begins at database time and spans 30 elapsed days; each event's host-calendar horizon still applies. `tz` validates the requested display zone; returned `start` and `end` remain UTC instants. The browser formats those instants in the selected zone.

Example shapes below are illustrative; choose an actual returned slot instead of reusing a fixed date:

```json
{
  "host": {
    "id": 1,
    "slug": "demo",
    "name": "Alex Morgan",
    "timeZone": "Asia/Kolkata"
  },
  "event": {
    "id": 1,
    "hostId": 1,
    "name": "Introduction",
    "slug": "intro",
    "durationMinutes": 30,
    "capacity": 1,
    "bufferBefore": 0,
    "bufferAfter": 0,
    "minNoticeMinutes": 0,
    "horizonDays": 30
  },
  "slots": [
    {
      "start": "2026-11-09T03:30:00Z",
      "end": "2026-11-09T04:00:00Z",
      "remaining": 1
    }
  ],
  "serverNow": "2026-11-08T09:00:00.000Z",
  "timeZone": "America/New_York"
}
```

Create a hold with `{ "eventId": 1, "start": "<returned UTC instant>" }` and a random UUID in `Idempotency-Key`. Hold and booking responses contain `id`, `status`, `eventId`, `eventName`, `eventSlug`, `hostSlug`, `hostName`, `hostTimeZone`, `start`, `end`, `expiresAt`, `name`, `email`, `reason` and `serverNow`. Confirmation adds `manageToken`; the browser link is `/manage/{manageToken}`. Treat both the hold ID and manage link as private capabilities. The authenticated-by-capability reschedule listing previews availability after removing only that booking; it does not release the actual seat.

Use an idempotency key of 8–128 characters. Keys bind to normalized request payloads and are scoped to the host and operation. A repeated hold returns that hold's current state, including `expired`; use a new key for a genuinely new attempt. A repeated reschedule returns its original saved response and never moves the booking again. Fetch the booking to obtain its latest state after replay. Confirm and cancel have natural idempotency; changed guest details on a confirm retry are rejected.

Host settings example (`weekday`: Monday `1` through Sunday `7`):

```json
{
  "timeZone": "Asia/Kolkata",
  "availability": [{ "weekday": 1, "start": "09:00", "end": "17:00" }],
  "overrides": [
    { "date": "2026-12-25", "windows": [] },
    { "date": "2026-12-26", "windows": [{ "start": "10:00", "end": "12:00" }] }
  ]
}
```

A new event requires `name`, a lowercase hyphenated `slug`, `durationMinutes` (15–120), `capacity` (1–100), `bufferBefore` and `bufferAfter` (0–30), `minNoticeMinutes` (0–43200), and `horizonDays` (1–365). Existing event editing/deletion is outside this implementation.

## Design and scope

- [Architecture, schema, decisions, assumptions and failure cases](docs/ARCHITECTURE.md)
- [Timed interview practice script](docs/WALKTHROUGH.md)
- [AI usage log](AI_LOG.md)
- [Companion report](../slotbook-report.pdf) — distributed beside this repo; upload it separately when submitting.

Built optional extension: basic observability through request IDs, structured route-level logs, `/health`, and authenticated metrics. Logs omit guest details and capability tokens. Notifications use a transactional table sink. No external email, calendar integration, external locks or Redis.

The main deliberate limits are seeded single-host authentication, no rate limits/bot protection, no notification delivery worker, no load benchmark, no automated browser E2E/CI and no live deployment. Review the architecture document before extending or deploying.

## Submission status

The local source, migration, seed, tests, AI log and walkthrough are implemented. **Public GitHub publication is still pending**; no public repo URL has been invented. Preserve the development commit history when publishing. Add the real repository URL to the report, review the AI-assisted work yourself, then submit the repository link and report to the recruiter. The companion PDF is outside the repository directory and should accompany it as a separate file.
