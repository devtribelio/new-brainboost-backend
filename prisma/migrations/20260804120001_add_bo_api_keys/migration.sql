-- API key read-only untuk /api/v1 (backoffice-bb) + permission apikeys.manage.
-- Hand-written, idempotent — lanjutan dari 20260622000000_backoffice_tables yang
-- memiliki tabel bo_*. Backoffice belum dimodelkan di schema.prisma.
--
-- Catatan: tidak ada BEGIN/COMMIT eksplisit — Prisma Migrate sudah membungkus
-- tiap file migration dalam satu transaksi.

-- ============ TABEL API KEY ============
-- Menyimpan HANYA SHA-256 dari key, tidak pernah plaintext-nya. Kolom
-- `permissions` memakai katalog RBAC yang sama dengan bo_roles, sehingga sebuah
-- API key tidak pernah bisa membaca lebih banyak daripada seorang user.
CREATE TABLE IF NOT EXISTS bo_api_keys (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name          text NOT NULL,          -- label yang dibaca manusia
  key_prefix    text NOT NULL,          -- mis. "bbk_live_1a2b3c4d" — aman ditampilkan
  key_hash      text NOT NULL UNIQUE,   -- sha256(plaintext), hex
  permissions   text[] NOT NULL DEFAULT '{}',
  note          text,
  created_by    uuid REFERENCES bo_users(id) ON DELETE SET NULL,
  created_email text,                   -- disimpan terpisah agar tetap ada bila user dihapus
  expires_at    timestamptz,            -- NULL = tanpa kedaluwarsa
  revoked_at    timestamptz,            -- NULL = masih berlaku
  last_used_at  timestamptz,
  request_count bigint NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- Lookup saat autentikasi adalah satu equality probe ke key_hash — indeks ini
-- yang membuatnya tidak menjadi seq scan seiring jumlah key bertambah.
CREATE INDEX IF NOT EXISTS bo_api_keys_hash_idx    ON bo_api_keys (key_hash);
CREATE INDEX IF NOT EXISTS bo_api_keys_created_idx ON bo_api_keys (created_at DESC);

COMMENT ON TABLE  bo_api_keys IS 'API key read-only untuk /api/v1 dan MCP server. Hanya hash yang disimpan.';
COMMENT ON COLUMN bo_api_keys.key_hash    IS 'SHA-256 heksadesimal dari key plaintext. Plaintext tidak pernah disimpan.';
COMMENT ON COLUMN bo_api_keys.key_prefix  IS 'Potongan awal key untuk ditampilkan di UI. Bukan rahasia.';
COMMENT ON COLUMN bo_api_keys.revoked_at  IS 'Dicabut secara soft — baris tetap ada agar audit log masih menunjuk ke sesuatu.';

-- ============ PERMISSION BARU: apikeys.manage ============
-- Menentukan siapa yang boleh membuka menu Administrasi -> API Keys dan
-- menerbitkan/mencabut key. Aman diulang: baris yang sudah punya permission ini
-- dilewati oleh klausa NOT.
UPDATE bo_roles
SET permissions = array_append(permissions, 'apikeys.manage'),
    updated_at  = now()
WHERE name = 'Administrator'
  AND NOT ('apikeys.manage' = ANY (permissions));

-- Kalau di produksi role admin dinamai lain, baris di bawah menjangkaunya lewat
-- kemampuan yang setara (siapa pun yang sudah boleh mengelola role) alih-alih
-- lewat nama.
UPDATE bo_roles
SET permissions = array_append(permissions, 'apikeys.manage'),
    updated_at  = now()
WHERE 'roles.manage' = ANY (permissions)
  AND NOT ('apikeys.manage' = ANY (permissions));
