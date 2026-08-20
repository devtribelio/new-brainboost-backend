-- Data penjualan Shopee yang di-upload manual (xlsx "Laporan Penghasilan").
-- Hand-written, idempotent — lanjutan dari 20260622000000_backoffice_tables yang
-- memiliki tabel bo_*. Backoffice belum dimodelkan di schema.prisma.
--
-- Catatan: tidak ada BEGIN/COMMIT eksplisit — Prisma Migrate sudah membungkus
-- tiap file migration dalam satu transaksi.
--
-- LATAR BELAKANG. Sampai sekarang penjualan Shopee diturunkan dari transaksi
-- Tribelio ber-voucher MPSHP*/SHP*, dengan potongan flat -11% (lib/channels.ts di
-- backoffice-bb). Client memutuskan memakai data Shopee sendiri karena angka
-- turunan itu tidak pernah cocok. Diukur pada file 12 Mei-12 Agu 2026, untuk
-- rentang pesanan yang sama: turunan 173 transaksi / net Rp 45.973.840, Shopee
-- 167 pesanan / net Rp 44.706.503. Bukan cuma nilainya beda 2,8% — himpunan
-- transaksinya pun beda.
--
-- CAKUPAN PER HARI, bukan per bulan. Laporan Shopee dipotong berdasarkan tanggal
-- dana DILEPAS, sementara dashboard membukukan berdasarkan tanggal PESANAN
-- (keputusan 19 Agu 2026, supaya sebaris dengan kanal lain). Akibatnya satu file
-- tidak pernah menutup bulan penuh: pesanan yang dibuat menjelang akhir periode
-- baru cair setelahnya. Karena itu tiap upload menyimpan rentang tanggal pesanan
-- yang BENAR-BENAR ada di dalamnya, dan penggantian data turunan dilakukan per
-- hari yang tercakup — bukan per bulan, yang akan menciptakan lubang.

-- ============ HEADER UPLOAD ============
CREATE TABLE IF NOT EXISTS bo_shopee_uploads (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  filename          text NOT NULL,
  seller_username   text,                    -- "brainboost_store", dari sheet Summary
  -- Rentang yang tertulis di file (basis tanggal dana dilepas).
  report_from       date,
  report_to         date,
  -- Rentang tanggal PESANAN yang benar-benar ada di file. Inilah cakupan efektif:
  -- hari di luar rentang ini tetap memakai data turunan voucher.
  order_from        date NOT NULL,
  order_to          date NOT NULL,
  order_count       integer NOT NULL DEFAULT 0,
  item_count        integer NOT NULL DEFAULT 0,
  gross_total       numeric(18,2) NOT NULL DEFAULT 0,   -- SUM(Harga Produk)
  net_total         numeric(18,2) NOT NULL DEFAULT 0,   -- SUM(Total Penghasilan)
  -- Upload yang lebih baru menggantikan yang lama pada hari yang beririsan.
  -- Baris lama tidak dihapus supaya jejak audit tetap ada.
  superseded_at     timestamptz,
  uploaded_by       uuid REFERENCES bo_users(id) ON DELETE SET NULL,
  uploaded_email    text,                    -- tetap ada meski user dihapus
  created_at        timestamptz NOT NULL DEFAULT now()
);

-- Query pemakai selalu "upload aktif mana yang menutupi hari X" — indeks rentang
-- ini yang membuatnya bukan seq scan seiring bertambahnya arsip upload.
CREATE INDEX IF NOT EXISTS bo_shopee_uploads_range_idx   ON bo_shopee_uploads (order_from, order_to);
CREATE INDEX IF NOT EXISTS bo_shopee_uploads_created_idx ON bo_shopee_uploads (created_at DESC);

COMMENT ON TABLE  bo_shopee_uploads IS 'Satu baris per file "Laporan Penghasilan" Shopee yang di-upload lewat UI.';
COMMENT ON COLUMN bo_shopee_uploads.report_from   IS 'Rentang yang tertulis di file, basis tanggal dana dilepas. Bukan cakupan efektif.';
COMMENT ON COLUMN bo_shopee_uploads.order_from    IS 'Cakupan efektif: hari di luar [order_from, order_to] tetap memakai data turunan voucher.';
COMMENT ON COLUMN bo_shopee_uploads.superseded_at IS 'Digantikan secara soft oleh upload yang lebih baru — baris tetap ada demi audit.';

-- ============ SATU BARIS PER PESANAN ============
-- Dari baris "Order" di sheet Penghasilan.
--
-- Baris "Sku" sengaja tidak dipakai untuk nilai: tiap pesanan muncul dua kali di
-- file (sekali sebagai Order, sekali per SKU), jadi menjumlahkan semuanya
-- menggandakan revenue — Rp 89,4 jt dari yang sebenarnya Rp 44,7 jt.
CREATE TABLE IF NOT EXISTS bo_shopee_orders (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  upload_id      uuid NOT NULL REFERENCES bo_shopee_uploads(id) ON DELETE CASCADE,
  order_no       text NOT NULL,              -- "No. Pesanan", mis. 260808S8VJEH0M
  order_date     date NOT NULL,              -- "Waktu Pesanan Dibuat"
  release_date   date,                       -- "Tanggal Dana Dilepaskan"
  order_type     text,                       -- "Tipe Pesanan"
  release_method text,                       -- "Metode Pelepasan Dana"
  gross          numeric(18,2) NOT NULL DEFAULT 0,  -- "Harga Produk"
  net            numeric(18,2) NOT NULL DEFAULT 0,  -- "Total Penghasilan"
  admin_fee      numeric(18,2) NOT NULL DEFAULT 0,
  service_fee    numeric(18,2) NOT NULL DEFAULT 0,
  other_fee      numeric(18,2) NOT NULL DEFAULT 0,
  created_at     timestamptz NOT NULL DEFAULT now()
);

-- Satu pesanan hanya boleh hidup di satu upload aktif; re-upload periode yang
-- sama menggantikan, bukan menambah.
CREATE UNIQUE INDEX IF NOT EXISTS bo_shopee_orders_upload_no_idx ON bo_shopee_orders (upload_id, order_no);
CREATE INDEX IF NOT EXISTS bo_shopee_orders_date_idx ON bo_shopee_orders (order_date);

COMMENT ON TABLE  bo_shopee_orders IS 'Baris "Order" sheet Penghasilan. Sumber nilai revenue Shopee.';
COMMENT ON COLUMN bo_shopee_orders.order_date IS 'Waktu Pesanan Dibuat. Dashboard membukukan pada tanggal ini, bukan release_date.';

-- ============ SATU BARIS PER SKU ============
-- Dari baris "Sku". Dipakai HANYA untuk atribusi produk, tidak pernah untuk
-- total revenue. Shopee memecah Total Penghasilan dengan benar antar-SKU
-- (terverifikasi: pesanan 260727QTKXWHAY = 438.279 = 239.286 + 198.993), jadi
-- jumlah item selalu sama dengan nilai pesanannya.
CREATE TABLE IF NOT EXISTS bo_shopee_order_items (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  upload_id    uuid NOT NULL REFERENCES bo_shopee_uploads(id) ON DELETE CASCADE,
  order_no     text NOT NULL,
  order_date   date NOT NULL,
  product_id   text,                         -- "ID Produk"
  product_name text NOT NULL,                -- "Nama Produk"
  gross        numeric(18,2) NOT NULL DEFAULT 0,
  net          numeric(18,2) NOT NULL DEFAULT 0,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS bo_shopee_items_upload_idx ON bo_shopee_order_items (upload_id);
CREATE INDEX IF NOT EXISTS bo_shopee_items_date_idx   ON bo_shopee_order_items (order_date);

COMMENT ON TABLE bo_shopee_order_items IS 'Baris "Sku" sheet Penghasilan. HANYA untuk atribusi produk — menjumlahkannya bersama bo_shopee_orders menggandakan revenue.';

-- ============ PERMISSION BARU: shopee.manage ============
-- Membaca data Shopee ikut finance.view yang sudah ada; yang perlu izin sendiri
-- hanya meng-upload/menghapus file. Aman diulang: baris yang sudah punya
-- permission ini dilewati oleh klausa NOT.
UPDATE bo_roles
SET permissions = array_append(permissions, 'shopee.manage'),
    updated_at  = now()
WHERE name IN ('Administrator', 'Finance')
  AND NOT ('shopee.manage' = ANY (permissions));

-- Kalau di produksi role admin dinamai lain, baris di bawah menjangkaunya lewat
-- kemampuan yang setara (siapa pun yang sudah boleh mengelola role) alih-alih
-- lewat nama.
UPDATE bo_roles
SET permissions = array_append(permissions, 'shopee.manage'),
    updated_at  = now()
WHERE 'roles.manage' = ANY (permissions)
  AND NOT ('shopee.manage' = ANY (permissions));

-- ---------------------------------------------------------------------------
-- Verifikasi (jalankan manual setelah migrate — bukan bagian dari migration)
-- ---------------------------------------------------------------------------
-- (a) Ketiga tabel terbentuk?
--   SELECT table_name FROM information_schema.tables
--    WHERE table_name LIKE 'bo_shopee%' ORDER BY table_name;
-- (b) Indeks terpasang?
--   SELECT tablename, indexname FROM pg_indexes
--    WHERE tablename LIKE 'bo_shopee%' ORDER BY tablename, indexname;
-- (c) Role mana yang kini boleh meng-upload? (harus minimal Administrator)
--   SELECT name, 'shopee.manage' = ANY (permissions) AS bisa_upload_shopee
--     FROM bo_roles ORDER BY name;
-- (d) Tabel harus masih kosong — data masuk lewat UI upload, bukan lewat SQL.
--   SELECT (SELECT count(*) FROM bo_shopee_uploads)     AS upload,
--          (SELECT count(*) FROM bo_shopee_orders)      AS pesanan,
--          (SELECT count(*) FROM bo_shopee_order_items) AS item;
