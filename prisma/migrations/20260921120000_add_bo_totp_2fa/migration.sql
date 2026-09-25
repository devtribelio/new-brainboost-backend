-- Two-factor login (TOTP, RFC 6238) untuk backoffice-bb.
-- Hand-written, idempotent — lanjutan dari 20260622000000_backoffice_tables yang
-- memiliki tabel bo_*. Backoffice belum dimodelkan di schema.prisma.
--
-- Sumber: backoffice-bb db/migrations/2026-09-21-totp.sql (PR #35, feat/totp-2fa).
--
-- Catatan: tidak ada BEGIN/COMMIT eksplisit — Prisma Migrate sudah membungkus
-- tiap file migration dalam satu transaksi.
--
-- LATAR BELAKANG. Login backoffice menjadi password → challenge 5 menit →
-- kode 6 digit dari aplikasi authenticator (atau kode cadangan) → sesi.
-- Wajib untuk semua user ketika env BO_TOTP_KEY terisi (BO_TOTP_REQUIRED=false
-- = sukarela selama masa transisi). Tidak ada permission baru: reset 2FA user
-- lain memakai users.manage yang sudah ada.

-- ============ KOLOM BARU DI bo_users ============
-- totp_secret_enc : AES-256-GCM(secret) dengan kunci turunan dari BO_TOTP_KEY
--                   (env, bukan DB) — dump database saja tidak cukup untuk
--                   membuat kode. Sudah terisi saat MENDAFTAR; yang menandakan
--                   user sudah membuktikan memegang secret adalah totp_enabled_at.
-- totp_enabled_at : NULL = belum aktif. Terisi setelah kode pertama terverifikasi.
-- totp_last_step  : counter 30 detik terakhir yang diterima, supaya kode tidak
--                   bisa di-replay di dalam jendela validitasnya sendiri
--                   (shoulder-surf / proxy phishing).
ALTER TABLE bo_users ADD COLUMN IF NOT EXISTS totp_secret_enc text;
ALTER TABLE bo_users ADD COLUMN IF NOT EXISTS totp_enabled_at timestamptz;
ALTER TABLE bo_users ADD COLUMN IF NOT EXISTS totp_last_step  bigint;

COMMENT ON COLUMN bo_users.totp_secret_enc IS 'Secret TOTP terenkripsi AES-256-GCM dengan BO_TOTP_KEY (env). Terisi sejak mendaftar, belum tentu aktif.';
COMMENT ON COLUMN bo_users.totp_enabled_at IS 'Kapan user membuktikan memegang secret. NULL = 2FA belum aktif.';
COMMENT ON COLUMN bo_users.totp_last_step  IS 'Langkah waktu (30 detik) terakhir yang diterima — kode sekali pakai, anti-replay.';

-- ============ KODE CADANGAN SEKALI PAKAI ============
-- 10 kode per user, format XXXXX-XXXXX (50 bit acak). Disimpan SHA-256, bukan
-- bcrypt: ini bukan password, jadi hash lambat tidak menambah keamanan dan hash
-- cepat membuat verifikasi murah. Dipakai → used_at terisi, baris tidak dihapus.
CREATE TABLE IF NOT EXISTS bo_totp_backup_codes (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES bo_users(id) ON DELETE CASCADE,
  code_hash  text NOT NULL,
  used_at    timestamptz,                    -- NULL = masih bisa dipakai
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS bo_totp_backup_codes_user_idx ON bo_totp_backup_codes (user_id);

COMMENT ON TABLE  bo_totp_backup_codes IS 'Kode cadangan 2FA backoffice. Hanya SHA-256 yang disimpan; plaintext ditampilkan sekali saat dibuat.';
COMMENT ON COLUMN bo_totp_backup_codes.used_at IS 'Terisi saat kode dipakai login. Baris tetap ada demi audit.';

-- ============ CHALLENGE LOGIN (PASSWORD BENAR, KODE BELUM) ============
-- Sengaja BUKAN baris bo_sessions: apa pun yang membaca sesi tidak akan pernah
-- salah mengira login setengah jadi sebagai login penuh.
-- Kunci = hash dari nilai cookie bo_2fa; umur 5 menit, maks 5 percobaan.
CREATE TABLE IF NOT EXISTS bo_login_challenges (
  token_hash text PRIMARY KEY,
  user_id    uuid NOT NULL REFERENCES bo_users(id) ON DELETE CASCADE,
  attempts   integer NOT NULL DEFAULT 0,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
-- Pembersihan challenge kedaluwarsa adalah range scan di expires_at.
CREATE INDEX IF NOT EXISTS bo_login_challenges_expires_idx ON bo_login_challenges (expires_at);

COMMENT ON TABLE  bo_login_challenges IS 'Login backoffice tahap 1 selesai (password benar), menunggu kode 2FA. Bukan sesi.';
COMMENT ON COLUMN bo_login_challenges.token_hash IS 'SHA-256 dari nilai cookie bo_2fa. Plaintext tidak pernah disimpan.';
COMMENT ON COLUMN bo_login_challenges.attempts   IS 'Percobaan kode yang gagal. Maks 5 per challenge.';

-- ---------------------------------------------------------------------------
-- Verifikasi (jalankan manual setelah migrate — bukan bagian dari migration)
-- ---------------------------------------------------------------------------
-- (a) Ketiga kolom baru ada di bo_users?
--   SELECT column_name, data_type FROM information_schema.columns
--    WHERE table_name = 'bo_users' AND column_name LIKE 'totp_%' ORDER BY column_name;
-- (b) Kedua tabel terbentuk?
--   SELECT table_name FROM information_schema.tables
--    WHERE table_name IN ('bo_totp_backup_codes', 'bo_login_challenges') ORDER BY table_name;
-- (c) Indeks terpasang?
--   SELECT tablename, indexname FROM pg_indexes
--    WHERE tablename IN ('bo_totp_backup_codes', 'bo_login_challenges') ORDER BY tablename, indexname;
-- (d) Tabel harus masih kosong — data masuk lewat alur login/pendaftaran, bukan SQL.
--   SELECT (SELECT count(*) FROM bo_totp_backup_codes) AS kode_cadangan,
--          (SELECT count(*) FROM bo_login_challenges)  AS challenge,
--          (SELECT count(*) FROM bo_users WHERE totp_enabled_at IS NOT NULL) AS user_2fa_aktif;
