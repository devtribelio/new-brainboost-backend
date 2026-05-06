-- AlterTable
ALTER TABLE "comments" ADD COLUMN     "countLike" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "countReplies" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "imageUrls" TEXT[];

-- AlterTable
ALTER TABLE "members" ADD COLUMN     "code" TEXT,
ADD COLUMN     "coverUrl" TEXT,
ADD COLUMN     "firstName" TEXT,
ADD COLUMN     "isPhoneVerified" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "lastName" TEXT,
ADD COLUMN     "phoneCode" TEXT;

-- AlterTable
ALTER TABLE "networks" ADD COLUMN     "bannerUrl" TEXT,
ADD COLUMN     "countMember" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "isPaid" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "posts" ADD COLUMN     "countComment" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "countLike" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "countReplies" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "embedUrl" TEXT,
ADD COLUMN     "excerpt" TEXT,
ADD COLUMN     "networkId" TEXT,
ADD COLUMN     "postType" TEXT,
ADD COLUMN     "title" TEXT,
ADD COLUMN     "videoUrl" TEXT,
ADD COLUMN     "viewCount" INTEGER NOT NULL DEFAULT 0;

-- CreateIndex
CREATE UNIQUE INDEX "members_code_key" ON "members"("code");

