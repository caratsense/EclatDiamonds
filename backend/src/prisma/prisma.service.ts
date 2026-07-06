import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

/**
 * Thin wrapper around the generated Prisma client.
 * The schema is authored + migrated separately (prisma/schema.prisma); this
 * service just owns the connection lifecycle for the Nest app.
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  constructor() {
    // Cap the pool small + fail fast. A saturated/proxied Postgres (e.g. a busy
    // public proxy) otherwise lets migrate grab its one connection but hangs the
    // app's pool forever → boot never finishes → 502. connection_limit keeps the
    // demand low; connect/pool_timeout turn an unreachable DB into a fast error
    // instead of an infinite hang.
    const base = process.env.DATABASE_URL ?? '';
    const url = base
      ? base +
        (base.includes('?') ? '&' : '?') +
        'connection_limit=3&pool_timeout=20&connect_timeout=15'
      : undefined;
    super(url ? { datasources: { db: { url } } } : {});
  }

  async onModuleInit(): Promise<void> {
    // Never let a transient DB hiccup block the whole app from serving; Prisma
    // reconnects lazily on the next query if the initial connect fails.
    try {
      await this.$connect();
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error('[prisma] initial connect failed (continuing):', (e as Error).message);
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
