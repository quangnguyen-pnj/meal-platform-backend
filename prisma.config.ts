import { defineConfig, env } from '@prisma/config';

/**
 * Prisma 7 config.
 *
 * Prisma 7 no longer allows `url` inside `schema.prisma`, so the migrate/db
 * CLI commands read the connection string from `datasource.url` here. The
 * runtime client connects through the `@prisma/adapter-pg` driver adapter
 * built from the same `DATABASE_URL` (see `PrismaService`).
 */
export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
    seed: 'tsx prisma/seed.ts',
  },
  datasource: {
    url: env('DATABASE_URL'),
  },
});
