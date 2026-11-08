# Slotbook interview walkthrough

**Practice script — review and understand before presenting.** This is a suggested first-person explanation of the delivered code, not a claim that you personally authored every line. Read `AI_LOG.md`, run the app and tests, and adapt the wording to what you can defend. The brief permits AI assistance, so explain its use honestly.

Before recording, open the repo, the running guest page and host dashboard, and a terminal. Keep these files ready: `migrations/001_init.sql`, `server/db.ts`, `server/booking.ts`, `server/slots.ts` and `tests/reliability.test.ts`. Run the test once before the recording. Aim for about four and a half minutes.

## 00:00 — Repo, data model and double-booking prevention

**Show:** repository tree, then the session exclusion and booking seat constraints in the migration.

“I built Slotbook with a React frontend, a TypeScript Express API and Postgres. Both the host dashboard and the guest flow use the same API. The important files are the migration, the booking service, the transaction helper and the slot generator.

“The data model separates a session from its attendees. A session represents one occurrence of an event and owns the host's time range, including buffers. A booking occupies one numbered seat in that session. That lets three guests share a group session without allowing another event to overlap it.

“Postgres rejects overlapping active session ranges for the same host. A unique index rejects two active bookings in the same seat, and a capacity-bound foreign key prevents invented extra seats. Every lifecycle operation also takes the same host row lock, so the session's active state and seat changes remain consistent.”

## 01:00 — Hold, confirm, reschedule and the clock decision

**Show:** `withHostLock` in `server/db.ts`; then `createHold`, `confirmHold` and `rescheduleBooking` in `server/booking.ts`.

“My key reliability decision was to let Postgres arbitrate ownership. A transaction first locks the host row. Only after that lock is acquired do I read `clock_timestamp()`. Transaction-start `now()` could be stale if the request waited behind another booking.

“I expire old holds, then reserve a seat for five minutes. The idempotency key and hold commit together. If the response gets lost, retrying the same request recovers that hold instead of taking another seat.

“Confirmation turns the existing held seat into a confirmed booking and records its notification in the same transaction. Rescheduling releases and reserves inside one transaction; if the new time conflicts, the original booking remains intact.

“There is a savepoint after expiry cleanup. A rejected booking operation rolls back its own changes but keeps expiration terminal. A clock moving backward cannot revive an expired hold. A wrong database clock can affect how long a hold feels, but capacity still comes from locked state and database constraints.”

## 02:00 — Host and guest time zones

**Show:** `generateCandidateSlots` in `server/slots.ts`, then change the zone in the guest UI.

“Availability is stored as weekly wall-clock windows and date overrides in the host's IANA zone. I generate each local date there, then convert valid starts to UTC instants. The guest's selected zone only changes how those instants are displayed; it does not change the booking.

“The DST policy is explicit. On March eighth, 2026, New York has no 02:00 or 02:30, so I skip those starts. When 01:30 repeats in autumn, I choose the earlier occurrence once. Durations are real elapsed minutes, while the booking horizon uses host-local calendar days.

“For a simple cross-zone example, 09:00 in Kolkata on November ninth is 22:30 in New York on November eighth. The UI groups slots by the guest's date as well as formatting the time.”

## 03:00 — Optional extension and timebox choice

**Show:** request logging and `/health` in `server/index.ts`; optionally the authenticated metrics endpoint.

“I added basic observability: request IDs, structured route logs, a health endpoint and booking-state metrics. Logs omit guest details and private tokens. This helps explain failures and inspect behavior without adding another service.

“I chose not to add a full load benchmark, calendar integration or real email delivery. The notification table satisfies the core requirement atomically. I spent the reliability effort on real-database concurrency, expiry and rescheduling tests. I would add a measured load test and browser E2E coverage next, and I would not call the local seeded login production authentication.”

## 03:40 — Demonstrate one test

**Show:** the first test in `tests/reliability.test.ts`, then run:

```sh
node --import tsx --test --test-name-pattern='30 simultaneous requests' tests/reliability.test.ts
```

“This sends 30 simultaneous requests, each with a different key, for the same one-seat slot against real Postgres. It checks exactly one success, 29 conflicts and one active booking in the database.

“The full suite currently has 24 passing tests. It also covers group capacity, lost responses, waiting past hold expiry, a failed reschedule preserving the original booking, application-clock skew and DST edges. These tests demonstrate the failure cases I designed for; I am not claiming one test proves every possible interleaving.

“The architecture's operating rule is that every application writer uses the same host-lock protocol. The database constraints reinforce it. That is what keeps a stale screen, retrying network or misbehaving clock from granting a second booking.”

## Likely follow-up questions

| Question                                       | Point to explain                                                                                                         |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Why not just check availability before insert? | Two requests can both read available; the check and write must share database coordination.                              |
| Why does a group need a session row?           | The host is occupied once while several bounded seats can be filled.                                                     |
| Why not put `expires_at > now()` in the index? | Clock passage is not a row update. Use explicit lifecycle state and transactional cleanup.                               |
| What happens when the database clock jumps?    | Hold timing or policy boundaries can shift; occupancy safety still holds, and expired state does not reverse.            |
| What if a response is lost after commit?       | Retry the original key. A committed operation is recovered; an uncommitted one can execute once.                         |
| What if rescheduling fails halfway?            | The savepoint rolls the move back; the original confirmed seat remains.                                                  |
| What limits throughput?                        | Writes to one host are serialized intentionally. Measure contention before introducing more complex locking.             |
| What did AI do?                                | Explain the parallel implementation and review work in `AI_LOG.md`; describe the code and tests you personally reviewed. |
| Is the submission published?                   | The local repo is ready; use the actual GitHub URL only after publishing.                                                |
