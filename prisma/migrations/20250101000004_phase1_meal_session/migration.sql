-- Phase 1 (P1-03): meal sessions and their offered dishes.
--
-- Hand-authored to stay consistent with the generated Prisma client. The
-- Prisma engine CDN is unreachable in this environment, so `prisma migrate dev`
-- cannot author this file; it mirrors the MealSession and MealSessionDish
-- models in prisma/schema.prisma.

-- CreateEnum
CREATE TYPE "MealSessionStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'OPEN', 'CLOSED', 'CANCELLED');

-- CreateTable
CREATE TABLE "meal_session" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "factoryId" TEXT NOT NULL,
    "weeklyMenuId" TEXT,
    "serviceDate" DATE NOT NULL,
    "mealType" "MealType" NOT NULL,
    "status" "MealSessionStatus" NOT NULL DEFAULT 'DRAFT',
    "opensAt" TIMESTAMP(3) NOT NULL,
    "cutoffAt" TIMESTAMP(3) NOT NULL,
    "publishedAt" TIMESTAMP(3),
    "publishedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "meal_session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "meal_session_dish" (
    "id" TEXT NOT NULL,
    "mealSessionId" TEXT NOT NULL,
    "dishId" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "reservePoolSize" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "meal_session_dish_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "meal_session_organizationId_idx" ON "meal_session"("organizationId");

-- CreateIndex
CREATE INDEX "meal_session_factoryId_idx" ON "meal_session"("factoryId");

-- CreateIndex
CREATE INDEX "meal_session_weeklyMenuId_idx" ON "meal_session"("weeklyMenuId");

-- CreateIndex
CREATE UNIQUE INDEX "meal_session_factoryId_serviceDate_mealType_key" ON "meal_session"("factoryId", "serviceDate", "mealType");

-- CreateIndex
CREATE INDEX "meal_session_dish_mealSessionId_idx" ON "meal_session_dish"("mealSessionId");

-- CreateIndex
CREATE INDEX "meal_session_dish_dishId_idx" ON "meal_session_dish"("dishId");

-- CreateIndex
CREATE UNIQUE INDEX "meal_session_dish_mealSessionId_dishId_key" ON "meal_session_dish"("mealSessionId", "dishId");

-- AddForeignKey
ALTER TABLE "meal_session" ADD CONSTRAINT "meal_session_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "meal_session" ADD CONSTRAINT "meal_session_factoryId_fkey" FOREIGN KEY ("factoryId") REFERENCES "factory"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "meal_session" ADD CONSTRAINT "meal_session_weeklyMenuId_fkey" FOREIGN KEY ("weeklyMenuId") REFERENCES "weekly_menu"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "meal_session_dish" ADD CONSTRAINT "meal_session_dish_mealSessionId_fkey" FOREIGN KEY ("mealSessionId") REFERENCES "meal_session"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "meal_session_dish" ADD CONSTRAINT "meal_session_dish_dishId_fkey" FOREIGN KEY ("dishId") REFERENCES "dish"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
