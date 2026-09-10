# Event payment redirect — BE → FE answer

Answers `event-payment-redirect-contract.md` (FE → BE, 2026-09-10). Implemented and
merged into the main contract; this file is the delta, so read
`docs/event-ticketing-contract.md` §3–4 for the endpoints themselves.

- **Status:** built on the backend, waiting on deploy
- **FE work needed:** two small things, see §4
- **bb-comms:** not touched. No release coupling added.

---

## 1. Your asks, answered

| Ask | Answer |
|---|---|
| Confirm the path | **`/event/order/<code>` — keep it.** `/ticket/<code>` declined, see §5 |
| Set `success_redirect_url` / `failure_redirect_url` per event invoice | Done. Both, same URL |
| A, B or C for identifying the buyer | **A — signed token** |
| If A: `GET /api/event/order/:code` accepts `?t=` | Done, and it accepts a **bearer** too |
| Absolute URLs, per environment | Done — from `app_settings`, not a build constant |

Two premises in your doc were already out of date, worth correcting so nobody
re-litigates them:

- **§2 did not need proving.** `successRedirectUrl` / `failureRedirectUrl` have
  always been per-invoice request fields here — `payment.service.ts` has been
  setting both since commerce shipped. Nothing was read from an account setting.
- **The redirect never carried the code.** It carried `?transactionId=<uuid>`, so
  the page had nothing to look an order up by even if it had been reachable.

And the root cause is one notch worse than you described: the old target defaults to
`…/checkout/success`, and `/checkout` is in your own `PROTECTED_PATHS`. So the guest
was not merely landing on a receipt behind auth — they were landing on a path your
proxy actively redirects to `/login`.

---

## 2. Where Xendit sends the buyer now

```
https://<shop>/event/order/BB-20260909-0042?t=<token>
```

- **Success and failure are the same URL.** Your page already renders EXPIRED and
  CANCELED and can re-offer `invoiceUrl` while the order is still PENDING, so a
  dedicated failure route would only duplicate it.
- **Absolute, per environment.** Built from `app_settings['shop.baseUrl']` +
  `app_settings['event.orderPath']`, so staging never redirects to production, and
  the path can move later with a SQL update instead of a backend release.
- **`t` is opaque.** Do not parse it, do not build one, do not assume a length or a
  character set. Today it is three base64url segments; that is not a contract.
- Scoped to that one order, good for **~24 hours**.

**Free tickets never come through here.** When `amount = 0` (priced at zero or a
100% voucher) there is no Xendit step at all: checkout answers
`payment.status = "SUCCESS"`, `invoiceUrl = null`, and the tickets are already
issued. Go straight to your success page — unchanged from the existing contract.

---

## 3. Opening the order page

`GET /api/event/order/:code` now accepts **any ONE** of three credentials:

```
GET /api/event/order/BB-20260909-0042?t=<token>                  ← back from payment
GET /api/event/order/BB-20260909-0042?email=rina%40example.com   ← link in the email
GET /api/event/order/BB-20260909-0042   + Authorization: Bearer  ← logged-in buyer
```

Response body is unchanged.

| Situation | Status |
|---|---|
| Any one credential matches | `200` |
| Wrong credential, unknown code, expired `t`, order with no tickets | `404` |
| **No** credential at all | `400` |

A wrong credential is deliberately `404` and not `403`: a 403 would confirm to a
guesser that the order code exists, and order codes are guessable
(`BB-YYYYMMDD-####`, a per-day counter). Do not show "wrong email" as a distinct
state — the backend cannot tell you which it was, by design.

**An expired `t` is a 404, not a specific error.** If a buyer opens a day-old
redirect link, fall back to your email prompt rather than rendering "order not
found" — the order is fine, the credential is stale.

### The bearer case closes a bug you were about to hit

A logged-in buyer's order belongs to their **account** email. Checkout ignores the
`buyer` block when a bearer is present, so if that buyer typed a different contact
email at checkout, your `localStorage` stash holds an email that will never match
the payer — a permanent 404 on their own order. Send the bearer when you have one
and the problem disappears; no email needed at all.

---

## 4. What FE has to do

1. **Read `t` from the query and send it to the API.** One new optional param.
2. **Strip it from the URL after the first read** — `history.replaceState` — so it
   does not leak through `Referer` or into analytics/session-replay tools. Also keep
   it out of your own logs and error reports.
3. **Send the bearer when the visitor is logged in** (see §3).
4. Keep the `localStorage` email stash as a fallback; it still covers the
   same-browser case when a link arrives without `t`.
5. `/ticket/…` can stay out of `PROTECTED_PATHS` or go away — `/event/order/…` is
   the live path and must stay public either way.

Your polling (`3s`, max 20, then "payment is being processed") needs no change and
is still the right behaviour — the webhook can land after the redirect.

---

## 5. Why the path stayed `/event/order/<code>`

Your `/ticket/<code>` proposal is cheap on the FE and not cheap overall: bb-comms
builds the ticket emails and hardcodes `/event/order/<code>?email=` in two handlers
and two templates. Moving the path means changing that repo too, and it is a fixed
step in the release order — so the change buys a shorter URL and costs a
cross-repo deploy.

Your "once it is in an invoice it is permanent" argument is also much weaker than it
reads: a **ticket invoice lives 30 minutes**, so a path change breaks at most half an
hour of in-flight invoices. The part that really is permanent is the link in the
email, which is exactly the part that points at `/event/order/`.

If you still want `/ticket/<code>` later: the redirect alone is one SQL update
(`app_settings['event.orderPath']`), but **email links will not follow** until
bb-comms is changed. Don't flip it expecting both.

---

## 6. Known-open, so you are not surprised

- **Email links keep `?email=`.** Deliberate — the recipient already owns that
  mailbox, and a token there would force bb-comms to hold the signing key for no
  gain.
- **No rate limiter on `GET /event/order/:code`.** Considered and skipped for now.
  The page lists attendee names and emails, so treat its content as personal data
  and keep it out of shared screenshots and analytics payloads.
- **No per-member ticket cap.** `maxPerOrder` caps one order, so N orders bypass it.
  Unchanged by this work.
- `POST /api/event/visits` is still uncalled from the marketplace, so the Kunjungan
  column in the campaign report stays 0 until MP-01..04 land.
