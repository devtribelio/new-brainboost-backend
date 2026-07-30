import { ERROR_CODES, type ErrorCode } from './error-codes';

/**
 * User-facing copy for every error code — Bahasa Indonesia, ready to display.
 *
 * The mobile client renders `error.message` verbatim; it does not translate and
 * does not build its own copy. So this file IS the product copy for error
 * states. Treat a change here as a UI change.
 *
 * STYLE (follows the Indonesian messages that already existed in the repo, e.g.
 * "Saldo belum mencukupi untuk verifikasi KYC", "Rekening belum diisi"):
 * - Netral, tanpa kata ganti ("Anda"/"kamu") — the app addresses nobody directly.
 * - Sentence case, tanpa titik di akhir.
 * - Jelaskan KONDISI dan, kalau ada, langkah berikutnya. Bukan nama field.
 * - JANGAN sisipkan nilai dinamis (limit, input user, enum internal). Itu masuk
 *   `details` di call site — see ERROR_CODES docs.
 *
 * The `Record<ErrorCode, string>` type means adding a code without copy is a
 * compile error, so no code can ever fall back to an English placeholder.
 *
 * EXCEPTION — server-to-server codes at the bottom stay in English. Those
 * responses go to Xendit / Didit / RevenueCat / the ingestion caller, never to
 * a human, and provider dashboards are English.
 */
export const ERROR_MESSAGES: Record<ErrorCode, string> = {
  // --- generic fallbacks -----------------------------------------------------
  BAD_REQUEST: 'Permintaan tidak valid',
  UNAUTHORIZED: 'Sesi tidak valid, silakan masuk kembali',
  FORBIDDEN: 'Tidak memiliki akses untuk tindakan ini',
  NOT_FOUND: 'Data yang diminta tidak ditemukan',
  CONFLICT: 'Data sudah ada',
  UNPROCESSABLE_ENTITY: 'Permintaan tidak dapat diproses',
  TOO_MANY_REQUESTS: 'Terlalu banyak permintaan, coba lagi beberapa menit lagi',
  INTERNAL_ERROR: 'Terjadi kesalahan pada sistem, coba lagi nanti',
  VALIDATION_ERROR: 'Ada data yang belum benar, periksa kembali isian',
  ID_FORMAT_INVALID: 'Data yang diminta tidak ditemukan',
  RELATED_RESOURCE_INVALID: 'Data terkait tidak valid',

  // --- session / token -------------------------------------------------------
  AUTH_REQUIRED: 'Silakan masuk terlebih dahulu',
  BEARER_TOKEN_MISSING: 'Silakan masuk terlebih dahulu',
  MEMBER_TOKEN_REQUIRED: 'Silakan masuk terlebih dahulu',
  ACCESS_TOKEN_INVALID: 'Sesi sudah berakhir, silakan masuk kembali',
  REFRESH_TOKEN_INVALID: 'Sesi sudah berakhir, silakan masuk kembali',
  REFRESH_TOKEN_EXPIRED: 'Sesi sudah berakhir, silakan masuk kembali',
  REFRESH_TOKEN_REQUIRED: 'Sesi sudah berakhir, silakan masuk kembali',
  SESSION_REVOKED: 'Sesi telah diakhiri, silakan masuk kembali',

  // --- credentials / grants --------------------------------------------------
  INVALID_CREDENTIALS: 'Email atau kata sandi salah',
  CREDENTIALS_REQUIRED: 'Email dan kata sandi wajib diisi',
  INVALID_CLIENT_CREDENTIALS: 'Aplikasi tidak dikenali',
  CLIENT_CREDENTIALS_REQUIRED: 'Aplikasi tidak dikenali',
  UNSUPPORTED_GRANT_TYPE: 'Metode masuk tidak didukung',
  CLIENT_CREDENTIALS_DISABLED: 'Metode masuk tidak didukung',
  MEMBER_INACTIVE: 'Akun belum aktif atau sudah dinonaktifkan',
  PASSWORD_INCORRECT: 'Kata sandi lama tidak sesuai',
  PASSWORD_CONFIRMATION_MISMATCH: 'Konfirmasi kata sandi tidak sama',
  PASSWORD_MUST_DIFFER: 'Kata sandi baru harus berbeda dari kata sandi lama',

  // --- social sign-in --------------------------------------------------------
  SOCIAL_SIGNIN_NOT_CONFIGURED: 'Metode masuk ini belum tersedia',
  SOCIAL_PROVIDER_UNSUPPORTED: 'Metode masuk ini belum tersedia',
  SOCIAL_TOKEN_REQUIRED: 'Proses masuk tidak lengkap, coba lagi',
  GOOGLE_ID_TOKEN_INVALID: 'Gagal masuk dengan Google, coba lagi',
  GOOGLE_EMAIL_NOT_VERIFIED: 'Email Google belum terverifikasi',
  APPLE_ID_TOKEN_INVALID: 'Gagal masuk dengan Apple, coba lagi',
  EMAIL_IN_USE_UNVERIFIED:
    'Email ini sudah terdaftar tapi belum diverifikasi, selesaikan verifikasi terlebih dahulu',

  // --- registration / account identity ---------------------------------------
  ACCOUNT_NOT_REGISTERED: 'Akun tidak ditemukan',
  EMAIL_ALREADY_REGISTERED: 'Email sudah terdaftar',
  PHONE_ALREADY_REGISTERED: 'Nomor telepon sudah terdaftar',
  USERNAME_ALREADY_REGISTERED: 'Nama pengguna sudah terdaftar',
  EMAIL_OR_PHONE_ALREADY_REGISTERED: 'Email atau nomor telepon sudah terdaftar',
  EMAIL_OR_PHONE_REQUIRED: 'Email atau nomor telepon wajib diisi',

  // --- contact verification --------------------------------------------------
  EMAIL_ALREADY_VERIFIED: 'Email sudah terverifikasi',
  PHONE_ALREADY_VERIFIED: 'Nomor telepon sudah terverifikasi',
  EMAIL_NOT_ON_FILE: 'Akun ini belum memiliki email',
  PHONE_NOT_ON_FILE: 'Akun ini belum memiliki nomor telepon',
  CONTACT_NOT_ON_FILE: 'Akun ini belum memiliki email atau nomor telepon',
  EMAIL_LOCKED_AFTER_VERIFICATION: 'Email sudah terverifikasi dan tidak dapat diubah',
  EMAIL_TAKEN_BY_OTHER_MEMBER: 'Email sudah digunakan akun lain',
  PHONE_TAKEN_BY_OTHER_MEMBER: 'Nomor telepon sudah digunakan akun lain',
  EMAIL_INVALID: 'Format email tidak valid',
  PHONE_INVALID: 'Format nomor telepon tidak valid',

  // --- OTP -------------------------------------------------------------------
  OTP_NOT_FOUND: 'Kode verifikasi tidak ditemukan atau sudah digunakan',
  OTP_EXPIRED: 'Kode verifikasi sudah kedaluwarsa, minta kode baru',
  OTP_INVALID: 'Kode verifikasi salah',
  OTP_LOCKED: 'Terlalu banyak percobaan salah, minta kode baru',
  OTP_RESEND_TOO_SOON: 'Kode verifikasi sudah dikirim, tunggu sebentar sebelum meminta lagi',
  OTP_DAILY_LIMIT_REACHED: 'Batas permintaan kode hari ini sudah tercapai, coba lagi besok',
  OTP_PURPOSE_UNKNOWN: 'Permintaan kode verifikasi tidak valid',

  // --- profile ---------------------------------------------------------------
  MEMBER_NOT_FOUND: 'Akun tidak ditemukan',
  TARGET_MEMBER_NOT_FOUND: 'Akun yang dituju tidak ditemukan',
  MEMBER_MUTED: 'Akun sedang dibisukan',
  FULL_NAME_INVALID: 'Nama lengkap harus 4-100 karakter',
  GENDER_INVALID: 'Jenis kelamin tidak valid',
  BIRTHDATE_INVALID: 'Tanggal lahir tidak valid',
  AGE_BELOW_MINIMUM: 'Usia minimal 13 tahun',

  // --- account lifecycle -----------------------------------------------------
  CONFIRMATION_REQUIRED: 'Konfirmasi diperlukan untuk melanjutkan',
  DELETION_NOT_SCHEDULED: 'Akun tidak sedang dalam proses penghapusan',
  DEVICE_NOT_REGISTERED: 'Perangkat belum terdaftar',

  // --- affiliate -------------------------------------------------------------
  AFFILIATOR_CODE_REQUIRED: 'Kode afiliasi wajib diisi',
  AFFILIATOR_CODE_NOT_FOUND: 'Kode afiliasi tidak ditemukan',
  AFFILIATE_SELF_CONNECT: 'Tidak dapat menggunakan kode afiliasi sendiri',
  AFFILIATE_MODE_REQUIRED: 'Mode afiliasi wajib dipilih',
  AFFILIATE_MODE_INVALID: 'Mode afiliasi tidak valid',
  AFFILIATE_PROGRAM_CODE_REQUIRED: 'Kode program wajib diisi',
  AFFILIATE_PROGRAM_NOT_FOUND: 'Program afiliasi tidak ditemukan',
  AFFILIATE_PROGRAM_INACTIVE: 'Program afiliasi sudah tidak aktif',
  AFFILIATE_PROGRAM_NAME_REQUIRED: 'Nama program wajib diisi',
  AFFILIATE_ENROLL_PARAMS_REQUIRED: 'Kode program dan kode afiliasi wajib diisi',

  // --- KYC -------------------------------------------------------------------
  KYC_NOT_APPROVED: 'KYC belum disetujui',
  KYC_EXPIRED: 'KYC perlu diperbarui',
  KYC_IN_REVIEW: 'KYC sedang ditinjau',
  KYC_ALREADY_APPROVED: 'KYC sudah disetujui',
  KYC_BALANCE_INSUFFICIENT: 'Saldo belum mencukupi untuk verifikasi KYC',
  KYC_REVERIFY_REQUIRED: 'Pencairan besar memerlukan verifikasi KYC ulang',
  KYC_PROVIDER_NOT_CONFIGURED: 'Layanan verifikasi KYC belum tersedia',

  // --- disbursement ----------------------------------------------------------
  BANK_ACCOUNT_MISSING: 'Rekening belum diisi',
  DISBURSEMENT_ALREADY_PENDING: 'Masih ada permintaan pencairan yang diproses',
  DISBURSEMENT_NOT_ELIGIBLE: 'Pencairan belum dapat diajukan',
  DISBURSEMENT_AMOUNT_EXCEEDS_BALANCE: 'Jumlah melebihi saldo yang dapat dicairkan',
  DISBURSEMENT_BELOW_MIN_BALANCE: 'Saldo belum mencapai batas minimal pencairan',
  DISBURSEMENT_NET_TOO_SMALL: 'Jumlah pencairan terlalu kecil setelah biaya admin',

  // --- commerce --------------------------------------------------------------
  TRANSACTION_NOT_FOUND: 'Transaksi tidak ditemukan',
  TRANSACTION_NOT_OWNED: 'Transaksi ini bukan milik akun ini',
  TRANSACTION_NOT_PENDING: 'Transaksi ini sudah tidak dapat dibayar',
  TRANSACTION_NOT_CANCELABLE: 'Transaksi ini sudah tidak dapat dibatalkan',
  TRANSACTION_EXPIRED: 'Transaksi sudah kedaluwarsa',
  PAYMENT_IN_PROGRESS: 'Pembayaran sedang diproses, coba lagi sesaat',
  PRODUCT_NOT_FOUND: 'Produk tidak ditemukan',
  PRODUCT_NOT_AVAILABLE: 'Produk sudah tidak tersedia',
  PRODUCT_CODE_REQUIRED: 'Kode produk wajib diisi',
  VOUCHER_INVALID: 'Voucher tidak dapat digunakan',
  VOUCHER_EXHAUSTED: 'Kuota voucher sudah habis',

  // --- media -----------------------------------------------------------------
  MEDIA_TOKEN_MISSING: 'Media tidak dapat diakses, muat ulang halaman',
  MEDIA_TOKEN_INVALID: 'Media tidak dapat diakses, muat ulang halaman',
  MEDIA_TOKEN_EXPIRED: 'Akses media sudah kedaluwarsa, muat ulang halaman',
  MEDIA_AUTH_REQUIRED: 'Silakan masuk untuk mengakses media ini',
  MEDIA_RESOLUTION_INVALID: 'Kualitas video tidak tersedia',
  COURSE_NOT_ENROLLED: 'Belum terdaftar di kelas ini',

  // --- upload ----------------------------------------------------------------
  UPLOAD_FILE_MISSING: 'Tidak ada berkas yang diunggah',
  UPLOAD_EXTENSION_NOT_ALLOWED: 'Tipe berkas tidak didukung',
  UPLOAD_NOT_IMAGE: 'Hanya berkas gambar yang dapat diunggah',
  UPLOAD_IMAGE_INVALID: 'Berkas gambar tidak dapat dibaca',

  // --- post ------------------------------------------------------------------
  POST_NOT_FOUND: 'Postingan tidak ditemukan',
  POST_ID_REQUIRED: 'Postingan tidak dipilih',
  POST_EMPTY: 'Postingan harus berisi teks, gambar, atau video',
  POST_CONTENT_TOO_LONG: 'Isi postingan terlalu panjang',
  POST_TOO_MANY_IMAGES: 'Jumlah gambar melebihi batas',
  POST_DUPLICATE: 'Postingan serupa baru saja dikirim, tunggu beberapa menit',
  POST_NOT_PUBLISHED: 'Postingan belum dipublikasikan',
  POST_DELETE_FORBIDDEN: 'Tidak memiliki akses untuk menghapus postingan ini',
  POST_CATEGORY_REQUIRED: 'Kategori postingan wajib dipilih',

  // --- comment ---------------------------------------------------------------
  COMMENT_NOT_FOUND: 'Komentar tidak ditemukan',
  COMMENT_DELETED: 'Komentar sudah dihapus',
  COMMENT_ID_REQUIRED: 'Komentar tidak dipilih',
  COMMENT_CONTENT_REQUIRED: 'Isi komentar wajib diisi',
  COMMENT_EMPTY: 'Isi komentar wajib diisi',
  COMMENT_CONTENT_TOO_LONG: 'Isi komentar terlalu panjang',
  COMMENT_ON_UNPUBLISHED_POST: 'Postingan ini belum dapat dikomentari',
  COMMENT_NOT_AUTHOR: 'Hanya penulis yang dapat mengubah komentar ini',
  COMMENT_DELETE_FORBIDDEN: 'Tidak memiliki akses untuk menghapus komentar ini',
  PARENT_COMMENT_NOT_FOUND: 'Komentar yang dibalas tidak ditemukan',
  PARENT_COMMENT_POST_MISMATCH: 'Komentar yang dibalas bukan dari postingan ini',

  // --- network ---------------------------------------------------------------
  NETWORK_NOT_FOUND: 'Komunitas tidak ditemukan',
  NETWORK_INACTIVE: 'Komunitas sudah tidak aktif',
  NETWORK_NOT_VISIBLE: 'Komunitas ini tidak dapat diakses',
  NETWORK_IDENTIFIER_REQUIRED: 'Komunitas tidak dipilih',
  NETWORK_MEMBERSHIP_REQUIRED: 'Harus menjadi anggota komunitas terlebih dahulu',
  NETWORK_MEMBER_MUTED: 'Sedang dibisukan di komunitas ini',
  NETWORK_MEMBER_BANNED: 'Sudah dikeluarkan dari komunitas ini',
  NETWORK_HELPDESK_JOIN_FORBIDDEN: 'Komunitas ini tidak dapat diikuti secara langsung',
  NETWORK_TEAM_ONLY: 'Hanya tim komunitas yang dapat mengelola permintaan bergabung',
  JOIN_REQUEST_NOT_FOUND: 'Permintaan bergabung tidak ditemukan',
  JOIN_REQUEST_ALREADY_RESOLVED: 'Permintaan bergabung sudah diproses',
  JOIN_REQUEST_PARAMS_REQUIRED: 'Permintaan bergabung tidak dipilih',
  JOIN_REQUEST_MEMBER_BANNED: 'Akun ini sudah dikeluarkan dari komunitas',

  // --- topic -----------------------------------------------------------------
  TOPIC_NOT_FOUND: 'Topik tidak ditemukan',
  TOPIC_INACTIVE: 'Topik sudah tidak aktif',
  TOPIC_ID_REQUIRED: 'Topik tidak dipilih',
  TOPIC_NETWORK_MISMATCH: 'Topik tidak termasuk dalam komunitas ini',
  TOPIC_PARENT_NETWORK_REQUIRED: 'Harus bergabung ke komunitas induk sebelum mengikuti topik',
  TOPIC_SUBSCRIPTION_REQUIRED: 'Harus mengikuti topik ini sebelum membuat postingan',

  // --- notification ----------------------------------------------------------
  NOTIFICATION_SCOPE_REQUIRED: 'Data notifikasi tidak lengkap',
  NOTIFICATION_SCOPE_INVALID: 'Jenis notifikasi tidak valid',

  // --- report ----------------------------------------------------------------
  REPORT_SELF_FORBIDDEN: 'Tidak dapat melaporkan akun sendiri',
  REPORT_CATEGORY_INVALID: 'Kategori laporan tidak valid',
  REPORT_PARAMS_REQUIRED: 'Data laporan tidak lengkap',

  // --- server-to-server: English on purpose (see file header) ----------------
  INGEST_CREDENTIAL_INVALID: 'Invalid ingestion credential',
  INGEST_EVENT_ID_REQUIRED: 'providerEventId is required',
  INGEST_TYPE_INVALID: 'type must be PURCHASE or REFUND',
  INGEST_REFUND_REFERENCE_REQUIRED: 'refundOfProviderEventId required for REFUND',
  WEBHOOK_SIGNATURE_INVALID: 'Invalid webhook signature',
  WEBHOOK_TOKEN_INVALID: 'Invalid callback token',
  WEBHOOK_AUTH_MISSING: 'Missing RevenueCat authorization',
  WEBHOOK_AUTH_INVALID: 'Invalid RevenueCat authorization',
};

/** Copy for a code. Kept as a function so call sites never index the map directly. */
export function messageFor(code: ErrorCode): string {
  return ERROR_MESSAGES[code] ?? ERROR_MESSAGES[ERROR_CODES.INTERNAL_ERROR];
}
