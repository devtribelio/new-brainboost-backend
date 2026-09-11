# Event Visit Logging — FE ↔ BE Contract

One endpoint: record that somebody opened an event page, so a campaign can be
read as a funnel instead of a list of orders.

- **Status:** built, not released. Branch `feat/event-ticketing` in
  `bb-backend-new` (migration `20260910120000_event_visit`).
- **Written:** 2026-09-10.
- Part of event ticketing — the pages themselves are specified in
  `docs/event-ticketing-contract.md`.

---

## Why it exists

Orders alone cannot tell a channel that brought a thousand people and sold
nothing from one nobody ever opened. Both show zero. With visits the report
reads as **click → visit → order**, and a channel that converts badly becomes
distinguishable from a channel that was never seen.

Event visits are stored in their own table, apart from shop visits, so an
event's traffic never appears on the product Marketing pages. That is invisible
from your side and changes nothing about how you call this.

---

## `POST /api/event/visits`

**Public. No `Authorization`.** Call it once when the event page renders.

### Request

```jsonc
{
  "guestId": "0190a4d1-....",       // REQUIRED — contents of cookie bb_gid
  "eventSlug": "mt-mountain",       // optional; an unknown slug is still logged
  "utmSource": "instagram",         // optional — from cookie bb_attr
  "utmMedium": "social",
  "utmCampaign": "mt-mountain-instagram-denny",
  "utmContent": "story-1",
  "utmTerm": null,
  "referer": "https://t.co/...",    // optional
  "clientEventId": "0190a4d2-...."  // optional — see the rules below
}
```

`guestId` is the only required field. The UTM values are copied from the
`bb_attr` cookie exactly as the shop already does at checkout — same cookie,
same values, no normalisation on either side.

### Response — **always 200**

```jsonc
{ "success": true, "data": { "status": "logged" }, "meta": null, "error": null }
```

| `status` | Meaning | What you do |
|---|---|---|
| `logged` | Stored | Nothing |
| `duplicate` | This `clientEventId` was already logged | Nothing — your earlier attempt worked |
| `invalid` | No `guestId`, or the caller looks like a bot/unfurler | Nothing |
| `error` | Write failed on our side | Nothing |

**It never answers 4xx or 5xx** — not for bad input, not for an unknown slug,
not when the rate limiter is out of budget. A marketing link that returns an
error loses the click it exists to measure. So: never surface a failure to the
visitor, never block rendering on it, and do not add retries beyond your normal
network-level one.

---

## The two rules that decide whether the numbers are right

**1. `clientEventId` dedupes a RETRY, never a visit.**

Generate a fresh id per page view. Reuse it only when re-sending *that same*
view after a network failure. A refresh is a new view and must carry a new id.

A deterministic key — `hash(guestId + eventSlug)`, say — would make every later
view a `duplicate`, so "Kunjungan" would collapse onto "Pengunjung unik" and the
two columns would be equal forever. The column exists to make those two numbers
differ.

Sending no `clientEventId` at all is fine: you lose retry protection, nothing
else.

**2. One call per page view, not per render.**

React strict mode, a resize, a state change, a client-side navigation back to
the same page — none of those are visits. Guard the call so a remount does not
log again.

---

## Login

There is **no separate claim call for events**. `POST /api/shop/visits/claim` —
the one you already call after any successful auth (email register, password
login, Google) — binds this guest's event visits in the same request. Its
contract is unchanged.

That is why attribution does not ride on the register payload: `LoginDto` has no
UTM fields and the social create path never writes them, so a register-payload
design lands every Google signup in `direct`.

---

## Checklist

- [ ] Fire once when `/event/[slug]` renders, guarded against remounts
- [ ] `guestId` from cookie `bb_gid`; create the cookie if absent (30 days)
- [ ] UTM from cookie `bb_attr`, verbatim
- [ ] Fresh `clientEventId` per page view
- [ ] Ignore the response — never show it, never block on it
- [ ] Keep calling `POST /api/shop/visits/claim` after auth; nothing new there
