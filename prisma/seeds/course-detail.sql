-- Seed data for GET /api/member/product/course/detail?code=react-fundamentals
-- Idempotent: re-runnable via `psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f prisma/seeds/course-detail.sql`
--
-- Hardcoded UUIDs (UUIDv4) so SQL stays deterministic; Prisma's uuid(7) default
-- only kicks in for app-generated rows, not raw SQL inserts.
--
-- Rating data lives in `reviews` table only — the endpoint computes
-- ratingSummary (avg + per-star distribution) live from those rows.

BEGIN;

-- ---------------------------------------------------------------------------
-- Product
-- ---------------------------------------------------------------------------
INSERT INTO products (
  id, "legacyId", type, code, slug, title,
  description, "descriptionHtml",
  thumbnail, price, tags,
  "sellingPoints", status, "isActive",
  "createdAt", "updatedAt"
) VALUES (
  '11111111-1111-4111-8111-111111111111',
  456,
  'course',
  'react-fundamentals',
  'react-fundamentals',
  'React Fundamentals',
  'Hands-on course covering hooks, state, and testing.',
  '<p>Hands-on course covering <strong>hooks</strong>, state, and testing.</p>',
  'https://cdn.brainboost.com/products/react-fundamentals.jpg',
  299000,
  'frontend,react,javascript',
  '["Lifetime access","Certificate of completion","Project-based curriculum"]'::jsonb,
  'active',
  true,
  NOW(),
  NOW()
)
ON CONFLICT (code) DO UPDATE SET
  "legacyId"        = EXCLUDED."legacyId",
  type              = EXCLUDED.type,
  slug              = EXCLUDED.slug,
  title             = EXCLUDED.title,
  description       = EXCLUDED.description,
  "descriptionHtml" = EXCLUDED."descriptionHtml",
  thumbnail         = EXCLUDED.thumbnail,
  price             = EXCLUDED.price,
  tags              = EXCLUDED.tags,
  "sellingPoints"   = EXCLUDED."sellingPoints",
  status            = EXCLUDED.status,
  "isActive"        = EXCLUDED."isActive",
  "updatedAt"       = NOW();

-- ---------------------------------------------------------------------------
-- Course
-- ---------------------------------------------------------------------------
INSERT INTO courses (
  id, "productId", "legacyCourseId", "durationMin", level, "contentRef"
) VALUES (
  '22222222-2222-4222-8222-222222222222',
  '11111111-1111-4111-8111-111111111111',
  123,
  540,
  'beginner',
  'lms://courses/react-fundamentals'
)
ON CONFLICT ("productId") DO UPDATE SET
  "legacyCourseId" = EXCLUDED."legacyCourseId",
  "durationMin"    = EXCLUDED."durationMin",
  level            = EXCLUDED.level,
  "contentRef"     = EXCLUDED."contentRef";

-- ---------------------------------------------------------------------------
-- Sections + lessons (wipe & recreate for clean ordering)
-- ---------------------------------------------------------------------------
DELETE FROM course_sections WHERE "courseId" = '22222222-2222-4222-8222-222222222222';

INSERT INTO course_sections (id, "courseId", name, "order", "createdAt") VALUES
  ('33333333-3333-4333-8333-333333333301', '22222222-2222-4222-8222-222222222222', 'Getting Started', 0, NOW()),
  ('33333333-3333-4333-8333-333333333302', '22222222-2222-4222-8222-222222222222', 'Hooks Deep Dive', 1, NOW());

INSERT INTO course_lessons (id, "sectionId", name, description, "order", "createdAt") VALUES
  ('44444444-4444-4444-8444-444444444401', '33333333-3333-4333-8333-333333333301', 'Intro to React',   'What is React and why use it',     0, NOW()),
  ('44444444-4444-4444-8444-444444444402', '33333333-3333-4333-8333-333333333301', 'Setup',            'Project scaffolding with Vite',    1, NOW()),
  ('44444444-4444-4444-8444-444444444403', '33333333-3333-4333-8333-333333333301', 'First Component',  'Hello-world component',            2, NOW()),
  ('44444444-4444-4444-8444-444444444404', '33333333-3333-4333-8333-333333333302', 'useState',         'Local state management',           0, NOW()),
  ('44444444-4444-4444-8444-444444444405', '33333333-3333-4333-8333-333333333302', 'useEffect',        'Side effects and cleanup',         1, NOW()),
  ('44444444-4444-4444-8444-444444444406', '33333333-3333-4333-8333-333333333302', 'Custom Hooks',     'Reusable hook patterns',           2, NOW());

-- ---------------------------------------------------------------------------
-- Reviewer members (placeholder password hash — seed only)
-- ---------------------------------------------------------------------------
INSERT INTO members (id, email, "passwordHash", "isActive", "createdAt", "updatedAt") VALUES
  ('55555555-5555-4555-8555-555555555501', 'course-seed-reviewer-1@brainboost.test', 'seed-placeholder', true, NOW(), NOW()),
  ('55555555-5555-4555-8555-555555555502', 'course-seed-reviewer-2@brainboost.test', 'seed-placeholder', true, NOW(), NOW()),
  ('55555555-5555-4555-8555-555555555503', 'course-seed-reviewer-3@brainboost.test', 'seed-placeholder', true, NOW(), NOW()),
  ('55555555-5555-4555-8555-555555555504', 'course-seed-reviewer-4@brainboost.test', 'seed-placeholder', true, NOW(), NOW()),
  ('55555555-5555-4555-8555-555555555505', 'course-seed-reviewer-5@brainboost.test', 'seed-placeholder', true, NOW(), NOW())
ON CONFLICT (email) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Reviews (wipe & recreate to keep distribution deterministic)
-- ratingSummary is computed live from these rows; no denorm columns to sync.
-- ---------------------------------------------------------------------------
DELETE FROM reviews WHERE "productId" = '11111111-1111-4111-8111-111111111111';

INSERT INTO reviews (id, "productId", "memberId", stars, comment, "createdAt", "updatedAt") VALUES
  ('66666666-6666-4666-8666-666666666601', '11111111-1111-4111-8111-111111111111', '55555555-5555-4555-8555-555555555501', 5, 'Excellent',           NOW(), NOW()),
  ('66666666-6666-4666-8666-666666666602', '11111111-1111-4111-8111-111111111111', '55555555-5555-4555-8555-555555555502', 5, 'Loved it',            NOW(), NOW()),
  ('66666666-6666-4666-8666-666666666603', '11111111-1111-4111-8111-111111111111', '55555555-5555-4555-8555-555555555503', 5, 'Great content',       NOW(), NOW()),
  ('66666666-6666-4666-8666-666666666604', '11111111-1111-4111-8111-111111111111', '55555555-5555-4555-8555-555555555504', 5, 'Worth it',            NOW(), NOW()),
  ('66666666-6666-4666-8666-666666666605', '11111111-1111-4111-8111-111111111111', '55555555-5555-4555-8555-555555555505', 4, 'Good but pace fast',  NOW(), NOW());

COMMIT;
