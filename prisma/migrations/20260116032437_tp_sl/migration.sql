/*
  Warnings:

  - You are about to drop the column `createdAt` on the `User` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "Position" ADD COLUMN     "closeReason" TEXT,
ADD COLUMN     "stopLoss" DOUBLE PRECISION,
ADD COLUMN     "takeProfit" DOUBLE PRECISION,
ALTER COLUMN "currentPnl" DROP NOT NULL,
ALTER COLUMN "currentPnl" DROP DEFAULT;

-- AlterTable
ALTER TABLE "User" DROP COLUMN "createdAt",
ADD COLUMN     "password" TEXT;
