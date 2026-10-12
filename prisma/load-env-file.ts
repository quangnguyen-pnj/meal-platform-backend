import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Prisma 7 does not read `.env` on its own, so `prisma migrate` and the seed
 * script would fail with "Cannot resolve environment variable: DATABASE_URL"
 * after `cp .env.example .env`. This loads the file with Node's built-in
 * `process.loadEnvFile` (Node 20.12+). Variables already set in the shell win
 * over the file, so `DATABASE_URL=... npm run prisma:migrate` still works.
 */
export function loadEnvFile(): void {
  const envPath = resolve(process.cwd(), '.env');
  if (existsSync(envPath)) {
    process.loadEnvFile(envPath);
  }
}
