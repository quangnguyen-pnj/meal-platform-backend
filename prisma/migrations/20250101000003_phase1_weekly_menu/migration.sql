-- Phase 1 (P1-02): factory weekly menus and their menu items.
--
-- Hand-authored to stay consistent with the generated Prisma client. The
-- Prisma engine CDN is unreachable in this environment, so `prisma migrate dev`
-- cannot author this file; it mirrors the WeeklyMenu and MenuItem models in
-- prisma/schema.prisma.

-- CreateEnum
CREATE TYPE "WeeklyMenuStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "MealType" AS ENUM ('LUNCH', 'DINNER');

-- CreateTable
CREATE TABLE "weekly_menu" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "factoryId" TEXT NOT NULL,
    "weekStartDate" DATE NOT NULL,
    "status" "WeeklyMenuStatus" NOT NULL DEFAULT 'DRAFT',
    "publishedAt" TIMESTAMP(3),
    "publishedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "weekly_menu_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "menu_item" (
    "id" TEXT NOT NULL,
    "weeklyMenuId" TEXT NOT NULL,
    "serviceDate" DATE NOT NULL,
    "mealType" "MealType" NOT NULL,
    "dishId" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "menu_item_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "weekly_menu_organizationId_idx" ON "weekly_menu"("organizationId");

-- CreateIndex
CREATE INDEX "weekly_menu_factoryId_idx" ON "weekly_menu"("factoryId");

-- CreateIndex
CREATE UNIQUE INDEX "weekly_menu_factoryId_weekStartDate_key" ON "weekly_menu"("factoryId", "weekStartDate");

-- CreateIndex
CREATE INDEX "menu_item_weeklyMenuId_idx" ON "menu_item"("weeklyMenuId");

-- CreateIndex
CREATE INDEX "menu_item_dishId_idx" ON "menu_item"("dishId");

-- CreateIndex
CREATE UNIQUE INDEX "menu_item_weeklyMenuId_serviceDate_mealType_dishId_key" ON "menu_item"("weeklyMenuId", "serviceDate", "mealType", "dishId");

-- AddForeignKey
ALTER TABLE "weekly_menu" ADD CONSTRAINT "weekly_menu_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "weekly_menu" ADD CONSTRAINT "weekly_menu_factoryId_fkey" FOREIGN KEY ("factoryId") REFERENCES "factory"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "menu_item" ADD CONSTRAINT "menu_item_weeklyMenuId_fkey" FOREIGN KEY ("weeklyMenuId") REFERENCES "weekly_menu"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "menu_item" ADD CONSTRAINT "menu_item_dishId_fkey" FOREIGN KEY ("dishId") REFERENCES "dish"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
