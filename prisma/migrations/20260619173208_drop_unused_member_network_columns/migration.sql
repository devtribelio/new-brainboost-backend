-- AlterTable
ALTER TABLE "members" DROP COLUMN "first_name",
DROP COLUMN "inviter_network_id",
DROP COLUMN "last_name",
DROP COLUMN "register_from";

-- AlterTable
ALTER TABLE "networks" DROP COLUMN "banner_url",
DROP COLUMN "is_paid",
DROP COLUMN "member_quota";

