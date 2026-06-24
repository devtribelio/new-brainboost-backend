# Re-KYC / KYC reset design

Status: **IMPLEMENTED 2026-06-24** (pending the same Sumsub sandbox QA as the base flow).
Extends the Sumsub KYC gate (`docs/kyc-sumsub.md`).

## Implementation deviations from the original plan

- **Dormancy reuses `members.last_active_at`** (already present, bumped by
  `MemberService.findById`) instead of adding a new `lastLoginAt` column. The trigger is
  hooked in **`member.service.ts findById`** (the app-resume chokepoint) rather than in
  `auth.service login()` — `findById` already loads the member and updates `last_active_at`,
  so the previous value is the idle span. No new Member column was needed.
- **No DDL on `members`**: `kycStatus` is a free-form string, so the new `EXPIRED` value
  needs no migration; only the `kyc_event` table is created
  (`prisma/migrations/20260624110000_add_kyc_event`).
- Lifecycle audit events (`SUBMIT`/`PENDING`/`APPROVE`/`REJECT`) are also written, guarded
  by an actual status transition so Sumsub webhook replays stay idempotent.

## 1. Goal & scope

Force a previously-APPROVED affiliate to re-verify (re-KYC) before the **next disbursement**
when a risk event occurs. Four triggers (from product note):

1. Ganti rekening bank tujuan payout.
2. Aktivitas mencurigakan (fraud signal).
3. Reaktivasi akun dormant (≥1 tahun tanpa login).
4. "Checkout besar" = **pencairan (disbursement) bernilai besar** (dikonfirmasi produk
   2026-06-24), ambang **5.000.000 IDR**.

KYC di backend ini **hanya gate `requestDisbursement`** (`disbursement.service.ts:151`), bukan
gate checkout/pembelian. Jadi re-KYC = menurunkan `kycStatus` dari `APPROVED` ke state yang
ditolak gate, sampai member lolos Sumsub lagi. Tidak menghalangi aktivitas non-payout.

## 2. Design decisions (default — bisa diubah)

| # | Keputusan | Default yang dipilih | Alasan / alternatif |
|---|---|---|---|
| D1 | State setelah reset | **`kycStatus = 'EXPIRED'`** (status baru), bukan `NONE` | Mempertahankan provenance (`kycSource`, `kycReviewedAt` lama tetap terbaca via histori). Gate hanya loloskan `APPROVED`, jadi `EXPIRED` otomatis ditolak |
| D2 | Audit | **Tabel baru `kyc_event`** | AML butuh jejak: trigger, alasan, aktor, before/after. Write KYC sekarang absolut/overwrite — tidak ada histori |
| D3 | Ganti bank | Reset **hanya saat mengubah rekening yang sudah ada** (old non-null & nilai berubah); set-pertama dari `null` tidak reset | Set pertama biasanya bagian onboarding pra-payout; yang berisiko adalah pindah ke rekening lain pasca-approve. Opsi fase-2: enforce `bankAccountName` ≈ nama KYC |
| D4 | Dormansi | **Reuse `members.last_active_at`**; ambang `REKYC_DORMANT_DAYS=365`; deteksi di `MemberService.findById` (app-resume) | Tidak ada cron (rule repo) → cek on-event. Ternyata `last_active_at` sudah ada → tak perlu kolom/hook login baru |
| D5 | "Checkout besar" | **Disbursement amount ≥ `REKYC_LARGE_DISBURSEMENT_IDR` (= 5.000.000)** memicu re-KYC, hanya jika review terakhir > `REKYC_STALE_DAYS` | Dikonfirmasi produk 2026-06-24: "checkout besar" = pencairan besar. KYC = gate payout, bukan gate pembeli |
| D6 | Aktivitas mencurigakan | Method service `resetKyc(reason='SUSPICIOUS')` + aksi admin manual | Tidak ada engine fraud. Backoffice belum mulai → sediakan service-nya sekarang, wiring UI menyusul (admin EJS / backoffice) |
| D7 | Applicant Sumsub | Saat reset, panggil **Sumsub applicant reset** (atau clear `sumsubApplicantId`) | ⚠️ tanpa ini replay webhook / re-run SDK pada applicant yang masih GREEN akan auto-APPROVED tanpa verifikasi (lihat §7) |
| D8 | Disbursement in-flight | Reset **tidak** membatalkan row `PENDING`/`PROCESSING`; hanya blok request baru | Gate sudah dicek saat request; row lama sudah lolos. Pembekuan in-flight = scope terpisah |

## 3. Schema changes (`prisma/schema.prisma`)

```prisma
model Member {
  // ... existing kyc columns ...
  kycStatus   String  @default("NONE") @map("kyc_status")
  //          ^ NONE | PENDING | APPROVED | REJECTED | EXPIRED   (EXPIRED = perlu re-KYC)
  // dormansi pakai last_active_at yang SUDAH ADA — tidak ada kolom baru.
  kycEvents   KycEvent[]
}

model KycEvent {
  id          String   @id @default(uuid(7)) @db.Uuid
  memberId    String   @map("member_id") @db.Uuid
  member      Member   @relation(fields: [memberId], references: [id], onDelete: Cascade)
  type        String   // RESET | SUBMIT | APPROVE | REJECT | PENDING
  reason      String?  // BANK_CHANGE | DORMANT_REACTIVATION | LARGE_DISBURSEMENT | SUSPICIOUS | ADMIN_MANUAL
  fromStatus  String?  @map("from_status")
  toStatus    String   @map("to_status")
  actorType   String   @map("actor_type")  // SYSTEM | ADMIN | SUMSUB
  actorId     String?  @map("actor_id") @db.Uuid
  metadata    Json?    // mis. { oldBank, newBank } / { dormantDays } / { amount }
  createdAt   DateTime @default(now()) @map("created_at")

  @@index([memberId, createdAt])
  @@map("kyc_event")
}
```

Migration: `add_member_last_login_at_and_kyc_event`. `kycStatus` tetap `String` (konsisten dgn
pola repo yang pakai string-enum berkomentar, bukan Prisma enum).

## 4. State machine

```
NONE ─submit─► PENDING ─review─► APPROVED ──reset(event)──► EXPIRED
                  │                                            │
                  └──review RED──► REJECTED                    └─submit/Sumsub─► PENDING ─► APPROVED
```

- Gate `requestDisbursement`: **hanya `APPROVED` lolos.** `EXPIRED`/`REJECTED`/`PENDING`/`NONE` ditolak.
- `EXPIRED` boleh memulai ulang flow (token endpoint hanya menolak `APPROVED`).
- Reset **hanya valid dari `APPROVED`** (member yang belum pernah approved tidak perlu di-reset; idempotent no-op kalau dipanggil di state lain).

## 5. Core service: `resetKyc()`

Tambah di `packages/domain/src/affiliate/disbursement.service.ts`:

```ts
type ReKycReason = 'BANK_CHANGE' | 'DORMANT_REACTIVATION' | 'LARGE_DISBURSEMENT'
                 | 'SUSPICIOUS' | 'ADMIN_MANUAL';

async resetKyc(memberId: string, reason: ReKycReason, opts?: {
  actorType?: 'SYSTEM' | 'ADMIN'; actorId?: string; metadata?: unknown;
}): Promise<{ reset: boolean }> {
  const member = await prisma.member.findUnique({
    where: { id: memberId },
    select: { kycStatus: true, sumsubApplicantId: true },
  });
  if (!member || member.kycStatus !== 'APPROVED') return { reset: false }; // hanya reset dari APPROVED

  await prisma.$transaction(async (tx) => {
    await tx.member.update({
      where: { id: memberId },
      data: { kycStatus: 'EXPIRED', kycReviewedAt: null, kycRejectedReason: null },
      // kycSource & kycIdNumber DIPERTAHANKAN (provenance); applicant ditangani di §7
    });
    await tx.kycEvent.create({ data: {
      memberId, type: 'RESET', reason,
      fromStatus: 'APPROVED', toStatus: 'EXPIRED',
      actorType: opts?.actorType ?? 'SYSTEM', actorId: opts?.actorId ?? null,
      metadata: opts?.metadata as Prisma.InputJsonValue,
    }});
  });

  // §7 — fail-open: kalau Sumsub reset gagal, DB tetap EXPIRED (member tetap terblok, aman)
  if (member.sumsubApplicantId) await this.resetSumsubApplicant(member.sumsubApplicantId);

  logger.info({ memberId, reason }, '[kyc] re-KYC reset');
  return { reset: true };
}
```

Catatan: write KYC lain (`applySumsubReview`, `submitKyc`, `markSumsubPending`) sebaiknya **ikut
menulis `kyc_event`** supaya histori lengkap (opsional tapi disarankan di PR yang sama).

## 6. Trigger wiring

### 6.1 Ganti bank (D3) — `setBankAccount` (`disbursement.service.ts:554`)
```ts
async setBankAccount(memberId, input) {
  const prev = await prisma.member.findUnique({
    where: { id: memberId },
    select: { bankAccountNumber: true, bankCode: true, kycStatus: true },
  });
  const changed = !!prev?.bankAccountNumber &&
    (prev.bankCode !== input.bankCode || prev.bankAccountNumber !== input.bankAccountNumber);

  const updated = await prisma.member.update({ where: { id: memberId }, data: { ...input },
    select: { bankCode: true, bankAccountNumber: true, bankAccountName: true } });

  if (changed && prev?.kycStatus === 'APPROVED') {
    await this.resetKyc(memberId, 'BANK_CHANGE', {
      metadata: { from: prev.bankAccountNumber, to: input.bankAccountNumber },
    });
  }
  return updated;
}
```

### 6.2 Dormansi (D4) — di `member.service.ts findById` (DIIMPLEMENTASIKAN)
`findById` adalah chokepoint app-resume yang sudah meng-update `last_active_at`. Member
sudah ter-load, jadi `member.lastActiveAt` masih bernilai aktivitas sesi sebelumnya (di-update
setelahnya). Cek gap sebelum update:
```ts
if (member.kycStatus === 'APPROVED' && member.lastActiveAt) {
  const idleMs = Date.now() - member.lastActiveAt.getTime();
  if (idleMs > env.rekyc.dormantDays * DAY_MS) {
    await this.disbursementService.resetKyc(id, 'DORMANT_REACTIVATION',
      { metadata: { dormantDays: Math.floor(idleMs / DAY_MS) } });
  }
}
```
`MemberService` meng-inject `DisbursementService` lewat constructor default (pola DI repo).
Tidak perlu menyentuh `auth.service` maupun menambah kolom.

### 6.3 Disbursement besar (D5) — `requestDisbursement` (line 140)
Setelah `balance`/`quote` dihitung, sebelum membuat row:
```ts
if (quote.netAmount >= REKYC_LARGE_DISBURSEMENT_IDR) {
  const stale = !member.kycReviewedAt ||
    (now - member.kycReviewedAt.getTime()) > REKYC_STALE_DAYS * 86400_000;
  if (stale) {
    await this.resetKyc(memberId, 'LARGE_DISBURSEMENT', { metadata: { amount: quote.netAmount } });
    throw new BadRequestException('Pencairan besar memerlukan verifikasi KYC ulang');
  }
}
```
`member` select di `requestDisbursement` perlu tambah `kycReviewedAt`. Guard `REKYC_STALE_DAYS`
mencegah re-KYC tepat setelah approve segar.

### 6.4 Aktivitas mencurigakan (D6)
Service `resetKyc(memberId, 'SUSPICIOUS', { actorType:'ADMIN', actorId })` sudah cukup. Wiring:
- Sekarang: aksi di admin EJS (`apps/admin-ejs`) atau endpoint internal.
- Nanti: masuk modul backoffice (RBAC + audit log) saat sprint disbursement.

## 7. ⚠️ Reset applicant Sumsub (D7) — paling kritis

`applySumsubReview` (line 508) menulis `APPROVED` **absolut**. Kalau kita set `EXPIRED` tapi
applicant lama masih GREEN di Sumsub, replay webhook / re-run SDK → APPROVED lagi **tanpa
verifikasi nyata**. Reset DB saja tidak cukup.

Tambah di `packages/common/src/services/sumsub.client.ts`:
```ts
// POST /resources/applicants/{applicantId}/reset — Sumsub menghapus hasil check,
// applicant kembali ke "init" sehingga SDK run berikutnya wajib capture ulang.
export async function resetApplicant(applicantId: string): Promise<void> {
  await sumsubRequest('POST', `/resources/applicants/${encodeURIComponent(applicantId)}/reset`);
}
```
`resetSumsubApplicant` di service: panggil `resetApplicant`; kalau Sumsub tak terkonfigurasi
atau melempar, **log + lanjут** (member sudah `EXPIRED` = terblok, fail-safe). Member legacy
(`sumsubApplicantId = null`) tidak perlu reset Sumsub — re-KYC bikin applicant baru.

Pertahankan idempotency webhook: `applySumsubReview` tetap menulis absolut; setelah Sumsub reset,
event GREEN baru hanya datang setelah verifikasi ulang yang sah.

## 8. Gate & payload

- `requestDisbursement` gate tak berubah secara logika (`!== 'APPROVED'`), tapi pesan dibedakan
  untuk `EXPIRED`: `'KYC perlu diperbarui'` vs `'KYC belum disetujui'`.
- `getSummary` (line 85) sudah mengembalikan `kycStatus`; FE menampilkan banner re-KYC saat
  `EXPIRED`. Tambah field turunan opsional `needsReKyc: kycStatus === 'EXPIRED'`.
- Serializer member/affiliate yang mengekspos `kycStatus`: pastikan `EXPIRED` masuk daftar nilai
  valid (OpenAPI enum) supaya smoke test swagger tetap hijau.

## 9. Config (`packages/common/src/config/env.ts`)

```
REKYC_DORMANT_DAYS=365
REKYC_LARGE_DISBURSEMENT_IDR=5000000    # dikonfirmasi produk 2026-06-24
REKYC_STALE_DAYS=180
```
Tambahkan ke `.env.example`. Semua via `required()`/default pola env repo.

## 10. Migration & backfill

- Migrasi schema (kolom + tabel) — `pnpm prisma:migrate`.
- `lastLoginAt` backfill: set ke `createdAt` atau `NULL` (NULL = tak pernah login tercatat →
  trigger dormansi tidak menyala sampai login pertama tercatat; aman).
- Tidak ada backfill `EXPIRED` retroaktif — re-KYC hanya untuk event ke depan.

## 11. Tests (Vitest, Postgres asli — no mock DB)

- `resetKyc`: APPROVED→EXPIRED + buat `kyc_event`; no-op dari non-APPROVED; Sumsub reset gagal → tetap EXPIRED.
- Bank change: ganti rekening existing me-reset; set pertama tidak; rekening sama tidak.
- Dormansi: login dgn `lastLoginAt` > 365 hari me-reset; < 365 tidak; `lastLoginAt` selalu ter-update.
- Large disbursement: `netAmount ≥ ambang` + review stale → reset + tolak; review segar → lolos.
- Gate: `EXPIRED` ditolak `requestDisbursement`; token endpoint loloskan `EXPIRED`.
- Idempotency: replay webhook GREEN pada applicant yang sudah di-reset tidak meng-APPROVE (butuh applicant reset).
- Smoke: swagger enum `kycStatus` memuat `EXPIRED`.

## 12. File checklist

| File | Aksi | Status |
|---|---|---|
| `prisma/schema.prisma` | `kycStatus` EXPIRED (komentar), model `KycEvent` + relasi | ✅ |
| `prisma/migrations/20260624110000_add_kyc_event/` | CREATE TABLE kyc_event (no DDL members) | ✅ |
| `packages/domain/src/affiliate/disbursement.service.ts` | `ReKycReason`, `resetKyc`, hook `setBankAccount` & `requestDisbursement` (sentinel `ReKycRequiredError`), pesan gate EXPIRED, audit event di submit/pending/review | ✅ |
| `packages/common/src/services/sumsub.client.ts` | `resetApplicant` | ✅ |
| `apps/mobile-api/src/modules/member/member.service.ts` | inject `DisbursementService` + cek dormansi (reuse `last_active_at`) | ✅ |
| `packages/common/src/config/env.ts` | blok `rekyc` (3 konstanta REKYC_*) | ✅ |
| `apps/mobile-api/src/modules/affiliate/dto/affiliate-response.dto.ts` | enum `EXPIRED` (3 tempat) | ✅ |
| `apps/mobile-api/tests/affiliate/rekyc.spec.ts` | 12 test (resetKyc, bank, gate, large, dormansi) | ✅ |
| `.env.example` | blok `REKYC_*` | ⏳ belum (permission) |

## 13. Open questions (konfirmasi produk sebelum coding)

1. ~~"Checkout besar" = disbursement besar~~ — **RESOLVED (2026-06-24):** disbursement besar.
2. ~~Ambang `REKYC_LARGE_DISBURSEMENT_IDR`~~ — **RESOLVED:** 5.000.000 IDR. (`REKYC_STALE_DAYS`
   masih default 180 — konfirmasi bila perlu.)
3. Definisi "login" untuk dormansi — termasuk refresh-token silent? (default: ya, semua jalur).
4. Ganti bank: perlu enforce nama rekening ≈ nama KYC (fase 2)?
5. "Mencurigakan" — sumber sinyal otomatis apa, atau murni tombol admin (default: tombol admin)?
6. Reset perlu membekukan disbursement `PENDING` in-flight? (default D8: tidak).
</content>
</invoke>
