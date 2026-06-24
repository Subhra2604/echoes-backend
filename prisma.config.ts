import 'dotenv/config';
import { defineConfig } from 'prisma/config';

/**
 * Prisma 7 moved the migrate/CLI connection URL out of schema.prisma into this
 * file. We read process.env.DATABASE_URL directly (not the `env()` helper) so
 * that `prisma generate` — which runs at build time without a database URL —
 * does not fail; commands that actually connect (`prisma db push`, `migrate`)
 * receive DATABASE_URL from the environment (docker-compose / .env) at runtime.
 *
 * The runtime PrismaClient connects via the @prisma/adapter-pg driver adapter
 * (see src/lib/prisma.ts), independent of this CLI configuration.
 */
export default defineConfig({
  schema: 'prisma/schema.prisma',
  datasource: {
    url: process.env.DATABASE_URL ?? '',
  },
});
