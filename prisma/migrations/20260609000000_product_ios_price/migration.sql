-- Gross iOS IAP price (marked up to offset Apple's store cut). Null = same as `price`.
-- Drives the affiliate commission RANGE preview (iOS net basis = min, web price = max).
ALTER TABLE "products" ADD COLUMN "ios_price" INTEGER;
