-- AlterTable
ALTER TABLE "Payout" ADD COLUMN     "paymentId" TEXT,
ADD COLUMN     "status" TEXT NOT NULL DEFAULT 'pending';
