# Email / OTP Scope (legacy → mobile rewrite)

Inventory of email + OTP templates the **mobile** backend actually needs, extracted
from `tribelio-platform`. Drives the service-boundary decision in
[ADR-0002](adr/0002-email-otp-service-boundary.md).

Each row cites the legacy dispatch site so it can be re-verified.

---

## 1. Legacy architecture (what we're porting from)

```
TBEmail::send($type, $id)                         # 463 call sites platform-wide
  → TBEmail_Channel                               # picks SQS queue by $type
      sqs            (default)
      sqsUrgent      (OTP, payment, verification)
      sqsBroadcastNotification
      sqsWeekly
  → TBEmail_Engine_<Type>::execute()              # resolve model, build template data
  → view  views/TBEmailTemplate/default/template/<Type>/Email.php   (render HTML)
  → SES  (TBEmail/Ses)
```

Phone OTP is a **separate** path — not email:

```
TBQontak::send(...)  ← TBQontak_Engine_MemberVerificationOtpPhoneNumber   # WhatsApp Business API
```

Key fact: **legacy already runs email async via SQS** (4 priority queues). Delivery
is decoupled from the request that triggers it. The new backend currently sends
synchronously (`await mailer.send` in the request path) — an anti-pattern parity
gap, not a feature.

- Legacy template types total: **173** (`libraries/TBEmail/Engine/*.php`).
- In mobile rewrite scope: **~22** (rest are web/canvas/campaign/business/network-paid/
  topic-paid/powerup/storage/weekly — all marked NOT porting in `CLAUDE.md`).

---

## 2. Mobile-scope templates

Two trigger sources:
- **direct** — fired by the mobile API surface (`libraries/TBApi/**`, GROUP_MEMBER).
- **event** — fired downstream of a mobile-initiated flow (Xendit payment callback,
  affiliate commission, disbursement). In the new backend these map to the commerce
  module's event-driven side effects (see `docs/commerce-port.md`).

### A. Auth / OTP — ✅ shipped (inline text/string, no HTML template)

| Legacy template | New purpose key | Channel | Trigger | Status |
|---|---|---|---|---|
| `MemberVerification` / `MemberVerificationEmailByLink` | `verify-email` | Email | direct | ✅ |
| `MemberRegister` | (welcome, part of register) | Email | direct | ✅ |
| `MemberRequestForget` | `forgot-password` | Email | direct | ✅ |
| `MemberRequestDeleteAccount` | `delete-account` | Email | direct | ✅ |
| (pre-registration) | `pre-registration` | Email | direct | ✅ |
| `MemberVerificationOtpPhoneNumber` (Qontak) | `verify-phone` | WhatsApp | direct | ⚠️ logic done, Qontak not wired (T1.4, `legacy-providers.md`) |

Call sites (new): `apps/mobile-api/src/modules/{auth,account}/*.service.ts` → `otpService`.

### B. Commerce / purchase — ❌ email not ported (module exists)

Fired from payment success (`controllers/payment.php`, `TBEvent/PaymentSubscriber`).

| Legacy template | Notes |
|---|---|
| `CoursePaymentSuccess` / `CoursePaymentSuccessGuest` | course purchase confirmation |
| `CoursePaymentMember` | member-side course payment |
| `CommerceTransaction` | generic transaction receipt |
| `ProductTransactionReceipt` | product receipt |
| `PayNow` | invoice / pay reminder (legacy: `sqsUrgent`) |
| `VoucherCodeForAffiliate` | voucher delivery (`TBTaskQueue/Course/VoucherCodeSendEmail`) |

> **SaleAlert (NEW, ✅ shipped 2026-07-16)** — single-tenant replacement for legacy's
> chief email (`TBEmail_Engine_CoursePaymentSuccess`, "Produk X Berhasil Terjual!",
> sent to `networkAccount->member->email`). Recipients now come from app_settings
> **`sales.alertEmail`** (comma-separated, empty = off, seeded empty) — one outbox row
> per address with `recipient` set (relay maps it to `msg.to`; bb-comms sends there
> instead of the buyer). Producer: `packages/domain/src/comms/listeners/commerce-email.listener.ts`
> on `commerce.payment.success`. Skips renewals; the plan-backed (subscription) skip
> lands with the subscription branch. bb-comms side (pending, separate repo): handler
> `sale_alert.go` + template `sale_alert.html`, reads `commerce_transactions` by refId
> (+ `m.phone` in `GetCommerceTxn`), buyer name/email/phone included, `To` = `msg.To`,
> subject "Produk {title} Berhasil Terjual!". Note: legacy only fired via the Xendit webhook, so
> voucher-100% sales never emailed the chief — the event-driven port covers them too.

### C. Affiliate / disbursement — ❌ email not ported (module ~partial)

Fired from commission compute + disbursement callback.

| Legacy template | Dispatch site |
|---|---|
| `AffiliateJoin` | affiliate join |
| `AffiliatorCommisionCourse` | `TBAffiliator/Commision/ProductDigitalPayment` |
| `DisbursementAffiliate` | `TBXendit/Callback/Disbursement/Affiliate` |
| `MemberWithdraw` / `MemberWithdrawApproval` | withdraw flow (`controllers/studio/setting/account.php`) |
| `ReminderAffiliateInactive` | inactivity reminder (scheduled) |

### D. Social (post / comment) — ❌ email not ported (module exists)

| Legacy template | Notes |
|---|---|
| `Post` / `PostAdmin` | post notification |
| `Comment` | comment notification |
| `PostRequest` / `PostRequestConfirmation` | post approval flow |

> Most social signals in the new backend go through the **notification** module
> (FCM push + in-app feed), not email. Email port here is optional — confirm with
> product before building D templates.

### E. Network — ⚠️ questionable (module simplified, single-tenant)

| Legacy template | Notes |
|---|---|
| `HaveAccessNetwork` | access granted |
| `MemberInviteNetwork` | invite |
| `MemberRequestJoinNetwork` / `...Confirmation` | join request |

> Network is single-tenant-simplified in the rewrite. Re-verify these still apply
> before porting.

### EXCLUDE — appears in `TBApi` but NOT in rewrite scope

`BusinessDeleteAccount`, `MemberCreateAccountBussiness`, `MemberCancelPaidMembership`,
`MemberTransferAccount`, `MemberShareContact`, `MemberMessageAllFollower`,
`TransactionPaidTribe`, `MemberDeleteNetwork` — web/business/multitenant features.

---

## 3. Summary

| Bucket | Count | Status | Channel | Nature |
|---|---|---|---|---|
| A. Auth / OTP | 6 | ✅ done | Email + WhatsApp | sync, latency-sensitive |
| B. Commerce | 6 | ❌ pending | Email | event-driven (async) |
| C. Affiliate | 5 | ❌ pending | Email | event-driven (async) |
| D. Social | 4 | ❌ pending (optional) | Email | event-driven (async) |
| E. Network | 3 | ⚠️ verify | Email | event-driven (async) |
| **Total mobile scope** | **~22** | 6 done | — | — |

**Shape of the decision (ADR-0002):** outbound delivery moves to a **separate repo**,
`bb-comms` — a RabbitMQ-**triggered** worker outside this monorepo that **reads the
shared bb-platform Postgres** for template data (legacy Engine pattern), owning email +
WhatsApp (+ future SMS). Boundary:

- **OTP code state** (gen/store/verify/consume on `otp_codes`) **stays** in
  `bb-platform` `@bb/common` — sync, auth-critical, in-process. Only OTP *delivery*
  is published to `bb-comms`.
- **Message = trigger, not payload.** Transactional types publish a light
  `{v, type, id, channel, priority}` via the `NotificationOutbox` (transactional,
  `notification-port.md` §12); `bb-comms` **reads PG by `id`** to resolve data, then
  renders (MJML+Handlebars, templates live there) + sends.
- **OTP is the exception:** `otp_codes` holds only the bcrypt **hash**, so the plaintext
  code can't be read back — OTP messages carry it inline `{v, type:'otp', channel, to, code, name?, ttl}`. Sensitive: dedicated vhost + TLS + short TTL + no body logging.
- **Delivery log + idempotency** (`comms_delivery`, `comms_idempotency`) live in the
  **bb-platform Postgres** (comms-owned tables; migration ownership TBD — see ADR-0002).
- **In-app feed + FCM push stay** in the backend `notification` module.

Why a separate repo (vs ADR-0001 keeping backoffice in-monorepo): the split is about
**lifecycle independence** (deploy/scale/on-call/template iteration) + **no shared
domain logic**, NOT decoupling from the DB — bb-comms *does* share the Postgres (reads
business tables, writes `comms_*`). Shared surfaces = message shape + read-schema, both
versioned. See [ADR-0002](adr/0002-email-otp-service-boundary.md).

Related: `docs/otp-port.md`, `docs/legacy-providers.md` (Qontak T1.4),
`docs/notification-port.md §12` (RabbitMQ outbox).

---

## 4. Producer-side work in THIS repo (`bb-platform`)

Delivery (render + send) lives in the separate `bb-comms` repo (ADR-0002). This repo
becomes a **pure producer**: write an outbox row, publish to RabbitMQ. No SMTP, no
Qontak, no template rendering remains here.

### Stays (unchanged)

- `OtpCode` table + `otp.service` gen/store/**verify**/**consume** — auth-critical, sync.
- `notification` module: in-app feed + FCM push (Prisma-coupled).

### Moves out → `bb-comms` (deleted from this repo)

| Item | Current location |
|---|---|
| Qontak WhatsApp client | `packages/common/src/services/whatsapp.service.ts` |
| SMTP transport | `packages/common/src/services/mailer.service.ts` |
| env `smtp.*` + `qontak.*` blocks | `packages/common/src/config/env.ts` |
| ~16 HTML templates | (not built here — build in `bb-comms`) |

### Added / changed here

1. **Prisma `NotificationOutbox` table** (+ migration). Shape per `notification-port.md`
   §12: `id, channel, type, refId, payload(jsonb, OTP-only), status(PENDING|SENT|FAILED), priority(urgent|normal), attempts, createdAt, sentAt`. `refId` = the entity id
   bb-comms reads PG by; `payload` only used for the OTP inline-code exception. Reused by
   FCM push **and** external comms.
2. **`comms_delivery` + `comms_idempotency` tables** (Prisma) — written by bb-comms, but
   declared here since bb-platform `schema.prisma` is the single migration authority
   (ADR-0001). bb-comms reads/writes, does not migrate.
3. **Enqueue helper** in `@bb/common` (e.g. `comms-outbox.ts`) —
   `enqueue({channel, type, refId, priority, payload?})` writes one outbox row in the
   caller's Prisma transaction (no dual-write race). Trigger only — no template data.
4. **`otp.service.issue()` change** — swap `whatsappService.sendOtp(...)` /
   `mailer.send(...)` for `enqueue({type:'otp', payload:{code,to,name,ttl}})` (OTP inline
   payload — code not in DB as plaintext). `verify`/`consume` untouched.
5. **RabbitMQ publisher infra** in `@bb/common` — connection + topology constants
   (exchange + `urgent`/`normal` queues) per memory `[[feedback_messaging_config]]`
   (names as code constants, conn params in env, dedicated vhost).
6. **Relay daemon** — poll `NotificationOutbox` status=PENDING → publish to RabbitMQ →
   mark SENT/FAILED. Deployment shape TBD (lightweight standalone process recommended
   for clean at-least-once; alt: in-process tick on an existing app).
7. **Env additions** (`config/env.ts`): `RABBITMQ_URL`, `RABBITMQ_VHOST`,
   `COMMS_EXCHANGE`, queue names. Remove `smtp.*` / `qontak.*` (moved out).
8. **Transactional producers** (when bucket B/C ported) — commerce/affiliate event
   listeners write an outbox trigger (`{type, refId}`), not data, not render. Hook into
   existing PaymentService SUCCESS path + commission/disbursement events.
9. **Contract definition** — message shape `{v, type, refId, channel, priority}`
   (+ OTP inline-payload exception) **and** the per-`type` PG read-set bb-comms depends
   on. Documented here; promote to a published contract package if a second consumer
   appears (ADR-0002 revisit trigger).
10. **Dev no-broker mode** — `RABBITMQ_URL` empty → still write outbox, relay logs only
    (replaces today's "log instead of send" stub).
11. **Tests** — update OTP specs to assert an outbox row is written (not `mailer.send`
    called); add outbox + relay unit tests.

### Net effect

`@bb/common` services: **−2** (whatsapp, mailer) / **+2** (outbox enqueue, rabbitmq
publisher). This repo never renders or sends a message — it writes a trigger + relays it.
bb-comms reads PG for data + owns delivery/render.
