-- DropIndex
DROP INDEX "networks_name_key";

-- DropIndex
DROP INDEX "topics_name_key";

-- AlterTable
ALTER TABLE "banners" ADD COLUMN     "legacyId" INTEGER;

-- AlterTable
ALTER TABLE "cities" ADD COLUMN     "legacyId" INTEGER;

-- AlterTable
ALTER TABLE "comments" ADD COLUMN     "legacyId" INTEGER;

-- AlterTable
ALTER TABLE "countries" ADD COLUMN     "legacyId" INTEGER;

-- AlterTable
ALTER TABLE "districts" ADD COLUMN     "legacyId" INTEGER;

-- AlterTable
ALTER TABLE "members" ADD COLUMN     "legacyId" INTEGER,
ADD COLUMN     "passwordAlgo" TEXT NOT NULL DEFAULT 'bcrypt';

-- AlterTable
ALTER TABLE "network_members" ADD COLUMN     "legacyId" INTEGER;

-- AlterTable
ALTER TABLE "networks" ADD COLUMN     "legacyId" INTEGER;

-- AlterTable
ALTER TABLE "posts" ADD COLUMN     "legacyId" INTEGER;

-- AlterTable
ALTER TABLE "products" ADD COLUMN     "legacyId" INTEGER;

-- AlterTable
ALTER TABLE "provinces" ADD COLUMN     "legacyId" INTEGER;

-- AlterTable
ALTER TABLE "report_categories" ADD COLUMN     "legacyId" INTEGER;

-- AlterTable
ALTER TABLE "topics" ADD COLUMN     "legacyId" INTEGER,
ADD COLUMN     "networkId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "banners_legacyId_key" ON "banners"("legacyId");

-- CreateIndex
CREATE UNIQUE INDEX "cities_legacyId_key" ON "cities"("legacyId");

-- CreateIndex
CREATE UNIQUE INDEX "comments_legacyId_key" ON "comments"("legacyId");

-- CreateIndex
CREATE UNIQUE INDEX "countries_legacyId_key" ON "countries"("legacyId");

-- CreateIndex
CREATE UNIQUE INDEX "districts_legacyId_key" ON "districts"("legacyId");

-- CreateIndex
CREATE UNIQUE INDEX "members_legacyId_key" ON "members"("legacyId");

-- CreateIndex
CREATE UNIQUE INDEX "network_members_legacyId_key" ON "network_members"("legacyId");

-- CreateIndex
CREATE UNIQUE INDEX "networks_legacyId_key" ON "networks"("legacyId");

-- CreateIndex
CREATE INDEX "networks_name_idx" ON "networks"("name");

-- CreateIndex
CREATE UNIQUE INDEX "posts_legacyId_key" ON "posts"("legacyId");

-- CreateIndex
CREATE UNIQUE INDEX "products_legacyId_key" ON "products"("legacyId");

-- CreateIndex
CREATE UNIQUE INDEX "provinces_legacyId_key" ON "provinces"("legacyId");

-- CreateIndex
CREATE UNIQUE INDEX "report_categories_legacyId_key" ON "report_categories"("legacyId");

-- CreateIndex
CREATE UNIQUE INDEX "topics_legacyId_key" ON "topics"("legacyId");

-- CreateIndex
CREATE INDEX "topics_networkId_idx" ON "topics"("networkId");

-- CreateIndex
CREATE INDEX "topics_name_idx" ON "topics"("name");

-- AddForeignKey
ALTER TABLE "topics" ADD CONSTRAINT "topics_networkId_fkey" FOREIGN KEY ("networkId") REFERENCES "networks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

