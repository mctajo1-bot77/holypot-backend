-- AlterTable Entry: add closedAt and wasRollover columns
ALTER TABLE "Entry" ADD COLUMN "closedAt" TIMESTAMP(3);
ALTER TABLE "Entry" ADD COLUMN "wasRollover" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable Payout: add entryId column for direct traceability
ALTER TABLE "Payout" ADD COLUMN "entryId" TEXT;

-- AddForeignKey
ALTER TABLE "Payout" ADD CONSTRAINT "Payout_entryId_fkey" FOREIGN KEY ("entryId") REFERENCES "Entry"("id") ON DELETE SET NULL ON UPDATE CASCADE;
