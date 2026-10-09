# PRD — Web Shop: Sistem Affiliate Sama dengan App

> Web shop (brainboost-marketplace) mencatat klik link affiliate **persis seperti app**: visit atas nama member yang login, terikat produk, dan subscription dihitung sebagai satu kelompok. Cookie `bb_aff` tidak dipakai lagi untuk atribusi.
> Status: **DRAFT, belum dijadwalkan.** Jangan dieksekusi sebelum diputuskan. Backlog: project **BB**, prefix `[FE]` / `[BE]`, label `web-affiliate`.
> Dokumen terkait: `docs/prd-subscription-affiliate-link.md`, `docs/affiliate-link-contract.md`.
> Tanggal: 9 Okt 2026.

---

## 1. Masalah

Web shop **tidak punya mekanisme affiliate apa pun** (diverifikasi di commit `18c9c47`):
- tidak membaca `?affCode=`;
- tidak memanggil `POST /member/affiliate/visits`;
- checkout hanya mengirim `productId` + `voucherCode`;
- form daftar tidak mengisi `affiliateCode`, walaupun API-nya sudah menerima field itu (`services/auth.api.ts:129`).

Satu-satunya jalan sementara adalah link browser `GET /member/affiliate/link/...`, yang mengandalkan **cookie** `bb_aff`. Cookie ini:
- **tidak terikat produk**, sehingga aturan web berbeda dari app;
- **tidak terikat akun**, sehingga klik kode sendiri jarang terdeteksi;
- **rawan cookie stuffing**: situs penipu bisa memaksa browser korban membuka link affiliate, lalu cookie-nya mengambil komisi atas pembelian korban sampai 365 hari ke depan.

## 2. Tujuan
Perilaku web **identik dengan app**. Aturan atribusinya sama, endpoint-nya sama, hasilnya sama.

## 3. Alur (cermin dari app)

| # | App (referensi) | Web |
|---|---|---|
| 1 | Link dibuka → simpan `affCode` + produk. Link tanpa produk tidak dipakai untuk komisi (`appsflyer_service.dart:255-285`) | Baca `?affCode=` + produk dari URL, simpan per sesi browser. Aturan sama |
| 2 | Belum login → simpan juga sebagai kode referral, arahkan ke halaman daftar dengan kode terisi dan terkunci | Sama: `/register` dengan kode terisi dan terkunci |
| 3 | Daftar lewat Google → kirim `affiliateCode` saat login sosial (`token_cubit.dart:393`) | Sama di login Google web |
| 4 | Setelah login/daftar → buka produk dari link | Redirect ke `/product/<kode>` yang tersimpan |
| 5 | Halaman produk dibuka → `POST /member/affiliate/visits` (bearer, `affiliatorCode`, `productCode`, `clientEventId`), lalu **langsung hapus** kode (`product_detail_page.dart:257-285`) | Sama persis. Dipasang di samping `useVisitTracker` yang sudah ada |
| 6 | Checkout tidak membawa kode affiliate | ✅ Sudah sama |
| 7 | Buka app tanpa login → sisa kode sesi lama dibuang | Simpan per sesi browser (hilang saat tab ditutup) |

Yang memang berbeda karena platform: tidak ada deferred deep link (tidak relevan di web), dan antrean offline diganti `fetch` dengan `keepalive` + satu kali retry memakai `clientEventId` yang sama.

## 4. Pola yang sudah ada di web (untuk ditiru)
- Penangkapan parameter URL: `features/attribution/attribution.ts`, `client.ts` (untuk UTM).
- Visit di halaman produk: `features/attribution/useVisitTracker.ts`, dipanggil di `ProductDetail.tsx:103`.
- Kirim ulang setelah login: `postVisitClaim()` di `features/auth/context/AuthProvider.tsx:82`.
- Kirim tanpa mengganggu sesi: `fireAndForget` di `services/attribution.api.ts`.

## 5. Task

| ID | Task | Ukuran |
|---|---|---|
| FE-W1 | Tangkap `affCode` + produk dari URL, simpan per sesi browser | S |
| FE-W2 | Halaman daftar: kode referral terisi dan terkunci. Login Google mengirim `affiliateCode` | M |
| FE-W3 | Setelah login/daftar, kembali ke produk dari link | S |
| FE-W4 | Visit di halaman produk (dan halaman paket subscription, kalau sudah ada) + hapus kode setelah terkirim | S |
| FE-W5 | QA: klik → login → beli; klik → daftar → beli; klik kode sendiri; subscription pindah tier; dua link berturut-turut (klik terakhir menang) | ½ hari |
| BE-W1 | Link `GET /member/affiliate/link/...` jadi **redirect saja** ke `<shop>/product/<kode>?affCode=<kode>`, tanpa visit anonim dan tanpa cookie | S |
| BE-W2 | Checkout tidak lagi membaca cookie `bb_aff` (cookie lama habis sendirinya) | S |

**Total:** FE ± 1,5–2 hari (± 1 hari dengan coding agent). BE ± ½ hari termasuk test.

**Urutan rilis wajib:** FE-W1 s.d. FE-W4 harus live **sebelum** BE-W1/BE-W2. Kalau terbalik, klik dari browser tidak tercatat sama sekali selama jeda itu.

## 6. Keamanan & fraud

**Tidak lebih rawan dari app**, karena:
- endpoint visit sudah terbuka untuk siapa saja yang punya token login, termasuk lewat app;
- `memberId` visit hanya diambil dari token login (`affiliate.controller.ts:232`), jadi tidak bisa dibuat atas nama orang lain;
- marketplace memasang `X-Frame-Options: SAMEORIGIN` + `frame-ancestors 'self'`, jadi halaman produk tidak bisa disisipkan diam-diam di situs lain.

**Menghapus cookie justru menutup celah terbesar di web,** yaitu cookie stuffing.

**Yang tetap rawan, sama di app dan web:** pembeli memasang kode akun keduanya sendiri. Contohnya membeli PREMIUM lewat link akun kedua, sehingga komisi Rp 1,1 juta menjadi diskon untuk dirinya sendiri. Pengaman yang diusulkan (terpisah dari PRD ini):
1. Tolak komisi kalau pembeli dan affiliator memakai rekening bank atau KTP yang sama (cek saat komisi dibuat atau saat penarikan).
2. Masa tahan komisi subscription lebih panjang dari 7 hari.
3. Laporan anomali di backoffice: komisi affiliator didominasi satu atau dua pembeli, atau pembelian beberapa detik setelah klik dari IP yang sama dengan affiliator.

## 7. Di luar scope
- Halaman pilihan paket subscription di web (FE-1 di `prd-subscription-affiliate-link.md`). Halaman ini dibutuhkan terlepas dari PRD ini.
- Tombol "Bagikan" untuk affiliator di web (opsional, bisa memakai `affiliateLinkUrl`).
- Pengaman fraud di §6 butir 1–3.
