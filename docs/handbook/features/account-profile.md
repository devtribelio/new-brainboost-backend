# Account, Profile & Member

[⬅ Kembali ke index](../README.md)

## Overview

Tiga modul kecil yang bersama-sama mengurus siklus hidup akun di luar login: **account** (pre-registration, logout, ganti password, hapus akun terjadwal), **profile** (lihat & ubah data profil + lokasi), dan **member** (info member untuk home screen). Registrasi & login sendiri ada di halaman [auth](auth.md).

- Kode: `apps/mobile-api/src/modules/account/`, `modules/profile/`, `modules/member/`
- Legacy asal: `controllers/account.php` + `libraries/TBMember.php` / `TBProfile.php`

## Endpoint

Prefix ketiga modul: `/api/member`.

### Account

| Method | Path | Auth | Deskripsi |
|---|---|---|---|
| POST | `/api/member/account/preRegistration` | Publik | Simpan calon member ke `pra_members` (+ `attributionContext` marketing lengkap) lalu kirim OTP — step sebelum register |
| POST | `/api/member/account/affiliateConnect` | JWT | Hubungkan member ke program affiliate |
| POST | `/api/member/account/logout` | JWT (lenient) | Revoke refresh token + lepas token FCM device; *lenient* = token expired pun tetap diterima supaya logout tak pernah gagal |
| POST | `/api/member/account/changePassword` | JWT | Ganti password (verifikasi password lama) |
| GET | `/api/member/account/getPaymentToken` | JWT | Token pembayaran (kompat mobile lama) |
| POST | `/api/member/account/requestDeleteAccount` | JWT | Minta hapus akun → kirim OTP (ke email bila ada, kalau tidak ke phone/WA) |
| POST | `/api/member/account/verificationDeleteAccount` | JWT | Verifikasi OTP → set `scheduledDeletionAt` (+ masa tunggu), `isActive=false`, revoke semua refresh token |
| POST | `/api/member/account/recoverAccountScheduled` | JWT | Batalkan penghapusan terjadwal: `scheduledDeletionAt=null`, `isActive=true` |

### Profile

| Method | Path | Auth | Deskripsi |
|---|---|---|---|
| GET | `/api/member/account/profile/info` | JWT | Detail profil member yang login |
| POST | `/api/member/account/profile/update` | JWT | Update data profil (nama, bio, avatar, gender, birthdate, **email — lihat rule #2**) |
| POST | `/api/member/account/profile/location` | JWT | Upsert alamat + relasi lokasi ke `member_profiles` |

### Member

| Method | Path | Auth | Deskripsi |
|---|---|---|---|
| GET | `/api/member/info` | Opsional | Info member + daftar community untuk home screen; tanpa token → varian publik |

## Tabel database

| Tabel | Peran di fitur ini |
|---|---|
| `members` | Sumber utama: profil ringkas, flag verifikasi, `scheduledDeletionAt`, `lastActiveAt` |
| `member_profiles` | Alamat + relasi country/province/city/district (upsert via `profile/location`) |
| `pra_members` | Baris pre-registration: email/phone + `attributionContext` (programCode, utm_*, adId, installReferrer, deviceId, …) — dibawa ke step register agar `AffiliateVisit` tercipta dengan fidelitas marketing penuh |
| `otp_codes` | OTP pre-registration & delete-account (via `OtpService`) |
| `refresh_tokens` | Direvoke saat logout / delete-account |
| `devices` | Token FCM dilepas saat logout |

## Business rules

1. **Delete account = terjadwal, bukan seketika** — verifikasi OTP men-set `scheduledDeletionAt` di masa depan dan menonaktifkan akun (semua sesi direvoke). Selama belum lewat, member bisa membatalkan via `recoverAccountScheduled`. OTP dikirim ke email bila ada; member yang daftar via phone (email NULL) menerima lewat WA — routing channel otomatis dari bentuk target.
2. **Email hanya bisa diubah selama BELUM terverifikasi** — `profile/update` menerima field `email` hanya jika `isEmailVerified=false` (dinormalisasi + cek unik); setelah verified, field itu **diabaikan diam-diam** (bukan error). Ganti email pasca-verified harus lewat flow verifikasi di auth.
3. **`pra_members` adalah pembawa attribution** — konteks marketing ditangkap sedini mungkin (sebelum akun ada) dan dipakai saat register; baris punya `expiresAt`.
4. **Dormant reactivation memicu re-KYC** — `MemberService.findById` (dipanggil tiap buka app): jika member `kycStatus=APPROVED` dan `lastActiveAt` lebih tua dari 365 hari (`REKYC_DORMANT_DAYS`), `resetKyc(reason='DORMANT_REACTIVATION')` dijalankan → status jadi EXPIRED, wajib verifikasi ulang sebelum payout berikutnya. Tanpa kolom baru, tanpa cron. Detail: [affiliate.md — KYC](affiliate.md#kyc).
5. **Logout tidak pernah gagal karena token kadaluarsa** — pakai `authGuardLenient`; tujuan utamanya membersihkan refresh token + FCM token device.

## Referensi

- Flow register + verifikasi OTP (placeholder reusable, aktivasi akun): [`docs/specs/register-verification-flow.md`](../../specs/register-verification-flow.md)
- Login/OTP/token: [auth.md](auth.md)
- Re-KYC & disbursement gate: [`docs/specs/kyc-rekyc.md`](../../specs/kyc-rekyc.md)
