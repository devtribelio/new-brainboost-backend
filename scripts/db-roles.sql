-- ============================================================
-- BrainBoost prod DB roles
-- Jalankan SEBAGAI bb_admin (master) di database bb_backend (via DBeaver).
-- Ganti semua '<...>' dengan password kuat (simpan di password manager).
-- Urutan: PART 1  →  prisma:deploy sbg bb_migrator  →  PART 2.
-- ============================================================


-- ========== PART 1 — JALANKAN SEKARANG (sebelum migrasi) ==========

-- 1) MIGRATOR (DDL) — role buat jalanin prisma migrate
CREATE ROLE bb_migrator LOGIN PASSWORD '<migrator-pass>';
GRANT CONNECT ON DATABASE bb_backend TO bb_migrator;
GRANT USAGE, CREATE ON SCHEMA public TO bb_migrator;

-- WAJIB: biar bb_admin (rds_superuser, bukan superuser penuh) boleh menjalankan
-- "ALTER DEFAULT PRIVILEGES FOR ROLE bb_migrator" di langkah 4.
-- Tanpa ini → ERROR 42501 "permission denied to change default privileges".
GRANT bb_migrator TO bb_admin;

-- 2) APP (runtime backend / Fargate) — DML only, NO DDL
CREATE ROLE bb_app LOGIN PASSWORD '<app-pass>';
GRANT CONNECT ON DATABASE bb_backend TO bb_app;
GRANT USAGE ON SCHEMA public TO bb_app;

-- 3) DEVELOPER READ-ONLY (group role; login per-orang di langkah 5)
CREATE ROLE dev_ro NOLOGIN;
GRANT CONNECT ON DATABASE bb_backend TO dev_ro;
GRANT USAGE ON SCHEMA public TO dev_ro;
ALTER ROLE dev_ro SET statement_timeout = '30s';   -- query nyasar auto-stop 30s

-- 4) DEFAULT PRIVILEGES — tabel/sequence baru yang dibuat bb_migrator
--    OTOMATIS ke-grant ke bb_app (DML) & dev_ro (read-only)
ALTER DEFAULT PRIVILEGES FOR ROLE bb_migrator IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO bb_app;
ALTER DEFAULT PRIVILEGES FOR ROLE bb_migrator IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO bb_app;
ALTER DEFAULT PRIVILEGES FOR ROLE bb_migrator IN SCHEMA public
  GRANT SELECT ON TABLES TO dev_ro;

-- 5) LOGIN per developer (inherit dev_ro). Tambah/kurangi sesuai tim.
CREATE ROLE dev_budi LOGIN PASSWORD '<pass>' IN ROLE dev_ro;
CREATE ROLE dev_sari LOGIN PASSWORD '<pass>' IN ROLE dev_ro;


-- ========== >>> SEKARANG jalankan migrasi SEBAGAI bb_migrator <<< ==========
--   export DATABASE_URL="postgresql://bb_migrator:<migrator-pass>@localhost:5432/bb_backend?sslmode=require"
--   pnpm prisma:deploy
--   pnpm seed:admin && pnpm seed:settings && pnpm seed:revenuecat-iap
--
--   (Kalau terlanjur migrasi sbg bb_admin, pindahkan ownership dulu:
--      REASSIGN OWNED BY bb_admin TO bb_migrator;  -- hati2: pindah SEMUA objek milik bb_admin)
-- ===========================================================================


-- ========== PART 2 — JALANKAN SETELAH MIGRASI (sbg bb_admin) ==========

-- 6) Safety re-grant untuk tabel yang SUDAH ada
--    (jaga-jaga kalau ada tabel dibuat di luar default-privileges)
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO bb_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO bb_app;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO dev_ro;

-- 7) ANALYTICS read-only — schema `reporting` SAJA (no PII, no tabel mentah)
--    Butuh schema `reporting` (dibuat oleh reporting views, runbook §5).
--    Kalau schema reporting belum ada, lewati blok ini dulu.
CREATE ROLE analytics_ro LOGIN PASSWORD '<analytics-pass>';
GRANT CONNECT ON DATABASE bb_backend TO analytics_ro;
GRANT USAGE ON SCHEMA reporting TO analytics_ro;
GRANT SELECT ON ALL TABLES IN SCHEMA reporting TO analytics_ro;
ALTER DEFAULT PRIVILEGES IN SCHEMA reporting GRANT SELECT ON TABLES TO analytics_ro;
REVOKE ALL ON SCHEMA public FROM analytics_ro;   -- nggak boleh sentuh PII/raw
ALTER ROLE analytics_ro SET statement_timeout = '30s';


-- ========== TOGGLE bb_migrator (dipakai NANTI) ==========
-- Matikan setelah go-live → dev nggak bisa migrasi prod lagi:
--   ALTER ROLE bb_migrator NOLOGIN;
-- Nyalakan lagi pas migrasi terkontrol (idealnya via CI/CD):
--   ALTER ROLE bb_migrator LOGIN;


-- ========== UTIL ==========
-- Hapus developer yang resign:
--   DROP ROLE dev_budi;
-- Lihat siapa lagi konek:
--   SELECT usename, client_addr, state FROM pg_stat_activity ORDER BY usename;
-- Cek daftar role + atributnya:
--   \du     (di psql)  atau  SELECT rolname, rolcanlogin FROM pg_roles ORDER BY 1;
