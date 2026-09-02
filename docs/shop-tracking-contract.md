# Shop Tracking Link — FE (shop) ↔ BE Contract

Atribusi tracking link untuk web shop (`brainboost-marketplace`): tahu siapa yang
buka, siapa yang daftar, siapa yang beli karena satu link (kasus pemicu: webinar).

Turunan dari `tracking-link-plan.md` (Product, 2026-09-02) dan PRD
`prd-attribution-tracking-shop.md`. Nama parameter mengikuti PRD.

- **Status: BE selesai, belum rilis.** Endpoint di bawah sudah ada di
  `bb-backend-new` (migration `20260902120000_shop_visit_tracking`), tapi belum
  dideploy. Aman dikode lawan kontrak ini; konfirmasi ke BE sebelum QA di staging.
- **Ditulis:** 2026-09-02.

Yang menyeberangi kabel cuma **tiga panggilan**: kunjungan naik, klaim naik,
snapshot ikut di checkout. Sisanya (cookie, shortlink, halaman laporan) berdiri
sendiri di masing-masing sisi.

---

## Alur ujung-ke-ujung

```
  Peserta klik shortlink → /product/{code}?utm_source=webinar&utm_campaign=sep26&voucher=WEBINAR20
        │
  [FE]  │ 1. proxy.ts: simpan utm ke cookie bb_attr (30 hari, last-touch)
        │    buat cookie bb_gid (UUID tamu, 30 hari) kalau belum ada
        │
  [FE]  │ 2. halaman produk: POST /api/shop/visits          ──► shop_visits
        │
        │ 3. klik Beli → belum login → register / login / Google
        │
  [FE]  │ 4. sesudah auth SUKSES: POST /api/shop/visits/claim ──► shop_visits.member_id
        │
  [FE]  │ 5. checkout: POST /api/member/product/checkout/submit
        │       + snapshot cookie                            ──► commerce_transactions.utm_* (BEKU)
        │
  [BE]  │ 6. webhook Xendit → PAID. Laporan Sumber Traffic dihitung dari order.
```

---

## Dasar

- Base URL sama dengan API mobile. Envelope standar `{ success, data, meta, error }` —
  lihat `docs/api-envelope.md`.
- Semua nilai UTM dikirim **apa adanya** dari URL. Backend tidak menormalkan,
  tidak lowercase, tidak validasi isinya.
- Panjang tiap field UTM dipotong di 255 karakter. Lebih dari itu dipotong, bukan ditolak.

---

## 1. `POST /api/shop/visits` — catat kunjungan

**Publik. Tanpa `Authorization`.** Boleh dipanggil tamu.

### Request

```jsonc
{
  "guestId": "0190a4d1-....",   // WAJIB — isi cookie bb_gid
  "productCode": "BB-XYZ",      // opsional — legacyId (angka) | code | slug
  "utmSource": "webinar",       // opsional
  "utmMedium": "email",         // opsional
  "utmCampaign": "sep26",       // opsional
  "utmContent": "banner-a",     // opsional
  "utmTerm": "kelas-online",    // opsional
  "referer": "https://t.co/...",// opsional
  "clientEventId": "0190a4d2-..." // opsional — lihat di bawah
}
```

### Response — **selalu 200**

```jsonc
{ "success": true, "data": { "status": "logged" }, "meta": null, "error": null }
```

`status` salah satu:

| Nilai | Arti | Tindakan FE |
|---|---|---|
| `logged` | baris tercatat | — |
| `duplicate` | `clientEventId` sudah pernah masuk | — |
| `invalid` | payload tak terpakai (mis. `guestId` kosong) | — |
| `error` | gagal internal | — |

**FE tidak perlu bereaksi ke nilai manapun.** Endpoint ini tidak boleh memblokir
render halaman produk: panggil fire-and-forget, jangan `await` di jalur render,
jangan tampilkan error ke user.

### Aturan yang dijamin backend

- **Tidak pernah 4xx/5xx.** Link marketing yang menjawab error = kunjungan hilang.
  Parameter ngawur, `productCode` tak dikenal, UTM aneh — semua tetap 200.
- `productCode` tak dikenal → baris tetap ditulis dengan `product_id = null`.
- Rate limit per IP. Kena limit tetap 200 (`status: "error"`), bukan 429.
- User-Agent bot yang dikenali tidak ditulis (preview WhatsApp/Slack, pemindai email).

### `clientEventId` diisi apa

UUID v4 yang **FE bikin sendiri**, satu per percobaan-kirim, **dipakai ulang saat retry**.

```ts
const eventId = useRef(crypto.randomUUID());
await postVisit({ ...payload, clientEventId: eventId.current }); // retry: id sama
```

Yang di-dedupe adalah **retry**, bukan kunjungan:

- request timeout tapi row sudah masuk → kirim ulang id sama → `duplicate`, tak nambah baris.
- React StrictMode / `useEffect` jalan dua kali → satu baris.
- user refresh halaman, atau buka lagi besok → **id baru, baris baru**. Memang harus
  begitu: metrik "Kunjungan" hitung semua baris, "Pengunjung unik" hitung distinct `guestId`.

Jangan bikin deterministik (`hash(guestId+productId+utm)`) — itu bikin satu tamu
selamanya cuma punya satu kunjungan dan angka Kunjungan runtuh jadi sama dengan
Pengunjung unik.

Boleh dikosongkan. Konsekuensinya retry berpotensi dobel-hitung.

---

## 2. `POST /api/shop/visits/claim` — ikat kunjungan ke akun

**Butuh `Authorization: Bearer <access_token>`.**

Panggil **sekali, sesudah auth berhasil, lewat jalur apapun** — register email,
login password, atau Google. Ini yang membuat pendaftar Google tidak jatuh ke
bucket `direct`.

### Request

```jsonc
{ "guestId": "0190a4d1-...." }   // isi cookie bb_gid, jangan dihapus setelah login
```

### Response

```jsonc
{ "success": true, "data": { "claimed": 3 }, "meta": null, "error": null }
```

`claimed` = jumlah baris kunjungan yang baru saja terikat ke member ini.
`0` itu normal (tamu belum pernah tercatat, atau sudah pernah klaim).

Efek: `shop_visits.member_id` diisi untuk baris `guestId` tersebut yang masih
kosong, dalam window 30 hari terakhir. Baris yang sudah punya `member_id`
tidak disentuh.

Aman dipanggil berulang (idempoten).

---

## 3. `POST /api/member/product/checkout/submit` — snapshot sumber

Endpoint **yang sudah ada**, ditambah field. Perubahan aditif — klien lama tidak rusak.

### Field baru di request (semua opsional)

```jsonc
{
  "productId": "0190....",       // sudah ada
  "voucherCode": "WEBINAR20",    // sudah ada
  "affiliatorCode": "P6W0W0",    // sudah ada — jalur komisi, JANGAN diisi dari utm

  "guestId": "0190a4d1-....",    // BARU — cookie bb_gid
  "utmSource": "webinar",        // BARU — snapshot cookie bb_attr
  "utmMedium": "email",          // BARU
  "utmCampaign": "sep26",        // BARU
  "utmContent": "banner-a",      // BARU
  "utmTerm": "kelas-online"      // BARU
}
```

Response tidak berubah.

Aturan:

- Kirim **snapshot cookie `bb_attr` apa adanya** saat submit. Jangan diolah,
  jangan diisi `"direct"` — kosong ya kosong. Backend simpan NULL dan merender
  `direct` di laporan; kalau FE menulis `"direct"`, backend tak bisa membedakan
  "FE lupa kirim" dari "benar-benar tanpa sumber".
- Nilai ini **dibekukan di order** dan tidak pernah diperbarui. Alasannya cookie
  bersifat last-touch: kalau laporan menjoin lewat `guestId`, order webinar bisa
  pindah ke kampanye lain secara retroaktif begitu user klik iklan berikutnya.
- **UTM tidak pernah menyentuh perhitungan komisi.** Jalur komisi tetap
  `affiliatorCode` + `affiliate_visits`. Dua mekanisme ini berjalan paralel dan
  tidak boleh digabung.
- Parameter ngawur tidak boleh menggagalkan checkout.

---

## 4. Register + login web — endpoint yang sudah ada, tidak berubah

Web memakai flow yang sudah jalan di app. Tidak ada endpoint auth baru.

| # | Endpoint | Catatan |
|---|---|---|
| 1 | `POST /api/member/auth/register` | buat akun, `isActive=false`. **Tidak mengembalikan token** |
| 2 | `POST /api/member/auth/requestVerificationEmail` | kirim OTP ke email |
| 3 | `POST /api/member/auth/validateOtpEmail` | verifikasi. Balikannya `{ member_id, verified }` — **juga bukan token** |
| 4 | `POST /api/member/oauth/token` | login. `grant_type: "password"`, atau `"social"` untuk Google |
| 5 | `POST /api/shop/visits/claim` | sesudah punya access token |

Yang perlu diperhatikan FE:

- Setelah langkah 3 **wajib login di langkah 4** untuk dapat token. Verifikasi OTP
  tidak menerbitkan sesi.
- Akun yang belum diverifikasi bersifat *placeholder*: salah ketik email tidak
  mengunci alamat tersebut, dan email yang benar tetap bisa dipakai daftar.
- OTP: TTL 10 menit, kirim ulang setelah 60 detik, salah 5x kode hangus.
  Batas kirim email berlaku rolling 24 jam. Error throttle membawa `retryAfterSeconds`.
- `RegisterDto` **tidak** menerima field UTM tambahan — atribusi diikat lewat
  `/shop/visits/claim`, bukan lewat register.

### Input email di form (login dan register)

```html
type="email" inputMode="email" autoCapitalize="none" autoCorrect="off" spellCheck={false}
```

iOS mengkapitalkan huruf pertama dan meng-autocorrect domain kalau atribut ini absen.

---

## 5. Cookie — milik FE, backend tidak pernah membacanya

| Cookie | Isi | Umur | Aturan |
|---|---|---|---|
| `bb_attr` | `utm_source/medium/campaign/content/term` | 30 hari | Ditulis hanya kalau URL membawa `utm_*`. Kunjungan tanpa parameter **tidak** mengubah isinya (last-touch) |
| `bb_gid` | UUID tamu | 30 hari | Dibuat sekali kalau belum ada. **Jangan dihapus saat login** — masih dipakai untuk klaim dan checkout |

30 hari sengaja disamakan dengan window atribusi affiliate (`COOKIE_DAYS`). Kalau
salah satu berubah, ubah keduanya.

Backend tidak pernah membaca cookie — FE yang mengirim isinya sebagai body.

---

## 6. Di mana datanya mendarat

| Tabel | Peran | Metrik yang dihitung darinya |
|---|---|---|
| `shop_visits` (baru) | satu baris per kunjungan | Kunjungan, Pengunjung unik (distinct `guest_id`), Daftar (via `member_id`) |
| `commerce_transactions` (6 kolom baru) | snapshot beku saat order | Mulai checkout, Paid, Revenue |
| `members.utm_source` / `utm_content` | warisan signup app | **tidak dipakai** laporan ini |

`members` sengaja tidak dipakai: kolomnya cuma dua (tak ada `utm_campaign`) dan
selalu kosong untuk signup Google.

---

## 7. Uji sebelum event

- Klik shortlink → semua parameter sampai utuh di URL shop (redirect tidak memakan query).
- Laptop, belum punya akun: kunjungan tercatat → register + OTP → klaim → beli →
  order membawa `webinar / sep26` → muncul di Sumber Traffic.
- HP, sudah punya akun: kunjungan → login → klaim → beli → tercatat.
- **Google dari link berparameter**: voucher terpasang, dan setelah klaim
  kunjungannya terikat ke member (ini jalur yang paling mudah bocor).
- Buka lalu tidak beli: kunjungan tercatat, order tidak ada.
- Parameter ngawur / sangat panjang: checkout tetap sukses, order tanpa sumber.
- Backend mati: halaman produk tetap render, tombol Beli tetap jalan.

---

## 8. Yang belum diputuskan

- Nilai `utm_source` untuk webinar dan format `utm_campaign`
  (usulan: `webinar` dan `{nama}-{bulan}{tahun}`) — Product, masuk konvensi UTM PRD E3.
- Kuota voucher `WEBINAR20` kalau link disebar ulang di luar peserta.
- Prefix `/shop` sebagai rumah tracking web ke depan.
