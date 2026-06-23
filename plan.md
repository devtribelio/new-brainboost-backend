# Plan — Affiliate System (Brainboost Backend)

Blueprint implementasi sistem affiliate. Hasil reverse-engineer dari legacy
monolith `ittron` (`tribelio`/`tribeliopage`/`tribelio-admin`) + verifikasi
langsung ke prod DB MariaDB read-only + adaptasi ke schema repo current.

## Goal

Replikasi affiliate flow legacy di backend baru (Node + Express + Prisma +
Postgres) yang:

1. Mempertahankan **dua mode komisi** (`PERFORMANCE` + `GROWTH` + `INACTIVE`)
   untuk backward-compat dengan basis user existing (~670K PERFORMANCE + 16K
   GROWTH; keduanya masih aktif harian).
2. **Mobile-first attribution** via Universal Links / App Links + Apple/Google
   IAP, bukan cookie web.
3. **Tracking-grade marketing data** — setiap klik affiliate link ke-log
   lengkap (UTM, ad params, device, raw query/header). Tidak boleh silent-drop.
4. Schema disederhanakan dari legacy (25 tabel) jadi **4 tabel + augmentasi
   ke `Member`**. Single-tenant, course-only, no super-affiliate.
5. **Critical accuracy** — affiliate = duit ke pocket affiliator. Bug =
   complaint. Plan harus include reconciliation, dispute flow, dan test parity
   dengan legacy.

---

## Decisions (final)

| Topik | Keputusan |
|---|---|
| Mode commission | PERFORMANCE + GROWTH + INACTIVE |
| Default mode member baru | `PERFORMANCE` |
| GROWTH | legacy-only (untuk migrasi user existing nanti) |
| Source product | Course (single product type untuk MVP) |
| Multi-tenancy | Drop (`org_id`/`network_account_id` tidak dipakai) |
| Super affiliate, chief tier | Drop |
| Per-program rate config | Drop — semua konstanta di code |
| Attribution model | Last-touch overwrite, derived dari Visit terakhir |
| Cookie window | 30 hari (konstanta) |
| Identifier | **UUID v7** (`@default(uuid(7)) @db.Uuid`) repo-wide |
| Affiliator code param name | **`affCode`** (legacy convention) |
| Self-purchase | **Block** — affiliator beli pakai code-nya sendiri tidak dapat komisi |
| Commission timing | Immediate-PENDING saat IAP verified |
| Buffer PENDING → BALANCE | **7 hari** kalender (komunikasi marketing: "5 hari kerja") |
| Refund/void | Manual via CS, tidak ada auto-expire |
| Mobile SDK strategy (now) | **Path C: DIY full** — no SDK dependency |
| Mobile SDK strategy (future) | **Path B: Branch.io free tier** (saat MAU mendekati 10K) |
| Migrasi data legacy | Out-of-scope MVP — staging/dev only |
| Reconciliation | Daily cron + dispute flow via CS endpoint |
| Test parity | Pull 50 sample commission historical dari prod legacy |

---

## Open questions (yang masih perlu jawaban / koordinasi)

1. **Mobile readiness** — file `apple-app-site-association` & `assetlinks.json`
   sudah disiapin tim mobile? Kalau belum, kita stub dulu di nginx.
2. **Custom marketing params** — selain `utm_*`, `gclid`, `fbclid`, `ttclid`:
   confirmed gak ada (per scan DB legacy 30 hari).
3. **Recruitment flow GROWTH** — pakai `Member.inviterId` saat signup dengan
   `?affCode=arief-001`? (asumsi: yes, set inviterId = affiliator-nya, mode
   default tetap PERFORMANCE)
4. **Apa name format `Member.affiliateCode` BB baru** — generate dari
   username/email (mis. `arief-001`), full random nanoid (mis. `K4ALPLC0`),
   atau biarin user pilih?

---

## Schema design

### Konstanta (`src/modules/affiliate/constants.ts`)

```ts
// PERFORMANCE tier rates & thresholds (legacy: TBAffiliator::PERFORMANCE_SCHEMA_*)
export const PBS_TIER_RATES = [20, 30, 40] as const;     // % per tier
export const PBS_TIER2_THRESHOLD = 5_000_000;            // IDR
export const PBS_TIER3_THRESHOLD = 15_000_000;           // IDR

// GROWTH multi-level rates (legacy: TBAffiliator_Commision_CoursePayment::COMMISION_LEVEL_*)
export const GROWTH_LEVEL_RATES = [20, 10, 5, 5] as const;  // L1..L4
export const GROWTH_MAX_DEPTH = 4;

// INACTIVE (legacy: TBAffiliator::INACTIVE_COMMISION_PERCENT)
export const INACTIVE_RATE = 20;

// Attribution & status flow
export const COOKIE_DAYS = 30;
export const PENDING_TO_BALANCE_DAYS = 7;  // marketing: "5 hari kerja"
```

### Tabel 1 — `AffiliateProgram` (modify, simplify)

Definisi kampanye affiliate per produk. `code` = public reference di link.

```prisma
model AffiliateProgram {
  id          String   @id @default(uuid(7)) @db.Uuid
  legacyId    Int?     @unique
  productId   String?  @db.Uuid
  code        String   @unique          // "K4ALPLC0"
  name        String
  isActive    Boolean  @default(true)
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt

  product     Product?              @relation(fields: [productId], references: [id])
  affiliators MemberAffiliator[]
  commissions AffiliateCommission[]
  visits      AffiliateVisit[]

  @@map("affiliate_programs")
}
```

**Drop dari schema sekarang**: `networkId`, `categoryId`, `pbsCommissionType`,
`pbsAff1/2/3`, `commissionType`, `commissionAmount`.

### Tabel 2 — `MemberAffiliator` (modify, simplify)

Enrollment — "Member X resmi promote program Y."

```prisma
model MemberAffiliator {
  id         String    @id @default(uuid(7)) @db.Uuid
  legacyId   Int?      @unique
  memberId   String    @db.Uuid
  programId  String    @db.Uuid
  exitState  String?               // "KICK" | "LEAVE" | null
  exitAt     DateTime?
  isActive   Boolean   @default(true)
  createdAt  DateTime  @default(now())
  updatedAt  DateTime  @updatedAt

  member  Member           @relation(fields: [memberId], references: [id], onDelete: Cascade)
  program AffiliateProgram @relation(fields: [programId], references: [id], onDelete: Cascade)

  @@unique([memberId, programId])
  @@index([programId])
  @@map("member_affiliators")
}
```

**Drop**: `fbPixelId`, `ttPixelId`, `requestId`.

### Tabel 3 — `AffiliateCommission` (modify, restructure)

Ledger komisi. 1 row per (payment, recipient, level).

```prisma
model AffiliateCommission {
  id              String   @id @default(uuid(7)) @db.Uuid
  legacyId        Int?     @unique
  recipientId     String   @db.Uuid
  affiliatorId    String?  @db.Uuid
  programId       String?  @db.Uuid
  productId       String?  @db.Uuid
  paymentId       String?  @db.Uuid
  paymentLegacyId Int?
  buyerMemberId   String?  @db.Uuid
  level           Int      @default(1)            // 1 utk PERFORMANCE/INACTIVE; 1-4 utk GROWTH
  affiliateBased  String                          // snapshot: "PERFORMANCE" | "GROWTH" | "INACTIVE"
  schemaType      String?                         // "SCHEMA_1" | "SCHEMA_2" | "SCHEMA_3"
  productPrice    Int      @default(0)
  voucherAmount   Int      @default(0)
  commissionRate  Int                             // % yang dipakai (20/30/40/10/5)
  amount          Int      @default(0)            // priceRecipient
  status          String   @default("PENDING")    // "PENDING" | "BALANCE" | "VOIDED"
  approvedAt      DateTime?
  voidedAt        DateTime?
  voidedBy        String?  @db.Uuid               // admin id (CS) yang void
  voidedReason    String?
  source          String?                         // "DEEPLINK" | "WEB" | "INSTALL_REFERRER"
  attributionVisitId String? @db.Uuid             // FK ke AffiliateVisit yg jadi sumber attribution
  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt

  recipient  Member            @relation("AffiliateCommissionRecipient", fields: [recipientId], references: [id], onDelete: Cascade)
  affiliator MemberAffiliator? @relation(fields: [affiliatorId], references: [id])
  program    AffiliateProgram? @relation(fields: [programId], references: [id])
  product    Product?          @relation(fields: [productId], references: [id])

  @@unique([paymentId, recipientId, level], name: "uniq_payment_recipient_level")
  @@index([recipientId, createdAt])
  @@index([programId])
  @@index([buyerMemberId])
  @@index([status])
  @@map("affiliate_commissions")
}
```

**Drop**: `commissionType`, `commissionAmount`, `feePercent`, `feeAmount`,
`isPending`, `isExpired`, `isSuper`. **Tambah**: `paymentId`, `buyerMemberId`,
`affiliateBased`, `schemaType`, `commissionRate`, `voucherAmount`, `status`,
`approvedAt`, `voidedAt`, `voidedBy`, `voidedReason`, `source`,
`attributionVisitId`.

### Tabel 4 — `AffiliateVisit` (NEW)

Setiap klik affiliate link. Marketing tracking + sumber attribution.

```prisma
model AffiliateVisit {
  id                 String   @id @default(uuid(7)) @db.Uuid
  programId          String   @db.Uuid
  affiliatorMemberId String   @db.Uuid
  memberId           String?  @db.Uuid
  // marketing
  utmSource          String?
  utmMedium          String?
  utmCampaign        String?
  utmContent         String?
  utmTerm            String?
  adId               String?
  adNetwork          String?  // "google" | "meta" | "tiktok"
  // device
  ipAddress          String?
  userAgent          String?
  referer            String?
  deviceId           String?
  platform           String?  // "ios" | "android" | "web"
  appVersion         String?
  installReferrer    String?  // Android Play Store install referrer
  // raw escape-hatch
  rawQueryString     String?
  rawHeaders         Json?
  // idempotency
  clientEventId      String?  @unique
  createdAt          DateTime @default(now())

  program    AffiliateProgram @relation(fields: [programId], references: [id])
  affiliator Member           @relation("AffiliateVisitAffiliator", fields: [affiliatorMemberId], references: [id])

  @@index([programId, createdAt])
  @@index([affiliatorMemberId, createdAt])
  @@index([memberId])
  @@index([adId])
  @@index([utmCampaign])
  @@map("affiliate_visits")
}
```

### Augmentasi `Member`

Field existing yang dipakai: `affiliateCode`, `inviterId`, `inviterNetworkId`,
`registerFrom`, `utmSource`, `utmContent`.

**Tambah:**

```prisma
model Member {
  // ... existing fields (semua jadi @db.Uuid setelah migrasi)

  affiliateBased String  @default("PERFORMANCE")  // "PERFORMANCE" | "GROWTH" | "INACTIVE"

  // Self-relation untuk GROWTH upline chain
  inviter  Member?  @relation("MemberInviter", fields: [inviterId], references: [id])
  invitees Member[] @relation("MemberInviter")

  // Affiliate relations
  affiliateCommissions AffiliateCommission[] @relation("AffiliateCommissionRecipient")
  affiliateVisits      AffiliateVisit[]      @relation("AffiliateVisitAffiliator")
  memberAffiliators    MemberAffiliator[]
}
```

### Tabel yang DI-DROP

| Tabel | Alasan |
|---|---|
| `CommissionEntry` (placeholder lama) | Duplikat `AffiliateCommission` |
| `AffiliateProgramCategory` | BB MVP gak butuh kategorisasi |
| `AffiliateRequest` | Auto-enroll, gak perlu approval flow |

---

## Code format & generation

Format `code` di-confirm dari prod legacy (691,880 member affiliator codes
sampled).

| Field | Format | Charset | Sample |
|---|---|---|---|
| `Member.affiliateCode` | **6-char** | `[A-Z0-9]` (uppercase alphanumeric, 36 chars) | `DFEW49`, `KFELYF`, `OENB3Y` |
| `AffiliateProgram.code` | **8-char** | `[A-Z0-9]` (uppercase alphanumeric, 36 chars) | `K4ALPLC0`, `HN7QW35T`, `BA496V3T` |

**Beda panjang sengaja** — 6 char untuk affiliator vs 8 char untuk program biar
mudah di-distinguish secara visual + technically validate.

### Collision math
- 6-char: 36^6 = 2.17 billion combinations
- 8-char: 36^8 = 2.8 trillion combinations
- Untuk skala BB, collision probability negligible. Tetap pakai retry-on-conflict via DB unique constraint.

### Generator implementation

```ts
// src/modules/affiliate/utils/code-generator.ts
import { customAlphabet } from "nanoid";

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";  // 36 chars

export const generateAffiliatorCode = customAlphabet(ALPHABET, 6);
export const generateProgramCode    = customAlphabet(ALPHABET, 8);
```

### Service-layer with retry

```ts
async function assignAffiliatorCode(memberId: string): Promise<string> {
  for (let i = 0; i < 3; i++) {
    const code = generateAffiliatorCode();
    try {
      await prisma.member.update({
        where: { id: memberId },
        data: { affiliateCode: code }
      });
      return code;
    } catch (e) {
      if (isPrismaUniqueViolation(e)) continue;  // retry on collision
      throw e;
    }
  }
  throw new Error("Could not generate unique affiliate code after 3 retries");
}
```

Pattern sama untuk `AffiliateProgram.code` saat create program.

### Validation di schema-level (optional)

Tambahkan constraint bisa via Postgres CHECK:

```sql
ALTER TABLE members ADD CONSTRAINT affiliate_code_format
  CHECK (affiliate_code IS NULL OR affiliate_code ~ '^[A-Z0-9]{6}$');

ALTER TABLE affiliate_programs ADD CONSTRAINT code_format
  CHECK (code ~ '^[A-Z0-9]{8}$');
```

Or skip schema constraint dan andalin di app-level (Prisma bisa add `@db.VarChar(6)` untuk length lock).

---

## UUID v7 migration (repo-wide)

Sebelum touch affiliate, **migrasi semua model dari `cuid()` ke
`uuid(7) @db.Uuid`**.

### Pola

```diff
- id String @id @default(cuid())
+ id String @id @default(uuid(7)) @db.Uuid

- xxxId String
+ xxxId String @db.Uuid
```

### Scope
- 37 model dengan `@default(cuid())`
- ~35-40 FK column dapat tambahan `@db.Uuid`
- Field non-FK string (email, code, name, dll) tidak berubah

### Risk
- `prisma db push --accept-data-loss` (drop & recreate, aman karena DB kosong)
- Test fixtures hardcoded cuid → ganti
- Frontend/mobile yang nyimpen id format cuid → notify (panjang & format
  berubah)

---

## Mobile attribution flow (Path C — DIY full)

### Format link

```
https://brainboost.com/p/{program_code}?affCode={affiliator_code}&utm_source=...&utm_campaign=...
```

Contoh:
```
https://brainboost.com/p/K4ALPLC0?affCode=arief-001&utm_source=meta&utm_campaign=mar26&fbclid=...
```

### Flow lengkap (best case — app sudah ke-install)

```
1. Affiliator share link
2. Buyer klik di WA/IG/dll
   → Universal Link (iOS) / App Link (Android) route ke BB app
3. App parse URL → POST /v1/affiliate/visits (log)
4. Buyer login → app POST /v1/affiliate/attribution (re-log dengan memberId)
5. Buyer trigger IAP → Apple/Google handle payment
6. App POST receipt ke /v1/payments/iap-verify
7. Backend validate receipt → create Payment row
8. Commission engine:
   a. Cari Visit terakhir (memberId, programId) within COOKIE_DAYS
   b. Self-purchase guard: kalau buyer === affiliator → skip + log
   c. Generate AffiliateCommission rows (PERFORMANCE/GROWTH/INACTIVE)
9. Status: PENDING → auto-promote ke BALANCE setelah 7 hari (cron)
```

### Flow user belum install (deferred deep link)

**Android:** Google Play Install Referrer API (gratis, native, official). App
baca referrer string saat first launch → ekstrak `affCode` & `program`.
Akurasi ~90%.

**iOS multi-layer:**

| Teknik | Tangkap kasus | Akurasi |
|---|---|---|
| Universal Links | User udah install + klik link | ~40% klik |
| Pasteboard handoff (web set clipboard → app read on first launch) | User install dari klik | ~30-40% |
| AdServices Framework (iOS 14.3+) | Khusus Apple Search Ads | ~5% |
| IP/UA fingerprint match (backend probabilistic, 10-min window) | Fallback | ~50% kasus |

Combined coverage iOS: ~70-80%. Sisanya `affiliate.attribution_miss` di log.

### Implementasi DIY — komponen yang harus dibikin

1. **Smart link generator** (backend)
   - `GET /p/:code` — landing page (web), Universal Link route (mobile)
   - Set Open Graph metadata untuk preview di sosmed
   - Capture click → log ke `AffiliateVisit`

2. **Web fallback page** (di `/p/:code`)
   - Detect device → tombol App Store / Play Store
   - Set browser cookie `affCode` (web flow backup)
   - Pasteboard handoff: write affiliator info to clipboard before redirect ke App Store
   - Capture UTM/ad params + log via `/v1/affiliate/visits`

3. **Static assets di nginx**
   - `/.well-known/apple-app-site-association` (untuk iOS Universal Link)
   - `/.well-known/assetlinks.json` (untuk Android App Link)
   - File dari tim mobile — backend cuma serve static

4. **Backend matching service**
   - `POST /v1/affiliate/visits` — selalu return 200, log error internal
   - Postback dari Android Install Referrer (saat app first launch)
   - Postback dari iOS pasteboard read (saat app first launch)
   - Probabilistic match: pakai `ipAddress + userAgent + createdAt window` untuk reconcile pre-install vs post-install visits

### Future migration ke Path B (Branch.io free tier)

Saat MAU approaching 10K, migrate untuk dapat akurasi iOS 90%+. Branch.io free
under 10K MAU. Cliff effect di 10,001 MAU = $5/1K MAU charged ke seluruh
basis.

Migration nanti:
- Replace mobile SDK code dengan Branch.io
- Backend `/v1/affiliate/visits` tetap dipakai sebagai reconciliation endpoint
- Branch postback → trigger commission engine
- ~1 minggu effort migration

---

## API endpoints

### Mobile-facing

| Method | Path | Auth | Tujuan |
|---|---|---|---|
| `POST` | `/v1/affiliate/visits` | optional | Log visit. Selalu return 200, error log internal. |
| `POST` | `/v1/affiliate/attribution` | required | Bind attribution ke member yang baru login (re-log dengan memberId). |
| `GET`  | `/v1/affiliate/me` | required | Profile affiliator (mode, code, status). |
| `GET`  | `/v1/affiliate/me/summary` | required | `{lifetimeAmount, balance, pending, schemaType, nextThreshold, totalDownline}` |
| `GET`  | `/v1/affiliate/me/commissions` | required | Paginated dgn filter `status`, `from`, `to`. |
| `GET`  | `/v1/affiliate/me/downline?depth=` | required | Direct + indirect downline (untuk GROWTH). |
| `GET`  | `/v1/affiliate/programs` | required | List program tersedia. |
| `POST` | `/v1/affiliate/programs/:code/enroll` | required | Auto-enroll member ke program. |

### Public (no auth)

| Method | Path | Tujuan |
|---|---|---|
| `GET`  | `/p/:code` | Landing page web — handle deep link + redirect to app/store |
| `GET`  | `/.well-known/apple-app-site-association` | Static iOS Universal Link config |
| `GET`  | `/.well-known/assetlinks.json` | Static Android App Link config |

### Admin / CS-facing

| Method | Path | Tujuan |
|---|---|---|
| `POST` | `/v1/admin/affiliate/programs` | Create program |
| `PATCH`| `/v1/admin/affiliate/programs/:id` | Update program |
| `GET`  | `/v1/admin/affiliate/commissions` | Audit list cross-affiliator |
| `POST` | `/v1/admin/affiliate/commissions/:id/void` | Manual void komisi (refund/CS dispute) |
| `POST` | `/v1/admin/affiliate/disputes` | Investigate + create commission untuk klaim valid |
| `GET`  | `/v1/admin/affiliate/reconciliation/:date` | Daily report attribution miss / mismatch |

### Internal hooks

- `paymentService.onIAPVerified(payment)` → trigger commission engine
- `affiliateService.computeCommission(payment)` → core engine

---

## Business logic — formula

### 1. PERFORMANCE (single-level, auto-upgrade tier)

```ts
totalLifetime = sum(commission.amount where recipientId = me AND status != 'VOIDED' AND affiliateBased != 'INACTIVE')

if (totalLifetime <= PBS_TIER2_THRESHOLD)      tier = 1, rate = 20, schemaType = SCHEMA_1
else if (totalLifetime <= PBS_TIER3_THRESHOLD) tier = 2, rate = 30, schemaType = SCHEMA_2
else                                            tier = 3, rate = 40, schemaType = SCHEMA_3

amount = floor((productPrice - voucherAmount) * rate / 100)
recipients = [{ recipientId: affiliatorMemberId, level: 1, rate, amount, schemaType }]
```

### 2. GROWTH (multi-level upline chain)

```ts
chain = walkInviterChain(directAffiliatorMemberId, maxDepth=4)
chain = takeWhile(chain, m => m.affiliateBased != 'PERFORMANCE')

recipients = chain.map((member, idx) => {
  const level = idx + 1
  const rate = GROWTH_LEVEL_RATES[idx]
  const amount = floor((productPrice - voucherAmount) * rate / 100)
  return { recipientId: member.id, level, rate, amount }
})
```

### 3. INACTIVE

```ts
amount = floor((productPrice - voucherAmount) * INACTIVE_RATE / 100)
recipients = [{ recipientId: affiliatorMemberId, level: 1, rate: 20, amount }]
```

### 4. Self-purchase guard (NEW)

```ts
if (buyerMemberId === directAffiliatorMemberId) {
  log.info("commission.skipped", { reason: "self_purchase", buyerMemberId, programId })
  return  // no commission generated
}
```

### 5. Attribution resolution

```ts
const visit = await prisma.affiliateVisit.findFirst({
  where: {
    memberId: buyerMemberId,
    programId: programId,
    createdAt: { gt: now - COOKIE_DAYS_MS }
  },
  orderBy: { createdAt: "desc" }
})

if (!visit) {
  log.info("commission.skipped", { reason: "no_active_attribution", buyerMemberId, programId })
  return
}
```

### 6. Status transition (cron job)

```ts
// runs daily
await prisma.affiliateCommission.updateMany({
  where: {
    status: "PENDING",
    createdAt: { lte: now - 7_DAYS }
  },
  data: { status: "BALANCE", approvedAt: now }
})
```

---

## Tracking exactness rules

1. **`POST /v1/affiliate/visits` selalu return 200** — log error internal, gak break user UX.
2. **Idempotency optional via `clientEventId`** — UUID dari device, server `@@unique` enforce.
3. **Raw archive** — `rawQueryString` + `rawHeaders` (JSON: User-Agent, Referer, Accept-Language, X-Forwarded-For).
4. **Attribution miss logged** — saat IAP gak generate commission, log dedicated event dengan reason: `no_active_attribution` | `expired` | `self_purchase` | `affiliator_not_enrolled`.
5. **All-paths logged** — visit endpoint log semua hit, termasuk yang missing `affCode` (anonymous baseline traffic).
6. **Indexed fields** — `adId`, `utmCampaign`, `affiliatorMemberId+createdAt`, `programId+createdAt`.

---

## Reconciliation + dispute flow (safety nets)

### Daily reconciliation cron

Compare antara:
- Total IAP payments yang verified hari ini
- Total `AffiliateCommission` rows yang ke-generate hari ini
- Total visits dengan attributable members

Flag mismatch, alert ke CS + engineering:

```
Daily report 2026-05-08:
  IAP payments verified: 1,250
  Commissions generated: 1,247  ← 3 missing!
  Self-purchase skipped: 12
  No-attribution skipped: 248 (ekspektasi karena banyak buyer langsung tanpa link)
  Anomalies (eligible tapi gak ke-generate):
    - payment_id_xxx: ada attribution tapi commission engine throw
    - payment_id_yyy: ada attribution tapi recipient null
    - payment_id_zzz: timing race (visit created < 1s sebelum payment)
  → notify CS + engineering Slack
```

### Affiliator dispute flow

CS endpoint untuk handle "saya yakin user X beli pakai link saya tapi gak masuk":

```
POST /v1/admin/affiliate/disputes
Body: { affiliatorMemberId, buyerMemberId, paymentId, reason }

Flow:
1. Investigate visit log untuk (buyer, program) within last 60 days
2. Investigate buyer's attribution history
3. Cross-check: ada visit dari affiliator-claimer dalam window?
4. Decision (manual atau auto):
   - Valid → POST /v1/admin/affiliate/commissions/manual-create
   - Invalid → reject dengan reason
5. Audit log siapa yang approve/reject
```

### Audit log (semua keputusan commission)

Setiap commission generation atau skip log dengan reason yang queryable:

```ts
log.info("commission.generated", {
  paymentId, recipientId, level, amount, schemaType, attributionVisitId, affiliateBased
})
log.info("commission.skipped", {
  paymentId, reason: "self_purchase" | "no_active_attribution" | "expired" | "affiliator_not_enrolled",
  buyerMemberId, programId
})
log.info("commission.voided", {
  commissionId, voidedBy, reason
})
```

CS punya tool query log → bisa replay setiap kasus.

### Real-time affiliator notification

Setiap commission event push ke device affiliator:
- Visit (klik): "1 orang baru klik link kamu"
- Commission PENDING: "Komisi Rp X dari pembelian Y, masuk balance dalam 5 hari kerja"
- Commission BALANCE: "Komisi Rp X masuk ke balance kamu"
- Commission VOIDED: "Komisi Rp X dibatalkan: {reason}"

---

## Test parity dengan legacy

Sebelum deploy commission engine ke production, validate output identik dengan
legacy untuk 50 sample real.

### Strategi

```
Step 1 — Pull 50 sample dari prod (read-only access)
  - 20 sample PERFORMANCE (mix tier 1/2/3)
  - 20 sample GROWTH (mix level 1/2/3/4)
  - 5 sample INACTIVE
  - 5 sample edge cases (boundary, voucher, expired)

Step 2 — Untuk tiap sample, reconstruct input state
  - Payment data (price, voucher, course/bundle)
  - Member network state saat itu (parent_id, affiliate_based)
  - Program config (pbs_aff_*)
  - Lifetime sum saat itu (sum dari commission rows yg created sebelumnya)

Step 3 — Feed ke commission engine baru
  Result = computeCommission(input)

Step 4 — Compare
  legacyOutput vs Result
  - level match?
  - rate match?
  - amount match?
  - schemaType match?

Step 5 — Mismatch → bug, fix, retest
```

### Sample mismatch yang harus dicover

- Boundary tier: lifetime = 5,000,000 → tier 1 (`<=`) bukan tier 2 (`<`)
- Voucher partial: course Rp 1jt + voucher Rp 200K → komisi dari Rp 800K
- Self-purchase historical: legacy mungkin gak block (sekarang kita block — pastikan exclude dari sample)
- GROWTH chain dengan `is_expired = 1` di lifetime sum
- Mode switch: affiliator yang pernah ganti GROWTH → PERFORMANCE → exclude

---

## Execution phases

### Phase 0 — Decisions (mostly done)
- [x] Schema design lock
- [x] Path C mobile strategy
- [x] Buffer 7 hari
- [ ] Mobile readiness check (Universal Links files)

### Phase 1 — UUID(7) migration repo-wide
- [ ] Update `prisma/schema.prisma` — replace `cuid()` → `uuid(7) @db.Uuid` di 37 model
- [ ] Tambah `@db.Uuid` di FK columns
- [ ] `pnpm prisma db push --accept-data-loss` (local + staging)
- [ ] Verifikasi tipe `uuid` di `psql \d+ table_name`
- [ ] Update test fixtures yang hardcoded cuid

### Phase 2 — Affiliate schema delta
- [ ] Drop model: `CommissionEntry`, `AffiliateProgramCategory`, `AffiliateRequest`
- [ ] Modify `AffiliateProgram`: drop legacy fields
- [ ] Modify `MemberAffiliator`: drop pixel fields, requestId
- [ ] Modify `AffiliateCommission`: drop legacy flags, tambah field baru
- [ ] Add new model `AffiliateVisit`
- [ ] Augment `Member`: tambah `affiliateBased` + relation `inviter`/`invitees`
- [ ] `pnpm prisma db push --accept-data-loss`

### Phase 3 — Constants + utilities
- [ ] `src/modules/affiliate/constants.ts`
- [ ] `compute-amount.ts` — formula kanonik
- [ ] `walk-inviter-chain.ts` — recursive parent walker (Postgres CTE)

### Phase 4 — AffiliateProgram CRUD
- [ ] `affiliate-program.service.ts`
- [ ] Code generator (8-char alphanumeric uppercase)
- [ ] Admin endpoints

### Phase 5 — Member affiliator profile
- [ ] `affiliator.service.ts` — get-me, set-mode, generate `affiliateCode`
- [ ] `GET /v1/affiliate/me`

### Phase 6 — Enrollment
- [ ] `enrollment.service.ts` — auto-enroll
- [ ] `POST /v1/affiliate/programs/:code/enroll`

### Phase 7 — Visit tracking
- [ ] `visit.service.ts` — log dengan UTM parsing
- [ ] `POST /v1/affiliate/visits` — never-fail 200
- [ ] `POST /v1/affiliate/attribution` — re-log post-login

### Phase 8 — Commission engine: PERFORMANCE
- [ ] `commission.service.ts`:
  - `computePriceRecipient`
  - `getPerformanceTier` — query lifetime sum
  - `buildRecipientsPerformance`
- [ ] `paymentService.onIAPVerified()` stub
- [ ] Idempotency via @@unique
- [ ] Self-purchase guard
- [ ] Test: 3 sale di tier-1 / tier-2 boundary / tier-3 boundary

### Phase 9 — Test parity (CRITICAL)
- [ ] Script `scripts/test-commission-parity.ts`
- [ ] Pull 50 sample dari prod legacy (read-only)
- [ ] Reconstruct input state untuk tiap sample
- [ ] Run engine, compare with legacy output
- [ ] Fix mismatches sampai 100% pass
- [ ] Document edge cases ditemukan

### Phase 10 — Commission engine: GROWTH multi-level
- [ ] `walkInviterChain` (Postgres recursive CTE)
- [ ] `buildRecipientsGrowth` — chain + per-level rate
- [ ] Stop-on-PERFORMANCE rule
- [ ] Test: tree 5-level, sale di leaf → 4 commission rows

### Phase 11 — Commission engine: INACTIVE
- [ ] `buildRecipientsInactive`
- [ ] Test parity untuk mode INACTIVE

### Phase 12 — Status transition cron
- [ ] Daily cron PENDING → BALANCE setelah 7 hari
- [ ] Manual void endpoint (CS)
- [ ] Affiliator notification (PENDING/BALANCE/VOIDED events)

### Phase 13 — Reconciliation + dispute (safety net)
- [ ] Daily reconciliation cron + Slack alert
- [ ] Dispute investigation endpoint
- [ ] Manual commission create endpoint (CS approval)
- [ ] Audit log struktur

### Phase 14 — Reporting endpoints
- [ ] `GET /v1/affiliate/me/summary`
- [ ] `GET /v1/affiliate/me/commissions` (filters)
- [ ] `GET /v1/affiliate/me/downline` (GROWTH only)

### Phase 15 — Mobile attribution infra (Path C)
- [ ] Stub `GET /p/:code` web fallback page
- [ ] Static serve `apple-app-site-association` & `assetlinks.json`
- [ ] Pasteboard handoff endpoint (web set clipboard before redirect)
- [ ] Probabilistic match service (IP+UA window)
- [ ] Coordinate dengan tim mobile: deep-link routing, deferred attribution

### Phase 16 — Hardening
- [ ] Rate limiting di `/visits` (anti-bot)
- [ ] DB indexes verify via `EXPLAIN ANALYZE`
- [ ] Integration tests (vitest + supertest) untuk happy path semua mode
- [ ] Push staging, regression check

### Future (next iteration)
- [ ] Migrate ke Branch.io free tier saat MAU ~8K
- [ ] Migrasi data legacy historical (BB-only) — staging only
- [ ] Disbursement / payout flow ke balance

---

## Out of scope (eksplisit)

- Disbursement / payout flow ke balance member
- Multi-tenancy / org system
- Super affiliate, chief tier
- Affiliator program category, bulk upload assets, invitation flow
- Polymorphic productable lain (CanvasCheckout, ProductBook, ProductDigital, ProductBundle, MemberNetwork)
- Pixel auto-fire (FB/TikTok/GTM) — yang ada cuma capture parameter di `AffiliateVisit`
- A/B testing rate per program
- SDK pihak ketiga (Branch.io/AppsFlyer) — future iteration

---

## Reference legacy artifacts

| File | Fungsi |
|---|---|
| `tribelio/default/libraries/TBAffiliator.php` | Constants, `getPriceRecipient`, `getPerformanceSchemaPercent` |
| `tribelio/default/libraries/TBAffiliator/CommisionAbstract.php` | Base commission flow |
| `tribelio/default/libraries/TBAffiliator/Commision/CoursePayment.php` | Brainboost main path |
| `tribelio/default/libraries/TBModel/MemberNetwork.php::getParentTree` | Walk upline chain via `parent_id` (max 4) |
| `tribelio-admin/default/controllers/affiliate/brainboost.php` | Admin UI legacy |
| Prod tables: `affiliator_commision`, `member_product_affiliator`, `network_account_product_affiliator`, `member_network`, `log_cookie_affiliator`, `network_account_product_affiliator_visit` | Source of truth structure |

---

## Tabel summary

| Status | Tabel |
|---|---|
| Keep + simplify | `AffiliateProgram`, `MemberAffiliator`, `AffiliateCommission` |
| New | `AffiliateVisit` |
| Member field add | `affiliateBased` + relation `inviter`/`invitees` |
| Drop | `CommissionEntry`, `AffiliateProgramCategory`, `AffiliateRequest` |

**Total tabel affiliate-related: 4** (vs 6 setelah pull, vs 25 di legacy).
