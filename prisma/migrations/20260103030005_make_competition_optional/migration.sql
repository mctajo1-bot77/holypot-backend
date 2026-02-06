-- DropForeignKey
ALTER TABLE "Entry" DROP CONSTRAINT "Entry_competitionId_fkey";

-- AlterTable
ALTER TABLE "Entry" ALTER COLUMN "competitionId" DROP NOT NULL;

-- AddForeignKey
ALTER TABLE "Entry" ADD CONSTRAINT "Entry_competitionId_fkey" FOREIGN KEY ("competitionId") REFERENCES "Competition"("id") ON DELETE SET NULL ON UPDATE CASCADE;
