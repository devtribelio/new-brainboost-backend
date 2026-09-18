# PRD Backend — Audio Offline Satu File via CloudFront, Tanpa Update Aplikasi

> Memindahkan **audio** pelajaran dari HLS ratusan potongan di Bunny Stream menjadi **satu file AAC per pelajaran** di S3, dilayani lewat `cdn.brainboost.id` dengan URL bertanda tangan, dan disajikan ke aplikasi yang sudah beredar sebagai **playlist HLS berisi satu segmen**. Aplikasi tidak diubah. Video tetap di Bunny Stream.
> Repo: **new-brainboost-backend** (+ ops CloudFront/S3). Status: DRAFT 18 Sep 2026, belum ada task Jira. Backlog: project **BB**, prefix `[BE]` / `[OPS]` / `[QA]`, label `audio-cdn`.
> Dokumen terkait: `docs/media-port.md` §8 (pengukuran HLS vs MP4, tidak ada rendisi audio-only di Bunny), PRD tim mobile `prd-download-improvements.md` (opsi C/D/E), `docs/prd-android-offline-download-reliability.md` (perbaikan sisi aplikasi, menyusul).

---

## 0. Ringkasan satu paragraf

Unduhan offline di Android gagal di Xiaomi/POCO karena satu pelajaran = 780–920 tugas WorkManager kecil yang dihentikan OS (`canceled`) dan loop Dart yang mengantrekan batch berikutnya dibekukan saat aplikasi ke latar belakang. Aplikasi yang beredar mengunduh "semua segmen yang tertulis di playlist"; **pembaca playlist-nya menerima playlist media tanpa master, URI absolut ke domain lain, dan ekstensi apa pun**. Maka backend cukup mengganti isi playlist: satu segmen `.aac` utuh di CloudFront. Hasilnya satu tugas unduh berdurasi puluhan detik, tidak ada batch berikutnya yang bisa macet, retry mengulang satu file. Byte per jam dengar turun dari ~77 MB (HLS 360p, audio + gambar diam) menjadi ~60 MB (salin track audio apa adanya) atau ~43 MB (encode ulang 96 kbps), dan egress sampai 1 TB/bulan masuk kuota gratis CloudFront. Rollback per aset: kosongkan satu baris, playlist kembali ke Bunny.

---

## 1. Fakta yang menopang desain (diverifikasi 18 Sep 2026)

| Fakta | Sumber |
|---|---|
| Aplikasi Android membaca playlist dari `GET /api/member/media/hls` (`{url, expiresAt}`), lalu mengunduh setiap URI segmen; menerima playlist media langsung (memilih rendisi hanya bila ada `EXT-X-STREAM-INF`), `base.resolve()` untuk URI (absolut ok), mempertahankan ekstensi file, menolak hanya `EXT-X-KEY` terenkripsi; mendukung `EXT-X-MAP` | `brainboost-apps/lib/core/service/media/hls_download_service.dart` (`_rewritePlaylist`, `_extensionOf`) |
| iOS menyerahkan playlist ke `AVAssetDownloadURLSession` (HLS standar) | idem, jalur `_downloadIos` |
| Backend menandatangani URL Bunny (`signBunnyHlsUrl`) dengan TTL 2 jam streaming / 24 jam unduh (`MEDIA_SIGNED_URL_TTL_SECONDS`, `MEDIA_DOWNLOAD_TTL_SECONDS`); `MEDIA_MODE=signed` di prod | `apps/mobile-api/src/modules/media/media.service.ts`, `env.ts` |
| Identitas aset = **Bunny `guid`**, diturunkan serializer dari embed legacy di lesson (`parseBunnyEmbed`); tidak ada kolom guid di `course_lessons` | `product.serializer.ts:195,261` |
| Bunny Stream **tidak punya rendisi audio-only**; 360p dan 480p membawa audio byte-identik (AAC ~134 kbps); MP4 fallback aktif | `docs/media-port.md` §"There is no audio-only variant" |
| CloudFront `cdn.brainboost.id` (id `EAN6B036LQYKV`) sudah ada dengan origin `brainboost-production` | akun AWS |
| Katalog: 108 aset audio, 70 video (`scripts/media-guids.json`) | `docs/media-port.md` |
| Egress S3 Jakarta Agustus 302 GB ≈ $0,088/GB; CloudFront 1 TB/bulan gratis lalu ~$0,12/GB Asia Pasifik; Bunny Asia ~$0,03/GB | Cost Explorer, daftar harga |

---

## 2. Keputusan desain

### Terkunci

| # | Keputusan | Alasan |
|---|---|---|
| K1 | **Hanya audio** yang pindah; video tetap Bunny Stream | Video butuh transcoding + ABR; masalahnya ada di audio yang dipaksa jadi video |
| K2 | Disajikan sebagai **playlist HLS satu segmen**, bukan endpoint baru | Satu-satunya cara tanpa update aplikasi; kedua platform sudah memakai HLS |
| K3 | Segmen berformat **AAC ADTS (`.aac`)** | Satu segmen tanpa `EXT-X-MAP` hanya sah untuk elementary stream; ExoPlayer & AVFoundation memutarnya. fMP4 (`.m4s` + `EXT-X-MAP`) disimpan sebagai alternatif bila ADTS bermasalah di perangkat tertentu |
| K4 | **Salin track audio apa adanya** untuk 10 aset percobaan (`ffmpeg -vn -c:a copy`), keputusan encode ulang ke 96 kbps diambil setelah didengar | Salin = tanpa risiko kualitas, cepat, ~60 MB/jam; encode ulang ~43 MB/jam tapi 108 × proses |
| K5 | Sumber playlist bertahap **per aset**: tabel pemetaan `guid → audio_key`; baris kosong = playlist Bunny seperti sekarang | Rollback per aset tanpa deploy; migrasi 10 aset dulu |
| K6 | URL segmen = **CloudFront signed URL** (key pair, private key di Secrets Manager), TTL sama dengan `/media/hls` sekarang | Menggantikan token Bunny; S3 tetap privat, tidak ada public-read |
| K7 | Playlist **dibuat backend saat diminta** (bukan file statis di S3), berisi URL segmen yang baru ditandatangani | TTL berjalan dari saat diminta; tidak ada playlist basi di CDN |
| K8 | Prefix S3 `private/audio/<guid>/<version>.aac` di bucket `brainboost-production` (di bawah `private/`, konvensi presign-only yang sudah ada); behavior CloudFront baru untuk `/private/audio/*` dengan **signed URL wajib** dan cache panjang | Satu distribusi yang sudah ada; `version` memungkinkan encode ulang tanpa menimpa file yang sedang diunduh |
| K9 | Unduhan HLS lama di perangkat **tidak disentuh**; user mendapat file baru saat mengunduh ulang | Tidak ada migrasi klien |

### Terbuka (butuh keputusan sebelum BE-03)

| # | Pertanyaan | Default |
|---|---|---|
| D-1 | Salin (134 kbps, ~60 MB/jam) atau encode ulang (96 kbps, ~43 MB/jam)? | Salin untuk percobaan; putuskan di QA-01 |
| D-2 | Batas egress yang memicu peninjauan biaya | 800 GB/bulan di CloudFront (mendekati kuota gratis 1 TB) |
| D-3 | Aset audio dihapus dari Bunny setelah migrasi? | Ya, **30 hari** setelah aset terakhir pindah dan tidak ada keluhan |

---

## 3. Alur

```
aplikasi (versi toko) → GET /api/member/media/hls?t=<token>
  → backend: guid dari token (seperti sekarang)
  → cari media_audio_sources[guid]
      ├─ tidak ada / inactive → { url: signBunnyHlsUrl(guid) }           (perilaku sekarang, tidak berubah)
      └─ ada                 → { url: https://bb-be.brainboost.id/api/member/media/audio-playlist?t=<token2> }
aplikasi → GET audio-playlist
  → backend menjawab text/vnd.apple.mpegurl:
      #EXTM3U
      #EXT-X-VERSION:3
      #EXT-X-TARGETDURATION:<durasi bulat ke atas>
      #EXT-X-MEDIA-SEQUENCE:0
      #EXT-X-PLAYLIST-TYPE:VOD
      #EXTINF:<durasi detik>,
      https://cdn.brainboost.id/private/audio/<guid>/<v>.aac?Expires=…&Signature=…&Key-Pair-Id=…
      #EXT-X-ENDLIST
aplikasi → mengunduh 1 segmen dari CloudFront (Android: 1 tugas; iOS: AVAssetDownload)
        → menulis playlist lokal dengan seg_00000.aac → memutar seperti biasa
```

Streaming online memakai jalur yang sama (playlist satu segmen; pemutar HLS menangani seek lewat byte-range internalnya). Bila pemutaran online ternyata kurang mulus dengan satu segmen besar (dinilai di QA-01), alternatif: playlist streaming memakai Bunny seperti sekarang dan hanya `forDownload=true` yang memakai satu segmen; keduanya tersedia lewat flag yang sudah ada.

---

## 4. Data model (aditif)

```prisma
model MediaAudioSource {
  guid        String   @id                          // Bunny guid, identitas aset yang dipakai serializer
  audioKey    String   @map("audio_key")            // private/audio/<guid>/<version>.aac
  version     Int      @default(1)
  codec       String   @default("aac")              // aac | aac-96k (D-1)
  durationSec Int      @map("duration_sec")         // untuk EXTINF/TARGETDURATION; dari ffprobe
  bytes       Int
  sha256      String                                 // verifikasi unggahan
  isActive    Boolean  @default(true) @map("is_active")   // false = kembali ke Bunny (rollback per aset)
  encodedAt   DateTime @map("encoded_at")
  createdAt   DateTime @default(now()) @map("created_at")
  @@map("media_audio_sources")
}
```

Tidak ada perubahan pada `course_lessons`, `products`, tracker, atau tabel lain. Migrasi satu file, aditif.

---

## 5. Perubahan per komponen

### Ops / infra — `[OPS]`

| ID | Task | Acceptance |
|---|---|---|
| OPS-01 | Key pair CloudFront (public key + key group) untuk distribusi `EAN6B036LQYKV`; private key ke Secrets Manager `bb/prod/cdn-signing`; task role mobile-api boleh `GetSecretValue` untuk itu | Backend bisa menandatangani; kunci tidak ada di repo/env |
| OPS-02 | Behavior CloudFront path `/private/audio/*`: origin `brainboost-production`, **Restrict viewer access = key group**, cache policy TTL panjang, compress off, Range diteruskan | URL tanpa tanda tangan → 403; dengan tanda tangan → 200; Range request → 206 |
| OPS-03 | Bucket policy: `/private/audio/*` hanya lewat OAC CloudFront; tidak masuk policy public-read `public/*` | Akses langsung ke S3 → 403 |
| OPS-04 | Alarm biaya: CloudFront egress > D-2 per bulan | Notifikasi ke email ops |

### Backend — `[BE]`

| ID | Task | Acceptance | Ukuran | Tergantung |
|---|---|---|---|---|
| BE-01 | Migration `media_audio_sources` | `prisma migrate diff` no drift | S | — |
| BE-02 | `cloudfront-sign.util.ts`: signed URL (canned policy) dengan key dari Secrets Manager, cache kunci di memori; unit test terhadap vektor yang dibuat dengan AWS CLI | Tanda tangan diterima CloudFront staging behavior | S | OPS-01 |
| BE-03 | `MediaService.buildHlsUrl`: bila `media_audio_sources[guid].isActive` → URL endpoint playlist backend (token turunan dari token media yang ada, TTL sama); selain itu perilaku lama byte-identik | Test: guid tanpa baris → URL Bunny persis seperti sebelum; guid dengan baris → URL playlist | S | BE-01 |
| BE-04 | Endpoint `GET /api/member/media/audio-playlist?t=` (publik seperti `/media/hls`, tanpa auth ulang karena token sudah membawa guid + expiry; `Cache-Control: no-store`) yang menghasilkan playlist satu segmen §3 dengan `EXTINF` dari `durationSec` | Playlist lolos validator `mediastreamvalidator`/`hls-parser`; app staging mengunduhnya | M | BE-02, BE-03 |
| BE-05 | Skrip `pnpm media:encode-audio --guid=<g> [--all-audio] [--dry-run] [--reencode=96k]`: ambil MP4 360p dari Bunny (URL bertanda tangan yang sudah ada), `ffmpeg -vn -c:a copy -f adts` (atau encode ulang), `ffprobe` durasi, unggah ke `private/audio/<guid>/<v>.aac`, hitung sha256, tulis baris `isActive=false` dulu; flag `--activate` menyalakannya | Idempoten per guid+version; gagal di tengah tidak meninggalkan baris aktif tanpa file | M | BE-01 |
| BE-06 | `GET /media/download` untuk aset yang sudah pindah mengarah ke file `.aac` yang sama (bukan MP4 Bunny) | Tidak ada jalur yang masih menarik byte video untuk aset audio yang sudah pindah | S | BE-03 |
| BE-07 | Log + metrik: hitungan playlist per sumber (`bunny` vs `cdn`) per hari, untuk memantau rollout dan biaya | Terlihat di CloudWatch tanpa dashboard baru | S | BE-04 |
| BE-08 | Docs: `docs/media-port.md` §9 (arsitektur audio baru, rollback per aset), CLAUDE.md §5 satu paragraf | Tertulis sebelum aset ke-11 diaktifkan | S | semua |

### QA — `[QA]`

| ID | Task | Acceptance |
|---|---|---|
| QA-01 | **Uji 1 aset** di staging dengan **aplikasi versi toko**: POCO bermasalah (layar mati, 3×), Samsung/Pixel, iPhone. Unduh, putar sampai habis, seek, hapus, unduh ulang. Streaming online seek. Bandingkan kualitas dengar dengan Bunny | 3/3 selesai di POCO; tidak ada regresi platform lain; kualitas diterima → putuskan D-1 |
| QA-02 | Setelah 10 aset aktif di prod 7 hari: baca `bb_audio_download_result` (3.4.0) per sumber; keluhan CS | Tingkat gagal aset CDN < aset Bunny |

---

## 6. Urutan rilis

1. OPS-01..03 (setengah hari). 2. BE-01..05 (3 hari), deploy backend; **belum ada aset aktif**, perilaku prod identik. 3. Encode **1 aset**, aktifkan di staging → QA-01. 4. Putuskan D-1, encode 10 aset, aktifkan di prod → QA-02 selama 7 hari. 5. Encode sisa 98 aset (skrip `--all-audio`), aktifkan bertahap 30 per hari sambil memantau BE-07 dan biaya. 6. D-3: hapus aset audio dari Bunny setelah 30 hari.

Rollback kapan pun: `UPDATE media_audio_sources SET is_active=false WHERE guid=…` → playlist berikutnya kembali ke Bunny. Tidak ada deploy, tidak ada rilis aplikasi.

Tenaga: 1 backend ≈ 4 hari, ops ≈ 1 hari, QA ≈ 1 hari. Kalender ≈ 2 minggu termasuk 7 hari pemantauan.

---

## 7. Biaya (asumsi salin, ~60 MB/jam dengar)

| Volume dengar/bulan | Egress CloudFront | Biaya CloudFront | Bunny sekarang (77 MB/jam × $0,03) |
|---|---|---|---|
| 10.000 jam | 600 GB | $0 (kuota gratis 1 TB) | ~$23 |
| 16.000 jam | 1 TB | $0 | ~$37 |
| 30.000 jam | 1,8 TB | ~$96 | ~$69 |

Penyimpanan S3 untuk 108 aset ≈ 6,5 GB ≈ $0,16/bulan. Titik impas terhadap Bunny sekitar 20.000 jam/bulan pada mode salin, 28.000 jam pada mode 96 kbps. **Angka bandwidth Bunny bulan lalu (dashboard Bunny › Statistics) harus dibaca sebelum langkah 5** untuk memastikan kalian di sisi kiri tabel; kalau tidak, pilihan yang lebih murah adalah file `.aac` yang sama di Bunny Storage + Bunny CDN dengan token Bunny, dan semua yang lain di PRD ini tetap berlaku kecuali OPS-01..03 dan BE-02.

---

## 8. Yang tidak diselesaikan dan tetap milik tim mobile

- **Foreground service + notifikasi progres** (opsi C di PRD tim). Dengan satu segmen, jendela risiko turun ke puluhan detik, tetapi HP dengan pembatasan latar belakang paling ketat tetap bisa memotong tugas itu. Ini penyempurnaan berikutnya, bukan prasyarat.
- Panduan pengaturan baterai untuk Xiaomi/POCO/Oppo/Vivo.
- Melanjutkan unduhan yang terputus di tengah satu file (Range resume di sisi aplikasi); retry 3× yang ada mengulang file utuh, ~30 detik.

## 9. Out of scope

- Video: tetap Bunny Stream sepenuhnya.
- DRM/enkripsi segmen.
- Mengubah pemutar atau format unduhan di aplikasi.
- Bunny Storage sebagai alternatif (dicatat di §7 sebagai jalur cadangan biaya).

## 10. Risiko

| Risiko | Mitigasi |
|---|---|
| Playlist satu segmen besar memutar kurang mulus saat streaming online (seek lambat) di perangkat tertentu | QA-01 menguji seek; fallback: streaming tetap Bunny, hanya unduhan yang memakai satu segmen (flag `forDownload` sudah ada) |
| ADTS `.aac` tidak diterima satu decoder | K3: alternatif fMP4 + `EXT-X-MAP`, didukung parser aplikasi |
| Token playlist bocor memberi akses 2 jam ke satu aset | Sama dengan token Bunny sekarang; tidak lebih buruk |
| Biaya CloudFront melampaui perkiraan | OPS-04 alarm + D-2; jalur Bunny Storage tersedia tanpa perubahan aplikasi |
| Aset audio yang ternyata dipakai sebagai video (gambar berubah) | `--all-audio` memakai daftar 108 aset di `media-guids.json`; QA-01 memastikan pemilihan; aset ragu tetap di Bunny |
