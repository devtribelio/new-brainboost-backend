/* eslint-disable no-console */
/**
 * Seed default app_settings rows so they're visible/editable. Idempotent — re-running only
 * refreshes the description, NEVER overwrites a value an operator may have changed.
 *
 *   pnpm seed:settings
 */
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const SETTINGS: Array<{ key: string; value: string; description: string }> = [
  {
    key: 'affiliate.cookieDays',
    value: '365',
    description: 'Affiliate attribution cookie lifetime in days (legacy parity: 1 year).',
  },
  {
    key: 'affiliate.holdDays',
    value: '7',
    description: 'Days a commission stays PENDING before becoming withdrawable BALANCE.',
  },
  {
    key: 'affiliate.iapHoldDays',
    value: '35',
    description:
      'Days an IAP-channel commission stays PENDING before BALANCE (longer: covers store refund window).',
  },
  {
    key: 'event.checkoutExpiryMinutes',
    value: '30',
    description:
      'Menit yang diberikan pembeli tiket event untuk membayar sebelum kursinya dilepas kembali. Terpisah dari batas 24 jam checkout kursus: kursus tidak punya kuota, tiket punya.',
  },
  {
    key: 'event.orderPath',
    value: '/event/order',
    description:
      'Path halaman pesanan di web shop, ditempel ke shop.baseUrl untuk membangun redirect setelah pembayaran tiket event (ditambah token ?t=). Ubah di sini kalau route FE pindah — tidak perlu redeploy. CATATAN: hanya memindahkan REDIRECT; link di email tiket dibangun bb-comms dari SHOP_BASE_URL + /event/order/ yang hardcode, jadi email yang sudah terkirim tidak ikut pindah.',
  },
  {
    key: 'shop.baseUrl',
    value: 'https://brainboost.id',
    description:
      'Origin web shop, tanpa slash di akhir. SATU baris yang dipakai bersama: target redirect shortlink /s/:slug, URL di halaman Tracking Link backoffice, dan redirect setelah pembayaran tiket event. Salinan kedua di tempat lain adalah cara redirect mulai menunjuk host yang tidak pernah dilihat operator.',
  },
  {
    key: 'banner.maxVersionAndroid',
    value: '',
    description:
      "Max Android app version (INCLUSIVE) that still sees banners on GET /api/data/banner, e.g. '3.3.0' = shown on 3.3.0 and below, hidden on 3.3.1+. Empty = gate off. Requires the client to send ?platform=android&version=; a build that sends neither always sees banners.",
  },
  {
    key: 'banner.maxVersionIos',
    value: '',
    description:
      "Max iOS app version (INCLUSIVE) that still sees banners on GET /api/data/banner, e.g. '3.3.0' = shown on 3.3.0 and below, hidden on 3.3.1+. Empty = gate off. Separate from Android because App Store review and Play rollout never land together.",
  },
  {
    key: 'disbursement.autoEnabled',
    value: 'false',
    description:
      "Kill-switch for the AUTO payout lane ('true' to enable). false = every payout goes through backoffice approval.",
  },
  {
    key: 'disbursement.autoApproveMax',
    value: '1000000',
    description:
      'Max NET payout (IDR) eligible for auto-approval; anything above always goes MANUAL.',
  },
  {
    key: 'disbursement.fee',
    value: '5000',
    description:
      'Flat platform fee (IDR) deducted from the gross payout (member receives gross - fee).',
  },
  {
    key: 'disbursement.minBalance',
    value: '55000',
    description: 'Minimum withdrawable balance (IDR) required to request a payout (gross >= this).',
  },
  {
    key: 'fx.usdIdr',
    value: '17800',
    description:
      'USD→IDR rate used to normalise foreign-storefront IAP purchases. Acts as the static floor of the resolution chain; promoted to top priority when fx.usdIdrPinned is true.',
  },
  {
    key: 'fx.usdIdrPinned',
    value: 'false',
    description:
      "Pin the USD→IDR rate to fx.usdIdr ('true' to enable), overriding the FX API and RevenueCat-derived rates. Use when the live rate is wrong or the providers are down.",
  },
  {
    key: 'kyc.minBalance',
    value: '55000',
    description:
      'Minimum withdrawable balance (IDR) required before a member may request KYC. 0 = gate off.',
  },
  {
    key: 'notification.unopenedPushLimit',
    value: '0',
    description:
      'Max push sent to a member while they stay out of the app; further push is suppressed (the in-app notification row is still written). Resets when the member opens the app. 0 = gate off (counter still tracked). Ship value is 0 — raise to 3 only after confirming the app calls /member/info on resume, not just cold start.',
  },
  {
    key: 'notification.digestEnabled',
    value: 'false',
    description:
      "Nightly topic digest: one push per member summarising the topic posts they have not read. 'true' to enable. Ships disabled.",
  },
  {
    key: 'notification.digestHour',
    value: '21',
    description:
      'Hour of day (0-23, Asia/Jakarta) the topic digest is sent. The job runs on the hourly cron tick and only acts on this hour, so changing this value moves the send time with no redeploy.',
  },
  {
    key: 'streak.graceDays',
    value: '1',
    description:
      'Listening days a member may miss without the streak resetting to 0, counted back from today (so an old gap is never forgiven retroactively). 0 = strict, no grace. Changing this changes the streak number every shipped app build already displays, so treat it as a product switch, not a tuning knob.',
  },
  {
    key: 'streak.atRiskEnabled',
    value: 'false',
    description:
      "Evening push telling a member their streak is not safe yet. 'true' to enable. Ships disabled — a new outbound message class to the whole active base. Independent of streak.dimmedEnabled.",
  },
  {
    key: 'streak.dimmedEnabled',
    value: 'false',
    description:
      "Morning push telling a member their streak went dim and can still be revived today. 'true' to enable. Independent of streak.atRiskEnabled, and silent regardless while streak.graceDays = 0, since no member can be in the dimmed state then.",
  },
  {
    key: 'streak.atRiskHour',
    value: '21',
    description:
      'Hour (0-23, Asia/Jakarta) the "streak not safe yet" push fires. NOTE: at 21:00 most of the night\'s listening has not started (the histogram peaks at 23:00), so this hour may be too early to carry any signal — check what share of members who eventually qualify have already started by this hour before trusting it.',
  },
  {
    key: 'streak.dimmedHour',
    value: '9',
    description:
      'Hour (0-23, Asia/Jakarta) the "streak dimmed, revive it today" push fires, the morning after a missed day. Only ever has candidates while streak.graceDays > 0.',
  },
  {
    key: 'sales.alertEmail',
    value: '',
    description:
      'Comma-separated email address(es) that receive a SaleAlert email on every successful (non-subscription) sale. Empty = off.',
  },
  // --- voucher pembeli pertama -------------------------------------------------
  // Lima nilai program sengaja DIKOSONGKAN. Angkanya keputusan tim internal lewat
  // backoffice, dan default pilihan dev adalah cara sebuah placeholder diam-diam jadi
  // angka yang benar-benar terkirim. Job menolak menerbitkan apa pun sampai semuanya
  // terisi, jadi seed kosong = program mati dengan aman, bukan program setengah jadi.
  {
    key: 'firstPurchaseVoucher.enabled',
    value: 'false',
    description:
      'Saklar program voucher pembeli pertama. false = job tidak menerbitkan apa pun. Dinyalakan tim internal dari backoffice setelah tipe/nilai/cap/masa berlaku terisi.',
  },
  {
    key: 'firstPurchaseVoucher.launchAt',
    value: '',
    description:
      'ISO datetime. Hanya pembelian kursus berbayar pada atau setelah waktu ini yang dihitung; member yang sudah pernah beli sebelumnya TIDAK pernah dapat. Kosong = job tidak jalan. Diisi otomatis saat program pertama kali dinyalakan dan tidak boleh dimundurkan — tanggal di masa lalu berarti email massal ke ribuan pembeli lama.',
  },
  {
    key: 'firstPurchaseVoucher.type',
    value: '',
    description: "PERCENT | AMOUNT. Kosong = program dianggap belum dikonfigurasi.",
  },
  {
    key: 'firstPurchaseVoucher.value',
    value: '',
    description:
      'Persen (kalau type=PERCENT) atau rupiah (kalau type=AMOUNT). Disalin ke baris voucher saat terbit, jadi mengubahnya tidak mengubah voucher yang sudah dikirim.',
  },
  {
    key: 'firstPurchaseVoucher.maxAmount',
    value: '',
    description:
      'Batas rupiah untuk voucher PERCENT. Kosong = tanpa batas. Satu-satunya nilai program yang boleh kosong.',
  },
  {
    key: 'firstPurchaseVoucher.validityDays',
    value: '',
    description: 'Berapa hari voucher berlaku sejak diterbitkan (ends_at = terbit + N hari).',
  },
  {
    key: 'firstPurchaseVoucher.lastSweepAt',
    value: '',
    description:
      'Watermark sweep, DITULIS OLEH JOB — bukan setelan operator. Jangan diedit manual: memundurkannya menyuruh job memindai ulang (aman, unique guard), memajukannya melewatkan pembeli secara permanen.',
  // --- provider WhatsApp ------------------------------------------------------
  // Provider aktif + template id-nya hidup di sini, BUKAN di env, supaya template
  // yang ditolak Meta atau provider yang bermasalah bisa diganti ops dalam hitungan
  // menit tanpa deploy. Kredensialnya TETAP di env untuk sekarang (lihat
  // docs/wa-provider-switch.md §10) — yang pindah ke sini hanya yang tidak rahasia.
  {
    key: 'wa.provider',
    value: 'qontak',
    description:
      'Provider WhatsApp aktif untuk SEMUA pesan WhatsApp (OTP + voucher). Harus salah satu yang adaptornya sudah dideploy di bb-comms — nama tak dikenal membuat setiap kiriman WhatsApp gagal ke DLQ. Perubahan terbaca bb-comms <= 60 detik, tanpa deploy.',
  },
  {
    key: 'wa.qontak.baseUrl',
    value: 'https://service-chat.qontak.com',
    description: 'Origin API Qontak. Kosong = pakai default di adaptor.',
  },
  {
    key: 'wa.qontak.channelIntegrationId',
    value: '9fe63a0f-e6c7-4a2e-b1ad-d12e69b5706c',
    description: 'Pengenal integrasi channel WhatsApp di Qontak. Bukan rahasia.',
  },
  {
    key: 'wa.qontak.template.otp',
    value: '453e330c-64d6-434c-ba3e-900afd0da366',
    description:
      'ID template OTP di Qontak — UUID terbitan QONTAK, bukan ID numerik Meta (dua namespace berbeda; hanya UUID yang diterima endpoint broadcast). Satu template ini melayani SEMUA keperluan OTP; variabelnya cuma kodenya, jadi pesannya tidak bisa menyebut OTP itu untuk apa.',
  },
  // --- Cekat: provider kedua, adaptornya BELUM ada di bb-comms -----------------
  // Nilai-nilai ini boleh diisi lebih dulu; `wa.provider` tetap qontak sampai
  // adaptornya dideploy DAN ada uji yang berhasil. Memilih 'cekat' sebelum itu
  // ditolak backoffice (tidak ada di `wa.supportedProviders`).
  {
    key: 'wa.cekat.baseUrl',
    value: 'https://api.cekat.ai',
    description: 'Origin API Cekat. Auth-nya API key statis di header `api_key`, bukan OAuth seperti Qontak.',
  },
  {
    key: 'wa.cekat.inboxId',
    value: 'ddd687f2-95ce-41ae-b3a1-f30757257d4f',
    description:
      'Inbox Cekat = SATU nomor WhatsApp Business. Menentukan pesan keluar dari nomor mana — salah inbox berarti OTP datang dari nomor yang bukan nomor resmi, dan itu terkirim tanpa error. Padanan channel_integration_id di Qontak.',
  },
  {
    key: 'wa.cekat.template.otp',
    value: '',
    description:
      'wa_template_id template OTP di Cekat. KOSONG: belum ada template OTP yang disetujui di sana, jadi Cekat belum bisa mengambil alih OTP. Isi setelah templatnya lolos review Meta di bawah akun Cekat — template tidak berpindah antar provider.',
  },
  {
    key: 'wa.cekat.template.firstPurchaseVoucher',
    value: '2285965248914372',
    description:
      "wa_template_id template `first_time_buyer` di Cekat (APPROVED, kategori MARKETING, bahasa id, 4 variabel). Angka — bentuknya berbeda dengan UUID milik Qontak; tiap provider punya namespace sendiri, jadi id ini TIDAK bisa dipakai di baris wa.qontak.*. Jangan tertukar dengan waba_id (1368529094981820), yang menunjuk akun WhatsApp Business, bukan template.",
  },
  {
    key: 'wa.qontak.template.firstPurchaseVoucher',
    value: '',
    description:
      'ID template voucher pembeli pertama di Qontak. Kosong = kiriman WhatsApp-nya dilewati dengan log, bukan DLQ — template ini kategori MARKETING dan harus lolos review Meta dulu. Isi setelah disetujui.',
  },
];

async function main() {
  for (const s of SETTINGS) {
    await prisma.appSetting.upsert({
      where: { key: s.key },
      create: s,
      update: { description: s.description }, // keep operator-set value; refresh description only
    });
    console.log(`seeded ${s.key}`);
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
