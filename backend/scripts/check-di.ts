/**
 * Build the Nest injector and exit.
 *
 * This exists because production went down for twelve minutes on 16 Nov with
 * an UnknownDependenciesException: a service was added to a constructor
 * without importing the module that exports it. Nothing caught it —
 * `tsc --noEmit` passed, all unit tests passed, and `next build` compiled,
 * because none of them construct the dependency graph. Only starting the app
 * does, and the first thing that started it was the production container.
 *
 * `create()` resolves the whole graph and is enough; `init()` is deliberately
 * not called, so no port is bound and no socket opened. A throwaway
 * DATABASE_URL is fine because Prisma connects lazily — if that ever changes,
 * this will say so loudly rather than pass quietly.
 */
// Set before AppModule is imported: a throwaway URL so Prisma has something
// to parse. It connects lazily, so nothing dials out.
process.env.DATABASE_URL ||= 'postgresql://u:p@127.0.0.1:1/none';

import { NestFactory } from '@nestjs/core';

import { AppModule } from '../src/app.module';

async function main(): Promise<void> {
  const app = await NestFactory.create(AppModule, {
    logger: ['error'],
    abortOnError: false,
  });
  await app.close();
  console.log('Nest dependency graph resolves.');
}

main().catch((error: unknown) => {
  console.error('Nest dependency graph FAILED to resolve:\n');
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
