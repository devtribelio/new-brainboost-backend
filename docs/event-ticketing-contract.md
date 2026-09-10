# Event Ticketing — FE (marketplace) ↔ BE Contract

API contract for selling event tickets on the web shop (`brainboost-marketplace`):
showing which events are on sale, the event page, ticket checkout without login,
and the order status page.

Derived from the PRD `docs/event-ticketing.md` (Product, 8 Sep 2026) plus the
technical revision in §14 of that same document. Field names follow the PRD.

- **Status: all four endpoints built and tested** (branch `feat/event-ticketing`,
  not released). Tickets are issued and their emails queued on payment success.
  Release is gated on bb-comms learning the two new message types first —
  until then the emails would land in its DLQ — so confirm with BE before
  running an end-to-end test on staging.
- **Written:** 2026-09-09.

Four calls cross the wire: two reads (swiper + event page), one write
(checkout), one poll (order status). Attribution cookies, the shortlink, and the
backoffice pages stand on their own on each side.

---

## Why the API is split this way

These four endpoints answer four different questions, and are deliberately not
merged:

| Endpoint | Answers | Called from |
|---|---|---|
| `GET /api/event/on-sale` | "Is there an event on sale at all?" | Shop home, once per render |
| `GET /api/event/:slug` | "What is this event, which tickets, how many left?" | Event page + checkout page |
| `POST /api/event/checkout` | "I want N tickets, here is the data" | Pay button |
| `GET /api/event/order/:code` | "Has my order been paid yet?" | Waiting/success page, polled |

Reason for the split: the first must be **cheap and frequently called** (every
visitor to the home page hits it, including those who do not care about events),
the second is **heavy** (HTML description, every ticket type, quota counting),
the third **writes money**, and the fourth must be reachable **with no login at
all** by someone who just closed the Xendit tab.

---

## End-to-end flow

```
  Instagram / broadcast → s.brainboost.id/webinar-sep       (shortlink, already live)
        │
  [FE]  │ 1. proxy.ts: store utm in cookie bb_attr (30 days, last-touch)
        │    create cookie bb_gid (guest UUID, 30 days) if absent
        │    → redirect lands on /event/<slug>
        │
  [FE]  │ 2. home: GET /api/event/on-sale        → swiper (hidden when empty)
  [FE]  │ 3. event page: GET /api/event/<slug>   → ticket type cards
  [FE]  │    and POST /api/event/visits          ──► event_visits (funnel)
        │
        │ 4. pick ticket type + quantity → fill payer form + N attendees
        │
  [FE]  │ 5. POST /api/event/checkout  + cookie snapshot  ──► order + N RESERVED tickets
        │       └─ paid → redirect to invoiceUrl (Xendit)
        │       └─ free → straight to the success page
        │
        │ 6. pay at Xendit → webhook → order PAID, tickets ISSUED
        │
  [FE]  │ 7. GET /api/event/order/<code>?email=...  → poll until PAID
        │       BE sends 1 email per ticket + 1 summary to the payer
```

---

## Ground rules

- Same base URL as the mobile API. Standard envelope
  `{ success, data, meta, error }` — see `docs/api-envelope.md`. Every example
  below shows the contents of `data` only unless stated otherwise.
- **Money is always an integer number of rupiah.** No decimals, no strings, no
  `"Rp"`. `150000` means Rp 150.000.
- **All timestamps are ISO-8601 UTC ending in `Z`.** The FE renders them in
  `Asia/Jakarta`. Never slice the string to get the date — an event at 09:00 WIB
  is stored as `02:00Z`, and one at 00:30 WIB is stored **on the previous day**
  in UTC. Use a timezone-aware formatter, not `substring`.
- Content language (title, description, ticket type name) comes through verbatim
  from the backoffice — there is no i18n on the BE side. Only FE labels are
  translated.

---

## 1. `GET /api/event/on-sale` — events currently on sale

**Public. No `Authorization`.**

### What it is for

Feeds the swiper on the shop home page. Events are not always running, and
Product decided against an event index page — so this is the only way a visitor
discovers an event without being sent a link. **When `items` is empty, the whole
swiper block is not rendered** (as opposed to showing "no events yet").

Returns only `ON_SALE` events that have at least one active ticket type inside
its sale window. Events that are `CLOSED`, canceled, or entirely sold out do not
appear here — their pages remain reachable by direct link (§2).

### Request

No parameters. (A `limit` may be added later; the default is sized for a swiper.)

### Response — 200

```jsonc
{
  "items": [
    {
      "slug": "webinar-tidur-berkualitas",
      "title": "Webinar: Tidur Berkualitas",
      "coverUrl": "https://cdn.../cover.webp",   // may be null
      "startsAt": "2026-09-20T02:00:00Z",        // 09:00 WIB
      "endsAt": "2026-09-20T04:00:00Z",          // may be null
      "location": "Zoom",                        // null for an event with no location
      "lowestPrice": 150000,                     // cheapest ticket type still on sale
      "remainingQuota": 42                       // null = unlimited; see the quota note
    }
  ]
}
```

`remainingQuota` is the **aggregate** across every ticket type, not per type.
Use it for a "42 seats left" badge. If any ticket type is unlimited, the whole
value is `null`.

---

## 2. `GET /api/event/:slug` — event detail + ticket types

**Public. No `Authorization`.**

### What it is for

Fills the `/event/[slug]` page **and** the checkout page (both read the same
endpoint — do not call it a second time when moving to checkout, carry the data
across). This is the only source of price and remaining quota that may be
displayed.

**Always 200 as long as the slug exists**, including events that are over,
closed, or canceled — the page must still open for someone clicking an old link
(D-3). What changes is `canBuy`.

### Response — 200

```jsonc
{
  "slug": "webinar-tidur-berkualitas",
  "title": "Webinar: Tidur Berkualitas",
  "description": "<p>Materi…</p>",         // HTML from the backoffice editor; render as HTML
  "coverUrl": "https://cdn.../cover.webp",
  "startsAt": "2026-09-20T02:00:00Z",
  "endsAt": "2026-09-20T04:00:00Z",
  "location": "Zoom",                      // null → do not render the location row at all
  "locationUrl": "https://maps.app.goo.gl/…", // null; map link for an offline event
  "status": "ON_SALE",                     // DRAFT | ON_SALE | CLOSED | CANCELED
  "canBuy": true,                          // the single gate for showing the buy button
  "ticketTypes": [
    {
      "id": "0199c3a1-....",               // pass this as ticketTypeId at checkout
      "name": "Online",
      "kind": "ONLINE",                    // ONLINE | OFFLINE — for icon/filter
      "price": 150000,
      "remainingQuota": 42,                // null = unlimited
      "isSoldOut": false,
      "maxPerOrder": 10,
      "saleStartsAt": null,                // null = already open
      "saleEndsAt": "2026-09-19T17:00:00Z",// null = until the event starts
      "isOnSale": true                     // sale window active AND not sold out
    }
  ]
}
```

### Rendering rules

- **`canBuy` is the gate, not `status`.** Do not reimplement "if CLOSED then…"
  on the client — the BE already folds event status, sale window and quota into
  that one boolean. `canBuy=false` → render the full page, drop the buy button,
  show "Event telah berlangsung" / "Penjualan ditutup".
- Ticket types with `isOnSale=false` are **still displayed** (so people can see
  the Offline tier sold out), just not selectable.
- `remainingQuota` is a **snapshot**. It goes stale in a tab left open. Do not
  try to keep it fresh — a checkout that refuses (§3,
  `EVENT_TICKET_SOLD_OUT`) is the final word.

### Errors

| HTTP | code | Meaning |
|---|---|---|
| 404 | `NOT_FOUND` | No such slug. Render the normal 404 |

A `DRAFT` event is also **404** — nobody may see it yet.

---

## 3. `POST /api/event/checkout` — buy tickets

**Auth optional.** With a valid `Authorization: Bearer …`, the order attaches to
that account and the `buyer` block is ignored. Without one this is **guest
checkout**: the BE finds or creates an account behind the scenes from the payer's
email, and the buyer never sees or learns about it.

### What it is for

One call that performs the entire transaction: validate, hold quota, create the
order, create N tickets, and **create the Xendit invoice**. The FE does not call
a separate payment endpoint the way course checkout does — a guest holds no
token with which to call it.

### Request

```jsonc
{
  "ticketTypeId": "0199c3a1-....",   // REQUIRED — from ticketTypes[].id
  "buyer": {                          // REQUIRED when logged out; IGNORED when logged in
    "name": "Rina Kusuma",
    "email": "rina@example.com",
    "phone": "081234567890"
  },
  "attendees": [                      // REQUIRED — length = number of tickets
    { "name": "Rina Kusuma", "email": "rina@example.com" },
    { "name": "Budi",        "email": "budi@example.com" }
  ],
  "voucherCode": "HEMAT20",           // optional
  "source": {                         // optional — cookie snapshot, EXACTLY as product checkout
    "guestId": "0190a4d1-....",       //   contents of cookie bb_gid
    "utmSource": "instagram",
    "utmMedium": "social",
    "utmCampaign": "webinar-sep",
    "utmContent": "story-1",
    "utmTerm": null
  }
}
```

**Rules the FE should enforce before submitting** (the BE enforces them again;
this is for good error messages, not for safety):

- `attendees.length` between 1 and that ticket type's `maxPerOrder`.
- Every attendee needs a name and an email. Emails may repeat across attendees
  and may match the payer (P5) — do not reject that.
- Attendee block #1 is **prefilled** from the payer's details but stays editable
  (D-4). Not locked, not blank.
- `source` is read from the `bb_attr`/`bb_gid` cookies **exactly the same way**
  product checkout reads them. This is the only thing that records "bought via
  the Instagram link"; when it is missing, the order is `direct` forever (it
  cannot be fixed later — the snapshot is frozen).

### Response — 201

```jsonc
{
  "transactionId": "0199c3b2-....",
  "transactionCode": "BB-20260909-0042",   // used in the status page URL
  "itemTotal": 300000,                      // price × ticket count
  "voucherAmount": 60000,
  "amount": 240000,                         // amount due
  "expiredAt": "2026-09-09T14:00:00Z",      // payment deadline; seats are released after this
  "payment": {
    "paymentId": "0199c3b3-....",
    "status": "PENDING",                    // PENDING → send the buyer to invoiceUrl
    "invoiceUrl": "https://checkout.xendit.co/web/...."
  },
  "tickets": [
    { "code": "BBT-K7M2QD", "attendeeName": "Rina Kusuma", "attendeeEmail": "rina@example.com" },
    { "code": "BBT-P4X9RT", "attendeeName": "Budi",        "attendeeEmail": "budi@example.com" }
  ]
}
```

**Free tickets** (`amount = 0`, whether priced at zero or fully covered by a
voucher): `payment.status = "SUCCESS"`, `invoiceUrl = null`. Do not redirect
anywhere — go straight to the success page. The tickets are already issued and
the emails are on their way.

**Ticket codes appear in this response** before payment. They are not valid
until the order is `PAID` — show them as information, not as a ticket anyone can
present.

### Errors

| HTTP | code | Meaning | Suggested copy |
|---|---|---|---|
| 400 | `EVENT_NOT_ON_SALE` | Event closed/canceled, or the ticket type's sale window has passed | "Penjualan tiket untuk event ini sudah ditutup." Reload the event page |
| 400 | `EVENT_TICKET_SOLD_OUT` | Out of seats — including losing the race for the last one | "Maaf, tiket baru saja habis." Reload; do not auto-retry |
| 400 | `EVENT_TICKET_QTY_INVALID` | Zero attendees, or more than `maxPerOrder` | Fix in the form |
| 400 | `EVENT_ATTENDEE_INVALID` | An attendee is missing a name/email, or the email is malformed | Mark the offending field |
| 400 | `VOUCHER_INVALID` | Voucher does not apply to this product / expired / quota used up | "Kode voucher tidak berlaku." Let the buyer continue without it |
| 429 | `TOO_MANY_REQUESTS` | Too many attempts from the same IP or email | Show `error.details.retryAfterSeconds` |

**`EVENT_TICKET_SOLD_OUT` can occur even though the page showed seats left.**
That is expected: quota is held at checkout, so two people pressing pay at the
same instant for the last seat produce one success and one of these. Do not
auto-retry — reload the event data and let the buyer decide.

### What the FE must NOT do

- **Never reveal anything about the buyer's account status.** The email used may
  already have a Brainboost account; the BE deliberately does not say so, and the
  response is byte-identical for a registered and an unregistered email. Guessing
  and rendering "this email is already registered, please log in" turns this
  endpoint into an account-enumeration oracle.
- **Never force a login.** Guest checkout is a product decision (P2). A login
  button may exist as an option; it must not be a requirement.

---

## 4. `GET /api/event/order/:code` — order status

**Public, but the payer's email is required as proof.**

```
GET /api/event/order/BB-20260909-0042?email=rina%40example.com
```

### What it is for

The `/event/order/[code]` page — "waiting for payment", "paid", or "expired". A
guest buyer has no account to browse history with, so this is their only window
into their own order. The same URL is sent in the summary email, so it must open
days later from a different device.

`email` is required and must match the payer's. A mismatch is **404**, not 403:
a 403 would confirm to a guesser that the order code exists.

### Response — 200

```jsonc
{
  "transactionCode": "BB-20260909-0042",
  "status": "PAID",                       // PENDING | PAID | EXPIRED | CANCELED
  "amount": 240000,
  "paidAt": "2026-09-09T07:12:00Z",       // null when unpaid
  "expiredAt": "2026-09-09T14:00:00Z",
  "invoiceUrl": "https://checkout.xendit.co/…", // only while PENDING; null otherwise
  "event": {
    "slug": "webinar-tidur-berkualitas",
    "title": "Webinar: Tidur Berkualitas",
    "startsAt": "2026-09-20T02:00:00Z",
    "location": "Zoom"
  },
  "ticketTypeName": "Online",
  "tickets": [
    { "code": "BBT-K7M2QD", "attendeeName": "Rina Kusuma", "attendeeEmail": "rina@example.com", "status": "ISSUED" },
    { "code": "BBT-P4X9RT", "attendeeName": "Budi",        "attendeeEmail": "budi@example.com", "status": "ISSUED" }
  ]
}
```

Ticket status: `RESERVED` (unpaid), `ISSUED` (valid), `EXPIRED` (order lapsed),
`VOID` (canceled by an admin).

### Polling

After the buyer returns from Xendit the status is **not necessarily `PAID` yet**
— the Xendit webhook takes a moment. Poll every **3 seconds, at most 20 times**
(~1 minute), then stop and show "payment is being processed, check your email".
Do not poll forever, and do not conclude failure merely because it is still
`PENDING`.

Once `PAID`, show the ticket codes and **which email each one was sent to** —
that is the first question a buyer purchasing for other people will ask.

---

## 5. `POST /api/event/visits` — log an event-page visit

**Public. No `Authorization`.** Call it once when the event page renders.

### What it is for

It is what turns the campaign report from "orders" into a funnel: click →
**visit** → order. Without it, a channel that brings a thousand people and sells
nothing looks identical to one nobody ever opened.

Event visits are stored **apart from shop visits**, in their own table, so an
event's traffic never appears on the product Marketing pages. That separation is
invisible to you — it changes nothing about how you call this.

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
  "clientEventId": "0190a4d2-...."  // optional — see below
}
```

### Response — **always 200**

```jsonc
{ "success": true, "data": { "status": "logged" }, "meta": null, "error": null }
```

| `status` | Meaning | What you do |
|---|---|---|
| `logged` | Stored | Nothing |
| `duplicate` | This `clientEventId` was already logged | Nothing — your retry worked the first time |
| `invalid` | No `guestId`, or the caller looks like a bot/unfurler | Nothing |
| `error` | Write failed | Nothing |

**It never answers 4xx or 5xx** — not for bad input, not for an unknown slug, not
when the rate limiter is out of budget. A marketing link that returns an error
loses the click it exists to measure. So: do not surface failures to the visitor,
do not block rendering on it, and do not retry on a non-200 beyond your normal
network retry.

### The two rules that decide whether the numbers are right

**1. `clientEventId` dedupes a RETRY, never a visit.** Generate a fresh id per
page view and reuse it only when re-sending *that same* view after a network
failure. A refresh is a new view and must send a new id — a deterministic key
(say `hash(guestId + eventSlug)`) would collapse "Kunjungan" onto "Pengunjung
unik" and the two columns would forever be equal.

**2. Send it once per page view, not per render.** React strict mode, a resize,
a state change — none of those are visits. Guard it so a remount does not log
again.

### Login

There is no separate claim call for events. `POST /api/shop/visits/claim` — the
one you already call after any successful auth — binds this guest's event visits
too, in the same request.

## Register / login for buyers who want an account

There are no new auth endpoints. A buyer who chooses to log in uses the existing
flow:

```
POST /api/member/auth/register
POST /api/member/auth/requestVerificationEmail
POST /api/member/auth/validateOtpEmail     ← returns NO tokens
POST /api/member/oauth/token               ← tokens come from here
```

Note the third step: OTP verification does **not** issue tokens, so the web app
must log in afterwards. That is existing behaviour, not something added for
events.

If a buyer logs in **after** having checked out as a guest with the same email,
their order was attached to that account from the start — there is no claim call
for the FE to make.

---

## Implementation summary

| Page | Calls | Notes |
|---|---|---|
| Shop home | `GET /api/event/on-sale` | Block disappears entirely when `items` is empty |
| `/event/[slug]` | `GET /api/event/:slug` + `POST /api/event/visits` | `canBuy` drives the button; sold-out types stay visible. Log the visit once per page view |
| `/event/[slug]/checkout` | data from that same call, submit to `POST /api/event/checkout` | Must send `source` from cookies |
| `/event/order/[code]` | `GET /api/event/order/:code?email=` | Poll every 3s, 20 times |

Easiest things to get wrong, most frequent first:

1. `source` not sent → the whole campaign records as `direct`, unfixable
   afterwards.
2. Dates sliced as strings → evening events show on the wrong day.
3. `EVENT_TICKET_SOLD_OUT` auto-retried → the buyer sees the error repeatedly.
4. Account status inferred from the checkout response → account-existence leak.
5. Ticket codes from the checkout response presented as valid before `PAID`.
6. A deterministic `clientEventId`, or logging a visit on every render → the
   visit count collapses onto the unique-visitor count.
