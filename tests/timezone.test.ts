import assert from "node:assert/strict";
import { test } from "node:test";
import { generateCandidateSlots } from "../server/slots.js";

function slotsOn(
  date: string,
  start: number,
  end: number,
  zone = "America/New_York",
) {
  return generateCandidateSlots({
    zone,
    durationMinutes: 30,
    capacity: 1,
    weekly: [],
    overrides: { [date]: [{ start_minute: start, end_minute: end }] },
    from: `${date}T00:00:00Z`,
    to: `${date}T23:59:59Z`,
    now: `${date}T00:00:00Z`,
    minNoticeMinutes: 0,
    horizonDays: 30,
  });
}

test("spring DST: nonexistent 02:00 and 02:30 starts are skipped instead of shifted", () => {
  const slots = slotsOn("2026-03-08", 60, 240);
  assert.deepEqual(
    slots.map((slot) => slot.start),
    [
      "2026-03-08T06:00:00Z",
      "2026-03-08T06:30:00Z",
      "2026-03-08T07:00:00Z",
      "2026-03-08T07:30:00Z",
    ],
  );
  for (const slot of slots)
    assert.equal(Date.parse(slot.end) - Date.parse(slot.start), 30 * 60_000);
});

test("fall DST: ambiguous local starts use the earlier occurrence once", () => {
  const slots = slotsOn("2026-11-01", 60, 150);
  assert.deepEqual(
    slots.map((slot) => slot.start),
    ["2026-11-01T05:00:00Z", "2026-11-01T05:30:00Z", "2026-11-01T07:00:00Z"],
  );
  assert.equal(new Set(slots.map((slot) => slot.start)).size, slots.length);
  assert.ok(!slots.some((slot) => slot.start === "2026-11-01T06:30:00Z"));
});

test("a host wall time resolves to one instant that a guest can display in another zone", () => {
  const slots = slotsOn("2026-11-09", 9 * 60, 10 * 60, "Asia/Kolkata");
  assert.equal(slots[0].start, "2026-11-09T03:30:00Z");
  const format = (timeZone: string) =>
    new Intl.DateTimeFormat("en-GB", {
      timeZone,
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).format(new Date(slots[0].start));
  assert.equal(format("Asia/Kolkata"), "09:00");
  assert.equal(format("America/New_York"), "22:30"); // Previous local day.
  assert.equal(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/New_York",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date(slots[0].start)),
    "2026-11-08",
  );
});

test("date overrides replace weekly windows and an empty override closes the day", () => {
  const options = {
    zone: "UTC",
    durationMinutes: 30,
    capacity: 1,
    weekly: [{ weekday: 1, start_minute: 540, end_minute: 600 }],
    from: "2026-11-09T00:00:00Z",
    to: "2026-11-10T00:00:00Z",
    now: "2026-11-08T00:00:00Z",
    minNoticeMinutes: 0,
    horizonDays: 30,
  };
  assert.equal(generateCandidateSlots({ ...options, overrides: {} }).length, 2);
  assert.equal(
    generateCandidateSlots({ ...options, overrides: { "2026-11-09": [] } })
      .length,
    0,
  );
  assert.deepEqual(
    generateCandidateSlots({
      ...options,
      overrides: { "2026-11-09": [{ start_minute: 720, end_minute: 750 }] },
    }).map((slot) => slot.start),
    ["2026-11-09T12:00:00Z"],
  );
});

test("minimum notice and booking horizon are checked against the supplied database time", () => {
  const slots = generateCandidateSlots({
    zone: "UTC",
    durationMinutes: 30,
    capacity: 1,
    weekly: [
      { weekday: 1, start_minute: 540, end_minute: 720 },
      { weekday: 2, start_minute: 540, end_minute: 720 },
    ],
    overrides: {},
    from: "2026-11-09T00:00:00Z",
    to: "2026-11-12T00:00:00Z",
    now: "2026-11-09T08:00:00Z",
    minNoticeMinutes: 120,
    horizonDays: 1,
  });
  assert.equal(slots[0].start, "2026-11-09T10:00:00Z");
  assert.ok(
    slots.every(
      (slot) => Date.parse(slot.start) < Date.parse("2026-11-10T08:00:00Z"),
    ),
  );
});
