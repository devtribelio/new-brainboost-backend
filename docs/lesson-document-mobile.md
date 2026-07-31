# Slide dokumen + flag bonus — kontrak FE

Perubahan pada `GET /api/member/product/course/detail` (dan varian `/public`).
Semuanya **aditif**: tidak ada field yang dihapus atau berganti nama, jadi build
FE yang sekarang tetap jalan tanpa perubahan. Yang baru di bawah ini diperlukan
untuk membuka dokumen lesson dan untuk menampilkan section Bonus.

Terkait: `docs/media-port.md` (audio/video), `docs/api-envelope.md` (amplop
respons).

---

## 1. Ringkasan

| | Sebelum | Sesudah |
|---|---|---|
| Slide dokumen | `data.url` — URL publik permanen | `data.fileUrl` — URL opaque bergerbang |
| Nama & ukuran file | tidak ada | `data.fileName`, `data.sizeBytes` |
| Penanda bonus | tidak ada | `bonus` di level slide |
| Akses dokumen | siapa pun yang punya tautan | wajib login + terdaftar di judul |

Dokumen lesson dulunya duduk di URL publik permanen, jadi siapa pun yang
memegang tautannya bisa mengunduh tanpa login. Sekarang berkasnya disimpan
privat dan hanya bisa dibuka lewat endpoint yang mengecek enrollment.

---

## 2. Bentuk slide

Setiap slide sekarang `{ id, type, bonus, data }`.

### `bonus` — level slide, bukan di dalam `data`

```jsonc
{
  "id": "01890000-0000-7000-8000-0000000000bb",
  "type": "DocumentTemplate",
  "bonus": true,          // ← sejajar dengan `type`
  "data": { /* … */ }
}
```

- **Selalu ada** di semua tipe slide (`AudioTemplate`, `VideoTemplate`,
  `TextTemplate`, `DocumentTemplate`, …). Tidak pernah `undefined`, jadi tidak
  perlu `slide.bonus ?? false`.
- `true` = tampilkan slide ini di **section Bonus** halaman judul, selain/alih-alih
  inline di player. Keputusan penempatan ada di FE.
- **Bukan penanda gratis.** Slide bonus tetap terikat lesson-nya dan tetap
  melewati cek enrollment yang sama persis. `bonus: true` tidak memberi akses
  apa pun.
- Berlaku untuk semua tipe karena bonus ke depan bisa berupa audio atau video,
  bukan hanya PDF.

### `DocumentTemplate` — `data`

```jsonc
{
  "id": "DOC456QRS",
  "type": "DocumentTemplate",
  "bonus": true,
  "data": {
    "title": "Workbook",
    "description": "<p>Latihan pekan 1</p>",
    "downloadable": true,
    "fileName": "workbook-pekan-1.pdf",
    "sizeBytes": 2310442,
    "fileUrl": "/api/member/media/document?t=<token-opaque>"
  }
}
```

| Field | Tipe | Catatan |
|---|---|---|
| `fileUrl` | `string?` | Path relatif ke endpoint dokumen. **Ada hanya untuk dokumen bergerbang.** |
| `url` | `string?` | Dokumen lama, URL publik apa adanya. **Ada hanya kalau `fileUrl` tidak ada.** |
| `fileName` | `string \| null` | Nama asli unggahan. `null` untuk dokumen lama. |
| `sizeBytes` | `number \| null` | Ukuran berkas. `null` = tidak diketahui — **bukan** `0`. |
| `downloadable` | `boolean` | `false` = view-only, jangan tawarkan simpan ke perangkat. |

`fileName` dan `sizeBytes` **selalu jadi key** (bernilai `null` bila tidak
diketahui) supaya bentuknya stabil. `fileUrl` dan `url` sebaliknya: hanya salah
satu yang muncul.

Slide dokumen **tidak punya `duration`** — dokumen bukan media berdurasi.

### Kompatibilitas dokumen lama

Sebagian dokumen belum dipindah ke penyimpanan privat. Slide itu masih keluar
dengan `data.url` (URL publik langsung, buka seperti biasa) dan
`fileName`/`sizeBytes` bernilai `null`. Tangani keduanya:

```dart
final data = slide['data'] as Map<String, dynamic>;
final gated = data['fileUrl'] as String?;
final legacy = data['url'] as String?;

if (gated != null) {
  await openGatedDocument(gated);        // §3
} else if (legacy != null) {
  await launchUrl(Uri.parse(legacy));    // langsung, tanpa auth
}
```

Cabang `url` akan hilang setelah backfill selesai. Aman untuk dipertahankan.

---

## 3. Membuka dokumen bergerbang

```
GET {baseUrl}{fileUrl}
Authorization: Bearer <access_token>
```

Balasannya **302** ke presigned URL S3 yang berlaku **900 detik**. Query opsional
`&filename=workbook.pdf` mengatur `Content-Disposition` untuk nama berkas
tersimpan.

### ⚠️ Jangan teruskan header `Authorization` ke redirect

Presigned URL sudah membawa kredensialnya di query string. Kalau client
meneruskan `Authorization` ke S3, S3 menolak dengan
`400 InvalidArgument: Only one auth mechanism allowed`. Gejalanya menyesatkan —
gerbangnya lolos, tapi unduhannya gagal.

Cara paling pasti: jangan auto-follow, ambil `Location`, unduh terpisah tanpa
header auth.

```dart
Future<void> openGatedDocument(String fileUrl, {String? saveAs}) async {
  final res = await dio.get(
    '$baseUrl$fileUrl${saveAs != null ? '&filename=$saveAs' : ''}',
    options: Options(
      followRedirects: false,
      validateStatus: (s) => s == 302,
      headers: {'Authorization': 'Bearer $accessToken'},
    ),
  );

  final signed = res.headers.value('location')!;
  // Tanpa header Authorization — presigned URL sudah membawa kredensialnya.
  await dio.download(signed, savePath,
      onReceiveProgress: (recv, total) { /* progres unduh */ });
}
```

Memisahkan dua langkah ini juga yang memberi FE kendali progres unduh, yang
memang diminta untuk berkas di atas 20 MB.

---

## 4. Penanganan error

| Status | Code | Arti & tindakan |
|---|---|---|
| `400` | `MEDIA_TOKEN_MISSING` | `t` kosong. Bug FE. |
| `401` | `MEDIA_TOKEN_EXPIRED` | Course detail yang dipegang sudah basi. **Refetch course detail sekali**, ambil `fileUrl` baru, ulangi. |
| `401` | `MEDIA_TOKEN_INVALID` | Token rusak atau bukan token dokumen. Refetch course detail. |
| `401` | `MEDIA_AUTH_REQUIRED` | Dokumen non-preview dipanggil tanpa login. |
| `403` | `COURSE_NOT_ENROLLED` | Belum terdaftar di judul ini. |
| `429` | — | Lihat batas di bawah. |

Retry otomatis **sekali** untuk `MEDIA_TOKEN_EXPIRED` sudah cukup; kalau masih
gagal, tampilkan pesan, jangan loop.

### Batas laju

10 request per menit per member, dan jatah itu **dipakai bersama** dengan
`/api/member/media/download` (unduh audio/video offline). Mengunduh banyak
dokumen sambil menyimpan audio offline bisa saling memakan jatah — beri jeda
antar unduhan massal.

---

## 5. Lesson preview

Kalau lesson-nya `isPreview: true`, dokumennya bisa dibuka **tanpa login sama
sekali** — sama seperti audio/video preview. Panggil endpoint yang sama tanpa
header `Authorization`.

---

## 6. Catatan perilaku

- **`downloadable: false`** = view-only. Buka di viewer in-app, jangan tawarkan
  "simpan ke perangkat". Ini kontrak produk, bukan penegakan teknis — server
  tetap mengirim byte-nya.
- **Presigned URL bersifat bearer.** Selama 900 detik siapa pun yang memegangnya
  bisa membuka. Jangan tulis URL itu ke log, share sheet, atau cache yang
  persisten. Yang dicache sebaiknya berkasnya, bukan tautannya.
- **`sizeBytes: null` ≠ 0.** Kalau `null`, sembunyikan label ukuran, jangan
  tampilkan "0 B".
- **Jangan cache `fileUrl` lintas sesi.** Token punya masa berlaku; ambil ulang
  dari course detail, jangan simpan permanen.
