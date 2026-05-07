-- CreateEnum
CREATE TYPE "JoinRequestStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ReportStatus" AS ENUM ('REPORTED', 'REVIEWED', 'RESOLVED', 'DISMISSED');

-- AlterTable Member
ALTER TABLE "members"
  ADD COLUMN "birthdate" TIMESTAMP(3),
  ADD COLUMN "gender" TEXT,
  ADD COLUMN "inviterId" TEXT,
  ADD COLUMN "inviterNetworkId" TEXT,
  ADD COLUMN "isBanned" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "isMuted" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "lastActiveAt" TIMESTAMP(3),
  ADD COLUMN "latitude" DOUBLE PRECISION,
  ADD COLUMN "longitude" DOUBLE PRECISION,
  ADD COLUMN "registerFrom" TEXT,
  ADD COLUMN "utmContent" TEXT,
  ADD COLUMN "utmSource" TEXT;

-- AlterTable Topic
ALTER TABLE "topics" ADD COLUMN "type" TEXT NOT NULL DEFAULT 'PUBLIC';

-- AlterTable Post
ALTER TABLE "posts"
  ADD COLUMN "engagedAt" TIMESTAMP(3),
  ADD COLUMN "isPinned" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "publishAt" TIMESTAMP(3),
  ADD COLUMN "publishStatus" TEXT NOT NULL DEFAULT 'PUBLISHED';

-- AlterTable Network
ALTER TABLE "networks"
  ADD COLUMN "isActive" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "isHelpdesk" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "isPublic" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "memberQuota" INTEGER;

-- AlterTable MemberReport
ALTER TABLE "member_reports"
  ADD COLUMN "networkId" TEXT,
  ADD COLUMN "reportStatus" "ReportStatus" NOT NULL DEFAULT 'REPORTED';

-- AlterTable PostReport
ALTER TABLE "post_reports"
  ADD COLUMN "networkId" TEXT,
  ADD COLUMN "reportStatus" "ReportStatus" NOT NULL DEFAULT 'REPORTED';

-- AlterTable Notification
DROP INDEX IF EXISTS "notifications_memberId_idx";
ALTER TABLE "notifications"
  ADD COLUMN "networkId" TEXT,
  ADD COLUMN "notifGroup" TEXT,
  ADD COLUMN "readAt" TIMESTAMP(3),
  ADD COLUMN "url" TEXT;

-- CreateTable
CREATE TABLE "topic_join_requests" (
    "id" TEXT NOT NULL,
    "topicId" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "status" "JoinRequestStatus" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "topic_join_requests_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "network_member_requests" (
    "id" TEXT NOT NULL,
    "networkId" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "status" "JoinRequestStatus" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "network_member_requests_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "network_banned_members" (
    "id" TEXT NOT NULL,
    "networkId" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "reason" TEXT,
    "bannedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "network_banned_members_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "network_team_members" (
    "id" TEXT NOT NULL,
    "networkId" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'MODERATOR',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "network_team_members_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "topic_join_requests_memberId_idx" ON "topic_join_requests"("memberId");
CREATE UNIQUE INDEX "topic_join_requests_topicId_memberId_key" ON "topic_join_requests"("topicId", "memberId");
CREATE INDEX "network_member_requests_memberId_idx" ON "network_member_requests"("memberId");
CREATE UNIQUE INDEX "network_member_requests_networkId_memberId_key" ON "network_member_requests"("networkId", "memberId");
CREATE UNIQUE INDEX "network_banned_members_networkId_memberId_key" ON "network_banned_members"("networkId", "memberId");
CREATE INDEX "network_team_members_memberId_idx" ON "network_team_members"("memberId");
CREATE UNIQUE INDEX "network_team_members_networkId_memberId_key" ON "network_team_members"("networkId", "memberId");
CREATE INDEX "member_reports_targetId_idx" ON "member_reports"("targetId");
CREATE INDEX "member_reports_reporterId_idx" ON "member_reports"("reporterId");
CREATE INDEX "notifications_memberId_readAt_idx" ON "notifications"("memberId", "readAt");
CREATE INDEX "notifications_memberId_networkId_idx" ON "notifications"("memberId", "networkId");
CREATE INDEX "post_reports_postId_idx" ON "post_reports"("postId");

-- AddForeignKey
ALTER TABLE "topic_join_requests" ADD CONSTRAINT "topic_join_requests_topicId_fkey" FOREIGN KEY ("topicId") REFERENCES "topics"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "network_member_requests" ADD CONSTRAINT "network_member_requests_networkId_fkey" FOREIGN KEY ("networkId") REFERENCES "networks"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "network_banned_members" ADD CONSTRAINT "network_banned_members_networkId_fkey" FOREIGN KEY ("networkId") REFERENCES "networks"("id") ON DELETE CASCADE ON UPDATE CASCADE;
