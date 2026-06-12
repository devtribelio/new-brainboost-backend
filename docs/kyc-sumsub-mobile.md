# KYC Sumsub — Panduan Integrasi Mobile FE

Dokumen untuk tim mobile. Backend reference: `docs/kyc-sumsub.md`.

KYC dipakai sebagai **gate pencairan komisi affiliate** (disbursement). Verifikasi
identitas (KTP + selfie/liveness) dijalankan oleh **Sumsub MobileSDK** di dalam app —
FE **tidak** lagi upload foto KTP/selfie ke backend sendiri.

## Ringkasan flow

```
1. App minta token  : POST /api/member/affiliate/me/kyc/token   (bearer JWT member)
2. App launch SDK   : Sumsub MobileSDK dengan accessToken dari step 1
3. User foto KTP + selfie di dalam SDK → SDK upload langsung ke Sumsub
4. Sumsub review (sandbox: instan; prod: menit–jam)
5. Backend terima webhook → kycStatus member berubah otomatis
6. App cek hasil    : GET /api/member/affiliate/me/kyc  (polling / on-resume)
```

FE TIDAK pernah memanggil API Sumsub langsung dan TIDAK pernah memegang app
token/secret Sumsub. Satu-satunya kontak dengan Sumsub adalah lewat SDK + access token.

## Endpoint

Semua response pakai envelope standar `{ success, data, meta, error }`.

### 1. `POST /api/member/affiliate/me/kyc/token` — mulai/lanjut sesi KYC

Auth: `Authorization: Bearer <jwt>`. Body: kosong.

```json
// 200
{
  "success": true,
  "data": {
    "token": "sbx:abcdef....",        // access token SDK, umur pendek (default 600 detik)
    "applicantId": "63abc...",         // id applicant Sumsub milik member ini
    "kycStatus": "NONE"                // status SAAT token diterbitkan
  }
}
```

Errors:

| HTTP | `error.message` | Arti / aksi FE |
|---|---|---|
| 400 | `KYC sudah disetujui` | Member sudah APPROVED — jangan tampilkan tombol KYC |
| 400 | `KYC provider not configured` | Env backend belum diisi (dev) — tampilkan error generik |
| 401 | — | Token JWT invalid/expired |

Idempotent: panggil berulang aman. Applicant dibuat sekali; panggilan berikutnya hanya
menerbitkan token baru. Status `REJECTED` tetap boleh minta token (re-submit — kecuali
Sumsub menolak FINAL, SDK yang akan menampilkan pesannya).

### 2. `GET /api/member/affiliate/me/kyc` — status KYC

Auth: bearer. Tidak berubah dari versi manual, field sama:

```json
{
  "success": true,
  "data": {
    "kycStatus": "PENDING",            // NONE | PENDING | APPROVED | REJECTED
    "kycIdNumber": null,               // hanya terisi di flow manual lama
    "kycIdCardUrl": null,              // idem
    "kycSelfieUrl": null,              // idem
    "kycSubmittedAt": "2026-06-12T09:00:00.000Z",
    "kycReviewedAt": null,
    "kycRejectedReason": null          // terisi saat REJECTED, mis. "RETRY: BAD_PROOF_OF_IDENTITY"
  }
}
```

### 3. `GET /api/member/affiliate/me/disbursement` — gate pencairan

Sudah ada sebelumnya; `kycStatus` ikut di response. `eligible` baru `true` kalau
`kycStatus === "APPROVED"` + rekening bank terisi + saldo cukup + tidak ada
withdrawal pending. `reason` berisi pesan siap-tampil (mis. `"KYC belum disetujui"`).

## Integrasi SDK

Install (pilih sesuai stack):

- React Native: `@sumsub/react-native-mobilesdk-module`
- Android native: `com.sumsub.sns:idensic-mobile-sdk`
- iOS native: pod `IdensicMobileSDK`

Dokumen resmi: https://docs.sumsub.com/docs/get-started-with-mobile-sdk

Contoh React Native:

```ts
import SNSMobileSDK from '@sumsub/react-native-mobilesdk-module';

async function fetchKycToken(): Promise<string> {
  const res = await api.post('/api/member/affiliate/me/kyc/token'); // axios/fetch wrapper ber-auth
  return res.data.data.token;
}

async function startKyc() {
  const token = await fetchKycToken();

  const sdk = SNSMobileSDK.init(token, fetchKycToken) // arg ke-2 = token refresh handler, WAJIB:
    .withHandlers({                                    // dipanggil SDK saat token expired (umur 600s)
      onStatusChanged: (event) => {
        // event.newStatus: 'Pending' | 'Approved' | 'FinallyRejected' | 'TemporarilyDeclined' | ...
      },
    })
    .withLocale('id')
    .build();

  const result = await sdk.launch();
  // result.success === user menyelesaikan flow SDK; status FINAL tetap dari backend (webhook),
  // jadi setelah SDK tutup → refresh GET /affiliate/me/kyc
}
```

Catatan wajib:

- **Token refresh handler harus diimplement** (param kedua `init`). Token umurnya
  600 detik; sesi foto-foto bisa lebih lama dari itu.
- **Jangan simpan token** — minta baru tiap launch.
- **Status dari SDK ≠ sumber kebenaran.** SDK event cuma untuk UX (loading/selesai).
  Status final selalu dari `GET /affiliate/me/kyc` (diisi webhook backend).

## State → UI mapping

| `kycStatus` | UI |
|---|---|
| `NONE` | Tampilkan CTA "Verifikasi identitas" → `startKyc()` |
| `PENDING` | "Sedang ditinjau" — disable CTA. Refresh saat screen resume / pull-to-refresh. Review bisa menit–jam, **jangan** poll agresif (interval ≥30 detik kalau perlu polling di screen aktif) |
| `APPROVED` | Badge verified; menu pencairan terbuka (cek `eligible` dari endpoint disbursement) |
| `REJECTED` | Tampilkan `kycRejectedReason` + CTA "Coba lagi" → `startKyc()` lagi (applicant sama, Sumsub tahu riwayatnya). Kalau Sumsub menolak FINAL, SDK sendiri yang menampilkan blokirnya |

Format `kycRejectedReason`: `"<RETRY|FINAL>: <LABEL1>, <LABEL2>"` — label adalah konstanta
Sumsub (mis. `BAD_PROOF_OF_IDENTITY`, `BLURRED_DOCUMENT`). Mapping label → copy Indonesia
silakan di sisi FE; tampilkan raw label kalau tidak dikenal.

## Transisi dari flow manual

- `POST /api/member/affiliate/me/kyc` (manual: idNumber + URL foto) **masih hidup** sebagai
  fallback, tapi flow baru JANGAN dipakai dari app — gunakan Sumsub.
- Screen upload KTP/selfie lama bisa dihapus setelah Sumsub live.
- Field `kycIdNumber`/`kycIdCardUrl`/`kycSelfieUrl` di `GET /kyc` akan `null` untuk member
  yang lewat Sumsub — jangan dirender sebagai data wajib.

## Environment

| | Backend | Catatan FE |
|---|---|---|
| Sandbox | token dari backend dev/staging | Dokumen dummy diterima; review bisa disimulasi dari dashboard Sumsub |
| Production | token dari backend prod | Tidak ada perubahan kode FE — token menentukan environment |

FE tidak perlu config Sumsub apa pun selain install SDK. Environment ditentukan
sepenuhnya oleh access token yang diberikan backend.
