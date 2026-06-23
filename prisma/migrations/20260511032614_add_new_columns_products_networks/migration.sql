/*
  Warnings:

  - The primary key for the `admins` table will be changed. If it partially fails, the table could be left without primary key constraint.
  - The primary key for the `affiliate_commissions` table will be changed. If it partially fails, the table could be left without primary key constraint.
  - You are about to drop the column `commissionAmount` on the `affiliate_commissions` table. All the data in the column will be lost.
  - You are about to drop the column `commissionType` on the `affiliate_commissions` table. All the data in the column will be lost.
  - You are about to drop the column `feeAmount` on the `affiliate_commissions` table. All the data in the column will be lost.
  - You are about to drop the column `feePercent` on the `affiliate_commissions` table. All the data in the column will be lost.
  - You are about to drop the column `isExpired` on the `affiliate_commissions` table. All the data in the column will be lost.
  - You are about to drop the column `isPending` on the `affiliate_commissions` table. All the data in the column will be lost.
  - You are about to drop the column `isSuper` on the `affiliate_commissions` table. All the data in the column will be lost.
  - The `affiliatorId` column on the `affiliate_commissions` table would be dropped and recreated. This will lead to data loss if there is data in the column.
  - The `programId` column on the `affiliate_commissions` table would be dropped and recreated. This will lead to data loss if there is data in the column.
  - The `productId` column on the `affiliate_commissions` table would be dropped and recreated. This will lead to data loss if there is data in the column.
  - The primary key for the `affiliate_programs` table will be changed. If it partially fails, the table could be left without primary key constraint.
  - You are about to drop the column `categoryId` on the `affiliate_programs` table. All the data in the column will be lost.
  - You are about to drop the column `commissionAmount` on the `affiliate_programs` table. All the data in the column will be lost.
  - You are about to drop the column `commissionType` on the `affiliate_programs` table. All the data in the column will be lost.
  - You are about to drop the column `networkId` on the `affiliate_programs` table. All the data in the column will be lost.
  - You are about to drop the column `pbsAff1` on the `affiliate_programs` table. All the data in the column will be lost.
  - You are about to drop the column `pbsAff2` on the `affiliate_programs` table. All the data in the column will be lost.
  - You are about to drop the column `pbsAff3` on the `affiliate_programs` table. All the data in the column will be lost.
  - You are about to drop the column `pbsCommissionType` on the `affiliate_programs` table. All the data in the column will be lost.
  - The `productId` column on the `affiliate_programs` table would be dropped and recreated. This will lead to data loss if there is data in the column.
  - The primary key for the `banners` table will be changed. If it partially fails, the table could be left without primary key constraint.
  - The primary key for the `cities` table will be changed. If it partially fails, the table could be left without primary key constraint.
  - The primary key for the `comment_likes` table will be changed. If it partially fails, the table could be left without primary key constraint.
  - The primary key for the `comments` table will be changed. If it partially fails, the table could be left without primary key constraint.
  - The `parentId` column on the `comments` table would be dropped and recreated. This will lead to data loss if there is data in the column.
  - The primary key for the `countries` table will be changed. If it partially fails, the table could be left without primary key constraint.
  - The primary key for the `courses` table will be changed. If it partially fails, the table could be left without primary key constraint.
  - The primary key for the `devices` table will be changed. If it partially fails, the table could be left without primary key constraint.
  - The primary key for the `districts` table will be changed. If it partially fails, the table could be left without primary key constraint.
  - The primary key for the `member_affiliators` table will be changed. If it partially fails, the table could be left without primary key constraint.
  - You are about to drop the column `fbPixelId` on the `member_affiliators` table. All the data in the column will be lost.
  - You are about to drop the column `requestId` on the `member_affiliators` table. All the data in the column will be lost.
  - You are about to drop the column `ttPixelId` on the `member_affiliators` table. All the data in the column will be lost.
  - The primary key for the `member_profiles` table will be changed. If it partially fails, the table could be left without primary key constraint.
  - The `countryId` column on the `member_profiles` table would be dropped and recreated. This will lead to data loss if there is data in the column.
  - The `provinceId` column on the `member_profiles` table would be dropped and recreated. This will lead to data loss if there is data in the column.
  - The `cityId` column on the `member_profiles` table would be dropped and recreated. This will lead to data loss if there is data in the column.
  - The `districtId` column on the `member_profiles` table would be dropped and recreated. This will lead to data loss if there is data in the column.
  - The primary key for the `member_reports` table will be changed. If it partially fails, the table could be left without primary key constraint.
  - The `networkId` column on the `member_reports` table would be dropped and recreated. This will lead to data loss if there is data in the column.
  - The primary key for the `members` table will be changed. If it partially fails, the table could be left without primary key constraint.
  - The `inviterId` column on the `members` table would be dropped and recreated. This will lead to data loss if there is data in the column.
  - The `inviterNetworkId` column on the `members` table would be dropped and recreated. This will lead to data loss if there is data in the column.
  - The primary key for the `network_banned_members` table will be changed. If it partially fails, the table could be left without primary key constraint.
  - The primary key for the `network_member_requests` table will be changed. If it partially fails, the table could be left without primary key constraint.
  - The primary key for the `network_members` table will be changed. If it partially fails, the table could be left without primary key constraint.
  - The primary key for the `network_tags` table will be changed. If it partially fails, the table could be left without primary key constraint.
  - The primary key for the `network_team_members` table will be changed. If it partially fails, the table could be left without primary key constraint.
  - The primary key for the `networks` table will be changed. If it partially fails, the table could be left without primary key constraint.
  - The primary key for the `notifications` table will be changed. If it partially fails, the table could be left without primary key constraint.
  - The `networkId` column on the `notifications` table would be dropped and recreated. This will lead to data loss if there is data in the column.
  - The primary key for the `otp_codes` table will be changed. If it partially fails, the table could be left without primary key constraint.
  - The primary key for the `post_likes` table will be changed. If it partially fails, the table could be left without primary key constraint.
  - The primary key for the `post_reports` table will be changed. If it partially fails, the table could be left without primary key constraint.
  - The `networkId` column on the `post_reports` table would be dropped and recreated. This will lead to data loss if there is data in the column.
  - The primary key for the `posts` table will be changed. If it partially fails, the table could be left without primary key constraint.
  - The `topicId` column on the `posts` table would be dropped and recreated. This will lead to data loss if there is data in the column.
  - The `networkId` column on the `posts` table would be dropped and recreated. This will lead to data loss if there is data in the column.
  - The primary key for the `pra_members` table will be changed. If it partially fails, the table could be left without primary key constraint.
  - The `affiliateMemberId` column on the `pra_members` table would be dropped and recreated. This will lead to data loss if there is data in the column.
  - The `networkId` column on the `pra_members` table would be dropped and recreated. This will lead to data loss if there is data in the column.
  - The primary key for the `products` table will be changed. If it partially fails, the table could be left without primary key constraint.
  - The primary key for the `provinces` table will be changed. If it partially fails, the table could be left without primary key constraint.
  - The primary key for the `refresh_tokens` table will be changed. If it partially fails, the table could be left without primary key constraint.
  - The primary key for the `report_categories` table will be changed. If it partially fails, the table could be left without primary key constraint.
  - The primary key for the `topic_join_requests` table will be changed. If it partially fails, the table could be left without primary key constraint.
  - The primary key for the `topic_subscriptions` table will be changed. If it partially fails, the table could be left without primary key constraint.
  - The primary key for the `topics` table will be changed. If it partially fails, the table could be left without primary key constraint.
  - The `networkId` column on the `topics` table would be dropped and recreated. This will lead to data loss if there is data in the column.
  - You are about to drop the `affiliate_program_categories` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `affiliate_requests` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `commission_entries` table. If the table is not empty, all the data it contains will be lost.
  - A unique constraint covering the columns `[paymentId,recipientId,level]` on the table `affiliate_commissions` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[code]` on the table `affiliate_programs` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[code]` on the table `networks` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[code]` on the table `products` will be added. If there are existing duplicate values, this will fail.
  - Changed the type of `id` on the `admins` table. No cast exists, the column would be dropped and recreated, which cannot be done if there is data, since the column is required.
  - Added the required column `affiliateBased` to the `affiliate_commissions` table without a default value. This is not possible if the table is not empty.
  - Added the required column `commissionRate` to the `affiliate_commissions` table without a default value. This is not possible if the table is not empty.
  - Changed the type of `id` on the `affiliate_commissions` table. No cast exists, the column would be dropped and recreated, which cannot be done if there is data, since the column is required.
  - Changed the type of `recipientId` on the `affiliate_commissions` table. No cast exists, the column would be dropped and recreated, which cannot be done if there is data, since the column is required.
  - Added the required column `code` to the `affiliate_programs` table without a default value. This is not possible if the table is not empty.
  - Changed the type of `id` on the `affiliate_programs` table. No cast exists, the column would be dropped and recreated, which cannot be done if there is data, since the column is required.
  - Made the column `name` on table `affiliate_programs` required. This step will fail if there are existing NULL values in that column.
  - Changed the type of `id` on the `banners` table. No cast exists, the column would be dropped and recreated, which cannot be done if there is data, since the column is required.
  - Changed the type of `id` on the `cities` table. No cast exists, the column would be dropped and recreated, which cannot be done if there is data, since the column is required.
  - Changed the type of `provinceId` on the `cities` table. No cast exists, the column would be dropped and recreated, which cannot be done if there is data, since the column is required.
  - Changed the type of `id` on the `comment_likes` table. No cast exists, the column would be dropped and recreated, which cannot be done if there is data, since the column is required.
  - Changed the type of `commentId` on the `comment_likes` table. No cast exists, the column would be dropped and recreated, which cannot be done if there is data, since the column is required.
  - Changed the type of `memberId` on the `comment_likes` table. No cast exists, the column would be dropped and recreated, which cannot be done if there is data, since the column is required.
  - Changed the type of `id` on the `comments` table. No cast exists, the column would be dropped and recreated, which cannot be done if there is data, since the column is required.
  - Changed the type of `postId` on the `comments` table. No cast exists, the column would be dropped and recreated, which cannot be done if there is data, since the column is required.
  - Changed the type of `authorId` on the `comments` table. No cast exists, the column would be dropped and recreated, which cannot be done if there is data, since the column is required.
  - Changed the type of `id` on the `countries` table. No cast exists, the column would be dropped and recreated, which cannot be done if there is data, since the column is required.
  - Changed the type of `id` on the `courses` table. No cast exists, the column would be dropped and recreated, which cannot be done if there is data, since the column is required.
  - Changed the type of `productId` on the `courses` table. No cast exists, the column would be dropped and recreated, which cannot be done if there is data, since the column is required.
  - Changed the type of `id` on the `devices` table. No cast exists, the column would be dropped and recreated, which cannot be done if there is data, since the column is required.
  - Changed the type of `memberId` on the `devices` table. No cast exists, the column would be dropped and recreated, which cannot be done if there is data, since the column is required.
  - Changed the type of `id` on the `districts` table. No cast exists, the column would be dropped and recreated, which cannot be done if there is data, since the column is required.
  - Changed the type of `cityId` on the `districts` table. No cast exists, the column would be dropped and recreated, which cannot be done if there is data, since the column is required.
  - Changed the type of `id` on the `member_affiliators` table. No cast exists, the column would be dropped and recreated, which cannot be done if there is data, since the column is required.
  - Changed the type of `memberId` on the `member_affiliators` table. No cast exists, the column would be dropped and recreated, which cannot be done if there is data, since the column is required.
  - Changed the type of `programId` on the `member_affiliators` table. No cast exists, the column would be dropped and recreated, which cannot be done if there is data, since the column is required.
  - Changed the type of `id` on the `member_profiles` table. No cast exists, the column would be dropped and recreated, which cannot be done if there is data, since the column is required.
  - Changed the type of `memberId` on the `member_profiles` table. No cast exists, the column would be dropped and recreated, which cannot be done if there is data, since the column is required.
  - Changed the type of `id` on the `member_reports` table. No cast exists, the column would be dropped and recreated, which cannot be done if there is data, since the column is required.
  - Changed the type of `reporterId` on the `member_reports` table. No cast exists, the column would be dropped and recreated, which cannot be done if there is data, since the column is required.
  - Changed the type of `targetId` on the `member_reports` table. No cast exists, the column would be dropped and recreated, which cannot be done if there is data, since the column is required.
  - Changed the type of `categoryId` on the `member_reports` table. No cast exists, the column would be dropped and recreated, which cannot be done if there is data, since the column is required.
  - Changed the type of `id` on the `members` table. No cast exists, the column would be dropped and recreated, which cannot be done if there is data, since the column is required.
  - Changed the type of `id` on the `network_banned_members` table. No cast exists, the column would be dropped and recreated, which cannot be done if there is data, since the column is required.
  - Changed the type of `networkId` on the `network_banned_members` table. No cast exists, the column would be dropped and recreated, which cannot be done if there is data, since the column is required.
  - Changed the type of `memberId` on the `network_banned_members` table. No cast exists, the column would be dropped and recreated, which cannot be done if there is data, since the column is required.
  - Changed the type of `id` on the `network_member_requests` table. No cast exists, the column would be dropped and recreated, which cannot be done if there is data, since the column is required.
  - Changed the type of `networkId` on the `network_member_requests` table. No cast exists, the column would be dropped and recreated, which cannot be done if there is data, since the column is required.
  - Changed the type of `memberId` on the `network_member_requests` table. No cast exists, the column would be dropped and recreated, which cannot be done if there is data, since the column is required.
  - Changed the type of `id` on the `network_members` table. No cast exists, the column would be dropped and recreated, which cannot be done if there is data, since the column is required.
  - Changed the type of `networkId` on the `network_members` table. No cast exists, the column would be dropped and recreated, which cannot be done if there is data, since the column is required.
  - Changed the type of `memberId` on the `network_members` table. No cast exists, the column would be dropped and recreated, which cannot be done if there is data, since the column is required.
  - Changed the type of `id` on the `network_tags` table. No cast exists, the column would be dropped and recreated, which cannot be done if there is data, since the column is required.
  - Changed the type of `networkId` on the `network_tags` table. No cast exists, the column would be dropped and recreated, which cannot be done if there is data, since the column is required.
  - Changed the type of `id` on the `network_team_members` table. No cast exists, the column would be dropped and recreated, which cannot be done if there is data, since the column is required.
  - Changed the type of `networkId` on the `network_team_members` table. No cast exists, the column would be dropped and recreated, which cannot be done if there is data, since the column is required.
  - Changed the type of `memberId` on the `network_team_members` table. No cast exists, the column would be dropped and recreated, which cannot be done if there is data, since the column is required.
  - Changed the type of `id` on the `networks` table. No cast exists, the column would be dropped and recreated, which cannot be done if there is data, since the column is required.
  - Changed the type of `id` on the `notifications` table. No cast exists, the column would be dropped and recreated, which cannot be done if there is data, since the column is required.
  - Changed the type of `memberId` on the `notifications` table. No cast exists, the column would be dropped and recreated, which cannot be done if there is data, since the column is required.
  - Changed the type of `id` on the `otp_codes` table. No cast exists, the column would be dropped and recreated, which cannot be done if there is data, since the column is required.
  - Changed the type of `id` on the `post_likes` table. No cast exists, the column would be dropped and recreated, which cannot be done if there is data, since the column is required.
  - Changed the type of `postId` on the `post_likes` table. No cast exists, the column would be dropped and recreated, which cannot be done if there is data, since the column is required.
  - Changed the type of `memberId` on the `post_likes` table. No cast exists, the column would be dropped and recreated, which cannot be done if there is data, since the column is required.
  - Changed the type of `id` on the `post_reports` table. No cast exists, the column would be dropped and recreated, which cannot be done if there is data, since the column is required.
  - Changed the type of `postId` on the `post_reports` table. No cast exists, the column would be dropped and recreated, which cannot be done if there is data, since the column is required.
  - Changed the type of `reporterId` on the `post_reports` table. No cast exists, the column would be dropped and recreated, which cannot be done if there is data, since the column is required.
  - Changed the type of `categoryId` on the `post_reports` table. No cast exists, the column would be dropped and recreated, which cannot be done if there is data, since the column is required.
  - Changed the type of `id` on the `posts` table. No cast exists, the column would be dropped and recreated, which cannot be done if there is data, since the column is required.
  - Changed the type of `authorId` on the `posts` table. No cast exists, the column would be dropped and recreated, which cannot be done if there is data, since the column is required.
  - Changed the type of `id` on the `pra_members` table. No cast exists, the column would be dropped and recreated, which cannot be done if there is data, since the column is required.
  - Changed the type of `id` on the `products` table. No cast exists, the column would be dropped and recreated, which cannot be done if there is data, since the column is required.
  - Changed the type of `id` on the `provinces` table. No cast exists, the column would be dropped and recreated, which cannot be done if there is data, since the column is required.
  - Changed the type of `countryId` on the `provinces` table. No cast exists, the column would be dropped and recreated, which cannot be done if there is data, since the column is required.
  - Changed the type of `id` on the `refresh_tokens` table. No cast exists, the column would be dropped and recreated, which cannot be done if there is data, since the column is required.
  - Changed the type of `memberId` on the `refresh_tokens` table. No cast exists, the column would be dropped and recreated, which cannot be done if there is data, since the column is required.
  - Changed the type of `id` on the `report_categories` table. No cast exists, the column would be dropped and recreated, which cannot be done if there is data, since the column is required.
  - Changed the type of `id` on the `topic_join_requests` table. No cast exists, the column would be dropped and recreated, which cannot be done if there is data, since the column is required.
  - Changed the type of `topicId` on the `topic_join_requests` table. No cast exists, the column would be dropped and recreated, which cannot be done if there is data, since the column is required.
  - Changed the type of `memberId` on the `topic_join_requests` table. No cast exists, the column would be dropped and recreated, which cannot be done if there is data, since the column is required.
  - Changed the type of `id` on the `topic_subscriptions` table. No cast exists, the column would be dropped and recreated, which cannot be done if there is data, since the column is required.
  - Changed the type of `memberId` on the `topic_subscriptions` table. No cast exists, the column would be dropped and recreated, which cannot be done if there is data, since the column is required.
  - Changed the type of `topicId` on the `topic_subscriptions` table. No cast exists, the column would be dropped and recreated, which cannot be done if there is data, since the column is required.
  - Changed the type of `id` on the `topics` table. No cast exists, the column would be dropped and recreated, which cannot be done if there is data, since the column is required.

*/
-- DropForeignKey
ALTER TABLE "affiliate_commissions" DROP CONSTRAINT "affiliate_commissions_affiliatorId_fkey";

-- DropForeignKey
ALTER TABLE "affiliate_commissions" DROP CONSTRAINT "affiliate_commissions_productId_fkey";

-- DropForeignKey
ALTER TABLE "affiliate_commissions" DROP CONSTRAINT "affiliate_commissions_programId_fkey";

-- DropForeignKey
ALTER TABLE "affiliate_commissions" DROP CONSTRAINT "affiliate_commissions_recipientId_fkey";

-- DropForeignKey
ALTER TABLE "affiliate_programs" DROP CONSTRAINT "affiliate_programs_categoryId_fkey";

-- DropForeignKey
ALTER TABLE "affiliate_programs" DROP CONSTRAINT "affiliate_programs_networkId_fkey";

-- DropForeignKey
ALTER TABLE "affiliate_programs" DROP CONSTRAINT "affiliate_programs_productId_fkey";

-- DropForeignKey
ALTER TABLE "affiliate_requests" DROP CONSTRAINT "affiliate_requests_memberId_fkey";

-- DropForeignKey
ALTER TABLE "affiliate_requests" DROP CONSTRAINT "affiliate_requests_programId_fkey";

-- DropForeignKey
ALTER TABLE "cities" DROP CONSTRAINT "cities_provinceId_fkey";

-- DropForeignKey
ALTER TABLE "comment_likes" DROP CONSTRAINT "comment_likes_commentId_fkey";

-- DropForeignKey
ALTER TABLE "comment_likes" DROP CONSTRAINT "comment_likes_memberId_fkey";

-- DropForeignKey
ALTER TABLE "comments" DROP CONSTRAINT "comments_authorId_fkey";

-- DropForeignKey
ALTER TABLE "comments" DROP CONSTRAINT "comments_parentId_fkey";

-- DropForeignKey
ALTER TABLE "comments" DROP CONSTRAINT "comments_postId_fkey";

-- DropForeignKey
ALTER TABLE "courses" DROP CONSTRAINT "courses_productId_fkey";

-- DropForeignKey
ALTER TABLE "devices" DROP CONSTRAINT "devices_memberId_fkey";

-- DropForeignKey
ALTER TABLE "districts" DROP CONSTRAINT "districts_cityId_fkey";

-- DropForeignKey
ALTER TABLE "member_affiliators" DROP CONSTRAINT "member_affiliators_memberId_fkey";

-- DropForeignKey
ALTER TABLE "member_affiliators" DROP CONSTRAINT "member_affiliators_programId_fkey";

-- DropForeignKey
ALTER TABLE "member_profiles" DROP CONSTRAINT "member_profiles_cityId_fkey";

-- DropForeignKey
ALTER TABLE "member_profiles" DROP CONSTRAINT "member_profiles_countryId_fkey";

-- DropForeignKey
ALTER TABLE "member_profiles" DROP CONSTRAINT "member_profiles_districtId_fkey";

-- DropForeignKey
ALTER TABLE "member_profiles" DROP CONSTRAINT "member_profiles_memberId_fkey";

-- DropForeignKey
ALTER TABLE "member_profiles" DROP CONSTRAINT "member_profiles_provinceId_fkey";

-- DropForeignKey
ALTER TABLE "member_reports" DROP CONSTRAINT "member_reports_categoryId_fkey";

-- DropForeignKey
ALTER TABLE "network_banned_members" DROP CONSTRAINT "network_banned_members_networkId_fkey";

-- DropForeignKey
ALTER TABLE "network_member_requests" DROP CONSTRAINT "network_member_requests_networkId_fkey";

-- DropForeignKey
ALTER TABLE "network_members" DROP CONSTRAINT "network_members_networkId_fkey";

-- DropForeignKey
ALTER TABLE "network_tags" DROP CONSTRAINT "network_tags_networkId_fkey";

-- DropForeignKey
ALTER TABLE "notifications" DROP CONSTRAINT "notifications_memberId_fkey";

-- DropForeignKey
ALTER TABLE "post_likes" DROP CONSTRAINT "post_likes_memberId_fkey";

-- DropForeignKey
ALTER TABLE "post_likes" DROP CONSTRAINT "post_likes_postId_fkey";

-- DropForeignKey
ALTER TABLE "post_reports" DROP CONSTRAINT "post_reports_categoryId_fkey";

-- DropForeignKey
ALTER TABLE "post_reports" DROP CONSTRAINT "post_reports_postId_fkey";

-- DropForeignKey
ALTER TABLE "posts" DROP CONSTRAINT "posts_authorId_fkey";

-- DropForeignKey
ALTER TABLE "posts" DROP CONSTRAINT "posts_topicId_fkey";

-- DropForeignKey
ALTER TABLE "provinces" DROP CONSTRAINT "provinces_countryId_fkey";

-- DropForeignKey
ALTER TABLE "refresh_tokens" DROP CONSTRAINT "refresh_tokens_memberId_fkey";

-- DropForeignKey
ALTER TABLE "topic_join_requests" DROP CONSTRAINT "topic_join_requests_topicId_fkey";

-- DropForeignKey
ALTER TABLE "topic_subscriptions" DROP CONSTRAINT "topic_subscriptions_memberId_fkey";

-- DropForeignKey
ALTER TABLE "topic_subscriptions" DROP CONSTRAINT "topic_subscriptions_topicId_fkey";

-- DropForeignKey
ALTER TABLE "topics" DROP CONSTRAINT "topics_networkId_fkey";

-- DropIndex
DROP INDEX "affiliate_commissions_productId_idx";

-- DropIndex
DROP INDEX "affiliate_commissions_recipientId_idx";

-- DropIndex
DROP INDEX "affiliate_programs_networkId_idx";

-- AlterTable
ALTER TABLE "admins" DROP CONSTRAINT "admins_pkey",
DROP COLUMN "id",
ADD COLUMN     "id" UUID NOT NULL,
ADD CONSTRAINT "admins_pkey" PRIMARY KEY ("id");

-- AlterTable
ALTER TABLE "affiliate_commissions" DROP CONSTRAINT "affiliate_commissions_pkey",
DROP COLUMN "commissionAmount",
DROP COLUMN "commissionType",
DROP COLUMN "feeAmount",
DROP COLUMN "feePercent",
DROP COLUMN "isExpired",
DROP COLUMN "isPending",
DROP COLUMN "isSuper",
ADD COLUMN     "affiliateBased" TEXT NOT NULL,
ADD COLUMN     "approvedAt" TIMESTAMP(3),
ADD COLUMN     "attributionVisitId" UUID,
ADD COLUMN     "buyerMemberId" UUID,
ADD COLUMN     "commissionRate" INTEGER NOT NULL,
ADD COLUMN     "paymentId" UUID,
ADD COLUMN     "schemaType" TEXT,
ADD COLUMN     "status" TEXT NOT NULL DEFAULT 'PENDING',
ADD COLUMN     "voidedAt" TIMESTAMP(3),
ADD COLUMN     "voidedBy" UUID,
ADD COLUMN     "voidedReason" TEXT,
ADD COLUMN     "voucherAmount" INTEGER NOT NULL DEFAULT 0,
DROP COLUMN "id",
ADD COLUMN     "id" UUID NOT NULL,
DROP COLUMN "recipientId",
ADD COLUMN     "recipientId" UUID NOT NULL,
DROP COLUMN "affiliatorId",
ADD COLUMN     "affiliatorId" UUID,
DROP COLUMN "programId",
ADD COLUMN     "programId" UUID,
DROP COLUMN "productId",
ADD COLUMN     "productId" UUID,
ADD CONSTRAINT "affiliate_commissions_pkey" PRIMARY KEY ("id");

-- AlterTable
ALTER TABLE "affiliate_programs" DROP CONSTRAINT "affiliate_programs_pkey",
DROP COLUMN "categoryId",
DROP COLUMN "commissionAmount",
DROP COLUMN "commissionType",
DROP COLUMN "networkId",
DROP COLUMN "pbsAff1",
DROP COLUMN "pbsAff2",
DROP COLUMN "pbsAff3",
DROP COLUMN "pbsCommissionType",
ADD COLUMN     "code" TEXT NOT NULL,
DROP COLUMN "id",
ADD COLUMN     "id" UUID NOT NULL,
DROP COLUMN "productId",
ADD COLUMN     "productId" UUID,
ALTER COLUMN "name" SET NOT NULL,
ADD CONSTRAINT "affiliate_programs_pkey" PRIMARY KEY ("id");

-- AlterTable
ALTER TABLE "banners" DROP CONSTRAINT "banners_pkey",
DROP COLUMN "id",
ADD COLUMN     "id" UUID NOT NULL,
ADD CONSTRAINT "banners_pkey" PRIMARY KEY ("id");

-- AlterTable
ALTER TABLE "cities" DROP CONSTRAINT "cities_pkey",
DROP COLUMN "id",
ADD COLUMN     "id" UUID NOT NULL,
DROP COLUMN "provinceId",
ADD COLUMN     "provinceId" UUID NOT NULL,
ADD CONSTRAINT "cities_pkey" PRIMARY KEY ("id");

-- AlterTable
ALTER TABLE "comment_likes" DROP CONSTRAINT "comment_likes_pkey",
DROP COLUMN "id",
ADD COLUMN     "id" UUID NOT NULL,
DROP COLUMN "commentId",
ADD COLUMN     "commentId" UUID NOT NULL,
DROP COLUMN "memberId",
ADD COLUMN     "memberId" UUID NOT NULL,
ADD CONSTRAINT "comment_likes_pkey" PRIMARY KEY ("id");

-- AlterTable
ALTER TABLE "comments" DROP CONSTRAINT "comments_pkey",
DROP COLUMN "id",
ADD COLUMN     "id" UUID NOT NULL,
DROP COLUMN "postId",
ADD COLUMN     "postId" UUID NOT NULL,
DROP COLUMN "authorId",
ADD COLUMN     "authorId" UUID NOT NULL,
DROP COLUMN "parentId",
ADD COLUMN     "parentId" UUID,
ADD CONSTRAINT "comments_pkey" PRIMARY KEY ("id");

-- AlterTable
ALTER TABLE "countries" DROP CONSTRAINT "countries_pkey",
DROP COLUMN "id",
ADD COLUMN     "id" UUID NOT NULL,
ADD CONSTRAINT "countries_pkey" PRIMARY KEY ("id");

-- AlterTable
ALTER TABLE "courses" DROP CONSTRAINT "courses_pkey",
DROP COLUMN "id",
ADD COLUMN     "id" UUID NOT NULL,
DROP COLUMN "productId",
ADD COLUMN     "productId" UUID NOT NULL,
ADD CONSTRAINT "courses_pkey" PRIMARY KEY ("id");

-- AlterTable
ALTER TABLE "devices" DROP CONSTRAINT "devices_pkey",
DROP COLUMN "id",
ADD COLUMN     "id" UUID NOT NULL,
DROP COLUMN "memberId",
ADD COLUMN     "memberId" UUID NOT NULL,
ADD CONSTRAINT "devices_pkey" PRIMARY KEY ("id");

-- AlterTable
ALTER TABLE "districts" DROP CONSTRAINT "districts_pkey",
DROP COLUMN "id",
ADD COLUMN     "id" UUID NOT NULL,
DROP COLUMN "cityId",
ADD COLUMN     "cityId" UUID NOT NULL,
ADD CONSTRAINT "districts_pkey" PRIMARY KEY ("id");

-- AlterTable
ALTER TABLE "member_affiliators" DROP CONSTRAINT "member_affiliators_pkey",
DROP COLUMN "fbPixelId",
DROP COLUMN "requestId",
DROP COLUMN "ttPixelId",
DROP COLUMN "id",
ADD COLUMN     "id" UUID NOT NULL,
DROP COLUMN "memberId",
ADD COLUMN     "memberId" UUID NOT NULL,
DROP COLUMN "programId",
ADD COLUMN     "programId" UUID NOT NULL,
ADD CONSTRAINT "member_affiliators_pkey" PRIMARY KEY ("id");

-- AlterTable
ALTER TABLE "member_profiles" DROP CONSTRAINT "member_profiles_pkey",
DROP COLUMN "id",
ADD COLUMN     "id" UUID NOT NULL,
DROP COLUMN "memberId",
ADD COLUMN     "memberId" UUID NOT NULL,
DROP COLUMN "countryId",
ADD COLUMN     "countryId" UUID,
DROP COLUMN "provinceId",
ADD COLUMN     "provinceId" UUID,
DROP COLUMN "cityId",
ADD COLUMN     "cityId" UUID,
DROP COLUMN "districtId",
ADD COLUMN     "districtId" UUID,
ADD CONSTRAINT "member_profiles_pkey" PRIMARY KEY ("id");

-- AlterTable
ALTER TABLE "member_reports" DROP CONSTRAINT "member_reports_pkey",
DROP COLUMN "id",
ADD COLUMN     "id" UUID NOT NULL,
DROP COLUMN "reporterId",
ADD COLUMN     "reporterId" UUID NOT NULL,
DROP COLUMN "targetId",
ADD COLUMN     "targetId" UUID NOT NULL,
DROP COLUMN "categoryId",
ADD COLUMN     "categoryId" UUID NOT NULL,
DROP COLUMN "networkId",
ADD COLUMN     "networkId" UUID,
ADD CONSTRAINT "member_reports_pkey" PRIMARY KEY ("id");

-- AlterTable
ALTER TABLE "members" DROP CONSTRAINT "members_pkey",
ADD COLUMN     "affiliateBased" TEXT NOT NULL DEFAULT 'PERFORMANCE',
DROP COLUMN "id",
ADD COLUMN     "id" UUID NOT NULL,
DROP COLUMN "inviterId",
ADD COLUMN     "inviterId" UUID,
DROP COLUMN "inviterNetworkId",
ADD COLUMN     "inviterNetworkId" UUID,
ADD CONSTRAINT "members_pkey" PRIMARY KEY ("id");

-- AlterTable
ALTER TABLE "network_banned_members" DROP CONSTRAINT "network_banned_members_pkey",
DROP COLUMN "id",
ADD COLUMN     "id" UUID NOT NULL,
DROP COLUMN "networkId",
ADD COLUMN     "networkId" UUID NOT NULL,
DROP COLUMN "memberId",
ADD COLUMN     "memberId" UUID NOT NULL,
ADD CONSTRAINT "network_banned_members_pkey" PRIMARY KEY ("id");

-- AlterTable
ALTER TABLE "network_member_requests" DROP CONSTRAINT "network_member_requests_pkey",
DROP COLUMN "id",
ADD COLUMN     "id" UUID NOT NULL,
DROP COLUMN "networkId",
ADD COLUMN     "networkId" UUID NOT NULL,
DROP COLUMN "memberId",
ADD COLUMN     "memberId" UUID NOT NULL,
ADD CONSTRAINT "network_member_requests_pkey" PRIMARY KEY ("id");

-- AlterTable
ALTER TABLE "network_members" DROP CONSTRAINT "network_members_pkey",
DROP COLUMN "id",
ADD COLUMN     "id" UUID NOT NULL,
DROP COLUMN "networkId",
ADD COLUMN     "networkId" UUID NOT NULL,
DROP COLUMN "memberId",
ADD COLUMN     "memberId" UUID NOT NULL,
ADD CONSTRAINT "network_members_pkey" PRIMARY KEY ("id");

-- AlterTable
ALTER TABLE "network_tags" DROP CONSTRAINT "network_tags_pkey",
DROP COLUMN "id",
ADD COLUMN     "id" UUID NOT NULL,
DROP COLUMN "networkId",
ADD COLUMN     "networkId" UUID NOT NULL,
ADD CONSTRAINT "network_tags_pkey" PRIMARY KEY ("id");

-- AlterTable
ALTER TABLE "network_team_members" DROP CONSTRAINT "network_team_members_pkey",
DROP COLUMN "id",
ADD COLUMN     "id" UUID NOT NULL,
DROP COLUMN "networkId",
ADD COLUMN     "networkId" UUID NOT NULL,
DROP COLUMN "memberId",
ADD COLUMN     "memberId" UUID NOT NULL,
ADD CONSTRAINT "network_team_members_pkey" PRIMARY KEY ("id");

-- AlterTable
ALTER TABLE "networks" DROP CONSTRAINT "networks_pkey",
ADD COLUMN     "code" TEXT,
ADD COLUMN     "purpose" TEXT,
DROP COLUMN "id",
ADD COLUMN     "id" UUID NOT NULL,
ADD CONSTRAINT "networks_pkey" PRIMARY KEY ("id");

-- AlterTable
ALTER TABLE "notifications" DROP CONSTRAINT "notifications_pkey",
DROP COLUMN "id",
ADD COLUMN     "id" UUID NOT NULL,
DROP COLUMN "memberId",
ADD COLUMN     "memberId" UUID NOT NULL,
DROP COLUMN "networkId",
ADD COLUMN     "networkId" UUID,
ADD CONSTRAINT "notifications_pkey" PRIMARY KEY ("id");

-- AlterTable
ALTER TABLE "otp_codes" DROP CONSTRAINT "otp_codes_pkey",
DROP COLUMN "id",
ADD COLUMN     "id" UUID NOT NULL,
ADD CONSTRAINT "otp_codes_pkey" PRIMARY KEY ("id");

-- AlterTable
ALTER TABLE "post_likes" DROP CONSTRAINT "post_likes_pkey",
DROP COLUMN "id",
ADD COLUMN     "id" UUID NOT NULL,
DROP COLUMN "postId",
ADD COLUMN     "postId" UUID NOT NULL,
DROP COLUMN "memberId",
ADD COLUMN     "memberId" UUID NOT NULL,
ADD CONSTRAINT "post_likes_pkey" PRIMARY KEY ("id");

-- AlterTable
ALTER TABLE "post_reports" DROP CONSTRAINT "post_reports_pkey",
DROP COLUMN "id",
ADD COLUMN     "id" UUID NOT NULL,
DROP COLUMN "postId",
ADD COLUMN     "postId" UUID NOT NULL,
DROP COLUMN "reporterId",
ADD COLUMN     "reporterId" UUID NOT NULL,
DROP COLUMN "categoryId",
ADD COLUMN     "categoryId" UUID NOT NULL,
DROP COLUMN "networkId",
ADD COLUMN     "networkId" UUID,
ADD CONSTRAINT "post_reports_pkey" PRIMARY KEY ("id");

-- AlterTable
ALTER TABLE "posts" DROP CONSTRAINT "posts_pkey",
DROP COLUMN "id",
ADD COLUMN     "id" UUID NOT NULL,
DROP COLUMN "authorId",
ADD COLUMN     "authorId" UUID NOT NULL,
DROP COLUMN "topicId",
ADD COLUMN     "topicId" UUID,
DROP COLUMN "networkId",
ADD COLUMN     "networkId" UUID,
ADD CONSTRAINT "posts_pkey" PRIMARY KEY ("id");

-- AlterTable
ALTER TABLE "pra_members" DROP CONSTRAINT "pra_members_pkey",
DROP COLUMN "id",
ADD COLUMN     "id" UUID NOT NULL,
DROP COLUMN "affiliateMemberId",
ADD COLUMN     "affiliateMemberId" UUID,
DROP COLUMN "networkId",
ADD COLUMN     "networkId" UUID,
ADD CONSTRAINT "pra_members_pkey" PRIMARY KEY ("id");

-- AlterTable
ALTER TABLE "products" DROP CONSTRAINT "products_pkey",
ADD COLUMN     "code" TEXT,
ADD COLUMN     "marketingLink" TEXT,
ADD COLUMN     "ratingAvg" DOUBLE PRECISION DEFAULT 0,
ADD COLUMN     "slug" TEXT,
ADD COLUMN     "tags" TEXT,
DROP COLUMN "id",
ADD COLUMN     "id" UUID NOT NULL,
ADD CONSTRAINT "products_pkey" PRIMARY KEY ("id");

-- AlterTable
ALTER TABLE "provinces" DROP CONSTRAINT "provinces_pkey",
DROP COLUMN "id",
ADD COLUMN     "id" UUID NOT NULL,
DROP COLUMN "countryId",
ADD COLUMN     "countryId" UUID NOT NULL,
ADD CONSTRAINT "provinces_pkey" PRIMARY KEY ("id");

-- AlterTable
ALTER TABLE "refresh_tokens" DROP CONSTRAINT "refresh_tokens_pkey",
DROP COLUMN "id",
ADD COLUMN     "id" UUID NOT NULL,
DROP COLUMN "memberId",
ADD COLUMN     "memberId" UUID NOT NULL,
ADD CONSTRAINT "refresh_tokens_pkey" PRIMARY KEY ("id");

-- AlterTable
ALTER TABLE "report_categories" DROP CONSTRAINT "report_categories_pkey",
DROP COLUMN "id",
ADD COLUMN     "id" UUID NOT NULL,
ADD CONSTRAINT "report_categories_pkey" PRIMARY KEY ("id");

-- AlterTable
ALTER TABLE "topic_join_requests" DROP CONSTRAINT "topic_join_requests_pkey",
DROP COLUMN "id",
ADD COLUMN     "id" UUID NOT NULL,
DROP COLUMN "topicId",
ADD COLUMN     "topicId" UUID NOT NULL,
DROP COLUMN "memberId",
ADD COLUMN     "memberId" UUID NOT NULL,
ADD CONSTRAINT "topic_join_requests_pkey" PRIMARY KEY ("id");

-- AlterTable
ALTER TABLE "topic_subscriptions" DROP CONSTRAINT "topic_subscriptions_pkey",
DROP COLUMN "id",
ADD COLUMN     "id" UUID NOT NULL,
DROP COLUMN "memberId",
ADD COLUMN     "memberId" UUID NOT NULL,
DROP COLUMN "topicId",
ADD COLUMN     "topicId" UUID NOT NULL,
ADD CONSTRAINT "topic_subscriptions_pkey" PRIMARY KEY ("id");

-- AlterTable
ALTER TABLE "topics" DROP CONSTRAINT "topics_pkey",
DROP COLUMN "id",
ADD COLUMN     "id" UUID NOT NULL,
DROP COLUMN "networkId",
ADD COLUMN     "networkId" UUID,
ADD CONSTRAINT "topics_pkey" PRIMARY KEY ("id");

-- DropTable
DROP TABLE "affiliate_program_categories";

-- DropTable
DROP TABLE "affiliate_requests";

-- DropTable
DROP TABLE "commission_entries";

-- DropEnum
DROP TYPE "AffiliateRequestStatus";

-- CreateTable
CREATE TABLE "affiliate_visits" (
    "id" UUID NOT NULL,
    "programId" UUID NOT NULL,
    "affiliatorMemberId" UUID NOT NULL,
    "memberId" UUID,
    "utmSource" TEXT,
    "utmMedium" TEXT,
    "utmCampaign" TEXT,
    "utmContent" TEXT,
    "utmTerm" TEXT,
    "adId" TEXT,
    "adNetwork" TEXT,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "referer" TEXT,
    "deviceId" TEXT,
    "platform" TEXT,
    "appVersion" TEXT,
    "installReferrer" TEXT,
    "rawQueryString" TEXT,
    "rawHeaders" JSONB,
    "clientEventId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "affiliate_visits_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "affiliate_visits_clientEventId_key" ON "affiliate_visits"("clientEventId");

-- CreateIndex
CREATE INDEX "affiliate_visits_programId_createdAt_idx" ON "affiliate_visits"("programId", "createdAt");

-- CreateIndex
CREATE INDEX "affiliate_visits_affiliatorMemberId_createdAt_idx" ON "affiliate_visits"("affiliatorMemberId", "createdAt");

-- CreateIndex
CREATE INDEX "affiliate_visits_memberId_idx" ON "affiliate_visits"("memberId");

-- CreateIndex
CREATE INDEX "affiliate_visits_adId_idx" ON "affiliate_visits"("adId");

-- CreateIndex
CREATE INDEX "affiliate_visits_utmCampaign_idx" ON "affiliate_visits"("utmCampaign");

-- CreateIndex
CREATE INDEX "affiliate_commissions_recipientId_createdAt_idx" ON "affiliate_commissions"("recipientId", "createdAt");

-- CreateIndex
CREATE INDEX "affiliate_commissions_programId_idx" ON "affiliate_commissions"("programId");

-- CreateIndex
CREATE INDEX "affiliate_commissions_buyerMemberId_idx" ON "affiliate_commissions"("buyerMemberId");

-- CreateIndex
CREATE INDEX "affiliate_commissions_status_idx" ON "affiliate_commissions"("status");

-- CreateIndex
CREATE UNIQUE INDEX "affiliate_commissions_paymentId_recipientId_level_key" ON "affiliate_commissions"("paymentId", "recipientId", "level");

-- CreateIndex
CREATE UNIQUE INDEX "affiliate_programs_code_key" ON "affiliate_programs"("code");

-- CreateIndex
CREATE INDEX "affiliate_programs_productId_idx" ON "affiliate_programs"("productId");

-- CreateIndex
CREATE INDEX "cities_provinceId_idx" ON "cities"("provinceId");

-- CreateIndex
CREATE UNIQUE INDEX "comment_likes_commentId_memberId_key" ON "comment_likes"("commentId", "memberId");

-- CreateIndex
CREATE INDEX "comments_postId_idx" ON "comments"("postId");

-- CreateIndex
CREATE INDEX "comments_parentId_idx" ON "comments"("parentId");

-- CreateIndex
CREATE UNIQUE INDEX "courses_productId_key" ON "courses"("productId");

-- CreateIndex
CREATE UNIQUE INDEX "devices_memberId_deviceId_key" ON "devices"("memberId", "deviceId");

-- CreateIndex
CREATE INDEX "districts_cityId_idx" ON "districts"("cityId");

-- CreateIndex
CREATE INDEX "member_affiliators_programId_idx" ON "member_affiliators"("programId");

-- CreateIndex
CREATE UNIQUE INDEX "member_affiliators_memberId_programId_key" ON "member_affiliators"("memberId", "programId");

-- CreateIndex
CREATE UNIQUE INDEX "member_profiles_memberId_key" ON "member_profiles"("memberId");

-- CreateIndex
CREATE INDEX "member_reports_targetId_idx" ON "member_reports"("targetId");

-- CreateIndex
CREATE INDEX "member_reports_reporterId_idx" ON "member_reports"("reporterId");

-- CreateIndex
CREATE UNIQUE INDEX "network_banned_members_networkId_memberId_key" ON "network_banned_members"("networkId", "memberId");

-- CreateIndex
CREATE INDEX "network_member_requests_memberId_idx" ON "network_member_requests"("memberId");

-- CreateIndex
CREATE UNIQUE INDEX "network_member_requests_networkId_memberId_key" ON "network_member_requests"("networkId", "memberId");

-- CreateIndex
CREATE UNIQUE INDEX "network_members_networkId_memberId_key" ON "network_members"("networkId", "memberId");

-- CreateIndex
CREATE UNIQUE INDEX "network_tags_networkId_name_key" ON "network_tags"("networkId", "name");

-- CreateIndex
CREATE INDEX "network_team_members_memberId_idx" ON "network_team_members"("memberId");

-- CreateIndex
CREATE UNIQUE INDEX "network_team_members_networkId_memberId_key" ON "network_team_members"("networkId", "memberId");

-- CreateIndex
CREATE UNIQUE INDEX "networks_code_key" ON "networks"("code");

-- CreateIndex
CREATE INDEX "notifications_memberId_readAt_idx" ON "notifications"("memberId", "readAt");

-- CreateIndex
CREATE INDEX "notifications_memberId_networkId_idx" ON "notifications"("memberId", "networkId");

-- CreateIndex
CREATE UNIQUE INDEX "post_likes_postId_memberId_key" ON "post_likes"("postId", "memberId");

-- CreateIndex
CREATE INDEX "post_reports_postId_idx" ON "post_reports"("postId");

-- CreateIndex
CREATE INDEX "posts_authorId_idx" ON "posts"("authorId");

-- CreateIndex
CREATE INDEX "posts_topicId_idx" ON "posts"("topicId");

-- CreateIndex
CREATE UNIQUE INDEX "products_code_key" ON "products"("code");

-- CreateIndex
CREATE INDEX "provinces_countryId_idx" ON "provinces"("countryId");

-- CreateIndex
CREATE INDEX "refresh_tokens_memberId_idx" ON "refresh_tokens"("memberId");

-- CreateIndex
CREATE INDEX "topic_join_requests_memberId_idx" ON "topic_join_requests"("memberId");

-- CreateIndex
CREATE UNIQUE INDEX "topic_join_requests_topicId_memberId_key" ON "topic_join_requests"("topicId", "memberId");

-- CreateIndex
CREATE UNIQUE INDEX "topic_subscriptions_memberId_topicId_key" ON "topic_subscriptions"("memberId", "topicId");

-- CreateIndex
CREATE INDEX "topics_networkId_idx" ON "topics"("networkId");

-- AddForeignKey
ALTER TABLE "members" ADD CONSTRAINT "members_inviterId_fkey" FOREIGN KEY ("inviterId") REFERENCES "members"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "member_profiles" ADD CONSTRAINT "member_profiles_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "members"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "member_profiles" ADD CONSTRAINT "member_profiles_countryId_fkey" FOREIGN KEY ("countryId") REFERENCES "countries"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "member_profiles" ADD CONSTRAINT "member_profiles_provinceId_fkey" FOREIGN KEY ("provinceId") REFERENCES "provinces"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "member_profiles" ADD CONSTRAINT "member_profiles_cityId_fkey" FOREIGN KEY ("cityId") REFERENCES "cities"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "member_profiles" ADD CONSTRAINT "member_profiles_districtId_fkey" FOREIGN KEY ("districtId") REFERENCES "districts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "devices" ADD CONSTRAINT "devices_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "members"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "members"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "provinces" ADD CONSTRAINT "provinces_countryId_fkey" FOREIGN KEY ("countryId") REFERENCES "countries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cities" ADD CONSTRAINT "cities_provinceId_fkey" FOREIGN KEY ("provinceId") REFERENCES "provinces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "districts" ADD CONSTRAINT "districts_cityId_fkey" FOREIGN KEY ("cityId") REFERENCES "cities"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "courses" ADD CONSTRAINT "courses_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "topics" ADD CONSTRAINT "topics_networkId_fkey" FOREIGN KEY ("networkId") REFERENCES "networks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "topic_join_requests" ADD CONSTRAINT "topic_join_requests_topicId_fkey" FOREIGN KEY ("topicId") REFERENCES "topics"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "topic_subscriptions" ADD CONSTRAINT "topic_subscriptions_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "members"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "topic_subscriptions" ADD CONSTRAINT "topic_subscriptions_topicId_fkey" FOREIGN KEY ("topicId") REFERENCES "topics"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "posts" ADD CONSTRAINT "posts_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "members"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "posts" ADD CONSTRAINT "posts_topicId_fkey" FOREIGN KEY ("topicId") REFERENCES "topics"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "post_likes" ADD CONSTRAINT "post_likes_postId_fkey" FOREIGN KEY ("postId") REFERENCES "posts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "post_likes" ADD CONSTRAINT "post_likes_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "members"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "post_reports" ADD CONSTRAINT "post_reports_postId_fkey" FOREIGN KEY ("postId") REFERENCES "posts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "post_reports" ADD CONSTRAINT "post_reports_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "report_categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "comments" ADD CONSTRAINT "comments_postId_fkey" FOREIGN KEY ("postId") REFERENCES "posts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "comments" ADD CONSTRAINT "comments_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "members"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "comments" ADD CONSTRAINT "comments_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "comments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "comment_likes" ADD CONSTRAINT "comment_likes_commentId_fkey" FOREIGN KEY ("commentId") REFERENCES "comments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "comment_likes" ADD CONSTRAINT "comment_likes_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "members"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "network_member_requests" ADD CONSTRAINT "network_member_requests_networkId_fkey" FOREIGN KEY ("networkId") REFERENCES "networks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "network_banned_members" ADD CONSTRAINT "network_banned_members_networkId_fkey" FOREIGN KEY ("networkId") REFERENCES "networks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "network_members" ADD CONSTRAINT "network_members_networkId_fkey" FOREIGN KEY ("networkId") REFERENCES "networks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "network_tags" ADD CONSTRAINT "network_tags_networkId_fkey" FOREIGN KEY ("networkId") REFERENCES "networks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "member_reports" ADD CONSTRAINT "member_reports_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "report_categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "members"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "affiliate_programs" ADD CONSTRAINT "affiliate_programs_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "member_affiliators" ADD CONSTRAINT "member_affiliators_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "members"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "member_affiliators" ADD CONSTRAINT "member_affiliators_programId_fkey" FOREIGN KEY ("programId") REFERENCES "affiliate_programs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "affiliate_commissions" ADD CONSTRAINT "affiliate_commissions_recipientId_fkey" FOREIGN KEY ("recipientId") REFERENCES "members"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "affiliate_commissions" ADD CONSTRAINT "affiliate_commissions_affiliatorId_fkey" FOREIGN KEY ("affiliatorId") REFERENCES "member_affiliators"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "affiliate_commissions" ADD CONSTRAINT "affiliate_commissions_programId_fkey" FOREIGN KEY ("programId") REFERENCES "affiliate_programs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "affiliate_commissions" ADD CONSTRAINT "affiliate_commissions_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "affiliate_visits" ADD CONSTRAINT "affiliate_visits_programId_fkey" FOREIGN KEY ("programId") REFERENCES "affiliate_programs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "affiliate_visits" ADD CONSTRAINT "affiliate_visits_affiliatorMemberId_fkey" FOREIGN KEY ("affiliatorMemberId") REFERENCES "members"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
