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
    // Bounded pool + fail fast. A saturated/proxied Postgres otherwise hangs the
    // pool forever → boot never finishes → 502. connect/pool_timeout turn an
    // unreachable DB into a fast error instead of an infinite hang.
    // connection_limit=10 (raised from the boot-recovery cap of 3 for the
    // multi-store rollout); override per-env with DB_POOL_SIZE if needed.
    const pool = Number(process.env.DB_POOL_SIZE) > 0 ? Number(process.env.DB_POOL_SIZE) : 10;
    const base = process.env.DATABASE_URL ?? '';
    const url = base
      ? base +
        (base.includes('?') ? '&' : '?') +
        `connection_limit=${pool}&pool_timeout=20&connect_timeout=15`
      : undefined;
    super(url ? { datasources: { db: { url } } } : {});
  }

  onModuleInit(): void {
    // LAZY CONNECT — deliberately do NOT $connect() at boot. Establishing the pool
    // against a saturated DB / public proxy makes $connect() hang indefinitely
    // (it ignores connect_timeout at the driver level), which hangs NestFactory
    // forever → the server never listens → 502. Prisma connects on the FIRST query
    // instead, so the app always reaches app.listen(); queries then succeed as soon
    // as a connection is available and fail fast (pool_timeout) if not.
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
