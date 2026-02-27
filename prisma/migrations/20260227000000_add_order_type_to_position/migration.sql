-- AddColumn orderType, targetPrice, orderStatus to Position
ALTER TABLE "Position" ADD COLUMN "orderType" TEXT NOT NULL DEFAULT 'market';
ALTER TABLE "Position" ADD COLUMN "targetPrice" DOUBLE PRECISION;
ALTER TABLE "Position" ADD COLUMN "orderStatus" TEXT NOT NULL DEFAULT 'filled';
