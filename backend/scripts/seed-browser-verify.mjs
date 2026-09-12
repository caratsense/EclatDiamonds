#!/usr/bin/env node
/**
 * Three tenants on three industries, each with three roles, for the browser run.
 *
 * Kept separate from the demo seed on purpose: this creates exactly what the
 * verification needs and nothing else, into its own organisations, so it can be
 * run against a scratch database without touching anybody's data.
 *
 * Prints the tenant/role table as JSON on stdout, which `browser-verify.mjs`
 * takes as `VERIFY_TENANTS`.
 */
import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();
const PASSWORD = 'password123';

const TENANTS = [
  { id: 'org_bv_jewel', slug: 'bv-jewellery', name: 'BV Jewellery', pack: 'jewellery' },
  { id: 'org_bv_health', slug: 'bv-healthcare', name: 'BV Clinic', pack: 'healthcare' },
  { id: 'org_bv_textile', slug: 'bv-textile', name: 'BV Mills', pack: 'textile' },
];

const ROLES = ['head_office', 'store_manager', 'salesperson'];

async function main() {
  const hash = await bcrypt.hash(PASSWORD, 10);
  const out = [];

  for (const t of TENANTS) {
    // Idempotent: re-running must not duplicate a tenant or fail on the slug.
    await prisma.userStore.deleteMany({ where: { user: { organisationId: t.id } } });
    await prisma.user.deleteMany({ where: { organisationId: t.id } });
    await prisma.store.deleteMany({ where: { organisationId: t.id } });
    await prisma.organisation.deleteMany({ where: { id: t.id } });

    await prisma.organisation.create({
      data: {
        id: t.id,
        name: t.name,
        slug: t.slug,
        industryPackCode: t.pack,
        industryPackVersion: 1,
        timezone: 'Asia/Kolkata',
      },
    });
    const store = await prisma.store.create({
      data: {
        id: `${t.id}_store`,
        name: `${t.name} main`,
        city: 'Mumbai',
        organisationId: t.id,
        timezone: 'Asia/Kolkata',
      },
    });

    const users = {};
    for (const role of ROLES) {
      const email = `${role}.${t.slug}@bv.local`;
      await prisma.user.create({
        data: {
          id: `${t.id}_${role}`,
          email,
          name: `${role} ${t.slug}`,
          role,
          passwordHash: hash,
          isActive: true,
          approvalStatus: 'approved',
          organisationId: t.id,
          userStores: { create: { storeId: store.id, isPrimary: true } },
        },
      });
      users[role] = { email, password: PASSWORD };
    }
    out.push({ label: t.slug, industry: t.pack, users });
  }

  console.log(JSON.stringify(out));
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
