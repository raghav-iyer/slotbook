import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "./style.css";

type EventType = {
  id: number;
  name: string;
  slug: string;
  durationMinutes: number;
  capacity: number;
  bufferBefore: number;
  bufferAfter: number;
  minNoticeMinutes: number;
  horizonDays: number;
};
type Host = { id: number; name: string; slug: string; timeZone: string };
type Slot = { start: string; end: string; remaining: number };
type Booking = {
  id: string;
  start: string;
  end: string;
  status: string;
  expiresAt?: string;
  eventId: number;
  eventSlug: string;
  eventName: string;
  hostSlug: string;
  hostTimeZone: string;
  name?: string;
  email?: string;
  reason?: string;
  serverNow?: string;
};
type SlotsResponse = {
  host: Host;
  event: EventType;
  slots: Slot[];
  serverNow: string;
};
type Window = { start: string; end: string };
type WeeklyWindow = Window & { weekday: number };
type Override = { date: string; windows: Window[] };
type Dashboard = {
  host: Host;
  events: EventType[];
  availability: { weekday: number; start: string; end: string }[];
  overrides: Override[];
  bookings: Booking[];
};

class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}
async function api<T>(
  path: string,
  body?: unknown,
  method = "POST",
  key?: string,
): Promise<T> {
  const response = await fetch(path, {
    method: body === undefined ? "GET" : method,
    credentials: "same-origin",
    headers: {
      "Content-Type": "application/json",
      ...(key ? { "Idempotency-Key": key } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = await response.json();
  if (!response.ok)
    throw new ApiError(
      typeof data.error === "string"
        ? data.error
        : data.message || "Something went wrong. Please try again.",
      response.status,
    );
  return data;
}
const errorText = (error: unknown) =>
  error instanceof Error
    ? error.message
    : "Something went wrong. Please try again.";
const browserZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
const zones = Array.from(
  new Set([
    browserZone,
    "Asia/Kolkata",
    "America/New_York",
    "America/Los_Angeles",
    "Europe/London",
    "Europe/Paris",
    "Asia/Singapore",
    "Australia/Sydney",
    "UTC",
  ]),
);
const validZone = (zone: string) => {
  try {
    new Intl.DateTimeFormat("en", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
};
const dayLabel = (value: string, zone: string) =>
  new Intl.DateTimeFormat("en", {
    timeZone: zone,
    weekday: "long",
    month: "short",
    day: "numeric",
  }).format(new Date(value));
const timeLabel = (value: string, zone: string) =>
  new Intl.DateTimeFormat("en", {
    timeZone: zone,
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(new Date(value));
const localDay = (value: string, zone: string) =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(value));

function ZoneInput({
  value,
  onChange,
  label = "Your time zone",
}: {
  value: string;
  onChange: (value: string) => void;
  label?: string;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  return (
    <label>
      {label}
      <input
        list="time-zones"
        value={draft}
        onChange={(e) => {
          setDraft(e.target.value);
          if (validZone(e.target.value)) onChange(e.target.value);
        }}
        aria-invalid={!validZone(draft)}
        onBlur={() => {
          if (!validZone(draft)) setDraft(value);
        }}
      />
      <datalist id="time-zones">
        {zones.map((zone) => (
          <option value={zone} key={zone} />
        ))}
      </datalist>
    </label>
  );
}

function App() {
  const path = window.location.pathname.split("/").filter(Boolean);
  return (
    <>
      <a className="skip" href="#main">
        Skip to content
      </a>
      <header>
        <a className="brand" href="/" aria-label="Slotbook home">
          <span className="brand-mark">s.</span>slotbook
        </a>
        <nav aria-label="Main navigation">
          <a href="/">Book a conversation</a>
          <a href="/host">
            Host dashboard <span aria-hidden="true">↗</span>
          </a>
        </nav>
      </header>
      <main id="main">
        {path[0] === "host" ? (
          <HostDashboard />
        ) : path[0] === "manage" && path[1] ? (
          <Manage token={path[1]} />
        ) : path.length === 2 ? (
          <BookingPage hostSlug={path[0]} eventSlug={path[1]} />
        ) : (
          <Home />
        )}
      </main>
      <footer>
        <a className="wordmark" href="/">
          slotbook.
        </a>
        <span>A little space for a good conversation.</span>
        <span>Built around your time.</span>
      </footer>
    </>
  );
}

function Home() {
  const [data, setData] = useState<{ host: Host; events: EventType[] }>();
  const [error, setError] = useState("");
  useEffect(() => {
    api<{ host: Host; events: EventType[] }>("/api/hosts/demo/events")
      .then(setData)
      .catch((e) => setError(errorText(e)));
  }, []);
  return (
    <>
      <section className="hero">
        <div>
          <p className="eyebrow">LESS BACK AND FORTH. MORE HELLO.</p>
          <h1>
            Good conversations
            <br />
            start with a <em>time.</em>
          </h1>
          <p className="lede">
            Find a moment that works for you. Choose a conversation, pick a
            time, and we’ll save your place.
          </p>
        </div>
        <div className="hero-art" aria-hidden="true">
          <div className="orbit orbit-one" />
          <div className="orbit orbit-two" />
          <div className="calendar-art">
            <div className="calendar-top">
              A LITTLE TIME, WELL SPENT <span>↗</span>
            </div>
            <div className="calendar-clock">
              09<span>:</span>30
            </div>
            <div className="calendar-bottom">
              <span className="small-dot" /> Room for something good.
            </div>
          </div>
          <span className="art-label">YOUR NEXT CONVERSATION</span>
        </div>
      </section>
      <section className="home-events">
        <div className="section-heading">
          <div>
            <p className="eyebrow">CHOOSE YOUR CONVERSATION</p>
            <h2>Let’s make time.</h2>
          </div>
          <p>
            {data
              ? `Hosted by ${data.host.name} · ${data.host.timeZone.replaceAll("_", " ")}`
              : "Loading your host…"}
          </p>
        </div>
        {error && (
          <p role="alert" className="notice error">
            {error}
          </p>
        )}
        <div className="event-grid">
          {data?.events.map((event, index) => (
            <a
              className="event-card"
              key={event.id}
              href={`/${data.host.slug}/${event.slug}`}
            >
              <div className="event-card-top">
                <span className="event-number">0{index + 1}</span>
                <span className="pill">
                  {event.capacity === 1
                    ? "ONE TO ONE"
                    : `${event.capacity} SEATS`}
                </span>
              </div>
              <h3>{event.name}</h3>
              <p>
                {event.capacity === 1
                  ? "A focused conversation, just the two of us."
                  : "Shared ideas. Fresh perspectives. A place for you."}
              </p>
              <div className="event-card-bottom">
                <span>◷ {event.durationMinutes} minutes</span>
                <span className="arrow" aria-hidden="true">
                  ↗
                </span>
              </div>
            </a>
          ))}
        </div>
      </section>
    </>
  );
}

function BookingPage({
  hostSlug,
  eventSlug,
}: {
  hostSlug: string;
  eventSlug: string;
}) {
  const [zone, setZone] = useState(browserZone);
  const [data, setData] = useState<SlotsResponse>();
  const [hold, setHold] = useState<Booking>();
  const [selection, setSelection] = useState<Slot>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const keys = useRef(new Map<string, string>());
  useEffect(() => {
    let current = true;
    api<SlotsResponse>(
      `/api/hosts/${encodeURIComponent(hostSlug)}/events/${encodeURIComponent(eventSlug)}/slots?tz=${encodeURIComponent(zone)}`,
    )
      .then((value) => {
        if (current) setData(value);
      })
      .catch((e) => {
        if (current) setError(errorText(e));
      });
    return () => {
      current = false;
    };
  }, [hostSlug, eventSlug, zone, refresh]);
  async function reserve(slot: Slot) {
    if (!data) return;
    setSelection(slot);
    setBusy(true);
    setError("");
    if (!keys.current.has(slot.start))
      keys.current.set(slot.start, crypto.randomUUID());
    try {
      const result = await api<Booking>(
        "/api/holds",
        { eventId: data.event.id, start: slot.start },
        "POST",
        keys.current.get(slot.start),
      );
      if (result.status === "expired" || result.status === "cancelled") {
        keys.current.delete(slot.start);
        throw new Error(
          "That hold has expired. Choose the time again for a new hold.",
        );
      }
      setHold(result);
    } catch (e) {
      setError(errorText(e));
      if (e instanceof ApiError) setRefresh((value) => value + 1);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="booking-layout">
      <aside className="booking-info">
        <a className="back-link" href="/">
          ← All conversations
        </a>
        <div className="avatar">{data?.host.name?.charAt(0) || "S"}</div>
        <p className="eyebrow">{data?.host.name || "YOUR HOST"}</p>
        <h1>{data?.event.name || "Find your time."}</h1>
        <div className="meeting-meta">
          <p>◷ {data?.event.durationMinutes || "—"} minutes</p>
          <p>
            ◎{" "}
            {data?.event.capacity === 1
              ? "One-to-one conversation"
              : `Up to ${data?.event.capacity || "—"} guests`}
          </p>
          <p>
            ↗ {data?.host.timeZone.replaceAll("_", " ") || "Loading time zone"}
          </p>
        </div>
        <p className="quiet-note">
          A little space in your day.
          <br />A conversation worth having.
        </p>
        <div className="reservation-note">
          <span className="small-dot" /> Your selected time is held for 5
          minutes while you enter your details.
        </div>
      </aside>
      <section className="booking-main">
        <p className="eyebrow">
          {hold ? "02 / YOUR DETAILS" : "01 / FIND A MOMENT"}
        </p>
        <h2>{hold ? "We saved you a place." : "When works for you?"}</h2>
        <p className="muted">
          {hold
            ? "Add your details to make it official."
            : "Available times for the next 30 days."}
        </p>
        {error && (
          <p className="notice error" role="alert">
            {error}
          </p>
        )}
        {hold ? (
          <ConfirmForm
            hold={hold}
            zone={zone}
            onReset={() => {
              keys.current.delete(selection?.start || hold.start || "");
              setHold(undefined);
              setSelection(undefined);
              setRefresh((value) => value + 1);
            }}
          />
        ) : (
          <>
            <ZoneInput value={zone} onChange={setZone} />
            {data ? (
              <SlotPicker
                slots={data.slots}
                zone={zone}
                busy={busy}
                selected={selection?.start}
                onSelect={reserve}
              />
            ) : (
              <p role="status" className="loading">
                Finding your next good conversation…
              </p>
            )}
          </>
        )}
      </section>
    </div>
  );
}

function SlotPicker({
  slots,
  zone,
  onSelect,
  busy,
  selected,
}: {
  slots: Slot[];
  zone: string;
  onSelect: (slot: Slot) => void;
  busy: boolean;
  selected?: string;
}) {
  const days = Array.from(
    new Set(slots.map((slot) => localDay(slot.start, zone))),
  );
  const [day, setDay] = useState("");
  const currentDay = days.includes(day) ? day : days[0];
  const visible = slots.filter(
    (slot) => localDay(slot.start, zone) === currentDay,
  );
  return slots.length ? (
    <>
      <div className="day-list" aria-label="Available dates">
        {days.map((date) => {
          const sample = slots.find(
            (slot) => localDay(slot.start, zone) === date,
          )!;
          const d = new Date(sample.start);
          return (
            <button
              type="button"
              className={`day-chip ${date === currentDay ? "selected" : ""}`}
              key={date}
              onClick={() => setDay(date)}
              aria-pressed={date === currentDay}
            >
              <span>
                {new Intl.DateTimeFormat("en", {
                  weekday: "short",
                  timeZone: zone,
                }).format(d)}
              </span>
              <strong>
                {new Intl.DateTimeFormat("en", {
                  day: "numeric",
                  timeZone: zone,
                }).format(d)}
              </strong>
              <span>
                {new Intl.DateTimeFormat("en", {
                  month: "short",
                  timeZone: zone,
                }).format(d)}
              </span>
            </button>
          );
        })}
      </div>
      <div className="slot-heading">
        <strong>{dayLabel(visible[0].start, zone)}</strong>
        <span>{visible.length} available</span>
      </div>
      <div className="slot-grid">
        {visible.map((slot) => (
          <button
            type="button"
            key={slot.start}
            disabled={busy}
            onClick={() => onSelect(slot)}
            className={`slot ${selected === slot.start ? "selected" : ""}`}
          >
            <span>
              {busy && selected === slot.start
                ? "Saving your place…"
                : timeLabel(slot.start, zone)}
            </span>
            {slot.remaining > 1 && <small>{slot.remaining} places left</small>}
          </button>
        ))}
      </div>
    </>
  ) : (
    <div className="empty-state">
      <strong>No times available just now.</strong>
      <p>Try again later, or choose another conversation.</p>
    </div>
  );
}

function ConfirmForm({
  hold,
  zone,
  onReset,
}: {
  hold: Booking;
  zone: string;
  onReset: () => void;
}) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Booking & { manageToken: string }>();
  const clock = useRef({
    start: performance.now(),
    server: Date.parse(hold.serverNow || new Date().toISOString()),
  });
  const [remaining, setRemaining] = useState(300);
  useEffect(() => {
    const tick = () =>
      setRemaining(
        Math.max(
          0,
          Math.ceil(
            (Date.parse(hold.expiresAt || "") -
              clock.current.server -
              (performance.now() - clock.current.start)) /
              1000,
          ),
        ),
      );
    tick();
    const timer = window.setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [hold.expiresAt]);
  async function confirm(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      setResult(
        await api(`/api/holds/${encodeURIComponent(hold.id)}/confirm`, {
          name,
          email,
        }),
      );
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  if (result)
    return (
      <div className="confirmation">
        <div className="check-icon" aria-hidden="true">
          ✓
        </div>
        <h3>You’re booked.</h3>
        <p>
          {dayLabel(result.start, zone)}
          <br />
          <strong>{timeLabel(result.start, zone)}</strong>
        </p>
        <p>
          Save your private link to reschedule or cancel. Anyone with this link
          can manage your booking.
        </p>
        <a className="button" href={`/manage/${result.manageToken}`}>
          View and manage booking <span aria-hidden="true">↗</span>
        </a>
        <p className="muted">
          This demo records notifications locally; no email will be sent.
        </p>
      </div>
    );
  return (
    <form onSubmit={confirm}>
      <div className="selected-summary">
        <div>
          <strong>{dayLabel(hold.start, zone)}</strong>
          <p>
            {timeLabel(hold.start, zone)} – {timeLabel(hold.end, zone)}
          </p>
        </div>
        <span
          className={`pill ${remaining === 0 ? "expired" : ""}`}
          role="timer"
          aria-label={`${remaining} seconds remaining`}
        >
          {remaining > 0
            ? `${Math.floor(remaining / 60)}:${String(remaining % 60).padStart(2, "0")} HELD`
            : "HOLD EXPIRED"}
        </span>
      </div>
      <label>
        Your name
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          autoComplete="name"
          required
          maxLength={100}
        />
      </label>
      <label>
        Email address
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          autoComplete="email"
          required
          maxLength={254}
        />
      </label>
      {error && (
        <p className="notice error" role="alert">
          {error}
        </p>
      )}
      <button className="button" disabled={busy || remaining === 0}>
        {busy ? "Confirming…" : "Confirm conversation →"}
      </button>
      <button type="button" className="text-button" onClick={onReset}>
        Choose a different time
      </button>
      {remaining === 0 && (
        <p role="status" className="muted">
          Your hold has expired. Choose a time to reserve again.
        </p>
      )}
      <p className="muted form-note">
        Your booking is complete when you see a confirmation. The countdown is a
        guide.
      </p>
    </form>
  );
}

function Manage({ token }: { token: string }) {
  const [booking, setBooking] = useState<Booking>();
  const [zone, setZone] = useState(browserZone);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [rescheduling, setRescheduling] = useState(false);
  const [slots, setSlots] = useState<SlotsResponse>();
  const [reason, setReason] = useState("");
  const [cancelling, setCancelling] = useState(false);
  const keys = useRef(new Map<string, string>());
  const path = `/api/bookings/${encodeURIComponent(token)}`;
  useEffect(() => {
    api<Booking>(path)
      .then(setBooking)
      .catch((e) => setError(errorText(e)));
  }, [path]);
  useEffect(() => {
    if (!rescheduling || !booking) return;
    let current = true;
    api<SlotsResponse>(`${path}/slots?tz=${encodeURIComponent(zone)}`)
      .then((value) => {
        if (current) setSlots(value);
      })
      .catch((e) => {
        if (current) setError(errorText(e));
      });
    return () => {
      current = false;
    };
  }, [rescheduling, booking, zone]);
  async function move(slot: Slot) {
    setBusy(true);
    setError("");
    if (!keys.current.has(slot.start))
      keys.current.set(slot.start, crypto.randomUUID());
    try {
      const value = await api<Booking>(
        `${path}/reschedule`,
        { start: slot.start },
        "POST",
        keys.current.get(slot.start),
      );
      setBooking(value);
      setRescheduling(false);
      keys.current.clear();
      setMessage("Your conversation has been rescheduled.");
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  async function cancel(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      setBooking(await api<Booking>(`${path}/cancel`, { reason }));
      setCancelling(false);
      setMessage("Your booking has been cancelled.");
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="manage-page">
      <p className="eyebrow">YOUR CONVERSATION</p>
      <h1>A moment, made.</h1>
      {error && (
        <p className="notice error" role="alert">
          {error}
        </p>
      )}
      {message && (
        <p className="notice success" role="status">
          {message}
        </p>
      )}
      {booking ? (
        <>
          <div className="manage-card">
            <div className="section-heading">
              <h2>{booking.eventName}</h2>
              <span
                className={`pill ${booking.status === "cancelled" ? "expired" : ""}`}
              >
                {booking.status}
              </span>
            </div>
            <p className="large-date">{dayLabel(booking.start, zone)}</p>
            <p>
              {timeLabel(booking.start, zone)} – {timeLabel(booking.end, zone)}
            </p>
            <p className="muted">
              Booked for {booking.name} · {booking.email}
            </p>
            <ZoneInput value={zone} onChange={setZone} />
            {booking.reason && <p>Cancellation reason: {booking.reason}</p>}
            {booking.status === "confirmed" && (
              <div className="actions">
                <button
                  className="button"
                  onClick={() => {
                    setRescheduling((value) => !value);
                    setCancelling(false);
                  }}
                >
                  {rescheduling ? "Keep current time" : "Reschedule"}
                </button>
                <button
                  className="text-button danger"
                  onClick={() => {
                    setCancelling((value) => !value);
                    setRescheduling(false);
                  }}
                >
                  Cancel booking
                </button>
              </div>
            )}
          </div>
          {cancelling && (
            <form className="manage-card" onSubmit={cancel}>
              <h2>Cancel this conversation?</h2>
              <label>
                Reason (optional)
                <textarea
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  maxLength={500}
                />
              </label>
              <button className="button danger-button" disabled={busy}>
                {busy ? "Cancelling…" : "Confirm cancellation"}
              </button>
            </form>
          )}
          {rescheduling && (
            <section className="manage-card">
              <h2>Choose a new time.</h2>
              <p className="muted">
                Your current booking stays yours until the move succeeds.
              </p>
              {slots ? (
                <SlotPicker
                  slots={slots.slots}
                  zone={zone}
                  busy={busy}
                  onSelect={move}
                />
              ) : (
                <p role="status">Loading available times…</p>
              )}
            </section>
          )}
          <p className="muted">
            Keep this page’s link private. It gives access to manage this
            booking.
          </p>
        </>
      ) : (
        !error && <p role="status">Loading your booking…</p>
      )}
    </section>
  );
}

function HostDashboard() {
  const [data, setData] = useState<Dashboard>();
  const [unauthorized, setUnauthorized] = useState(false);
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState("bookings");
  const [cancelId, setCancelId] = useState("");
  const [reason, setReason] = useState("");
  async function load() {
    try {
      setData(await api<Dashboard>("/api/host"));
      setUnauthorized(false);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) setUnauthorized(true);
      else setError(errorText(e));
    }
  }
  useEffect(() => {
    void load();
  }, []);
  async function login(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await api("/api/host/login", { password });
      await load();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  async function cancel(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await api(`/api/host/bookings/${encodeURIComponent(cancelId)}/cancel`, {
        reason,
      });
      setCancelId("");
      setReason("");
      setMessage("Booking cancelled. The notification has been recorded.");
      await load();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  if (unauthorized)
    return (
      <section className="login-card">
        <p className="eyebrow">THE HOST’S CORNER</p>
        <h1>Welcome back.</h1>
        <p className="muted">Make a little room in your calendar.</p>
        <form onSubmit={login}>
          <label>
            Password
            <input
              type="password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
            />
          </label>
          {error && (
            <p className="notice error" role="alert">
              {error}
            </p>
          )}
          <button className="button" disabled={busy}>
            {busy ? "Signing in…" : "Open dashboard →"}
          </button>
          <p className="demo-login">
            Local demo password: <code>slotbook-demo</code>
          </p>
        </form>
      </section>
    );
  return (
    <section className="dashboard">
      <div className="section-heading">
        <div>
          <p className="eyebrow">THE HOST’S CORNER</p>
          <h1>Your time, thoughtfully.</h1>
        </div>
        <div className="actions">
          <a href="/" className="text-button">
            View booking page ↗
          </a>
          <button
            className="text-button"
            onClick={async () => {
              try {
                await api("/api/host/logout", {});
                setData(undefined);
                setUnauthorized(true);
              } catch (e) {
                setError(errorText(e));
              }
            }}
          >
            Sign out
          </button>
        </div>
      </div>
      {error && (
        <p className="notice error" role="alert">
          {error}
        </p>
      )}
      {message && (
        <p className="notice success" role="status">
          {message}
        </p>
      )}
      {data ? (
        <>
          <div className="dashboard-tabs" aria-label="Dashboard sections">
            {["bookings", "availability", "event types"].map((value) => (
              <button
                className={tab === value ? "active" : ""}
                aria-pressed={tab === value}
                key={value}
                onClick={() => {
                  setTab(value);
                  setMessage("");
                  setError("");
                }}
              >
                {value}
              </button>
            ))}
          </div>
          {tab === "bookings" ? (
            <>
              <div className="section-heading">
                <h2>Upcoming conversations</h2>
                <span className="muted">Times in {data.host.timeZone}</span>
              </div>
              {data.bookings.length ? (
                <div className="booking-list">
                  {data.bookings.map((booking) => (
                    <article className="booking-row" key={booking.id}>
                      <div>
                        <strong>{booking.eventName}</strong>
                        <p>
                          {dayLabel(booking.start, data.host.timeZone)} ·{" "}
                          {timeLabel(booking.start, data.host.timeZone)}
                        </p>
                        <small>
                          {booking.name || "Guest entering details"}{" "}
                          {booking.email && `· ${booking.email}`}
                        </small>
                      </div>
                      <span className="pill">{booking.status}</span>
                      {["held", "confirmed"].includes(booking.status) && (
                        <button
                          className="text-button danger"
                          onClick={() => setCancelId(booking.id)}
                        >
                          Cancel
                        </button>
                      )}
                    </article>
                  ))}
                </div>
              ) : (
                <div className="empty-state">
                  <strong>A little breathing room.</strong>
                  <p>Your upcoming bookings will appear here.</p>
                </div>
              )}
              {cancelId && (
                <form className="manage-card" onSubmit={cancel}>
                  <h3>Cancel booking</h3>
                  <label>
                    Reason for the guest
                    <textarea
                      required
                      value={reason}
                      onChange={(e) => setReason(e.target.value)}
                      maxLength={500}
                    />
                  </label>
                  <div className="actions">
                    <button className="button danger-button" disabled={busy}>
                      Confirm cancellation
                    </button>
                    <button
                      type="button"
                      className="text-button"
                      onClick={() => setCancelId("")}
                    >
                      Keep booking
                    </button>
                  </div>
                </form>
              )}
            </>
          ) : tab === "availability" ? (
            <AvailabilityEditor
              data={data}
              onSaved={async () => {
                setMessage(
                  "Availability saved. Existing bookings keep their scheduled time.",
                );
                await load();
              }}
            />
          ) : (
            <EventEditor
              events={data.events}
              host={data.host}
              onSaved={async () => {
                setMessage("Event type created.");
                await load();
              }}
            />
          )}
        </>
      ) : (
        <p role="status">Loading your dashboard…</p>
      )}
    </section>
  );
}

function AvailabilityEditor({
  data,
  onSaved,
}: {
  data: Dashboard;
  onSaved: () => Promise<void>;
}) {
  const [zone, setZone] = useState(data.host.timeZone);
  const [weekly, setWeekly] = useState<WeeklyWindow[]>(
    data.availability.map((window) => ({
      weekday: window.weekday,
      start: window.start.slice(0, 5),
      end: window.end.slice(0, 5),
    })),
  );
  const [overrides, setOverrides] = useState<Override[]>(
    data.overrides.map((value) => ({
      ...value,
      date: value.date.slice(0, 10),
      windows: value.windows.map((window) => ({
        start: window.start.slice(0, 5),
        end: window.end.slice(0, 5),
      })),
    })),
  );
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await api(
        "/api/host/settings",
        { timeZone: zone, availability: weekly, overrides },
        "PUT",
      );
      await onSaved();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <form className="settings-form" onSubmit={save}>
      <div className="settings-block">
        <h2>Make room for conversations.</h2>
        <p className="muted">
          These are local wall-clock hours in your home time zone.
        </p>
        <ZoneInput value={zone} onChange={setZone} label="Home time zone" />
        {[
          "Monday",
          "Tuesday",
          "Wednesday",
          "Thursday",
          "Friday",
          "Saturday",
          "Sunday",
        ].map((day, index) => (
          <div className="weekly-row" key={day}>
            <strong>{day}</strong>
            <div>
              {weekly.map((window, i) =>
                window.weekday === index + 1 ? (
                  <div className="window-row" key={i}>
                    <label className="sr-only" htmlFor={`start-${i}`}>
                      {day} start
                    </label>
                    <input
                      id={`start-${i}`}
                      type="time"
                      required
                      value={window.start}
                      onChange={(e) =>
                        setWeekly(
                          weekly.map((item, j) =>
                            j === i ? { ...item, start: e.target.value } : item,
                          ),
                        )
                      }
                    />
                    <span>to</span>
                    <label className="sr-only" htmlFor={`end-${i}`}>
                      {day} end
                    </label>
                    <input
                      id={`end-${i}`}
                      type="time"
                      required
                      value={window.end}
                      onChange={(e) =>
                        setWeekly(
                          weekly.map((item, j) =>
                            j === i ? { ...item, end: e.target.value } : item,
                          ),
                        )
                      }
                    />
                    <button
                      type="button"
                      className="remove-button"
                      onClick={() =>
                        setWeekly(weekly.filter((_, j) => j !== i))
                      }
                      aria-label={`Remove ${day} window`}
                    >
                      ×
                    </button>
                  </div>
                ) : null,
              )}
              {!weekly.some((window) => window.weekday === index + 1) && (
                <span className="muted">Unavailable</span>
              )}
            </div>
            <button
              type="button"
              className="text-button"
              onClick={() =>
                setWeekly([
                  ...weekly,
                  { weekday: index + 1, start: "09:00", end: "17:00" },
                ])
              }
            >
              + Add hours
            </button>
          </div>
        ))}
      </div>
      <div className="settings-block">
        <div className="section-heading">
          <h2>Date overrides</h2>
          <button
            type="button"
            className="text-button"
            onClick={() =>
              setOverrides([...overrides, { date: "", windows: [] }])
            }
          >
            + Add date
          </button>
        </div>
        <p className="muted">
          Replace weekly hours for a date. With no hours, the day is off.
        </p>
        {overrides.map((override, i) => (
          <div className="override-row" key={i}>
            <div className="actions">
              <label>
                Local date
                <input
                  type="date"
                  required
                  value={override.date}
                  onChange={(e) =>
                    setOverrides(
                      overrides.map((item, j) =>
                        j === i ? { ...item, date: e.target.value } : item,
                      ),
                    )
                  }
                />
              </label>
              <button
                type="button"
                className="text-button danger"
                onClick={() =>
                  setOverrides(overrides.filter((_, j) => i !== j))
                }
              >
                Remove date
              </button>
            </div>
            {override.windows.map((window, j) => (
              <div className="window-row" key={j}>
                <label>
                  From
                  <input
                    type="time"
                    required
                    value={window.start}
                    onChange={(e) =>
                      setOverrides(
                        overrides.map((item, k) =>
                          k === i
                            ? {
                                ...item,
                                windows: item.windows.map((w, l) =>
                                  l === j ? { ...w, start: e.target.value } : w,
                                ),
                              }
                            : item,
                        ),
                      )
                    }
                  />
                </label>
                <label>
                  To
                  <input
                    type="time"
                    required
                    value={window.end}
                    onChange={(e) =>
                      setOverrides(
                        overrides.map((item, k) =>
                          k === i
                            ? {
                                ...item,
                                windows: item.windows.map((w, l) =>
                                  l === j ? { ...w, end: e.target.value } : w,
                                ),
                              }
                            : item,
                        ),
                      )
                    }
                  />
                </label>
                <button
                  type="button"
                  className="remove-button"
                  aria-label="Remove override hours"
                  onClick={() =>
                    setOverrides(
                      overrides.map((item, k) =>
                        k === i
                          ? {
                              ...item,
                              windows: item.windows.filter((_, l) => l !== j),
                            }
                          : item,
                      ),
                    )
                  }
                >
                  ×
                </button>
              </div>
            ))}
            <div className="actions">
              {!override.windows.length && (
                <span className="pill">DAY OFF</span>
              )}
              <button
                type="button"
                className="text-button"
                onClick={() =>
                  setOverrides(
                    overrides.map((item, j) =>
                      j === i
                        ? {
                            ...item,
                            windows: [
                              ...item.windows,
                              { start: "09:00", end: "17:00" },
                            ],
                          }
                        : item,
                    ),
                  )
                }
              >
                + Add custom hours
              </button>
            </div>
          </div>
        ))}
      </div>
      {error && (
        <p className="notice error" role="alert">
          {error}
        </p>
      )}
      <button className="button" disabled={busy}>
        {busy ? "Saving…" : "Save availability →"}
      </button>
    </form>
  );
}

function EventEditor({
  events,
  host,
  onSaved,
}: {
  events: EventType[];
  host: Host;
  onSaved: () => Promise<void>;
}) {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function create(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const fields = new FormData(form);
    const body = Object.fromEntries(fields);
    for (const key of [
      "durationMinutes",
      "capacity",
      "bufferBefore",
      "bufferAfter",
      "minNoticeMinutes",
      "horizonDays",
    ])
      (body as Record<string, unknown>)[key] = Number(body[key]);
    setBusy(true);
    setError("");
    try {
      await api("/api/host/events", body);
      form.reset();
      await onSaved();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <div className="event-grid compact">
        {events.map((event) => (
          <a
            className="event-card"
            key={event.id}
            href={`/${host.slug}/${event.slug}`}
          >
            <span className="pill">
              {event.durationMinutes} MIN · {event.capacity}{" "}
              {event.capacity === 1 ? "SEAT" : "SEATS"}
            </span>
            <h3>{event.name}</h3>
            <p>
              {event.bufferBefore} min before · {event.bufferAfter} min after
            </p>
            <p>
              {event.minNoticeMinutes} min notice · {event.horizonDays} day
              horizon
            </p>
            <span className="text-button">Open booking page ↗</span>
          </a>
        ))}
      </div>
      <form className="settings-block event-form" onSubmit={create}>
        <h2>Start a new conversation.</h2>
        <div className="form-grid">
          <label>
            Event name
            <input name="name" required maxLength={100} />
          </label>
          <label>
            URL slug
            <input
              name="slug"
              required
              pattern="[a-z0-9]+(-[a-z0-9]+)*"
              placeholder="coffee-chat"
              maxLength={80}
            />
          </label>
          <label>
            Duration (minutes)
            <input
              type="number"
              name="durationMinutes"
              min={15}
              max={120}
              defaultValue={30}
              required
            />
          </label>
          <label>
            Guest capacity
            <input
              type="number"
              name="capacity"
              min={1}
              max={100}
              defaultValue={1}
              required
            />
          </label>
          <label>
            Buffer before (minutes)
            <input
              type="number"
              name="bufferBefore"
              min={0}
              max={30}
              defaultValue={0}
              required
            />
          </label>
          <label>
            Buffer after (minutes)
            <input
              type="number"
              name="bufferAfter"
              min={0}
              max={30}
              defaultValue={0}
              required
            />
          </label>
          <label>
            Minimum notice (minutes)
            <input
              type="number"
              name="minNoticeMinutes"
              min={0}
              max={43200}
              defaultValue={240}
              required
            />
          </label>
          <label>
            Booking horizon (days)
            <input
              type="number"
              name="horizonDays"
              min={1}
              max={365}
              defaultValue={30}
              required
            />
          </label>
        </div>
        {error && (
          <p className="notice error" role="alert">
            {error}
          </p>
        )}
        <button className="button" disabled={busy}>
          {busy ? "Creating…" : "Create event type →"}
        </button>
      </form>
    </>
  );
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
