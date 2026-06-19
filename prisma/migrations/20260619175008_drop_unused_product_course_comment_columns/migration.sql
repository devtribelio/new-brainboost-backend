-- AlterTable
ALTER TABLE "comments" DROP COLUMN "embed_url",
DROP COLUMN "image_urls";

-- AlterTable
ALTER TABLE "course_lessons" DROP COLUMN "slug";

-- AlterTable
ALTER TABLE "courses" DROP COLUMN "content_ref",
DROP COLUMN "level";

-- AlterTable
ALTER TABLE "products" DROP COLUMN "description_html";

