-- CreateTable
CREATE TABLE "DailyCandle" (
    "id" SERIAL NOT NULL,
    "symbol" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "time" INTEGER NOT NULL,
    "open" DOUBLE PRECISION NOT NULL,
    "high" DOUBLE PRECISION NOT NULL,
    "low" DOUBLE PRECISION NOT NULL,
    "close" DOUBLE PRECISION NOT NULL,

    CONSTRAINT "DailyCandle_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DailyCandle_symbol_date_idx" ON "DailyCandle"("symbol", "date");

-- CreateIndex
CREATE UNIQUE INDEX "DailyCandle_symbol_date_time_key" ON "DailyCandle"("symbol", "date", "time");
