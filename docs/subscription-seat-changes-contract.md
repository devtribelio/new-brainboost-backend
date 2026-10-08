# Subscription seat changes — FE contract

Status: implemented BE 2026-10-08, branch `feat/batch-juli-jalur-a`. Additive; no
client release required to keep working, one needed to show the new UI.

## Why

An owner can rotate guest-seat occupants without limit. Each term now carries an
allowance of **seat changes**; a change is a guest seat going from occupied to
empty by a person (owner remove **or** member leave). Once spent, inviting is
refused until renewal. Removing and leaving are never refused.

## `GET /api/subscription/me` — owner only, additive

```jsonc
{
  "role": "owner",
  // …existing fields…
  "seatChanges": { "used": 1, "max": 2, "remaining": 1 }
}
```

| Field | Meaning |
| --- | --- |
| `used` | Vacates (remove + leave) counted this term. |
| `max` | Cap for this plan. |
| `remaining` | `max − used`, never below 0. |

Absent for a guest (`role: "member"`) and when `role: "none"`.

## `DELETE /api/subscription/seats/:seatId`

```jsonc
{ "removed": true, "seatChanges": { "used": 2, "max": 2, "remaining": 0 } }
```

Render from this; do not refetch `/me` just for the number.

## UI rules

1. **Before a remove, when `remaining === 1`:** confirm dialog. Copy along the
   lines of: *"Setelah anggota ini dikeluarkan, kamu tidak bisa mengundang
   anggota baru lagi sampai perpanjangan."* The remove itself always succeeds.
2. **When `remaining === 0`:** hide or disable the invite button and show why
   (allowance spent, resets at renewal on `expiresAt`).
3. **A member leaving also spends the owner's allowance.** The leave screen does
   not need to show the counter (the guest cannot see it), but the owner's `/me`
   reflects it on the next read.

## Errors

`POST /api/subscription/seats/invite` and `POST /api/subscription/seats/claim`
answer, once the allowance is spent:

```jsonc
{
  "success": false,
  "error": {
    "code": "SUBSCRIPTION_SEAT_CHANGES_EXHAUSTED",
    "message": "Batas pergantian anggota untuk periode ini sudah habis — undangan baru bisa dibuat setelah perpanjangan",
    "details": { "used": 2, "max": 2, "remaining": 0 }
  }
}
```

A claim can hit this even with a valid-looking code: the code was minted before
the cap was reached. Show the message; nothing for the claimer to retry.

## What does NOT count

Seats emptied by the system: downgrade eviction, subscription expiry, cancel.
Renewal and plan change reset `used` to 0.
