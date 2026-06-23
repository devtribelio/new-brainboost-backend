-- Product: store SKU mapping (IAP / external provider product_id -> Product)
ALTER TABLE "products" ADD COLUMN "iapProductId" TEXT;
CREATE UNIQUE INDEX "products_iapProductId_key" ON "products"("iapProductId");

-- AffiliateVisit: programId becomes optional (generic affiliator deeplink, no specific program)
ALTER TABLE "affiliate_visits" ALTER COLUMN "programId" DROP NOT NULL;

-- CommerceTransaction: multi-channel ingestion provenance + idempotency
ALTER TABLE "commerce_transactions" ADD COLUMN "provider" TEXT;
ALTER TABLE "commerce_transactions" ADD COLUMN "providerEventId" TEXT;
CREATE UNIQUE INDEX "commerce_transactions_provider_providerEventId_key" ON "commerce_transactions"("provider", "providerEventId");

-- ThirdPartyCredential: auth + per-channel capability toggles
CREATE TABLE "third_party_credentials" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "keyHash" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "triggersAffiliate" BOOLEAN NOT NULL DEFAULT false,
    "canIngestRefund" BOOLEAN NOT NULL DEFAULT false,
    "lastUsedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "third_party_credentials_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "third_party_credentials_name_key" ON "third_party_credentials"("name");
CREATE UNIQUE INDEX "third_party_credentials_keyHash_key" ON "third_party_credentials"("keyHash");
