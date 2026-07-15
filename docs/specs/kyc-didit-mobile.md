# KYC Didit — Handoff Integrasi Mobile/FE

Audience: **tim mobile/FE**. Backend reference: `docs/specs/kyc-didit.md`.
Status backend: code complete; tinggal Console setup + creds (lihat §10).

KYC = **gate pencairan komisi affiliate** (disbursement). Member harus `APPROVED` sebelum
boleh menarik saldo. Verifikasi identitas (KTP + selfie/liveness) dijalankan oleh **Didit SDK**
di dalam app — FE **tidak** upload foto KTP/selfie ke backend sendiri (flow manual lama hanya
fallback admin).

> **Provider note:** KYC pindah dari **Sumsub → Didit** (2026-06-26). Kalau FE sempat mulai
> integrasi Sumsub, lihat **§9 Migrasi** — yang berubah cuma SDK + bentuk response
> `/kyc/token`. Path endpoint sama.

---

## 1. Gambaran flow

```
1. App minta sesi   : POST /api/member/affiliate/me/kyc/token   (bearer JWT member)
2. App launch SDK   : DiditSdk.startVerification(sessionToken)   (token dari step 1)
3. User foto KTP + selfie + liveness di dalam SDK → SDK kirim langsung ke Didit
4. Didit review (umumnya near-instant; tetap perlakukan ASYNC)
5. Backend terima webhook Didit → kycStatus member berubah otomatis
6. App cek hasil    : GET /api/member/affiliate/me/kyc   (polling / on-resume)
7. Kalau APPROVED   : menu pencairan terbuka (cek GET /affiliate/me/disbursement)
```

Prinsip penting:
- **FE tidak pernah** memanggil API Didit langsung, tidak pernah memegang API key / webhook secret.
- **Status final selalu dari backend** (`GET /kyc`), bukan dari event SDK. Event SDK hanya untuk UX.
- Semua response pakai envelope standar: `{ "success": boolean, "data": ..., "meta": ..., "error": ... }`.

---

## 2. `POST /api/member/affiliate/me/kyc/token` — mulai sesi KYC

Auth: `Authorization: Bearer <jwt>`. Body: **kosong**.

**200**
```json
{
  "success": true,
  "data": {
    "sessionId": "9f2c1e7a-...",                   // id sesi Didit (disimpan backend; dipakai webhook)
    "sessionToken": "<session-token>",             // token 12-char untuk SDK (placeholder)
    "url": "https://verification.didit.me/s/...",  // URL hosted (fallback webview)
    "kycStatus": "NONE"                             // status SAAT sesi dibuat
  },
  "meta": null,
  "error": null
}
```

**Error**
| HTTP | `error.message` | Arti / aksi FE |
|---|---|---|
| 400 | `KYC sudah disetujui` | Member sudah `APPROVED` — sembunyikan tombol verifikasi |
| 400 | `Saldo belum mencukupi untuk verifikasi KYC` | Saldo (withdrawable) belum capai minimum buat mulai KYC. Sembunyikan/disable tombol verifikasi sampai saldo cukup; arahkan user kumpulin komisi dulu |
| 400 | `KYC provider not configured` | Env backend belum diisi (biasanya dev) — tampilkan error generik |
| 401 | — | JWT invalid/expired → refresh token / re-login |

Catatan: tiap panggil = **sesi baru** (Didit session-per-attempt). Status `REJECTED`/`EXPIRED`
**boleh** minta sesi baru (itulah cara re-submit / re-KYC).

---

## 3. `GET /api/member/affiliate/me/kyc` — status KYC (sumber kebenaran)

Auth: bearer.

**200**
```json
{
  "success": true,
  "data": {
    "kycStatus": "PENDING",        // NONE | PENDING | APPROVED | REJECTED | EXPIRED
    "kycIdNumber": null,           // hanya terisi di flow manual lama (Didit → null)
    "kycIdCardUrl": null,          // idem
    "kycSelfieUrl": null,          // idem
    "kycSubmittedAt": "2026-06-26T09:00:00.000Z",
    "kycReviewedAt": null,
    "kycRejectedReason": null,     // terisi saat REJECTED (alasan dari Didit decision)
    "kycMinBalance": 55000,        // saldo (withdrawable) minimal IDR buat boleh mulai KYC (0 = gate mati)
    "isEligible": false            // boleh mulai KYC sekarang? = kycStatus != APPROVED && withdrawableBalance >= kycMinBalance
  }
}
```

FE menjadikan endpoint ini **satu-satunya** acuan status. Field `kycIdNumber`/`kycIdCardUrl`/
`kycSelfieUrl` akan `null` untuk member yang lewat Didit — jangan dirender sebagai data wajib.

**Gunakan `isEligible` buat enable/disable CTA "Verifikasi"** — kalau `false` karena saldo
kurang, FE bisa kasih hint (mis. "kumpulin komisi dulu"; saldo terkini ada di
`GET /affiliate/me/disbursement → withdrawableBalance`). Mencegah user kena `400` saat tap.

---

## 4. `GET /api/member/affiliate/me/disbursement` — gate pencairan

Auth: bearer. Endpoint pencairan yang sudah ada; `kycStatus` ikut di sini.

**200 (potongan relevan)**
```json
{
  "success": true,
  "data": {
    "withdrawableBalance": 50000,
    "eligible": false,
    "reason": "KYC belum disetujui",   // pesan siap-tampil saat tidak eligible
    "fee": 5000,
    "netAmount": 45000,
    "kycStatus": "PENDING",
    "hasBankAccount": true,
    "hasPendingDisbursement": false,
    "pendingDisbursement": null
  }
}
```

`eligible` baru `true` kalau **`kycStatus === "APPROVED"` + rekening bank terisi + saldo cukup +
tidak ada withdrawal pending**. Saat `EXPIRED`, `reason` = `"KYC perlu diperbarui"`.

---

## 5. Integrasi SDK

Install (pilih sesuai stack app):

| Stack | Package |
|---|---|
| Flutter | `didit_sdk` (pub.dev) |
| React Native | `@didit-protocol/sdk-react-native` |
| iOS / Android native | SDK native Didit |

Docs resmi: https://docs.didit.me/integration/native-sdks

**Flutter**
```dart
import 'package:didit_sdk/didit_sdk.dart';

Future<String> fetchSessionToken() async {
  final res = await api.post('/api/member/affiliate/me/kyc/token'); // wrapper ber-auth
  return res.data['data']['sessionToken'] as String;
}

Future<void> startKyc() async {
  final sessionToken = await fetchSessionToken();
  await DiditSdk.startVerification(sessionToken);
  // SDK tutup = user selesai. Status FINAL tetap dari backend → refresh GET /kyc.
  await refreshKycStatus();
}
```

**React Native** (pola sama)
```ts
import { DiditSdk } from '@didit-protocol/sdk-react-native';

const { data } = await api.post('/api/member/affiliate/me/kyc/token');
await DiditSdk.startVerification(data.data.sessionToken);
await refreshKycStatus();
```

Aturan wajib:
- **Status SDK ≠ kebenaran.** Setelah SDK tutup, selalu `GET /kyc`.
- **Jangan simpan/cache `sessionToken`** — minta sesi baru tiap mulai verifikasi.

### Fallback webview (tanpa SDK native)
Buka `data.url` di in-app browser. Supaya user balik ke app setelah selesai, backend set
`DIDIT_CALLBACK_URL` ke deep link app (mis. `brainboost://kyc/done`). FE handle deep link itu →
tutup webview → `GET /kyc`. Gunakan jalur ini hanya kalau SDK native belum siap (UX di bawah SDK).

---

## 6. State → UI mapping

| `kycStatus` | UI / aksi |
|---|---|
| `NONE` | CTA "Verifikasi identitas" → `startKyc()` |
| `PENDING` | "Sedang ditinjau", disable CTA. Refresh saat screen resume / pull-to-refresh. Kalau polling, interval **≥30 detik** |
| `APPROVED` | Badge verified; buka menu pencairan (cek `eligible` dari §4) |
| `REJECTED` | Tampilkan `kycRejectedReason` + CTA "Coba lagi" → `startKyc()` (sesi baru) |
| `EXPIRED` | KYC dicabut oleh event risiko (ganti rekening / pencairan besar / lama tidak aktif / flag admin). Tampilkan "Verifikasi ulang diperlukan" + CTA → `startKyc()` (sesi baru) |

`EXPIRED` itu **status baru** dibanding flow lama — FE wajib menangani (jangan dianggap sama
dengan `REJECTED`; copy-nya beda: "perlu verifikasi ulang", bukan "ditolak").

---

## 7. Strategi polling / refresh status

Verifikasi Didit umumnya cepat tapi **asinkron** (digerakkan webhook). Rekomendasi:
1. Setelah SDK tutup → langsung `GET /kyc` sekali.
2. Kalau masih `PENDING`, refresh **on screen-resume / pull-to-refresh**. Hindari polling agresif.
3. Kalau butuh polling di screen aktif: interval **≥30 detik**, stop saat status final
   (`APPROVED`/`REJECTED`) atau saat user keluar screen.
4. Tidak ada push real-time ke FE untuk status KYC (webhook itu Didit→backend). Andalkan poll/resume.

---

## 8. Sandbox / testing

- Environment ditentukan **sepenuhnya oleh sesi dari backend** — FE tidak set config Didit apa pun selain install SDK.
- Sandbox: pakai backend dev/staging; dokumen dummy diterima; hasil bisa disimulasi dari Console Didit.
- Production: tidak ada perubahan kode FE — sesi yang menentukan environment.

---

## 9. Migrasi dari integrasi Sumsub (kalau sudah sempat dibuat)

| Hal | Sumsub (lama) | Didit (baru) |
|---|---|---|
| Endpoint mulai | `POST /affiliate/me/kyc/token` | **sama** |
| Response | `{ token, applicantId, kycStatus }` | `{ sessionId, sessionToken, url, kycStatus }` |
| SDK | `@sumsub/react-native-mobilesdk-module` | `didit_sdk` (Flutter) / `@didit-protocol/sdk-react-native` |
| Launch | `SNSMobileSDK.init(token, refreshFn)…launch()` | `DiditSdk.startVerification(sessionToken)` |
| Token refresh handler | wajib (token 600s) | **tidak perlu** |
| `GET /kyc` | sama | **sama** (tambah nilai `EXPIRED`) |
| `kycRejectedReason` | `"RETRY: BAD_PROOF..."` | string alasan dari Didit (format bebas) |

Yang harus FE ganti: ① package SDK, ② baca `sessionToken` (bukan `token`) + cara launch,
③ hapus token-refresh handler, ④ tangani status `EXPIRED`.

---

## 10. Checklist FE

- [ ] Install Didit SDK sesuai stack (`didit_sdk` Flutter / RN).
- [ ] Tombol "Verifikasi identitas" → `POST /kyc/token` → `DiditSdk.startVerification(sessionToken)`.
- [ ] Setelah SDK tutup → `GET /kyc` (+ refresh on-resume).
- [ ] Render state machine §6 termasuk **`EXPIRED`** dan **`REJECTED` + alasan**.
- [ ] Gate menu pencairan ke `eligible` / `kycStatus === "APPROVED"` (§4).
- [ ] (Opsional) deep link `DIDIT_CALLBACK_URL` untuk fallback webview.
- [ ] Hapus screen upload KTP/selfie manual lama setelah Didit live.

Blocker backend (FE bisa mulai pakai stub/sandbox lebih dulu): Didit Console workflow + creds,
konfirmasi free-tier. Lihat `docs/specs/kyc-didit.md` §Outstanding.
