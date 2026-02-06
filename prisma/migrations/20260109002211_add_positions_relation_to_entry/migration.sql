/*
  Warnings:

  - You are about to drop the column `direction` on the `Entry` table. All the data in the column will be lost.
  - You are about to drop the column `pair` on the `Entry` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "Entry" DROP COLUMN "direction",
DROP COLUMN "pair",
ALTER COLUMN "virtualCapital" DROP DEFAULT;

-- CreateTable
CREATE TABLE "Position" (
    "id" TEXT NOT NULL,
    "entryId" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "direction" TEXT NOT NULL,
    "sizePercent" DOUBLE PRECISION NOT NULL,
    "entryPrice" DOUBLE PRECISION NOT NULL,
    "currentPnl" DOUBLE PRECISION NOT NULL DEFAULT 0.0,
    "openedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closedAt" TIMESTAMP(3),

    CONSTRAINT "Position_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "Position" ADD CONSTRAINT "Position_entryId_fkey" FOREIGN KEY ("entryId") REFERENCES "Entry"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
