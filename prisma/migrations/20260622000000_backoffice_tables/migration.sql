-- Backoffice (bo_*) tables: RBAC users/roles, sessions, settings, audit log.
-- Hand-written, idempotent. Backoffice is not yet modeled in schema.prisma, so this
-- migration owns these tables until the Prisma models land.

-- ============ TABLES (idempotent, prefix bo_) ============
CREATE TABLE IF NOT EXISTS bo_roles (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL UNIQUE,
  description text,
  permissions text[] NOT NULL DEFAULT '{}',
  is_system   boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS bo_users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         text NOT NULL UNIQUE,
  name          text NOT NULL,
  password_hash text NOT NULL,
  role_id       uuid REFERENCES bo_roles(id) ON DELETE SET NULL,
  is_active     boolean NOT NULL DEFAULT true,
  last_login_at timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS bo_sessions (
  token      text PRIMARY KEY,
  user_id    uuid NOT NULL REFERENCES bo_users(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS bo_sessions_user_idx    ON bo_sessions (user_id);
CREATE INDEX IF NOT EXISTS bo_sessions_expires_idx ON bo_sessions (expires_at);

CREATE TABLE IF NOT EXISTS bo_settings (
  key        text PRIMARY KEY,
  value      text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES bo_users(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS bo_audit_log (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id    uuid REFERENCES bo_users(id) ON DELETE SET NULL,
  actor_email text,
  action      text NOT NULL,
  target      text,
  meta        jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS bo_audit_created_idx ON bo_audit_log (created_at DESC);
CREATE INDEX IF NOT EXISTS bo_audit_actor_idx   ON bo_audit_log (actor_id);

-- ============ SEED SYSTEM ROLES ============
INSERT INTO bo_roles (name, description, permissions, is_system) VALUES
('Administrator', 'Akses penuh ke semua fitur',
  ARRAY['finance.view','marketing.view','products.view','reviews.view','members.view','learning.view','affiliate.view','vouchers.view','community.view','kyc.view','settings.view','settings.manage','users.manage','roles.manage','audit.view'], true),
('Finance', 'Finance + Produk + Members + Affiliate + Vouchers + KYC',
  ARRAY['finance.view','products.view','members.view','affiliate.view','vouchers.view','kyc.view'], true),
('Marketing', 'Marketing + Produk + Members + Learning + Reviews + Community + Vouchers + Settings',
  ARRAY['marketing.view','products.view','members.view','learning.view','reviews.view','community.view','vouchers.view','settings.view'], true)
ON CONFLICT (name) DO UPDATE
  SET permissions = EXCLUDED.permissions, description = EXCLUDED.description;

-- ============ SEED SUPERADMIN ============
INSERT INTO bo_users (email, name, password_hash, role_id, is_active)
SELECT 'admin@bb.test', 'Super Admin',
       '$2a$10$WrBZeZngrHzUv.oJOCy71.NUrNB8y.l/7WkkhGILjDOKRihqT1iDC',
       r.id, true
FROM bo_roles r WHERE r.name = 'Administrator'
ON CONFLICT (email) DO NOTHING;
