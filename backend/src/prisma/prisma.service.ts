import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';

import { bindPlatform, bindTenant } from '../common/tenant-db';

/**
 * Thin wrapper around the generated Prisma client.
 * The schema is authored + migrated separately (prisma/schema.prisma); this
 * service just owns the connection lifecycle for the Nest app.
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private static readonly log = new Logger(PrismaService.name);

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

  /* ------------------------------------------------ RLS context (Phase B3) */

  /**
   * Run `fn` inside a transaction bound to one tenant at the DATABASE level.
   *
   * Everything `fn` does through `tx` is subject to the row-level policies for
   * that organisation, so a query that forgets its `where` clause returns
   * nothing instead of another tenant's rows.
   *
   * A TRANSACTION, not a bare statement, because `SET LOCAL` is transaction
   * scoped. Setting the value on a pooled connection outside one would leak the
   * tenant to whatever request is handed that connection next — which, with a
   * pool, is the normal case rather than an edge case.
   *
   * NOTE ON CURRENT STATE: the policies this cooperates with are written and
   * validated but NOT enabled in production (see the B3 migration). Until they
   * are, this behaves as an ordinary transaction — correct, and doing no harm.
   */
  async withTenant<T>(
    organisationId: string,
    fn: (tx: Prisma.TransactionClient) => Promise<T>,
    options?: { timeout?: number; maxWait?: number },
  ): Promise<T> {
    if (!organisationId) {
      // Fail closed. An empty organisation would bind the context to '' and, if
      // a policy were ever written with a loose comparison, match everything.
      throw new Error('withTenant requires an organisationId');
    }
    return this.$transaction(
      async (tx) => {
        await tx.$executeRaw(bindTenant(organisationId));
        return fn(tx);
      },
      { timeout: options?.timeout ?? 30_000, maxWait: options?.maxWait ?? 10_000 },
    );
  }

  /**
   * Run `fn` with the platform bypass open — control-plane work that legitimately
   * spans tenants.
   *
   * `reason` is mandatory and logged. An unexplained cross-tenant bypass is
   * indistinguishable from a bug, so the type system makes you write one down.
   */
  async withPlatform<T>(
    reason: string,
    fn: (tx: Prisma.TransactionClient) => Promise<T>,
    options?: { timeout?: number; maxWait?: number },
  ): Promise<T> {
    PrismaService.log.debug(`platform database context opened: ${reason}`);
    return this.$transaction(
      async (tx) => {
        await tx.$executeRaw(bindPlatform());
        return fn(tx);
      },
      { timeout: options?.timeout ?? 60_000, maxWait: options?.maxWait ?? 10_000 },
    );
  }
}
