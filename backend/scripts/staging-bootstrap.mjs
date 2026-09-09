/**
 * Make an empty staging database usable for a first Meta/WhatsApp test.
 *
 * Deliberately NOT the demo seed. It creates one store, one head-office login
 * and one unconfigured WhatsApp connection — the smallest set that makes the
 * administration screens reachable. No customers, no leads, no sales: a staging
 * database that looks like production is a staging database somebody will
 * eventually mistake for production.
 *
 * Refuses to run against anything that looks like a production database, and
 * refuses to run at all if the database already holds customer records.
 *
 *   railway run --service Postgres --environment staging -- \
 *     node scripts/staging-bootstrap.mjs --password "<chosen>"
 */
import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

const url = process.env.DATABASE_PUBLIC_URL ?? process.env.DATABASE_URL;
if (!url) {
  console.error('No database URL in the environment.');
  process.exit(1);
}

const args = process.argv.slice(2);
const password = args[args.indexOf('--password') + 1];
if (!args.includes('--password') || !password || password.length < 12) {
  console.error('Pass --password with at least 12 characters.');
  process.exit(1);
}

const prisma = new PrismaClient({ datasources: { db: { url } } });

/*
 * The guard. A staging bootstrap that runs against production would create a
 * head-office login nobody authorised, on a tenant with real customers. Any
 * customer record at all means this is not an empty staging database, and the
 * safe reading of "I am not sure" is to stop.
 */
const [parties, leads, sales] = await Promise.all([
  prisma.party.count(),
  prisma.lead.count(),
  prisma.sale.count().catch(() => 0),
]);
if (parties > 0 || leads > 0 || sales > 0) {
  console.error(
    `Refusing to run: this database already holds records ` +
      `(customers=${parties} leads=${leads} sales=${sales}). ` +
      `staging-bootstrap only runs against an empty database.`,
  );
  process.exit(1);
}

const organisation = await prisma.organisation.findFirst({ select: { id: true, name: true } });
if (!organisation) {
  console.error('No organisation exists yet — start the backend once so migrations seed it.');
  process.exit(1);
}

const store = await prisma.store.upsert({
  where: { id: 'store_staging_main' },
  create: {
    id: 'store_staging_main',
    organisationId: organisation.id,
    name: 'Staging Store',
    city: 'Test',
    timezone: 'Asia/Kolkata',
    isActive: true,
  },
  update: {},
});

const email = 'staging.admin@caratsense.in';
const user = await prisma.user.upsert({
  where: { email },
  create: {
    email,
    name: 'Staging Admin',
    role: 'head_office',
    passwordHash: await bcrypt.hash(password, 10),
    isActive: true,
    approvalStatus: 'approved',
    organisationId: organisation.id,
    userStores: { create: { storeId: store.id, isPrimary: true } },
  },
  update: { passwordHash: await bcrypt.hash(password, 10), isActive: true, approvalStatus: 'approved' },
});

// An unconfigured connection, so the administration screens have something to
// select. No credential is attached: the screens must show "not connected"
// until a real token is entered through the UI.
const whatsapp = await prisma.integration.upsert({
  where: { id: 'int_staging_whatsapp' },
  create: {
    id: 'int_staging_whatsapp',
    organisationId: organisation.id,
    providerCode: 'whatsapp_cloud',
    name: 'WhatsApp (staging test number)',
    status: 'configured',
    config: {},
  },
  update: {},
});
const meta = await prisma.integration.upsert({
  where: { id: 'int_staging_meta' },
  create: {
    id: 'int_staging_meta',
    organisationId: organisation.id,
    providerCode: 'meta_ads',
    name: 'Meta Ads (staging)',
    status: 'configured',
    config: {},
  },
  update: {},
});

console.log('organisation:', organisation.id, `(${organisation.name})`);
console.log('store:', store.id);
console.log('login:', user.email, '(password not printed)');
console.log('connections:', whatsapp.providerCode, '+', meta.providerCode, '— both unconfigured');
console.log('customers/leads/sales created: 0');

await prisma.$disconnect();
