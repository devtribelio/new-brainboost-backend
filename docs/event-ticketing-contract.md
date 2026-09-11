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
      "price": 150000,                     // UNIT price. NOT the total for N tickets
      "priceTiers": [                      // [] = no packages; total is price x qty
        { "minQty": 2, "totalPrice": 350000, "label": "Duo" },
        { "minQty": 3, "totalPrice": 500000, "label": "Trio" }
      ],
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
- **`priceTiers` is a display list, never a calculator.** Show the packages on the
  card ("Duo Rp350.000 · Trio Rp500.000") and ask §2b for any total. The backend
  always charges the cheapest combination for a quantity, which is not always the
  one the buyer clicked — four singles cost the same as Trio + Solo — so a total
  computed on the client will sometimes be higher than the bill. Empty array =
  behave exactly as before bundling existed.

### Errors

| HTTP | code | Meaning |
|---|---|---|
| 404 | `NOT_FOUND` | No such slug. Render the normal 404 |

A `DRAFT` event is also **404** — nobody may see it yet.

---

## 2b. `GET /api/event/quote` — price N tickets

**Public. No `Authorization`. Writes nothing, reserves nothing.**

```
GET /api/event/quote?ticketTypeId=0199c3a1-....&qty=4
```

### What it is for

A ticket kind may carry a bundle ladder, so the total is **not** `price × qty`.
Call this on every change of the quantity stepper and render the price summary
from what comes back. Same rule as vouchers: the client never computes money.

### Response — 200

```jsonc
{
  "qty": 4,
  "itemTotal": 700000,        // Trio + 1 single, NOT 4 x 200000
  "breakdown": [
    { "label": "Trio",   "qty": 3, "amount": 500000 },
    { "label": "Satuan", "qty": 1, "amount": 200000 }
  ],
  "voucherAmount": 0,         // always 0 here — see below
  "amount": 700000            // equals itemTotal; the shape matches checkout
}
```

`label` is either the tier's own label, a `Paket <n>` fallback, or `Satuan` for
the leftover single tickets. Treat it as copy to print, not a key to switch on.

### Rules

- **Always the cheapest combination.** A buyer who picks "4 singles" is charged
  the same as one who picks "Trio + Solo". Do not build UI that warns them they
  could have saved money — there is nothing to save.
- **No voucher.** This endpoint takes no `voucherCode` and always reports
  `voucherAmount: 0`. Voucher validation is per-member (a trial code is once per
  account) and lives behind auth, so accepting codes here would make a public
  endpoint that confirms which codes are live. The discount is applied at
  checkout; show it there.
- **Quantity only, seats not checked.** `qty` above the kind's `maxPerOrder` is
  `400 EVENT_TICKET_QTY_INVALID`. Availability is **not** verified — quoting is not
  buying, and `remainingQuota` from §2 is what you gate the stepper on.
- Unknown `ticketTypeId` → `404`.

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
  "buyer": {                          // Contact details FOR THIS ORDER, not identity.
                                      // Identity always comes from the session.
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
- **Each attendee may also carry `phone` (+ `phoneCode`, default `+62`)** — how the
  organiser reaches that specific person, separate from the payer's number. Optional,
  never verified, never matched against an account. An unusable value is **dropped,
  not rejected**: the field is optional and no part of the sale depends on it, so a
  typo must not fail the order. It is stored in full E.164 and is **not returned** in
  the checkout or order-status responses — the order page opens for anyone holding
  the link, and it already lists attendee emails; the organiser reads phones from the
  backoffice instead.
- Attendee block #1 is **prefilled** from the payer's details but stays editable
  (D-4). Not locked, not blank.
- **`buyer` fills gaps; it never overrides the account.** Logging in decides whose
  order it is, and every field here is a **fallback**: whatever the account already
  holds wins, silently. Nothing in this block can change the account.
  - **`phone` — always send it**, logged in or not. Used when the account has no
    number: it goes on the order AND fills the empty profile field (never
    overwritten, never treated as verified). When the account already has a number,
    that one is used and yours is ignored.
  - **`phoneCode` — send it for any number outside Indonesia** (`"+65"`, `"+60"`).
    Omitted means `+62`. Without it a foreign number is stored as an Indonesian one
    and becomes undialable, so "+65 9123 4567" must not be sent as `phone` alone.
  - **`email` — required when logged out.** When logged in it is used only if the
    account has no email of its own (someone who registered by phone), where it is
    what makes their receipt deliverable and their order page openable. If the
    account has one, that is used and yours is ignored — you cannot redirect a
    member's receipt. It is never written to the account either: an email becomes a
    login identity only through `requestVerificationEmail` → `validateOtpEmail`.
  - **`name` — ignored when logged in.** The account already has one.
- `source` is read from the `bb_attr`/`bb_gid` cookies **exactly the same way**
  product checkout reads them. This is the only thing that records "bought via
  the Instagram link"; when it is missing, the order is `direct` forever (it
  cannot be fixed later — the snapshot is frozen).

### Response — 201

```jsonc
{
  "transactionId": "0199c3b2-....",
  "transactionCode": "BB-20260909-0042",   // used in the status page URL
  "itemTotal": 300000,                      // total AFTER the bundle ladder — never recompute it
  "breakdown": [                            // how that total was reached; render the summary from this
    { "label": "Duo", "qty": 2, "amount": 350000 }
  ],
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

### Where Xendit sends the buyer back

An event invoice redirects to the order page, **not** to the course receipt:

```
https://<shop>/event/order/BB-20260909-0042?t=<token>
```

Success and failure point at the same URL — the page already renders `EXPIRED`
and `CANCELED` and re-offers `invoiceUrl` while the order is still `PENDING`, so
a separate failure page would only duplicate it.

`t` is an opaque signed token, scoped to that ONE order and good for ~24h. It
exists because the page authenticates on the payer's email and the redirect
cannot carry one: Xendit actively encourages opening checkout on a desktop and
paying by QR on a phone, and that buyer arrives with no `localStorage` to read it
back out of.

Treat `t` as a credential: **strip it from the URL after the first read**
(`history.replaceState`) so it does not leak through `Referer` or to analytics
scripts. Do not log it, and do not build your own — the value is opaque and its
format is not a contract.

The path is a runtime setting (`app_settings['event.orderPath']`, joined to
`shop.baseUrl`), so it can move without a backend deploy. Note this moves the
**redirect only** — the links in already-sent ticket emails are built separately
and keep pointing at `/event/order/`.

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

**Public, but one credential is required. Any ONE of three.**

```
GET /api/event/order/BB-20260909-0042?email=rina%40example.com
GET /api/event/order/BB-20260909-0042?t=<token from the payment redirect>
GET /api/event/order/BB-20260909-0042     + Authorization: Bearer <jwt>
```

| Credential | Use it when |
|---|---|
| `Authorization: Bearer` | the buyer is logged in — it must be the order's own member |
| `t` | the buyer just came back from Xendit (works on a second device) |
| `email` | the link in the summary email. Must match the order's contact address: **the account's own email** when it has one, otherwise what you sent as `buyer.email` |

### What it is for

The `/event/order/[code]` page — "waiting for payment", "paid", or "expired". A
guest buyer has no account to browse history with, so this is their only window
into their own order. The same URL is sent in the summary email, so it must open
days later from a different device.

A wrong credential is **404**, not 403: a 403 would confirm to a guesser that the
order code exists, and the code is guessable — `BB-YYYYMMDD-####` is a per-day
counter. Sending **no** credential at all is a **400** instead; unlike a 403 that
answer reveals nothing about the code.

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

Specified on its own in **`docs/event-visit-contract.md`**: one public endpoint,
called once when the event page renders, so a campaign reads as click → visit →
order instead of orders alone. It never answers anything but 200, and login needs
no new call — `POST /api/shop/visits/claim` already binds event visits too.

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
| `/event/order/[code]` | `GET /api/event/order/:code` + one of `?t=` / `?email=` / bearer | Poll every 3s, 20 times. Xendit redirects here with `?t=`; strip it from the URL after reading |

Easiest things to get wrong, most frequent first:

1. `source` not sent → the whole campaign records as `direct`, unfixable
   afterwards.
2. Dates sliced as strings → evening events show on the wrong day.
3. `EVENT_TICKET_SOLD_OUT` auto-retried → the buyer sees the error repeatedly.
4. Account status inferred from the checkout response → account-existence leak.
5. Ticket codes from the checkout response presented as valid before `PAID`.
6. A deterministic `clientEventId`, or logging a visit on every render → the
   visit count collapses onto the unique-visitor count.
