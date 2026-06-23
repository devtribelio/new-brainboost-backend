# Affiliate Attribution — Plan & Mobile Sync

Status snapshot, open questions to mobile, and backend implementation plan
for the post-install affiliate flow (AppsFlyer deferred deeplink → pre-reg →
register → permanent inviter + 1-year visit).

Last updated: 2026-06-04 (Pendekatan C implemented — uncommitted in working tree).

---

## 1. Status snapshot

### 1.1 Sudah selesai (deployed atau in-PR)

| Item | Status | Reference |
|---|---|---|
| Backend register baca `PraMember.affiliateMemberId` sebagai fallback → set `Member.inviterId` PERMANENT | ✅ PR ready | branch `feat/auth-prereg-affiliate-carryover`, commit `362995d` |
| **Pendekatan C — `PraMember.attributionContext` JSONB column** | ✅ Implemented (uncommitted) | `prisma/schema.prisma` + migration `20260604000000_pramember_attribution_context` |
| **Pendekatan C — `PreRegistrationDto` +12 optional attribution fields** | ✅ Implemented (uncommitted) | `apps/mobile-api/src/modules/account/dto/pre-registration.dto.ts` |
| **Pendekatan C — preReg bundles attribution → `attributionContext`** | ✅ Implemented (uncommitted) | `apps/mobile-api/src/modules/account/account.service.ts` |
| **Pendekatan C — register creates `AffiliateVisit` (best-effort, §3.5 fallback)** | ✅ Implemented (uncommitted) | `apps/mobile-api/src/modules/auth/auth.service.ts` + `packages/domain/src/affiliate/visit.service.ts::createVisitFromRegistration` |
| **Pendekatan C — 4 integration test cases (§3.6)** | ✅ **PASSING** (4/4, ~7s, real Postgres @ 5433) | `apps/mobile-api/tests/auth-prereg-affiliate-carryover.spec.ts` |
| `commerce_payments.accepted_amount` pakai `takehome_percentage` dari RC (single source of truth) | ✅ Merged | branch `feat/rc-capture-store-commission` |
| Affiliate commission base = `acceptedAmount` (net), bukan `amount` (gross) | ✅ Merged | sama dengan di atas |
| Raw RC payload persisted ke `commerce_payments.log_request` | ✅ Merged | sama dengan di atas |

### 1.1b Status blockers Pendekatan C

| Item | Status | Catatan |
|---|---|---|
| Migration applied | ✅ Done (2026-06-04) | `prisma migrate deploy` → applied `20260604000000_pramember_attribution_context` ke `bb_backend` @ `localhost:5433`. Hanya migration ini yang pending (35 lainnya sudah ada). **Staging/prod belum** — apply via `migrate deploy` saat deploy. |
| Integration tests | ✅ **4/4 PASSING** | Run dengan `set -a && . ./.env && set +a && pnpm test auth-prereg-affiliate-carryover`. Vitest tidak auto-load `.env` → harus di-source manual (setup.ts default `5433/bb` salah; .env yang benar `5433/bb_backend`). |
| Test path bug (fixed) | ✅ Fixed | Spec awalnya hit `/api/account/preRegistration` → 404. Path asli `**/api/member/account/preRegistration**` (account module `prefix:'/member'`). Doc lama (§1.2) tulis shorthand `/api/account/...`. |
| `ipAddress`/`userAgent` di register-flow visit | ⏳ Open (non-blocker) | Di-hardcode `null` — register controller tidak forward `req.ip`/`user-agent`. UTM/adId/platform/appVersion/installReferrer tetap ke-capture. Optional: thread headers dari `auth.controller.ts`. |

### 1.2 Existing endpoints yang sudah jalan

| Endpoint | Tujuan | Status |
|---|---|---|
| `POST /api/account/preRegistration` | Pre-register dengan OTP, accept `affiliateCode` opsional | ✅ |
| `POST /api/account/affiliateConnect` | Bind `Member.inviterId` PERMANENT post-login (idempotent) | ✅ |
| `POST /api/member/auth/register` | Register final, accept `affiliateCode` (+ PraMember carry-over after PR merge) | ✅ |
| `POST /api/affiliate/visit` | Log click event → AffiliateVisit row, anonymous OK | ✅ |
| `POST /api/affiliate/attribution` | Bind AffiliateVisit ke logged-in member | ✅ |

---

## 2. Open questions — perlu konfirmasi dari mobile

Sebelum implement Pendekatan C, dua hal yang perlu mobile confirm:

### Q1 — OneLink generator design

**Status:** ⏳ Awaiting mobile confirmation.

OneLink URL untuk share-app harus selalu carry **dua** param:

```
https://brainboost.app/r?aff={affiliateCode}&program={programCode}
```

- `aff` (mandatory) — affiliateCode dari Member yang sharing
- `program` (mandatory) — programCode dari AffiliateProgram yang aktif

**Yang perlu di-confirm:**

- Apakah marketing/affiliator dashboard saat ini sudah generate URL dengan **kedua param**?
- Atau OneLink template masih cuma include `aff` saja?
- Kalau cuma `aff` → mobile perlu update generator template + backend fallback (pilih program kalau affiliator cuma enrolled di 1 program; skip visit creation kalau ambiguous).

**Default plan kalau gak ada konfirmasi:** Backend implement fallback "1-program → auto-pick" untuk graceful degradation.

### Q2 — Confirm pemahaman 3 scenario endpoint usage

**Status:** ⏳ Awaiting mobile confirmation.

Sebelum kerjain Pendekatan C, perlu sync dulu apakah codebase mobile saat ini routing semua skenario ke endpoint yang benar:

| Scenario | Endpoint yang benar | Tujuan |
|---|---|---|
| **A** — New user via share-app deeplink (deferred deeplink → install) | `POST /api/account/preRegistration` dengan full context (Pendekatan C) | inviterId PERMANENT + AffiliateVisit 1-tahun, di-set sekaligus |
| **B** — Organic-install user yang nanti dapet share-app link | `POST /api/account/affiliateConnect` | inviterId PERMANENT (idempotent) |
| **C** — Existing user klik link **produk** | `POST /api/affiliate/visit` atau `/api/affiliate/attribution` | AffiliateVisit 1-tahun sliding |

**Yang perlu di-confirm:**

- Mobile note sebelumnya bilang "pertahankan `/affiliateConnect` untuk product link click" — kemungkinan **conflate** Scenario B dan C.
- Untuk Scenario C, **bukan** `/affiliateConnect`, harus `/affiliate/visit` atau `/affiliate/attribution`. `/affiliateConnect` cuma set permanent inviter, idempotent — kalau user udah punya inviterId, gak akan create AffiliateVisit untuk produk affiliator B.
- Action item mobile: audit codebase, pastikan method untuk product link click routing ke `/affiliate/visit`, bukan `/affiliateConnect`.

### Q3 — Apakah mobile sudah punya semua field di proposed payload?

**Status:** ✅ Confirmed by mobile (di message terakhir).

Mobile confirm udah capture full payload dari AppsFlyer:

```json
{
  "affiliateCode": "ABC12345",
  "programCode": "PROG2025",
  "utmSource": "facebook",
  "utmMedium": "social",
  "utmCampaign": "tahun-baru-2026",
  "utmContent": "story-ad-1",
  "utmTerm": "kelas-online",
  "adId": "1234567890",
  "adNetwork": "meta",
  "installReferrer": "utm_source=facebook&utm_medium=social&...",
  "deviceId": "abc123-device-uuid",
  "platform": "ios",
  "appVersion": "1.2.3"
}
```

→ Backend tinggal accept field-field tsb di `PreRegistrationDto`.

---

## 3. Backend implementation plan — Pendekatan C

**Goal:** mobile cukup kirim full attribution context **sekali** di pre-reg →
backend chain ke register flow → set `Member.inviterId` PERMANENT + create
`AffiliateVisit` row (1-tahun) sekaligus, atomic, zero race window.

**Estimate:** 40-60 baris production code + migration + 1-2 integration tests.

### 3.1 Schema change

```prisma
model PraMember {
  // existing fields ...
  
  /// JSON payload of full attribution context captured at pre-registration:
  /// programCode, utm_*, adId, adNetwork, installReferrer, deviceId, platform,
  /// appVersion. Carried to register so `AffiliateVisit` can be created with
  /// full marketing fidelity tied to the new Member.id.
  attributionContext Json?    @map("attribution_context")
}
```

Migration: 1 nullable JSONB column tambahan ke `pra_members`. Safe, backward
compat, gak butuh data backfill.

### 3.2 DTO extension

`apps/mobile-api/src/modules/account/dto/pre-registration.dto.ts`:

Tambah field-field optional matching mobile payload:

- `programCode?: string`
- `utmSource?: string`, `utmMedium?: string`, `utmCampaign?: string`, `utmContent?: string`, `utmTerm?: string`
- `adId?: string`, `adNetwork?: string`
- `installReferrer?: string`
- `deviceId?: string`, `platform?: string`, `appVersion?: string`

Semua optional — backward compat untuk caller yang gak kirim field-field ini.

### 3.3 Pre-registration service change

`apps/mobile-api/src/modules/account/account.service.ts::preRegistration`:

- Kalau ada field-field di atas → bundle jadi JSON object → simpan di `PraMember.attributionContext`
- Kalau gak ada → behavior persis seperti sekarang (only `affiliateMemberId` + `networkId` di-store)

### 3.4 Register flow change

`apps/mobile-api/src/modules/auth/auth.service.ts::register`:

- Setelah carry-over `inviterId` dari PraMember (logic yang sudah di-merge), TAMBAH:
  - Kalau `PraMember.attributionContext` ada AND `inviterId` resolved → create `AffiliateVisit` row dengan:
    - `memberId` = new Member.id
    - `affiliatorMemberId` = resolved inviterId (sama dengan Member.inviterId)
    - `programId` = resolve dari `attributionContext.programCode` via `AffiliateProgram.code` lookup
    - `utm_*`, `adId`, `adNetwork`, `installReferrer`, `deviceId`, `platform`, `appVersion` = dari attributionContext
    - `ipAddress`, `userAgent` = dari request headers
- Best-effort — kalau create gagal (mis. programCode invalid), log warning tapi jangan abort register. Permanent inviter tetep di-set.

### 3.5 Fallback untuk Q1 (kalau programCode missing)

- Kalau `attributionContext.programCode` kosong tapi `affiliatorMemberId` ada:
  - Lookup `MemberAffiliator` untuk affiliator tsb
  - Kalau active enrollment count == 1 → pakai program tsb (auto-pick)
  - Kalau count > 1 → ambiguous, skip visit creation, log info
  - Kalau count == 0 → skip visit creation

### 3.6 Test plan

- Extend `apps/mobile-api/tests/auth-prereg-affiliate-carryover.spec.ts`:
  - Test case: pre-reg dengan full context (programCode + UTM) → register → assert AffiliateVisit row created with binding ke Member.id
  - Test case: pre-reg tanpa context (cuma affiliateCode) → register → assert AffiliateVisit **tidak** dibuat, tapi inviterId tetep set (no regression)
  - Test case: pre-reg dengan affiliateCode tanpa programCode + affiliator enrolled di 1 program → assert visit created dengan program tsb (fallback)
  - Test case: pre-reg dengan affiliateCode tanpa programCode + affiliator enrolled di multiple program → assert no visit created, inviterId tetep set

---

## 4. Out of scope (logged untuk future work)

### 4.1 Rate-limit di `/api/account/preRegistration`

Saat ini endpoint **tidak punya** rate-limit middleware. Mobile-only flow
seharusnya gak abuse, tapi kalau endpoint exposed ke web/public → spam risk.

**Recommendation:** tambah `rateLimitPerIp({ windowMs: 60_000, max: 10 })`
untuk preRegistration. Tracked sebagai future task — non-blocker.

### 4.2 PraMember TTL cleanup cron

PraMember rows dengan `expiresAt < now` gak ada cleanup automation.
Numpuk pelan-pelan. Bukan immediate concern, tapi perlu cron / job
nanti.

**Recommendation:** scheduled task / Postgres LISTEN-based cleanup. Backlog.

### 4.3 Device-based anti-fraud dedup

`PraMember.device` Json column ada di schema, gak dipakai untuk
dedup atau fraud detection. Self-farming komisi (1 device bikin
multiple referral akun) saat ini gak ke-block.

**Recommendation:** kalau ada signal bisnis bahwa self-farming jadi
masalah, implement device fingerprint dedup window (mis. max 3
PraMember per device per 24 jam).

### 4.4 Backfill `accepted_amount` untuk row RC lama

Sebelum fix `takehome_percentage` deploy, rows RC punya
`accepted_amount` salah (mirror gross atau hasil formula buggy).

**Recommendation:** backfill manual hanya kalau ada concern audit /
reconciliation. Saat ini `accepted_amount` cuma reporting field, gak
ada konsumer di read path. Bisa di-skip.

---

## 5. Critical reminders untuk mobile

Hal-hal yang mobile **harus** aware setelah Pendekatan C deploy:

1. **Field naming consistency** — payload di `/preRegistration` pakai
   camelCase: `affiliateCode`, `programCode`, `utmSource`, etc. Bukan
   snake_case.

2. **Single source of truth — Pendekatan C menggantikan sebagian
   `/affiliateConnect`** untuk Scenario A (new user via deeplink).
   Setelah deploy, mobile **stop** call `/affiliateConnect` di flow
   share-app-deeplink-install. Tapi tetap pakai untuk Scenario B
   (organic-install user yang nanti dapet referral).

3. **`/affiliate/visit` vs `/affiliateConnect`** — dua endpoint
   beda semantic, jangan ke-conflate. Lihat tabel di section 2 Q2.

4. **OTP cooldown** — endpoint `/preRegistration` gak block multi-call,
   tapi `otpService.issue` punya internal cooldown. Mobile harus
   tampilkan countdown UI di re-send OTP, jangan asal re-call
   pre-reg karena PraMember row akan numpuk.

5. **PraMember TTL 15 menit** — kalau user pre-reg lalu close app
   dan resume > 15 menit kemudian, perlu re-trigger pre-reg.
   Attribution context dari row lama udah expired dan gak ke-carry.

---

## 6. Timeline

| Step | Owner | Status |
|---|---|---|
| Q1 confirmation (OneLink generator design) | Mobile | ⏳ (backend proceed dengan default fallback §3.5) |
| Q2 confirmation (endpoint routing audit) | Mobile | ✅ resolved — mobile Phase D refactor done (lihat mobile plan) |
| Schema migration + DTO extension | Backend | ✅ Done (uncommitted; migration belum applied — lihat §1.1b) |
| Service-level implementation | Backend | ✅ Done (uncommitted) |
| Integration tests | Backend | ✅ Written, ⚠️ belum di-run (test DB unreachable) |
| Code review + merge | Both | ⏳ Next — review working tree, run tests, commit |
| Mobile integration (call full payload) | Mobile | ✅ Phase A done (capture+builder); flip flag C3 pending staging deploy |
| QA end-to-end | Both | ⏳ Blocked by staging deploy + DB migration apply |

Estimasi sisa: jalankan migration + tests di env dengan DB access, code review, commit, deploy staging → flip mobile feature flag.

### Discrepancy ditemukan saat implement (PENTING untuk mobile)

- Endpoint live untuk Scenario C bukan `/affiliate/visit` (singular) seperti tertulis di plan ini — yang benar **`POST /api/affiliate/visits`** (plural, `optionalAuthGuard`) dan **`POST /api/affiliate/attribution`** (`authGuard`). Mobile Phase D sudah pakai path yang benar. Signature lengkap ada di mobile plan §"Backend Signatures Extracted".
