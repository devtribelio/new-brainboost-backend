# Kontrak API — Link Affiliate & Subscription

Untuk dev **mobile (brainboost-apps)** dan **web (brainboost-marketplace)**.
Backend: branch `feat/batch-juli-jalur-a` (belum deploy). PRD: `docs/prd-subscription-affiliate-link.md`.
Tanggal: 9 Okt 2026.

---

## 0. Ringkasan untuk FE

| | Mobile | Web |
|---|---|---|
| Wajib dikerjakan sekarang | §5 (3 task) | **Tidak ada.** Web parity dijadwalkan terpisah (`docs/prd-web-affiliate-parity.md`) |
| Endpoint baru | Tidak ada. Tetap `POST /member/affiliate/visits` | — |
| Field baru | `affiliateLinkUrl` di respons share | — |
| Nilai baru | `productCode: "subscription"` | — |

**Tidak ada breaking change.** Semua field lama tetap ada dengan arti yang sama.

---

## 1. Aturan atribusi (yang bisa diandalkan FE)

1. Komisi ditentukan dari **visit** (klik link affiliate) yang tercatat atas nama **member yang login**. Checkout **tidak** membawa kode affiliate.
2. **Per produk:** klik link produk A hanya berlaku untuk pembelian produk A.
3. **Subscription = satu kelompok:** klik pada plan subscription **mana pun** (atau ref `subscription`) berlaku untuk pembelian **tier mana pun** (SOLO/DUO/FAMILY/PREMIUM). Klik kursus tidak berlaku untuk subscription, dan sebaliknya.
4. **Klik terakhir menang**, berlaku 365 hari (`app_settings.affiliate.cookieDays`).
5. **Klik kode sendiri diabaikan.**
6. Tidak ada visit → komisi ke **inviter** pembeli (kalau ada).
7. Rate subscription: **40%** pembelian pertama, **10%** renewal dan pindah tier. Pembeli yang pernah membayar subscription (termasuk yang langganannya sudah expired) dihitung renewal. Pembelian yang direfund dan langganan gratis (grant) tidak dihitung.

---

## 2. `POST /api/member/affiliate/visits` — catat klik (SUDAH ADA)

Dipanggil app saat halaman produk dibuka dari link affiliate. **Tidak berubah**, kecuali `productCode` sekarang juga menerima `"subscription"`.

**Auth:** `Authorization: Bearer <token>` **wajib dikirim kalau user login.** Visit tanpa bearer tercatat anonim dan **tidak pernah** dipakai untuk komisi.

**Request**
```http
POST /api/member/affiliate/visits
Authorization: Bearer <member token>
Content-Type: application/json

{
  "affiliatorCode": "AFF123",
  "productCode": "KURSUS01",
  "clientEventId": "6f1c2a9e-0b7d-4c55-9a3e-2d8f1e4b7a10",
  "deviceId": "3b2e...",
  "platform": "android",
  "appVersion": "3.3.4"
}
```

| Field | Wajib | Keterangan |
|---|---|---|
| `affiliatorCode` | ya | Kode affiliate 6 karakter. Alias: `affCode`, `aff`, query `?affCode=` |
| `productCode` | ya, untuk komisi | `legacyId` \| `code` \| `slug` produk, **atau `"subscription"`**. Tanpa ini, visit tidak menghasilkan komisi |
| `clientEventId` | disarankan | UUID per klik. Dipakai untuk **retry yang sama**; kirim ulang dengan id yang sama = tidak dihitung dua kali. Klik baru = id baru |
| `programCode` | tidak | Kode program 8 karakter |
| `utmSource` `utmMedium` `utmCampaign` `utmContent` `utmTerm` `adId` `adNetwork` | tidak | Atribusi marketing |
| `deviceId` `platform` `appVersion` `installReferrer` | tidak | Diagnostik. `deviceId`/`platform`/`appVersion` juga diterima dari header `x-device-id` / `x-platform` / `x-app-version` |

**Response — selalu HTTP 200**, juga saat input salah, supaya iklan dan link tidak pernah rusak:
```json
{ "success": true, "data": { "status": "logged", "visitId": "0192..." }, "meta": null, "error": null }
```

| `status` | Arti | Tindakan app |
|---|---|---|
| `logged` | Visit tercatat | Selesai |
| `duplicate` | `clientEventId` sudah pernah tercatat | Selesai (retry yang berhasil) |
| `skipped` | `reason: "self"` → kode milik user sendiri | Selesai, jangan retry |
| `invalid` | Kode affiliate atau program tidak dikenal (`reason`) | Selesai, jangan retry |
| `error` | Error internal | Boleh retry dengan `clientEventId` yang sama |

### Subscription
```json
{ "affiliatorCode": "AFF123", "productCode": "subscription", "clientEventId": "…" }
```
Visit disimpan pada plan default (plan aktif dengan seat paling sedikit). Pembelian **tier apa pun** setelahnya diatribusikan ke `AFF123`. Mengirim kode plan tertentu (mis. kode produk FAMILY) juga berlaku untuk semua tier.

---

## 3. `POST /api/member/product/course/share` — buat link share (FIELD BARU)

**Auth:** bearer wajib.

**Request**
```json
{ "code": "KURSUS01" }
```
`code` = kode produk, **atau `"subscription"`** untuk link subscription (respons `GET /subscription/plans` tidak membawa kode produk, jadi pakai nilai ini).

**Response**
```json
{
  "success": true,
  "data": {
    "code": "KURSUS01",
    "shareUrl": "https://…/p/kursus-01?affCode=AFF123",
    "affiliateLinkUrl": "https://brainboost.id/api/member/affiliate/link/AFF123/KURSUS01"
  }
}
```

| Field | Keterangan |
|---|---|
| `code` | Kode produk. Untuk `"subscription"` berisi kode plan default |
| `shareUrl` | **Tidak berubah** (lama) |
| `affiliateLinkUrl` | **Baru.** Link yang bisa diklik di browser (§4). `null` kalau user tidak punya kode affiliate. Untuk produk subscription selalu berakhiran `/subscription` |

---

## 4. `GET /api/member/affiliate/link/:affCode/:product` — link untuk browser (BARU)

Bukan untuk dipanggil oleh kode app. Ini **link yang diklik orang** di browser (desktop, WhatsApp Web) atau dipakai sebagai fallback web OneLink (`af_web_dp`).

```
https://<shop-host>/api/member/affiliate/link/<affCode>/<product>[?utm_source=…]
```
- `<shop-host>` = `app_settings['shop.baseUrl']` (prod `https://brainboost.id`). **Harus lewat host shop**, bukan host API.
- `<product>` = `legacyId` | `code` | `slug`, atau `subscription`.

**Respons selalu redirect 302**, tidak pernah halaman error:

| Kondisi | Visit | Cookie `bb_aff` | Redirect ke |
|---|---|---|---|
| Kode + produk valid | dicatat (anonim) | dipasang | `<shop>/product/<code>` |
| `subscription` | dicatat pada plan default | dipasang | halaman produk plan default (sampai web punya halaman paket) |
| Kode tidak dikenal | tidak | tidak | `<shop>/product/<code>` |
| Produk tidak dikenal | dicatat tanpa produk | dipasang | `<shop>/products` |
| Bot / preview (WhatsApp, Telegram, Slack, crawler) | tidak | tidak | seperti biasa |
| Lebih dari 60 klik/menit per IP | tidak | tidak | seperti biasa |

---

## 5. Task mobile

### M-1. Tambah `af_web_dp` ke OneLink
`lib/shared/function/appsflyer_helper.dart` → `generateOneLinkUrl`: kalau **`productCode` dan `affCode` keduanya ada**, tambahkan
```
af_web_dp=<url-encode(affiliateLinkUrl)>
```
Parameter lain tidak berubah (`deep_link_value`, `deep_link_sub1`, `deep_link_sub2`, `product`, `affCode`). Ambil `affiliateLinkUrl` dari endpoint share (§3), atau bangun sendiri dengan pola §4.

| Diklik di | Hasil |
|---|---|
| Desktop | Ke `af_web_dp`: visit + cookie, lalu halaman produk di shop |
| HP tanpa app | Store → deferred deep link → app mencatat visit (tidak berubah) |
| HP dengan app | App terbuka (tidak berubah) |

### M-2. OneLink subscription
- Bentuk link: `https://brainboost.onelink.me/ZL18/links?deep_link_value=product&deep_link_sub1=subscription&deep_link_sub2=<affCode>&product=subscription&affCode=<affCode>&af_web_dp=<url-encode(…/link/<affCode>/subscription)>`
- Saat dibuka dengan `product=subscription`: buka **layar pilihan paket**, bukan halaman detail produk.
- Catat visit di layar itu seperti halaman produk, memakai `recordAffiliateVisit` dengan `productCode: "subscription"`. Hapus kode affiliate setelah dikirim, sama seperti sekarang.

### M-3. Tombol share di layar subscription
Panggil `POST /member/product/course/share` dengan `{ "code": "subscription" }`, lalu buat OneLink sesuai M-2.

---

## 6. Web (brainboost-marketplace)

**Tidak ada yang perlu dikerjakan sekarang.** Link §4 sudah bekerja tanpa perubahan web, karena marketplace me-rewrite `/api/:path*` ke backend.

Rencana menyamakan web dengan app (web mencatat visit atas nama member yang login, tanpa cookie) ada di `docs/prd-web-affiliate-parity.md`. **Belum dijadwalkan.**

---

## 7. Batasan yang diketahui

- **Visit dari link §4 anonim.** Di web, yang mengatribusikan pembelian adalah **cookie** `bb_aff`, yang dibaca checkout untuk **produk apa pun**. Jadi aturan per produk (§1.2) belum berlaku untuk klik dari browser sampai web parity selesai.
- **Klik kode sendiri dari browser** hanya terdeteksi kalau ada bearer valid, yang biasanya tidak ada pada klik link biasa.
- **Link §4 harus lewat host shop.** Kalau dibuka langsung di host API, cookie menempel di host API dan tidak terbaca checkout web.
- **App versi lama** yang tidak mengirim `productCode` tidak menghasilkan komisi lewat visit.
