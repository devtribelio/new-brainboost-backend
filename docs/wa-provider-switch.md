# PRD — Pergantian Provider WhatsApp dari Backoffice (bb-comms)

> Membuat provider WhatsApp OTP bisa **ditambah dengan satu deploy kecil** dan **diganti tanpa deploy** dari backoffice, tanpa menaruh kredensial di database. Menyentuh tiga repo: **bb-notification-service** (bb-comms, Go), **backoffice-bb**, dan repo ini (CDK + satu endpoint internal).
> Status: DRAFT — hasil diskusi 16 Sep 2026, belum ada task Jira. Backlog: project **BB**, prefix `[COMMS]` / `[BO]` / `[BE]` / `[OPS]`, label `wa-provider`.
> Diagram: artifact "WhatsApp Provider Switch". Dokumen terkait: `docs/comms-port-summary.md`, `docs/otp-cooldown.md`.

---

## 0. Ringkasan satu paragraf

Hari ini bb-comms hanya tahu satu provider WhatsApp, **Qontak**, dan hanya mengirim satu jenis pesan lewat WhatsApp, **OTP**. Seluruh pengetahuan tentang Qontak ada di satu file 130 baris (`internal/channel/whatsapp.go`), konfigurasinya tujuh variabel env `QONTAK_*`, termasuk **ID template OTP yang ditulis di env** sehingga penolakan template oleh Meta berarti deploy. Dokumen ini memecahnya menjadi tiga lapis dengan pemilik berbeda: **kode** menyimpan adaptor per provider (cara login, format kirim, cara membaca respons), **database `app_settings`** menyimpan provider aktif + ID template + nama secret, **AWS Secrets Manager** menyimpan kredensial. Hasilnya: satu deploy per provider baru, nol deploy per perpindahan, dan ops bisa membalik saklar dalam satu menit saat provider bermasalah.

---

## 1. Kondisi sekarang (diverifikasi di kode, 16 Sep 2026)

| Hal | Di mana | Catatan |
|---|---|---|
| Pemanggil Qontak | `bb-notification-service/internal/channel/whatsapp.go` | `NewWhatsApp(cfg QontakConfig)`, `getToken` (OAuth password grant, token berumur pendek), `SendOTP(ctx, phone, name, code)` |
| Konfigurasi | `internal/config/config.go` `QontakConfig` | `QONTAK_BASE_URL`, `CLIENT_ID`, `CLIENT_SECRET`, `USERNAME`, `PASSWORD`, `CHANNEL_INTEGRATION_ID`, `OTP_TEMPLATE_ID` — semua env, disuntik dari secret `bb/prod/app` |
| Pemakai | `internal/handler/otp.go` | `case contract.ChannelWhatsApp: h.WhatsApp.SendOTP(...)` — satu-satunya pemanggil |
| Perakitan | `cmd/bb-notification-service/main.go` | `wa := channel.NewWhatsApp(cfg.Qontak, log)` → `handler.New(db, email, wa, log)` |
| Pencatatan | tabel `comms_delivery` (`message_id, channel, type, recipient, status, provider_response, attempt`) | **Tidak ada kolom provider** |
| Pemilih channel | mobile-api, saat menerbitkan pesan OTP ke SQS | Tidak tahu provider; tidak berubah |
| Akses DB dari bb-comms | ada (`DATABASE_URL`) | Membaca/menulis `comms_*`; belum pernah membaca `app_settings` |
| Akses Secrets Manager dari bb-comms | **tidak ada** | Task role hanya menerima secret lewat env saat start |

---

## 2. Keputusan desain

### Terkunci

| # | Keputusan | Alasan |
|---|---|---|
| K1 | **Adaptor per provider tetap kode**, satu antarmuka `Sender` dengan `SendOTP(ctx, phone, name, code) (providerResponse string, err error)` | Autentikasi (Qontak: login → token berumur pendek), format permintaan, dan cara membaca sukses/gagal berbeda per provider dan butuh pengujian. "Template body di database" adalah program tanpa test yang langsung berlaku di prod; ditolak |
| K2 | **Provider aktif, ID template, dan pengenal akun di `app_settings`**, dibaca bb-comms dengan cache 60 detik | Ini yang berubah tanpa alasan teknis (template ditolak Meta, provider bermasalah) dan harus bisa dibalik ops dalam hitungan menit |
| K3 | **Kredensial di Secrets Manager**, database hanya menyimpan **nama secret** (`secretRef`) | Database disalin ke staging dan laptop; Secrets Manager mencatat setiap pembacaan di CloudTrail dan punya versi |
| K4 | Satu secret **per provider** dengan nama `bb/prod/wa/<provider>`, isi JSON dengan kunci yang ditentukan adaptornya | Rotasi satu provider tidak menyentuh yang lain; izin IAM bisa dibatasi ke prefix |
| K5 | **Satu provider aktif untuk semua OTP** (bukan per tujuan, bukan fallback otomatis) | Dua provider berarti dua nomor pengirim; user bingung. Fallback otomatis ditunda sampai ada data gagal per provider |
| K6 | **Tombol "kirim OTP percobaan"** wajib ada sebelum saklar boleh dibalik | Satu-satunya cara memverifikasi template + kredensial tanpa mengorbankan user sungguhan |
| K7 | Qontak dipindah ke dalam kerangka ini **tanpa mengubah perilaku**: nilai env yang ada menjadi nilai awal (seed) di `app_settings`, kredensialnya disalin ke `bb/prod/wa/qontak` | Rilis pertama harus byte-identik dari sisi user |

### Terbuka (butuh keputusan sebelum COMMS-01)

| # | Pertanyaan | Default |
|---|---|---|
| D-1 | Provider kedua yang pertama dibangun? | **Cekat** (disebut tim), butuh akun + dokumentasi API-nya |
| D-2 | Kalau `app_settings` tidak terbaca (DB error) saat kirim: pakai nilai cache terakhir, atau gagal? | **Cache terakhir**, kalau belum pernah ada cache → gagal dengan error jelas (bukan diam) |
| D-3 | Siapa yang boleh membalik saklar di backoffice? | Permission baru `settings.comms` — ops lead + engineering, bukan semua admin |
| D-4 | Simpan riwayat perpindahan provider? | **Ya**, lewat audit log backoffice yang sudah ada (siapa, kapan, dari → ke) |

---

## 3. Skema `app_settings`

Key yang dipakai (semua string, seperti key lain di tabel ini):

| Key | Contoh | Rahasia? |
|---|---|---|
| `wa.provider` | `qontak` | tidak |
| `wa.qontak.baseUrl` | `https://service-chat.qontak.com` | tidak |
| `wa.qontak.channelIntegrationId` | `9fe63a0f-…` | tidak |
| `wa.qontak.otpTemplateId` | `453e330c-…` | tidak |
| `wa.qontak.secretRef` | `bb/prod/wa/qontak` | tidak (nama, bukan isi) |
| `wa.cekat.baseUrl` / `wa.cekat.otpTemplateId` / `wa.cekat.secretRef` | … | tidak |

Isi secret `bb/prod/wa/qontak` (JSON): `{"clientId","clientSecret","username","password"}`. Setiap adaptor mendokumentasikan kunci yang dia butuhkan di komentar file-nya; kunci yang hilang → error saat kirim percobaan, bukan saat OTP user.

Seed awal (`prisma/seed-settings.ts` di repo ini, insert-only): `wa.provider=qontak` + empat key Qontak dari nilai env yang berlaku sekarang.

---

## 4. Alur runtime (bb-comms)

```
pesan OTP dari SQS (channel=whatsapp)
  → handler OTP memanggil registry.Active(ctx)
      → baca app_settings wa.provider + wa.<p>.* (cache 60 s; D-2 kalau gagal)
      → adaptor <p> (sudah terdaftar di kode)
      → kredensial: cache memori per secretRef; kalau kosong/ditolak provider → GetSecretValue(secretRef)
  → adaptor.SendOTP(phone, name, code)
  → comms_delivery: + kolom provider = <p>
  → sukses / gagal seperti sekarang (retry antrean, DLQ)
```

Yang **tidak** berubah: kontrak pesan SQS, mobile-api, cooldown/kuota OTP, email OTP.

---

## 5. Alur ops (backoffice)

Halaman baru **Settings › WhatsApp** (permission D-3):

1. Pilihan **Provider aktif** (dropdown dari daftar yang didukung kode; daftar ini diambil dari satu endpoint kecil supaya backoffice tidak menebak).
2. Per provider: field `baseUrl`, `otpTemplateId`, pengenal akun (mis. `channelIntegrationId`), `secretRef`. Tidak ada field kredensial. Teks bantuan: "Kredensial disimpan di AWS Secrets Manager dengan nama ini; minta engineering/ops AWS untuk mengisinya."
3. Tombol **Kirim OTP percobaan** per provider: input nomor, kirim lewat provider **yang dipilih di form** (bukan yang aktif), hasil ditampilkan dari `comms_delivery` dalam ≤ 30 detik (polling). Kode yang dikirim acak dan tidak diterima login mana pun.
4. Tombol **Jadikan aktif**, dinonaktifkan sampai percobaan terakhir untuk provider itu sukses dalam 24 jam terakhir (K6). Menulis `wa.provider` + audit log (D-4).
5. Kartu status: provider aktif, kiriman 24 jam terakhir per provider dari `comms_delivery` (terkirim / gagal), waktu perubahan terakhir dan oleh siapa.

Kirim percobaan lewat jalur normal: backoffice memanggil endpoint internal di mobile-api (§6) yang menerbitkan pesan OTP biasa ke SQS dengan `providerOverride`, sehingga yang diuji adalah jalur yang sama dengan produksi, bukan jalur khusus yang bisa saja berbeda.

---

## 6. Perubahan per repo

### bb-notification-service (Go) — `[COMMS]`

| ID | Task | Acceptance | Ukuran | Tergantung |
|---|---|---|---|---|
| COMMS-01 | Antarmuka `wa.Sender` + pindahkan Qontak ke `internal/channel/wa/qontak.go` tanpa perubahan perilaku; konfigurasi Qontak dibaca dari struct (bukan env langsung) | Test yang ada hijau; kirim OTP staging identik | S | D-1..D-4 |
| COMMS-02 | `internal/channel/wa/registry.go`: baca `wa.provider` + `wa.<p>.*` dari `app_settings` dengan cache 60 s; perilaku D-2 saat DB gagal; daftar provider yang didukung diekspos sebagai fungsi | Unit test: ganti nilai di DB → adaptor berganti ≤ 60 s; DB down → cache terakhir; tanpa cache → error eksplisit | M | COMMS-01 |
| COMMS-03 | Pembaca Secrets Manager (`GetSecretValue` by `secretRef`), cache memori, refresh saat 401/403 dari provider atau saat `secretRef` berubah; kunci JSON yang hilang → error yang menyebut kuncinya | Unit test dengan mock SDK; tidak ada nilai secret di log (redaksi) | M | — |
| COMMS-04 | Kolom `provider` di `comms_delivery` (migrasi di repo backend, tabel milik Prisma) diisi setiap kiriman WA; pesan SQS menerima field opsional `providerOverride` yang **hanya** dihormati untuk pesan uji (`type=OtpTest`) | Baris delivery membawa nama provider; override diabaikan untuk OTP asli | S | COMMS-02 |
| COMMS-05 | Adaptor **Cekat** (D-1): auth, kirim template OTP, baca respons, mapping error permanen vs sementara | Kirim percobaan ke 2 nomor nyata sukses; error kredensial salah → permanen, timeout → retry | M | COMMS-01, akun Cekat |
| COMMS-06 | Jenis pesan `OtpTest`: sama dengan OTP tapi kode acak, tidak menulis `otp_codes`, selalu dicatat dengan `type=OtpTest` | Kirim uji tidak bisa dipakai login | S | COMMS-04 |

### new-brainboost-backend — `[BE]`

| ID | Task | Acceptance | Ukuran | Tergantung |
|---|---|---|---|---|
| BE-01 | Migrasi: kolom `comms_delivery.provider text NULL`; seed `wa.*` di `seed-settings.ts` dengan nilai Qontak yang berlaku | `prisma migrate diff` no drift; seed idempoten | S | — |
| BE-02 | CDK: task role bb-comms mendapat `secretsmanager:GetSecretValue` + `DescribeSecret` untuk resource `arn:…:secret:bb/prod/wa/*`; env `QONTAK_*` **tetap** satu rilis sebagai fallback lalu dihapus di rilis berikutnya | `cdk diff` hanya IAM policy; tidak ada perubahan lain | S | — |
| BE-03 | Endpoint internal `POST /api/internal/comms/wa-test` (bearer internal seperti endpoint internal lain): body `{phone, provider}` → terbitkan pesan `OtpTest` dengan `providerOverride` ke SQS; rate limit 5/menit | Backoffice bisa memicu uji; tidak bisa dipanggil publik | S | COMMS-06 |
| BE-04 | Endpoint internal `GET /api/internal/comms/wa-providers` → daftar provider yang didukung bb-comms **versi yang live** (bb-comms menulis daftarnya ke `app_settings` key `wa.supportedProviders` saat start; endpoint hanya membacanya) | Backoffice tidak menampilkan provider yang belum dideploy | S | COMMS-02 |

### backoffice-bb — `[BO]`

| ID | Task | Acceptance | Ukuran | Tergantung |
|---|---|---|---|---|
| BO-01 | Halaman Settings › WhatsApp (§5): dropdown provider dari BE-04, form per provider, tanpa field kredensial, audit log saat `wa.provider` berubah, permission `settings.comms` | Nilai tersimpan di `app_settings`; audit log mencatat dari → ke | M | BE-04 |
| BO-02 | Kirim OTP percobaan + polling hasil dari `comms_delivery`; tombol "Jadikan aktif" terkunci sampai uji sukses ≤ 24 jam | Uji gagal → tombol tetap terkunci dengan alasan dari `provider_response` | M | BE-03, COMMS-06 |
| BO-03 | Kartu status: kiriman 24 jam per provider (sent/failed) + perubahan terakhir | Query `comms_delivery` group by provider | S | COMMS-04 |

### Ops — `[OPS]`

| ID | Task |
|---|---|
| OPS-01 | Buat secret `bb/prod/wa/qontak` berisi 4 kunci dari `bb/prod/app`; **jangan hapus** yang lama sampai rilis kedua |
| OPS-02 | Urutan rilis: BE-01 (migrasi + seed) → BE-02 (IAM) → bb-comms (COMMS-01..04, 06) → backoffice → verifikasi OTP asli masih lewat Qontak → rilis berikutnya hapus env `QONTAK_*` dari CDK |
| OPS-03 | Akun Cekat: daftarkan template OTP, tunggu persetujuan Meta, buat `bb/prod/wa/cekat`. Baru setelah itu COMMS-05 bisa diuji ujung ke ujung |
| OPS-04 | Runbook satu halaman: "OTP WhatsApp gagal massal → buka Settings › WhatsApp → lihat kartu status → kirim uji ke provider lain → jadikan aktif → pantau 1 jam → kabari CS" |

Jalur kritis: COMMS-01 → COMMS-02 → COMMS-04 → BE-03 → BO-02. COMMS-03 dan BE-02 bisa paralel sejak awal. COMMS-05 (Cekat) menunggu OPS-03 dan tidak menahan rilis kerangka.

Perkiraan: kerangka + migrasi Qontak ≈ 2 hari (Go) + 1,5 hari (backoffice) + 0,5 hari (backend/CDK). Cekat ≈ 1 hari kode + waktu tunggu persetujuan template.

---

## 7. Risiko

| Risiko | Mitigasi |
|---|---|
| Saklar dibalik ke provider yang templatenya belum disetujui → semua OTP gagal | K6: tombol aktif terkunci sampai uji sukses; kartu status menunjukkan gagal dalam menit pertama; balik saklar tanpa deploy |
| bb-comms kehilangan akses DB saat kirim → tidak tahu provider | D-2: cache terakhir; tanpa cache → error eksplisit + DLQ, bukan diam |
| Kredensial bocor lewat log saat debugging adaptor baru | Redaksi di logger untuk kunci `secret`, `password`, `token`; review PR adaptor wajib memeriksa log |
| Izin IAM `bb/prod/wa/*` terlalu luas | Prefix per lingkungan; staging memakai `bb/staging/wa/*` dengan role berbeda |
| Dua orang mengubah setting bersamaan | `app_settings` menang yang terakhir; audit log memperlihatkan keduanya; cukup untuk volume ops sekarang |
| Env `QONTAK_*` dan `app_settings` berbeda selama transisi | Rilis pertama: `app_settings` menang, env hanya fallback kalau key kosong; rilis kedua menghapus env |

---

## 8. Out of scope

- Fallback otomatis antar provider (gagal di A → coba B). Ditinjau setelah ada data gagal per provider dari BO-03.
- Provider per jenis pesan atau per negara.
- Pesan WhatsApp selain OTP (tiket event, pengingat). Kerangka ini siap menerimanya (`Sender` bisa diperluas), tapi template dan kontennya PRD sendiri.
- Form kredensial di backoffice dengan enkripsi KMS. Bisa dibangun nanti; untuk dua–tiga provider setahun, console Secrets Manager cukup.
- Migrasi nomor WhatsApp Business antar provider (proses Meta, bukan kode).

---

## 9. Temuan review kode (16 Sep 2026)

PRD di atas ditulis sebelum diadu dengan kode. Bagian ini hasil pembacaan
`bb-notification-service/internal/{channel,handler,mq,db}`, `infra/cdk/lib/bb-ecs-stack.ts`,
`prisma/schema.prisma`, dan stack backoffice. §0–§8 **tidak** diedit; §9 dan §10 yang
berlaku kalau keduanya bentrok.

### 9.1 Premis "WhatsApp cuma untuk OTP" sudah kedaluwarsa

§0 dan §1 benar terhadap `main`: `whatsapp.go` di sana tepat **130 baris** dan `SendOTP`
memang satu-satunya pemanggil. Tapi di branch `feat/first-purchase-voucher` (commit
`8d73bf6`) file itu **198 baris** dan ada tipe pesan WhatsApp **kedua**,
`FirstPurchaseVoucher`. Penulis PRD kemungkinan melihat main — branch-nya belum di-push.

Akibatnya antarmuka di K1 salah bentuk:

```go
Sender interface { SendOTP(ctx, phone, name, code) (string, error) }   // TERLALU SEMPIT
```

Kiriman voucher membawa empat body variable, suffix tombol URL, dan template ID yang
berbeda — tidak bisa dinyatakan lewat tanda tangan itu. Mengadopsinya berarti satu method
per tipe pesan, yang justru masalah yang baru dihapus saat `SendOTP` digeneralisasi.

**Pakai `SendTemplate` yang sudah ada sebagai `Sender`:**

```go
SendTemplate(ctx, TemplateInput{TemplateID, Phone, Name, Body []BodyVar, ButtonValue})
```

`SendOTP` tetap pembungkus tipis di atasnya. Kerangka PRD utuh; titik potongnya bergeser
satu lapis. Ini harus benar **sebelum** adaptor Cekat ditulis, atau adaptor itu lahir
dengan bentuk yang salah.

### 9.2 Satu templat per provider tidak cukup

`wa.<p>.otpTemplateId` di §3 mengasumsikan satu templat per provider. Hari ini sudah dua
(`QONTAK_OTP_TEMPLATE_ID` + `QONTAK_FIRST_PURCHASE_VOUCHER_TEMPLATE_ID`), dan §8 sendiri
memperkirakan akan bertambah.

Jadikan peta per tipe pesan: `wa.<p>.template.otp`, `wa.<p>.template.firstPurchaseVoucher`.
Kalau tidak, setiap jenis pesan baru memaksa key skema baru. Ini juga menguatkan K2 —
templat voucher kategori **MARKETING** dan lolos review Meta terpisah dari templat OTP,
persis kasus "ditolak Meta berarti deploy" yang PRD ingin hilangkan.

### 9.3 Tidak ada pola endpoint internal untuk ditiru

BE-03 menyebut "bearer internal seperti endpoint internal lain". Daftar modul mobile-api
tidak punya satu pun `/api/internal/*` — yang ada `webhook`, dan masing-masing webhook
punya auth sendiri (callback token Xendit, HMAC Didit, bearer RevenueCat).

Jadi BE-03 adalah **permukaan auth baru**: skema token, tempat penyimpanannya, dan siapa
yang boleh memanggil semuanya masih harus diputuskan. Ukuran S terlalu optimis selama itu
belum diputuskan.

### 9.4 BE-04 menjadikan bb-comms penulis `app_settings`

Klaim §1 "bb-comms belum pernah membaca `app_settings`" **benar** — satu-satunya penyebutan
ada di komentar `sale_alert.go`, dan yang membaca nilainya adalah produsen, bukan bb-comms.

BE-04 mengubahnya jadi penulis tabel milik Prisma. Alasannya sah (CDK sengaja melepas rilis
bb-comms dari mobile-api lewat `commsImageTag`, jadi daftar hardcode di backoffice bisa
mendahului deploy). Tapi tulis-saat-start punya dua sisi buruk: **rollback bb-comms
meninggalkan daftar basi** — backoffice menawarkan provider yang kode live-nya tidak punya
— dan container yang gagal start tidak pernah memperbaruinya. Kalau tetap dipilih, tulis
timestamp + tag image di baris yang sama supaya basi bisa terlihat.

### 9.5 `taskRole` dipakai bersama lima service — blocker BE-02

BE-02 menulis "task role bb-comms mendapat `secretsmanager:GetSecretValue`". **Tidak ada
task role bb-comms.** Ada satu `taskRole` (`bb-ecs-stack.ts:143`) yang dipasang ke lima task
definition: mobile-api (208), comms-relay (275), dua lane cron (305, 415), bb-comms (349).

Memberi izin "ke bb-comms" berarti memberi izin ke **mobile-api** juga. Prefix
`bb/prod/wa/*` membatasi *secret mana*, bukan *siapa* — dan dimensi kedua itu yang jadi
janji K4. Role itu juga sudah longgar: `sqs:*` dan `ses:*` keduanya `resources: ['*']`
dengan TODO dipersempit.

Perbaikannya `commsTaskRole` sendiri untuk bb-comms. Perubahan CDK kecil, tapi tidak ada di
daftar task — kalau tidak ditulis, BE-02 dikerjakan apa adanya dan izinnya melebar diam-diam.

Berlaku sama untuk `ssm:GetParameter` maupun `kms:Decrypt`: **tidak ada opsi penyimpanan
yang menghindari masalah ini.** (Kontras: stack backoffice-bb tidak menyetel `taskRole`
eksplisit, jadi CDK membuatkan role khusus per task — sisi itu bersih.)

### 9.6 Jalur error menulis balasan provider ke database

K3 memindahkan kredensial keluar dari database karena database ikut tersalin ke staging dan
laptop. Jalur gagal yang ada sekarang melakukan kebalikannya:

```go
// internal/mq/consumer.go:174
ProviderResponse: err.Error(),   // → comms_delivery.provider_response
```

dan error Qontak membawa **body respons mentah**:

```go
fmt.Errorf("qontak token request failed: %d %s", res.StatusCode, raw)
```

Kegagalan token menulis balasan mentah endpoint OAuth ke Postgres **dan** CloudWatch. Body
permintaan (berisi `client_secret` + `password`) tidak ikut, tapi banyak endpoint OAuth
memantulkan nama field atau `client_id`, dan adaptor provider baru belum diketahui
memantulkan apa.

Baris risiko PRD cuma menyebut "bocor lewat log". Yang lebih menggigit adalah **kolom
database**, karena itu persis ancaman yang dipakai K3 untuk membenarkan Secrets Manager.
Perlu satu task: potong + saring `provider_response` sebelum disimpan, dan wajibkan review
adaptor memeriksa apa yang masuk `err.Error()` — bukan hanya apa yang masuk logger.

### 9.7 Koreksi kecil

- **§3 "seed-settings.ts insert-only"** — sebenarnya upsert dengan
  `ON CONFLICT DO UPDATE SET description`. Nilainya memang tidak tertimpa (maksud PRD
  terpenuhi), tapi kalimatnya salah. Praktis penting di sini: menjalankan ulang seed setelah
  ops mengubah `wa.provider` tidak akan mereset pilihan ops.
- **D-3 `settings.comms`** — `setup-auth.ts` di backoffice menimpa permission role sistem
  setiap `db:setup`. Permission baru harus ditambahkan di script itu, bukan lewat UI Roles,
  atau hilang di setup berikutnya.
- **K6 "uji sukses"** — `comms_delivery.status` hanya `SENT | FAILED`, dan `SENT` berarti
  **provider menerima broadcast**, bukan pesan sampai ke HP. Gerbangnya tetap layak
  (membuktikan kredensial + template ID diterima), tapi jangan ditulis sebagai bukti sampai.
  Yang membuktikan sampai adalah manusia yang memegang nomor uji.
- **COMMS-03 "refresh saat 401/403 dari provider"** — untuk Qontak, kredensial salah tidak
  muncul di panggilan kirim; dia gagal lebih dulu di `getToken`, panggilan terpisah yang
  menjawab `qontak token request failed`. Pemicunya harus "pengambilan token gagal". Provider
  lain bisa berbeda — ini bagian kontrak adaptor, bukan satu aturan global.

### 9.8 Yang terverifikasi benar

Seluruh klaim §1 lainnya cocok dengan kode: tujuh env `QONTAK_*`, kolom `comms_delivery`
persis seperti didaftar dan memang tanpa kolom provider, perakitan di `main.go`, dan
**bb-comms memang tidak punya akses Secrets Manager saat runtime** — CDK menyuntikkan secret
sebagai env lewat execution role, bukan memberi task role izin baca. Jadi BE-02 pekerjaan
nyata, bukan formalitas.

K3 (kredensial di Secrets Manager, DB cuma simpan `secretRef`) kuat, dan alasannya —
"database disalin ke staging dan laptop" — persis alasan yang sudah dipakai untuk kunci
token order event di repo ini. K7 + rencana transisi (env jadi fallback satu rilis, baru
dihapus) juga benar.

---

## 10. Keputusan scope: kredensial tetap di env dulu (16 Sep 2026)

**Keputusan:** rilis pertama menaruh kredensial provider di **env**, bukan Secrets Manager.
Yang dibuktikan dulu adalah saklarnya bekerja; penyimpanan yang bisa dirotasi menyusul.

Sifat yang membuat ini aman untuk ditunda: **dengan kredensial di env, pergantian provider
tetap nol deploy.** Env hanya dibutuhkan saat *menambah* provider baru — dan menambah
provider sudah butuh deploy untuk adaptornya (K1). Jadi yang benar-benar tertunda hanya
**rotasi**, bukan tujuan utama PRD.

Biaya bukan alasannya. Angka terverifikasi di halaman pricing AWS (16 Sep 2026):
Parameter Store standard **$0**, Secrets Manager **$0,40/secret/bulan**, KMS
**$1/key/bulan** (20.000 request/bulan gratis). Untuk tiga provider seluruh rentangnya
sekitar satu dolar sebulan — tidak ada keputusan arsitektur yang layak diambil untuk itu.

### Ditunda

COMMS-03 (pembaca Secrets Manager), BE-02 (izin IAM), OPS-01 (buat `bb/prod/wa/qontak`),
K3/K4 sebagai implementasi. Blocker `taskRole` (§9.5) ikut tertunda bersamanya — tapi
dia kembali utuh saat pemindahan dilakukan, opsi penyimpanan apa pun yang dipilih nanti.

### Tetap dikerjakan

COMMS-01, COMMS-02, COMMS-04, COMMS-06, BE-01, BE-03, BE-04, BO-01..BO-03 — dengan
perbaikan §9.1 (bentuk `Sender`) dan §9.2 (templat per tipe pesan).

Pembagiannya jadi:

```
app_settings (tidak rahasia)          env (rahasia)
  wa.provider                           QONTAK_CLIENT_ID / SECRET / USERNAME / PASSWORD
  wa.<p>.baseUrl                        CEKAT_*  (saat adaptornya dibuat)
  wa.<p>.channelIntegrationId
  wa.<p>.template.<tipe>
```

### Satu hal yang harus benar sekarang

Kredensial dibaca lewat **satu antarmuka**, walaupun isinya dari env:

```go
type Credentials interface {
    For(provider string) (map[string]string, error)
}
// sekarang: envCredentials{}  → baca QONTAK_*, CEKAT_*
// nanti:    smCredentials{}   → GetSecretValue / GetParameter / kms:Decrypt
```

Kalau adaptor memanggil `os.Getenv` langsung, pemindahan nanti menyentuh **setiap** adaptor.
Lewat satu antarmuka, pemindahannya satu file baru + satu baris di `main.go`.

Sebaliknya: **jangan** menambahkan key `wa.<p>.secretRef` sekarang. Key yang tidak dibaca
siapa pun hanya membingungkan; tambahkan saat pemindahannya benar-benar dilakukan.

### Naik prioritas karena keputusan ini

§9.6 (`provider_response` menulis balasan provider ke database) sebaiknya masuk rilis
pertama. Dengan kredensial di env, jalur itu jadi **satu-satunya** yang bisa memuntahkan
sesuatu dari percakapan auth ke tempat yang tersalin ke staging dan laptop. Perbaikannya
murah.

### Ukuran

"2 hari Go" dipatok untuk antarmuka satu-method dan satu templat per provider. Dengan dua
tipe pesan dan peta templat per tipe, tambahkan ±0,5 hari. BE-03 bisa lebih lama kalau skema
auth internalnya masih harus dirancang. Sebaliknya, menunda COMMS-03 + BE-02 mengembalikan
kira-kira sebanyak itu.

---

## 11. Status implementasi — kerangka switch (16 Sep 2026)

Slice pertama selesai: **COMMS-01, COMMS-02, COMMS-04 (sisi Go), BE-01**. Cukup untuk
membuktikan pergantian provider bekerja dengan membalik satu baris `app_settings`.
Belum di-commit di repo mana pun.

### 11.1 bb-comms (branch `feat/first-purchase-voucher`)

Dibangun di atas branch itu, bukan `main`, karena `SendTemplate` — yang jadi dasar bentuk
`Sender` (§9.1) — hanya ada di sana.

| Berkas | Isi |
|---|---|
| `internal/channel/wa/sender.go` | `Sender`, `Message`, `BodyVar`, konstanta tipe pesan |
| `internal/channel/wa/credentials.go` | seam `Credentials` + `EnvCredentials` |
| `internal/channel/wa/qontak.go` | adaptor Qontak (pindahan dari `channel/whatsapp.go`) |
| `internal/channel/wa/registry.go` | pemilih provider + cache 60 dtk + resolusi template |
| `internal/channel/wa/phone.go` | dipindah dari `channel/` (cuma dipakai jalur WA) |
| `internal/db/settings.go` | `SettingsByPrefix` — baca `wa.*` dari `app_settings` |
| `internal/channel/whatsapp.go` | **dihapus** |

Handler tidak lagi menyebut provider maupun template id:

```go
provider, pr, err := h.WA.Send(ctx, wa.TypeOTP, wa.Message{...})
```

`Result` bertambah `Provider`, diteruskan `consumer.go` ke `comms_delivery.provider`.

### 11.2 Keputusan yang diambil saat implementasi

**`Sender` menerima `templateID` sebagai argumen**, bukan menyimpannya. Satu provider
melayani beberapa tipe pesan, dan pasangan tipe↔template adalah konfigurasi, bukan kode.

**`EnvCredentials` memindai prefix `<PROVIDER>_`**, bukan daftar key per provider. Provider
baru tidak butuh perubahan apa pun di seam itu, dan key yang hilang dilaporkan **sekaligus**
dengan nama lengkapnya (`require()`) — operator yang mengisi provider baru dapat satu daftar,
bukan empat ronde "sekarang yang ini juga".

**Adaptor dibangun ulang hanya saat konfigurasinya berubah**, dideteksi lewat `fingerprint`.
Tanpa itu token OAuth Qontak dibuang tiap 60 detik. Settings dibandingkan **per nilai**
(host baru dengan panjang sama harus terdeteksi — itu persis bentuk URL failover);
kredensial dibandingkan **per panjang saja**, supaya rahasianya tidak pernah disalin ke
variabel lain. Konsekuensi yang diterima: rotasi ke nilai berpanjang sama tidak terdeteksi
sampai restart — aman, karena token lama tetap berlaku sampai provider mencabutnya, dan
pencabutan itu muncul sebagai error auth.

**Template id kosong bukan error di registry.** Artinya diserahkan ke adaptor — Qontak
memperlakukannya sebagai skip ber-log, bukan DLQ. Memutuskannya di registry akan mencabut
penilaian itu dari satu-satunya lapisan yang tahu.

**`provider` NULL ≠ "provider tidak diketahui".** Kosong untuk email, dan untuk kegagalan
yang terjadi sebelum provider sempat dipilih. Yang terbaca: "belum sampai ke sana".

### 11.3 §9.6 ikut diperbaiki

Dua perubahan, keduanya kecil:

- `getToken` **tidak lagi memuat body respons** di error-nya. Itu balasan endpoint yang baru
  saja diberi empat kredensial, dan errornya mendarat di `comms_delivery.provider_response`
  plus CloudWatch. Statusnya saja sudah cukup untuk operator.
- `consumer.go` memotong `provider_response` di 500 karakter, di jalur sukses maupun gagal.
  Batas kerusakan kalau adaptor berikutnya lalai.

Body penolakan **broadcast** tetap disimpan (dipotong): itu soal pesannya — template id
salah, nomor salah — bukan soal kredensial, dan operator memang membutuhkannya.

### 11.4 backend (branch `hotfix/aff-code-register-phone`)

- Migrasi `20260916120000_comms_delivery_provider` — kolom `provider` + indeks
  `(provider, created_at)` untuk laporan 24 jam.
- `prisma/seed-settings.ts` + 5 key `wa.*`. `wa.qontak.template.firstPurchaseVoucher`
  sengaja kosong (template MARKETING-nya belum lolos Meta).
- CDK: tiga env `QONTAK_*` yang bukan rahasia **dihapus** dari container bb-comms
  (`BASE_URL`, `CHANNEL_INTEGRATION_ID`, `OTP_TEMPLATE_ID`) — sudah pindah ke
  `app_settings`. Empat kredensialnya tetap. Key lamanya dibiarkan di `bb/prod/app`,
  tidak dibaca siapa pun.

**Tidak ada fallback ke env untuk settings.** Kalau `wa.provider` kosong, setiap kiriman
WhatsApp gagal dengan pesan yang menyebut key-nya, dan masuk DLQ (bisa di-replay). Itu
sebabnya urutan OPS-02 mengikat: **seed dulu, baru deploy bb-comms.**

### 11.5 Verifikasi

- bb-comms: `gofmt` bersih, `go build`, `go vet`, `go test ./internal/...` hijau. 11 tes
  registry baru menutup acceptance COMMS-02 — ganti provider tanpa deploy, cache benar-benar
  meng-cache, DB gagal → config terakhir, tanpa cache → error eksplisit, provider tak dikenal
  → error yang menyebut yang tersedia, `SendVia` mengabaikan yang aktif.
- backend: `pnpm typecheck` hijau, `pnpm test` 1003/1004 — satu yang gagal adalah time-bomb
  `topic-digest` yang sudah dibuktikan pra-eksisting. Migrasi terpasang di DB tes.

### 11.6 Belum dikerjakan

- **COMMS-06 `OtpTest` + `providerOverride`** di kontrak SQS. `SendVia` sudah ada dan sudah
  diuji, jadi sisanya tinggal tipe pesan + field kontrak (dua repo harus sinkron).
- **BE-03 / BE-04** endpoint internal — masih menunggu keputusan skema auth (§9.3).
- **BO-01..03** halaman backoffice.
- **COMMS-05** adaptor Cekat — menunggu akun (OPS-03). Menambahkannya sekarang satu file
  + satu baris di map `builders`.
- **Uji pergantian sungguhan** butuh provider kedua. Dengan satu adaptor, yang terbukti baru
  resolusi + cache-nya (lewat tes), bukan dua provider nyata bergantian.

---

## 12. Dua bagian PRD yang dibuang, dan sisanya selesai (16 Sep 2026)

Setelah §11, sisa task tampak terblokir pada BE-03/BE-04. Ternyata tidak — keduanya
**tidak perlu ada**, dan tanpa keduanya seluruh backoffice bisa dikerjakan.

### 12.1 BE-03 (endpoint internal untuk kiriman uji) — dibuang

PRD ingin backoffice memanggil endpoint internal di mobile-api yang lalu menerbitkan
pesan ke SQS. Itu mengharuskan skema auth internal baru (§9.3), dan ternyata mubazir:
**backoffice sudah menulis `notification_outbox` langsung** — persis yang dilakukan
tombol kirim-ulang voucher. Baris itu mengalir lewat comms-relay → SQS → bb-comms,
yaitu jalur produksi yang sama yang PRD ingin pastikan ("yang diuji adalah jalur yang
sama dengan produksi").

Jadi: nol endpoint baru, nol permukaan auth baru, nol keputusan yang tertunda.

### 12.2 BE-04 (endpoint daftar provider) — tinggal separuhnya

Alasannya sah (bb-comms rilis terpisah dari mobile-api lewat `commsImageTag`, jadi
daftar hardcode bisa mendahului deploy), tapi endpointnya tidak: **backoffice membaca
`app_settings` langsung**, sama seperti `setShopBaseUrl`. Yang tersisa cuma sisi
bb-comms — `Registry.PublishSupported` menulis `wa.supportedProviders` saat start.

### 12.3 `providerOverride` pindah ke payload

PRD menaruhnya sebagai field top-level pesan SQS. Relay (`comms-relay.ts`) memetakan
tepat `{type, channel, refId, recipient, payload}` dari `notification_outbox` — field
top-level berarti **kolom baru + migrasi + perubahan relay** demi satu string untuk satu
jenis pesan. Dipindah ke `payload.provider`; `CONTRACT_VERSION` tetap 1.

### 12.4 Yang selesai

**bb-comms** — `OtpTest` (kode acak, tidak pernah masuk `otp_codes`, wajib menyebut
provider, khusus kanal whatsapp), `SendVia` dipakai hanya oleh handler itu sehingga
override tidak mungkin membelokkan OTP sungguhan, dan `PublishSupported` saat start.
5 tes baru.

**backoffice** — `lib/wa-provider-queries.ts`, dua route API, halaman
`/settings/whatsapp`, permission `settings.comms`, sidebar + command palette.
Penguncian K6 nyata: tombol "Jadikan aktif" mati sampai ada `OtpTest` berstatus `SENT`
untuk provider itu dalam 24 jam terakhir, dibaca dari `comms_delivery`. Route `PUT` juga
**menolak provider yang tidak ada di `wa.supportedProviders`** — tanpa itu satu typo
mematikan seluruh kiriman WhatsApp sampai ada yang sadar.

Provider aktif selalu ditampilkan walau tidak ada di daftar supported: justru keadaan
itu yang paling perlu terlihat, karena artinya kiriman WhatsApp sedang gagal semua.

### 12.5 Verifikasi

bb-comms `gofmt`/`build`/`vet`/`test` hijau (16 tes WA). Backend `typecheck` hijau.
Backoffice `next build` "Compiled successfully" lalu berhenti di 11 error `infra/cdk`
pra-eksisting (`aws-cdk-lib` tidak terpasang).

### 12.6 Sisa sebenarnya

Satu: **adaptor Cekat**. Spesifikasi API-nya belum bisa dibaca — `docs.cekat.ai` hanya
deskripsi fitur, dan koleksi Postman-nya (`documenter.getpostman.com/view/28427156/...`)
adalah SPA yang tidak terbaca saat di-fetch. Dibutuhkan: skema auth + nama header, base
URL, path endpoint kirim, cara template diidentifikasi, cara variabel + tombol dikirim,
format nomor, dan bentuk error (untuk memetakan permanen vs sementara).

Konsekuensinya: **pergantian dua provider nyata belum pernah diuji.** Yang terbukti baru
resolusi + cache + penguncian, lewat tes.

Dua hal non-teknis yang menentukan jadwal Cekat, keduanya di luar kendali dev:
template harus **disetujui ulang di Meta** di bawah akun Cekat (template tidak berpindah
antar BSP), dan **nomor pengirimnya berbeda** kecuali nomor WhatsApp Business-nya ikut
dimigrasi — proses Meta, dan §8 menaruhnya out of scope. Artinya selama dua provider
hidup berdampingan, member melihat OTP datang dari nomor yang berbeda tergantung saklar.

---

## 13. Cekat: spesifikasi API, diukur langsung (16 Sep 2026)

Dokumentasi publik Cekat tidak cukup untuk menulis adaptor — jadi API-nya dipanggil
langsung dengan kunci di `.env` bb-comms. Semua di bawah ini terverifikasi, bukan dari
dokumen.

### 13.1 Bentuk API

```
base URL   https://api.cekat.ai
auth       header  api_key: <key>          ← statis, BUKAN OAuth seperti Qontak
kirim      POST /templates/send
```

```json
{
  "wa_template_id": "2285965248914372",
  "inbox_id": "ddd687f2-95ce-41ae-b3a1-f30757257d4f",
  "phone_number": "6287875439433",
  "phone_name": "Tes",
  "template_body_variables": ["Rina", "10%", "K7M4XQ2P", "15 Oktober 2026"]
}
```

**`template_body_variables` tidak ada di dokumentasi publik.** Halaman
`api-reference/templates.md` hanya mendaftar empat field pertama dan menyebut tidak ada
field opsional — padahal kiriman tanpa field kelima itu ditolak:

> `Template body variable must match the number of placeholders (4)`

Nama fieldnya ditemukan dengan menyisir kandidat terhadap API sungguhan. Jangan
mengandalkan dokumentasi publik Cekat untuk endpoint ini.

Nomor: internasional tanpa `+` (`6285695209520`) — sama dengan Qontak, jadi `toMsisdn`
dipakai ulang. Hanya template `APPROVED` yang diproses.

### 13.2 Perbedaan bentuk yang menentukan desain adaptor

| | Qontak | Cekat |
|---|---|---|
| Auth | OAuth password grant → token berumur pendek | API key statis di header |
| Kegagalan kredensial muncul di | panggilan token terpisah | panggilan kirim itu sendiri |
| Variabel | array objek `{key, value, value_text}`, **berlabel** | array string, **posisional murni** |
| Tombol URL | dinamis, suffix dikirim saat kirim | **statis di template**, tidak ada parameter |
| Pemilih nomor | `channel_integration_id` | `inbox_id` |

Konsekuensi terpenting: **Cekat tidak punya label parameter sama sekali.** Satu-satunya
yang mengikat nilai ke slot `{{n}}` adalah indeksnya. `orderedBody` karena itu mengurut
berdasarkan `BodyVar.Key`, bukan percaya urutan slice — handler yang menyusun slice-nya
terbalik akan menukar dua nilai, dan kirimannya tetap melaporkan sukses.

`ButtonValue` diabaikan adaptor Cekat: tombolnya melekat di template.

### 13.3 Dua bug yang ketahuan karena ada template sungguhan

Template `first_time_buyer` (APPROVED, MARKETING, 4 variabel) berbunyi:

> Selamat **{{1}}** … Diskon **{{2}}** … Gunakan Kode: **{{3}}** … sampai **{{4}}**

Handler voucher yang ditulis 15 Sep mengirim `{{2}}`=kode, `{{3}}`=nilai — **tertukar**.
Pesannya akan berbunyi "Diskon K7M4XQ2P / Gunakan Kode: 10%", dengan `status = SENT`.
Ditulis terhadap template Qontak yang ternyata belum pernah dibuat; sekarang mengikuti
template yang benar-benar ada.

Ini memunculkan aturan yang tidak ditegakkan apa pun: **urutan variabel adalah kontrak
lintas provider.** Kalau template Qontak dibuat dengan urutan berbeda, satu array
posisional tidak bisa melayani keduanya.

Bug kedua: `1368529094981820` yang sempat dikira template id ternyata **`waba_id`** —
pengenal akun WhatsApp Business. Template id-nya `2285965248914372`. Id numerik Meta
dipakai untuk banyak objek berbeda dan bentuknya tidak membedakan mana yang mana.

### 13.4 Cekat belum bisa mengambil alih OTP

Dari **315** template di akun itu, **nol** berkategori `AUTHENTICATION` yang approved.
Template OTP-nya harus dibuat dari nol dan menunggu Meta — template tidak berpindah antar
BSP karena melekat pada WABA, dan WABA Cekat berbeda dari WABA Qontak.

Sampai itu ada, `wa.cekat.template.otp` kosong, tombol uji (yang memakai template OTP)
akan melewatkan kirimannya, dan penguncian K6 menolak mengaktifkan Cekat. Itu perilaku
yang benar: saklarnya mengatur SEMUA pesan WhatsApp, termasuk OTP.

### 13.5 Yang selesai

`internal/channel/wa/cekat.go` + terdaftar di `builders` + `CEKAT_API_KEY` di CDK +
seed `wa.cekat.*`. `go build`/`vet`/`test` hijau.

Satu tes registry ikut diperbaiki: dia memakai `"cekat"` sebagai contoh provider yang
belum dideploy, dan berhenti menguji apa pun pada hari adaptornya mendarat. Sekarang
memakai nama yang tidak akan pernah jadi provider.

**Prasyarat deploy:** `CEKAT_API_KEY` harus ditambahkan ke secret `bb/prod/app` lebih
dulu — `sm()` merujuk key di dalam secret itu, dan key yang tidak ada membuat task bb-comms
gagal start.

### 13.6 Sisa

Menyalakan Cekat untuk OTP menunggu template AUTHENTICATION-nya. Jalur voucher sudah bisa
diuji lewat Cekat hari ini — tapi lihat §12.6: uji yang lolos dengan template voucher
tidak membuktikan apa pun tentang OTP.
