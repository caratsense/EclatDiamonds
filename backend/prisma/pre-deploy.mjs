#!/usr/bin/env node
/**
 * The pre-deploy step, as ONE command.
 *
 * Railway runs `deploy.preDeployCommand` in its own container before the new
 * app instance boots. Chaining steps there with `&&` has silently dropped the
 * second step before (2026-07-10: migrations ran, the seed that followed them
 * never did), and a step that does not run leaves no error to notice. One
 * command, with the ordering in code, removes that class of failure: every step
 * is a child process, its output is inherited, and a non-zero exit stops the
 * rest — which fails the deployment rather than booting against a half-prepared
 * database.
 *
 * ALWAYS:
 *   1. apply pending migrations (idempotent — only un-applied ones run)
 *   2. backfill demo user phones, as the previous command did
 *
 * ONLY when SEED_DEMO_TARGET=staging:
 *   3. the demo dataset, so a staging environment has something to show
 *   4. the five demo WhatsApp threads
 *
 * Both of those write invented customers, so they are gated on the variable AND
 * on the seeders' own guards — `seed-conversations.mjs` refuses any database
 * that cannot prove it is staging. Production sets no such variable and is
 * unaffected: it runs steps 1 and 2 exactly as before.
 */
import { execFileSync } from 'node:child_process';

const STAGING = process.env.SEED_DEMO_TARGET === 'staging';

/** Prisma's CLI is called through node directly: npx hangs on egress-restricted hosts. */
const steps = [
  ['migrations', ['node_modules/prisma/build/index.js', 'migrate', 'deploy']],
  ['demo user phones', ['prisma/seed-user-phones.mjs']],
  ...(STAGING
    ? [
        ['demo dataset (staging only)', ['prisma/seed.mjs']],
        ['demo WhatsApp threads (staging only)', ['scripts/seed-conversations.mjs']],
      ]
    : []),
];

for (const [name, args] of steps) {
  console.log(`\n── pre-deploy: ${name} ───────────────────────────────────`);
  execFileSync(process.execPath, args, { stdio: 'inherit' });
}
console.log(`\npre-deploy finished: ${steps.length} step(s)${STAGING ? ', staging fill included' : ''}.`);
