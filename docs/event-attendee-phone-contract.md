# Event checkout — attendee phone (+ what else changed in the same deploy)

Delta note for the marketplace FE. The endpoint itself is specified in
`docs/event-ticketing-contract.md` §3; this is only what changed.

- **Written:** 2026-09-10
- **Status:** on the backend, waiting on deploy
- **Breaks nothing.** Every field added here is optional, and a body that predates
  this note is still valid.

---

## 1. What is new

`POST /api/event/checkout` now accepts a phone **per attendee**:

```jsonc
{
  "ticketTypeId": "0199c3a1-0000-7000-8000-000000000001",
  "buyer": {
    "name": "Rina Kusuma",
    "email": "rina@example.com",
    "phone": "081234567890",
    "phoneCode": "+62"          // NEW — optional, defaults to +62
  },
  "attendees": [
    { "name": "Rina Kusuma", "email": "rina@example.com", "phone": "081234567890" },
    { "name": "Budi",        "email": "budi@example.com", "phone": "91234567", "phoneCode": "+65" },
    { "name": "Sari",        "email": "sari@example.com" }   // phone is optional
  ],
  "voucherCode": "HEMAT20"
}
```

It is what the organiser uses to reach **that specific person** — a WhatsApp group
invite, a call about a no-show — as opposed to `buyer.phone`, which reaches whoever
paid. For a group booking those are different people, which is the case the attendee
fields exist for at all.

| Field | |
|---|---|
| `attendees[].phone` | optional, string |
| `attendees[].phoneCode` | optional, defaults to `+62` |

---

## 2. Rules worth knowing before you build the form

**Optional, and keep it optional.** Do not make it a required field on the basis of
this note — the backend accepts an attendee with no phone, and a required field would
cost you completed checkouts for something the organiser only sometimes needs.

**A bad value is dropped, not rejected.** An empty, blank, or unparseable number is
stored as null and the order goes through. You will not get a validation error for
it, so do not rely on the API to tell the buyer they mistyped — if you want that
feedback, validate in the form.

**Send `phoneCode` for anything outside Indonesia.** Omitted means `+62`, so
`"+65 9123 4567"` sent as `phone` alone is stored as an Indonesian number and becomes
undialable. Either send `phoneCode: "+65"` with the national part, or send the full
`+6591234567` **together with** `phoneCode: "+65"` — both forms work when the code is
present.

**It is not returned.** Neither the checkout response nor
`GET /api/event/order/:code` includes attendee phones. That is deliberate: the order
page opens for anyone holding the link and already lists attendee emails, so adding
phone numbers would widen what a forwarded link discloses. Do not build UI that reads
it back — the organiser gets it from the backoffice.

**It is never verified and never an identity.** No OTP, no uniqueness, never matched
against an account. Supplying it does not log anyone in, link anything, or change a
member's profile.

---

## 3. Two adjacent changes in the same deploy

Not about attendees, but they change what your checkout should send — read them
before you test.

### `buyer.phoneCode` (new, optional)

Same rule as the attendee one: omitted means `+62`. Send it for a foreign number.

### The account's own details now win over `buyer` — silently

`buyer` is a **fallback**, not an override. For a logged-in buyer:

| | What the order records |
|---|---|
| Account has an email | the account's. Your `buyer.email` is **ignored** |
| Account has no email (registered by phone) | your `buyer.email` |
| Account has a phone | the account's. Your `buyer.phone` is **ignored** |
| Account has no phone | your `buyer.phone`, which also fills the empty profile field |

Two consequences for you:

1. **Keep sending `buyer.phone` and `buyer.email` anyway.** They are what covers the
   phone-registered member, who has no email on the account at all — without them
   that member's receipt cannot be delivered and their order page cannot be opened.
2. **Do not promise the buyer a different contact address.** If your UI implies "send
   my receipt here", it will not be honoured for an account that already has an
   email. Either drop that implication or prefill the field from the account and
   leave it read-only.

This rule does **not** apply to attendees: an attendee phone is always the one you
sent, because an attendee is not an account.

---

## 4. Swagger is usable again for this endpoint

`attendees` used to render in `/api/docs` as a plain **string**. The generator
accepted `type: () => Dto` but not the array form `type: () => [Dto]`, so every
nested list in the event API fell through to `string` and its item schema was never
registered — `attendees`, both `tickets` arrays, the on-sale `items`, and
`ticketTypes`.

Fixed, so `/api/docs` now shows the real shape of all five, `EventAttendeeDto`
included. If you were working from a hand-written type because the spec was useless,
regenerate from the document instead.

---

## 5. Checklist

- [ ] add an optional phone input per attendee (plus a dial-code selector, or hardcode
      `+62` and send it)
- [ ] add `phoneCode` to the buyer block for the same reason
- [ ] validate the number in the form if you want the buyer told about a typo — the
      API will not say
- [ ] do not expect the phone back in any response
- [ ] check your copy around the buyer's email/phone against §3
