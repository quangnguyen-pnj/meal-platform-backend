-- Phase 2 (P2-01): registrations, batches, per-registration change history,
-- and reserve pool settings/allocations.
--
-- Hand-authored to stay consistent with the generated Prisma client. The
-- Prisma engine CDN is unreachable in this environment, so `prisma migrate dev`
-- cannot author this file; it mirrors the Phase 2 models in
-- prisma/schema.prisma (MealRegistration, RegistrationBatch,
-- RegistrationBatchEntry, RegistrationChange, ReservePoolSetting,
-- ReserveAllocation) and their enums.
--
-- Reserve pool reconciliation: Phase 1 added a nullable
-- "meal_session_dish"."reservePoolSize" placeholder. Phase 2 moves reserve
-- configuration into "reserve_pool_setting" (1:1 with a session dish, off by
-- default) as the plan specifies. The placeholder column is intentionally left
-- in place and unused; it is not dropped so the P1-03 migration stays intact.

-- CreateEnum
CREATE TYPE "RegistrationStatus" AS ENUM ('REGISTERED', 'CANCELLED', 'ABSENT');

-- CreateEnum
CREATE TYPE "RegistrationSource" AS ENUM ('SELF', 'BULK', 'PAPER_FORM', 'ADMIN_ADJUSTMENT');

-- CreateEnum
CREATE TYPE "RegistrationChangeKind" AS ENUM ('CREATED', 'DISH_CHANGED', 'CANCELLED', 'ABSENT', 'POST_CUTOFF_ADJUSTMENT');

-- CreateEnum
CREATE TYPE "RegistrationBatchStatus" AS ENUM ('DRAFT', 'COMMITTED', 'REJECTED');

-- CreateEnum
CREATE TYPE "RegistrationBatchEntryStatus" AS ENUM ('PENDING', 'VALID', 'INVALID', 'COMMITTED');

-- CreateEnum
CREATE TYPE "ReserveAllocationStatus" AS ENUM ('ALLOCATED', 'CANCELLED');

-- CreateTable
CREATE TABLE "registration_batch" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "factoryId" TEXT NOT NULL,
    "source" "RegistrationSource" NOT NULL,
    "status" "RegistrationBatchStatus" NOT NULL DEFAULT 'DRAFT',
    "reason" TEXT,
    "paperReference" TEXT,
    "createdByUserId" TEXT NOT NULL,
    "submittedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "registration_batch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "meal_registration" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "mealSessionId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "mealSessionDishId" TEXT NOT NULL,
    "status" "RegistrationStatus" NOT NULL DEFAULT 'REGISTERED',
    "source" "RegistrationSource" NOT NULL,
    "registrationBatchId" TEXT,
    "adjustmentReason" TEXT,
    "createdByUserId" TEXT NOT NULL,
    "updatedByUserId" TEXT,
    "registeredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "cancelledAt" TIMESTAMP(3),
    "absentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "meal_registration_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "registration_batch_entry" (
    "id" TEXT NOT NULL,
    "registrationBatchId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "mealSessionId" TEXT NOT NULL,
    "mealSessionDishId" TEXT,
    "rowNumber" INTEGER,
    "status" "RegistrationBatchEntryStatus" NOT NULL DEFAULT 'PENDING',
    "errors" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "registration_batch_entry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "registration_change" (
    "id" TEXT NOT NULL,
    "mealRegistrationId" TEXT NOT NULL,
    "kind" "RegistrationChangeKind" NOT NULL,
    "before" JSONB,
    "after" JSONB,
    "reason" TEXT,
    "actorUserId" TEXT,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "registration_change_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reserve_pool_setting" (
    "id" TEXT NOT NULL,
    "mealSessionDishId" TEXT NOT NULL,
    "isEnabled" BOOLEAN NOT NULL DEFAULT false,
    "quantity" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "reserve_pool_setting_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reserve_allocation" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "mealSessionId" TEXT NOT NULL,
    "mealSessionDishId" TEXT NOT NULL,
    "employeeId" TEXT,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "status" "ReserveAllocationStatus" NOT NULL DEFAULT 'ALLOCATED',
    "reason" TEXT,
    "allocatedByUserId" TEXT NOT NULL,
    "allocatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "reserve_allocation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "registration_batch_organizationId_idx" ON "registration_batch"("organizationId");

-- CreateIndex
CREATE INDEX "registration_batch_factoryId_idx" ON "registration_batch"("factoryId");

-- CreateIndex
CREATE INDEX "meal_registration_organizationId_idx" ON "meal_registration"("organizationId");

-- CreateIndex
CREATE INDEX "meal_registration_mealSessionId_idx" ON "meal_registration"("mealSessionId");

-- CreateIndex
CREATE INDEX "meal_registration_employeeId_idx" ON "meal_registration"("employeeId");

-- CreateIndex
CREATE INDEX "meal_registration_registrationBatchId_idx" ON "meal_registration"("registrationBatchId");

-- CreateIndex
CREATE UNIQUE INDEX "meal_registration_mealSessionId_employeeId_key" ON "meal_registration"("mealSessionId", "employeeId");

-- CreateIndex
CREATE INDEX "registration_batch_entry_registrationBatchId_idx" ON "registration_batch_entry"("registrationBatchId");

-- CreateIndex
CREATE INDEX "registration_batch_entry_employeeId_idx" ON "registration_batch_entry"("employeeId");

-- CreateIndex
CREATE INDEX "registration_batch_entry_mealSessionId_idx" ON "registration_batch_entry"("mealSessionId");

-- CreateIndex
CREATE INDEX "registration_change_mealRegistrationId_idx" ON "registration_change"("mealRegistrationId");

-- CreateIndex
CREATE UNIQUE INDEX "reserve_pool_setting_mealSessionDishId_key" ON "reserve_pool_setting"("mealSessionDishId");

-- CreateIndex
CREATE INDEX "reserve_allocation_organizationId_idx" ON "reserve_allocation"("organizationId");

-- CreateIndex
CREATE INDEX "reserve_allocation_mealSessionId_idx" ON "reserve_allocation"("mealSessionId");

-- CreateIndex
CREATE INDEX "reserve_allocation_mealSessionDishId_idx" ON "reserve_allocation"("mealSessionDishId");

-- CreateIndex
CREATE INDEX "reserve_allocation_employeeId_idx" ON "reserve_allocation"("employeeId");

-- AddForeignKey
ALTER TABLE "registration_batch" ADD CONSTRAINT "registration_batch_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "registration_batch" ADD CONSTRAINT "registration_batch_factoryId_fkey" FOREIGN KEY ("factoryId") REFERENCES "factory"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "meal_registration" ADD CONSTRAINT "meal_registration_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "meal_registration" ADD CONSTRAINT "meal_registration_mealSessionId_fkey" FOREIGN KEY ("mealSessionId") REFERENCES "meal_session"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "meal_registration" ADD CONSTRAINT "meal_registration_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "meal_registration" ADD CONSTRAINT "meal_registration_mealSessionDishId_fkey" FOREIGN KEY ("mealSessionDishId") REFERENCES "meal_session_dish"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "meal_registration" ADD CONSTRAINT "meal_registration_registrationBatchId_fkey" FOREIGN KEY ("registrationBatchId") REFERENCES "registration_batch"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "registration_batch_entry" ADD CONSTRAINT "registration_batch_entry_registrationBatchId_fkey" FOREIGN KEY ("registrationBatchId") REFERENCES "registration_batch"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "registration_batch_entry" ADD CONSTRAINT "registration_batch_entry_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "registration_batch_entry" ADD CONSTRAINT "registration_batch_entry_mealSessionId_fkey" FOREIGN KEY ("mealSessionId") REFERENCES "meal_session"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "registration_batch_entry" ADD CONSTRAINT "registration_batch_entry_mealSessionDishId_fkey" FOREIGN KEY ("mealSessionDishId") REFERENCES "meal_session_dish"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "registration_change" ADD CONSTRAINT "registration_change_mealRegistrationId_fkey" FOREIGN KEY ("mealRegistrationId") REFERENCES "meal_registration"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reserve_pool_setting" ADD CONSTRAINT "reserve_pool_setting_mealSessionDishId_fkey" FOREIGN KEY ("mealSessionDishId") REFERENCES "meal_session_dish"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reserve_allocation" ADD CONSTRAINT "reserve_allocation_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reserve_allocation" ADD CONSTRAINT "reserve_allocation_mealSessionId_fkey" FOREIGN KEY ("mealSessionId") REFERENCES "meal_session"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reserve_allocation" ADD CONSTRAINT "reserve_allocation_mealSessionDishId_fkey" FOREIGN KEY ("mealSessionDishId") REFERENCES "meal_session_dish"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reserve_allocation" ADD CONSTRAINT "reserve_allocation_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "employee"("id") ON DELETE SET NULL ON UPDATE CASCADE;
