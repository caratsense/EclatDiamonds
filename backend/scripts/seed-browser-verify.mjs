#!/usr/bin/env node
/**
 * Three tenants on three industries, each with four roles, for the browser run.
 *
 * Kept separate from the demo seed on purpose: this creates exactly what the
 * verification needs and nothing else, into its own organisations, so it can be
 * run against a scratch database without touching anybody's data.
 *
 * Each tenant is provisioned with its industry pack exactly as self-service
 * onboarding does (vocabulary, taxonomies, field policies), so a clinic is
 * shaped like a clinic. That code is TypeScript, so build the backend first.
 * Run it against a fresh database.
 *
 * Prints the tenant/role table as JSON on stdout, which `browser-verify.mjs`
 * takes as `VERIFY_TENANTS`.
 */
import { createRequire } from 'node:module';
import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

const require = createRequire(import.meta.url);
const { provisionIndustryPack } = require('../dist/config/industry-packs/provision.js');
const { getPack } = require('../dist/config/industry-packs/packs.js');

const prisma = new PrismaClient();
const PASSWORD = 'password123';

const TENANTS = [
  { id: 'org_bv_jewel', slug: 'bv-jewellery', name: 'BV Jewellery', pack: 'jewellery' },
  { id: 'org_bv_health', slug: 'bv-healthcare', name: 'BV Clinic', pack: 'healthcare' },
  { id: 'org_bv_textile', slug: 'bv-textile', name: 'BV Mills', pack: 'textile' },
];

const ROLES = ['head_office', 'store_manager', 'salesperson', 'storeperson'];

async function main() {
  const hash = await bcrypt.hash(PASSWORD, 10);
  const out = [];

  for (const t of TENANTS) {
    // A provisioned tenant owns config rows a delete would have to chase; a
    // second run is refused instead of half-reset.
    if (await prisma.organisation.count({ where: { id: t.id } })) {
      throw new Error(`${t.id} already exists: seed a fresh database.`);
    }

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
    const pack = getPack(t.pack);
    if (!pack) throw new Error(`No industry pack ${t.pack}`);
    await prisma.$transaction((tx) => provisionIndustryPack(tx, t.id, pack), { timeout: 20_000 });

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
    /*
     * Two leads at the same branch: one the salesperson owns, one the manager
     * owns. The browser run reads them back through the real API, so the board
     * proves the salesperson's scope rather than only that the page loaded.
     */
    const own = `BV Own Lead ${t.name}`;
    const colleague = `BV Colleague Lead ${t.name}`;
    for (const [n, name, owner] of [[1, own, 'salesperson'], [2, colleague, 'store_manager']]) {
      await prisma.lead.create({
        data: {
          organisationId: t.id, storeId: store.id, ref: `BV-${t.slug}-${n}`, customerName: name,
          source: 'walk_in', stage: 'inquiry', ownerId: `${t.id}_${owner}`,
        },
      });
    }
    const expectations = [
      { role: 'salesperson', route: 'crm', contains: [own], absent: [colleague] },
      { role: 'store_manager', route: 'crm', contains: [own, colleague], absent: [] },
      { role: 'head_office', route: 'crm', contains: [own, colleague], absent: [] },
    ];
    out.push({ label: t.slug, industry: t.pack, users, expectations });
  }

  console.log(JSON.stringify(out));
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
