import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../../generated/prisma/client';

/**
 * Thin wrapper around the generated PrismaClient so Nest can inject a single
 * shared instance.
 *
 * Prisma 7 connects through a driver adapter rather than a bundled query
 * engine binary, so the client is constructed with a `PrismaPg` adapter built
 * from `DATABASE_URL`. Connects on module init; Nest's `enableShutdownHooks`
 * handles disconnect on shutdown.
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit {
  private readonly logger = new Logger(PrismaService.name);

  constructor(config: ConfigService) {
    super({
      adapter: new PrismaPg({
        connectionString: config.getOrThrow<string>('DATABASE_URL'),
      }),
    });
  }

  async onModuleInit(): Promise<void> {
    try {
      await this.$connect();
      this.logger.log('Connected to the database');
    } catch (error) {
      // Don't crash the process on a transient DB outage at boot; the health
      // endpoint reports `degraded` and queries reconnect on demand.
      this.logger.error(
        'Failed to connect to the database on startup',
        error instanceof Error ? error.stack : String(error),
      );
    }
  }
}
