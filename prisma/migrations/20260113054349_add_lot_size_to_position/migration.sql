/*
  Warnings:

  - You are about to drop the column `sizePercent` on the `Position` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "Position" DROP COLUMN "sizePercent",
ADD COLUMN     "lotSize" DOUBLE PRECISION;
