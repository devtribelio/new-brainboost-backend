# External Purchase Webhook (design)

> **STATUS: NOT IMPLEMENTED — design / brainstorm only.**
> No code, route, DTO, migration, or test exists yet. This document captures the
> agreed design so implementation can start from a settled spec. Update the
> status line and tick the checklist at the bottom as parts land.

Inbound webhook that lets an **external sales/checkout channel** report a paid
purchase so we provision the buyer and grant course access — even when the buyer
has **no app account yet**. Reuses the existing ingestion kernel; the only net-new
logic is **placeholder ("pra-member") provisioning**.

---

## Why this is mostly already built

The provider-agnostic ingestion kernel `purchaseIngestService.ingest(NormalizedPurchase, credential)`
(`apps/mobile-api/src/modules/ingest/purchase-ingest.service.ts`) already does:

- resolve member (by id / by email), resolve product (by id / by sku)
- idempotency per `(provider, providerEventId)`
- create `CommerceTransaction` (`PAID`) + `CommercePayment` (`SUCCESS`)
- emit `commerce.payment.success` → listener grants `CourseEnrollment` (+ affiliate
  commission when the channel is allowed)

RevenueCat (`webhook/revenuecat.handler.ts`) is a thin adapter on top of this. The
external-purchase webhook is **another adapter** with one extra step.

### The one real gap: member provisioning

`resolveMember` (`purchase-ingest.service.ts:235`) only *looks up* a member. If the
email is unknown it returns `null` → `{ status: 'member_not_found' }`. It does **not**
create one. Our flow receives `name + email` from an external checkout where the
buyer may not have an account, so we must **provision a placeholder member**.

---

## Decisions (locked)

| Aspect | Decision |
|---|---|
| **Source** | Generic — one endpoint, a contract we control. Vendor-specific shapes (Scalev / Lynk.id / …) become thin adapters mapping to the same contract later. |
| **Timing** | **PAID-only.** Every hit = a settled purchase → transaction `PAID` immediately. No `pending`/`expired` state machine (unlike the Xendit invoice handler). |
| **Product ref** | Start with `byId` + `bySku` (existing `Product.iosProductId`). If a vendor uses its own code, add an `externalSku` column on `Product` then — not a blocker now. |
| **Affiliate** | `triggersAffiliate=false` by default (grant access only, no commission). Enable later with `pnpm issue:credential <ch> --affiliate` — **no code change**. |

---

## Endpoint

`POST /api/webhook/external-purchase`

- **Auth:** shared-secret via `ThirdPartyCredential` + `credentialService` — same
  pattern as the RevenueCat guard. Fails closed; secret is rotatable without a
  redeploy (`pnpm issue:credential <channel>`). Each sender gets its own credential
  → the channel name becomes `provider` on the transaction → per-source audit for free.
- **Always returns 200** on a processed/ignored outcome so the sender stops retrying.
  Only genuine transient failures (DB down) throw → `errorHandler` 5xx → sender retries.

### Proposed DTO (contract we control)

```
{
  providerEventId: string    // REQUIRED — idempotency key (sender's order id)
  name: string               // for the placeholder member
  email: string              // placeholder + member resolution
  product: { id? | sku? }    // flexible, layered resolution
  amount: number             // settled amount (IDR)
  affiliateCode?: string     // carried but inert until triggersAffiliate=true
  occurredAt?: string
}
```

> Payload shape is still open (sender TBD). Keep the DTO permissive; tighten once a
> concrete sender is chosen.

---

## Flow

```
POST /api/webhook/external-purchase
  ─▶ guard(shared-secret)             # ThirdPartyCredential, constant-time, fail-closed
  ─▶ validateDto(ExternalPurchaseDto)
  ─▶ ExternalPurchaseHandler
       1. provisionMember(email, name)          ← NEW
            • find member by email
            • not found → create placeholder Member
       2. map → NormalizedPurchase (type: PURCHASE, channel = credential.name)
       3. purchaseIngestService.ingest()
            → CommerceTransaction (PAID) + CommercePayment (SUCCESS)
            → commerce.payment.success → listener grants CourseEnrollment
```

### Recommended: provision inside the kernel, not the adapter

Extend `memberRef` rather than creating the member in the adapter:

```ts
memberRef: { byEmail, provision?: { name } }
```

`resolveMember` becomes: if `byEmail` misses **and** `provision` is set, create the
placeholder **inside the same transaction**. Rationale: two webhooks for the same
email (retry / burst) cannot race into duplicate members; member idempotency stays
in the kernel and is consistent for every future external channel.

---

## Placeholder ("pra-member") — how it later becomes a full member

This is the crux of the design and **requires no new "promote" mechanism** — the
existing register + verify-OTP flow handles it, and the `member.id` is preserved so
the webhook's transaction + enrollment stay attached.

### How the promotion happens (existing machinery)

A placeholder is a `Member` row with
`isActive=false, isEmailVerified=false, isPhoneVerified=false, legacyId=null,
scheduledDeletionAt=null` — matching `isReusableUnverifiedMember`
(`packages/common/src/utils/member-state.util.ts`).

When the buyer later **registers with the same email**:

1. `register()` does **not** block — the reusable-placeholder check skips the
   "Email already registered" error (`auth.service.ts:159-168`).
2. The row is **reused and overwritten in place**:
   `prisma.member.update({ where: { id: reuseRow.id }, ... })`
   (`auth.service.ts:284-288`). **Same `id`, same `code`/`affiliateCode`** → every
   `CommerceTransaction` and `CourseEnrollment` created by the webhook stays attached.
3. The member is still `isActive=false` after register; the **verify-OTP step**
   (`validateOtpEmail`) flips `isActive=true`. **That is the moment placeholder →
   full member.**

```
webhook purchase → placeholder Member (isActive=false, email=X) + tx + enrollment
        ↓ buyer opens app, registers with email X
   register() reuses that row (same id) → sets password/name → issues OTP
        ↓ verify OTP
   isActive=true → FULL MEMBER, tx & enrollment still attached
```

### CRITICAL constraint when creating the placeholder

The placeholder **must** be created `isEmailVerified=false` (and without a usable
password). Do **not** set `isEmailVerified=true` just because the email came from a
paid checkout: that makes `isReusableUnverifiedMember` return `false`, which **blocks**
the later register ("Email already registered") while the buyer has no password —
locking them out of an account they paid for. Keep it `false` so the claim path stays open.

### `PraMember` table is a different thing — do not confuse

`PraMember` (used in `register()` pre-registration carry-over, `auth.service.ts:226-248`)
stores **affiliate attribution context** for deferred-deeplink installs. It is **not**
the placeholder member. Our webhook provisions a placeholder **`Member`** row, not a
`PraMember`.

---

## Open questions (non-blocking, but shape the details)

1. **How does the buyer learn to register?**
   - **(A) Rely on normal register** — webhook silently creates the placeholder; the
     purchase is auto-claimed when the buyer eventually registers with the same email.
     Zero extra code. Risk: if they register with a *different* email, the purchase
     stays stuck on the placeholder.
   - **(B) Send an activation link** post-purchase ("set password & sign in"). Smoother
     UX, but needs an email template + a set-password endpoint. Can follow later.
   - *Decision pending.*

2. **Email trust.** The claim is verified by OTP to the inbox, so whoever receives the
   OTP gets the purchase. Safe **as long as** the checkout email is the buyer's real
   email. A mistyped someone-else's email could be claimed by that other person. Edge
   case — note it.

3. **Phone-only buyers.** If a channel provides only a phone (no email), the email
   claim path doesn't apply; consider `registerByPhone` + WhatsApp OTP.

4. **Placeholder fields.** Besides name + email — phone? target network/community
   (legacy `preRegistration` requires `networkId`)? password (random vs null until
   register)?

5. **Amount verification.** Trust the payload `amount`, or cross-check against
   `Product` price? (RevenueCat trusts the payload; the Xendit handler verifies.) For
   server-to-server with a secret guard, trusting the payload is reasonable.

6. **Non-course products.** Enrollment grant currently only fires for
   `product.type === 'course'`. Decide what "access" means for bundles/plans.

---

## Implementation checklist (none done)

- [ ] `ExternalPurchaseDto` (`webhook/dto/`)
- [ ] `external-purchase.guard.ts` (or reuse a generic credential guard)
- [ ] `ExternalPurchaseHandler` (`webhook/external-purchase.handler.ts`)
- [ ] Kernel: `memberRef.provision` + placeholder creation in `resolveMember`
- [ ] Route wired in `webhook.routes.ts` + controller method
- [ ] `pnpm issue:credential external-purchase` (credential row)
- [ ] Tests: provision-new-member, idempotency, duplicate, product-not-found,
      placeholder-then-register-reuse (id preserved)
- [ ] Resolve open questions 1 & 4 before coding the DTO

---

## Reference files

- Kernel: `apps/mobile-api/src/modules/ingest/purchase-ingest.service.ts`
- Adapter precedent: `apps/mobile-api/src/modules/webhook/revenuecat.handler.ts`
- Guard precedent: `apps/mobile-api/src/modules/webhook/revenuecat-callback.guard.ts`
- Placeholder predicate: `packages/common/src/utils/member-state.util.ts`
- Register / reuse: `apps/mobile-api/src/modules/auth/auth.service.ts` (`register`)
- Routes/controller: `apps/mobile-api/src/modules/webhook/webhook.routes.ts`, `webhook.controller.ts`
- Sibling design doc: `docs/revenuecat-webhook-port.md`
