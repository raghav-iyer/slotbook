# AI usage log

This repository was built from scratch with Codex after the candidate supplied the Slotbook assignment and asked for help building and explaining it. AI assistance is permitted by the supplied brief. This log describes the assistance honestly; it does not claim the candidate independently wrote or manually reviewed code they have not reviewed.

## How AI was used

Codex read the brief, proposed the transaction model and coordinated parallel implementation work on the booking core, browser interface, reliability tests and integration. The work used TypeScript, React, Express, plain parameterized SQL, Postgres and the Temporal polyfill. No application starter template was copied. The minimal project scaffolding was generated for this task.

Representative instructions were to:

- Keep correctness in Postgres; serialize booking changes per host and support both one-to-one and group capacity.
- Treat booking, retry handling and notification records as a single transactional operation.
- Generate availability in the host's IANA zone, with explicit policies for nonexistent and repeated local times.
- Test concurrency against real Postgres, including expiry, retries, buffer conflicts and failed rescheduling.
- Produce an interview explanation grounded in actual files and test results rather than an imagined implementation.

These summarize the working prompts; they are not presented as a verbatim transcript.

## Where review changed the generated work

The initial transaction design sampled `clock_timestamp()` after the host lock, avoiding a stale transaction-start timestamp after contention. A further review identified that rolling back the entire transaction on a rejected confirm would also roll back the observed expiry. A savepoint was added after cleanup: failed booking mutations roll back, while expiration remains committed and terminal. The queued-confirm test checks the resulting expired state.

The first version of several tests assumed every rejected state used HTTP `409`. Expired holds intentionally use `410 Gone`; those assertions were corrected to match the contract rather than changing the API to satisfy incorrect tests.

Cross-agent review also caught malformed authentication-cookie comparisons that could throw on unequal byte lengths, missing/non-object JSON request handling, and stale expiry counts in metrics. The implementation was adjusted. Time-zone and input-boundary review made the nonexistent-time policy explicit, kept ambiguous starts deterministic, and bounded calendar calculations.

Rescheduling review also added a capability-protected slot preview that removes only the current booking hypothetically. This lets the browser offer moves overlapping its own buffer without releasing the real seat or ignoring another group attendee. Local development and Compose defaults were aligned so replayed manage links remain stable across those launch modes.

The generated SQL was strengthened beyond a count-only application check: host occurrence ranges use an exclusion constraint, active attendees use a unique numbered seat, and a foreign key binds the booking's capacity to its session. Tests attempt invalid direct inserts to confirm those particular database protections.

## Validation and ownership

The recorded automated result is 24 passing tests: 19 against real Postgres and five deterministic time-zone tests. TypeScript checking and the production browser build were also run. These checks do not establish production readiness or measure sustained load performance.

The candidate should run the app, rerun the tests, read the transaction and time-zone code, and adapt the practice script before presenting. Any later candidate edits, rejected suggestions or additional checks should be added here. No candidate-authored manual changes or a four-hour completion time are claimed in this log.
