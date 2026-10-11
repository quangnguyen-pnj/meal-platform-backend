-- Phase 1 (P1-01): the organization-level Dish catalog.
--
-- Hand-authored to stay consistent with the generated Prisma client. The
-- Prisma engine CDN is unreachable in this environment, so `prisma migrate dev`
-- cannot author this file; it mirrors the Dish model in prisma/schema.prisma.

-- CreateTable
CREATE TABLE "dish" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "category" TEXT,
    "dietaryTags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "dish_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "dish_organizationId_idx" ON "dish"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "dish_organizationId_code_key" ON "dish"("organizationId", "code");

-- AddForeignKey
ALTER TABLE "dish" ADD CONSTRAINT "dish_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
