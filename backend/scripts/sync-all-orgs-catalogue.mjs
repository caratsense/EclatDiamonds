import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();
/*
 * Local only. This script writes across every organisation in the database, so
 * the same command pointed at a live one would push demo catalogue rows into
 * real tenants. The connection has to be on this machine.
 */
const dbHost = (() => {
  try {
    return new URL(process.env.DATABASE_URL ?? '').hostname;
  } catch {
    return '';
  }
})();
if (!['localhost', '127.0.0.1', '::1'].includes(dbHost)) {
  console.error(
    `Refusing to run against ${dbHost || 'an unreadable DATABASE_URL'}: this script is local-only.`,
  );
  process.exit(2);
}

async function main() {
  console.log('--- 1. Updating 10 original products with imageUrls ---');
  const originalImageMap = {
    'NK-TEMPLE-22': '/uploads/products/neck-001.jpg',
    'RG-SOL-18': '/uploads/products/ring-001.jpg',
    'BN-ROSE-18': '/uploads/products/ban-004.jpg',
    'ER-CHAND-22': '/uploads/products/ear-001.jpg',
    'BR-TENNIS-18': '/uploads/products/brac-001.jpg',
    'PD-MANGAL-22': '/uploads/products/pend-002.jpg',
    'CH-ROPE-22': '/uploads/products/ch-001.jpg',
    'RG-BAND-PT': '/uploads/products/ring-004.jpg',
    'BN-KADA-22': '/uploads/products/ban-001.jpg',
    'PD-HALO-18': '/uploads/products/pend-001.jpg',
  };

  for (const [sku, imageUrl] of Object.entries(originalImageMap)) {
    await prisma.product.updateMany({
      where: { sku },
      data: { imageUrl },
    });
  }
  console.log('Updated original product imageUrls.');

  console.log('--- 2. Connecting all user accounts to org_eclat ---');
  // Also link head.office@eclatdiamonds.in to org_eclat and stores
  const targetUsers = ['head.office@eclatdiamonds.in', 'shreyansh@kashyap.in'];
  const eclatStores = await prisma.store.findMany({
    where: { organisationId: 'org_eclat' },
    select: { id: true },
  });

  for (const email of targetUsers) {
    const user = await prisma.user.findUnique({ where: { email } });
    if (user) {
      await prisma.user.update({
        where: { email },
        data: {
          organisationId: 'org_eclat',
          role: 'head_office',
          approvalStatus: 'approved',
        },
      });
      for (const st of eclatStores) {
        await prisma.userStore.upsert({
          where: {
            userId_storeId: {
              userId: user.id,
              storeId: st.id,
            },
          },
          create: {
            userId: user.id,
            storeId: st.id,
            isPrimary: st.id === 'surat-main',
          },
          update: {},
        });
      }
      console.log(`Updated ${email} -> org_eclat with ${eclatStores.length} stores.`);
    }
  }

  console.log('--- 3. Replicating all 40 products and embeddings to other orgs ---');
  // In case the browser token still has the other org ID
  const allOrgs = await prisma.organisation.findMany();
  const sourceProducts = await prisma.product.findMany({
    where: {
      organisationId: 'org_eclat',
      sku: { startsWith: 'NECK-' },
    },
  });
  const allEclatProducts = await prisma.product.findMany({
    where: { organisationId: 'org_eclat' },
  });
  const allEmbeddings = await prisma.productEmbedding.findMany({
    where: { organisationId: 'org_eclat' },
  });

  for (const org of allOrgs) {
    if (org.id === 'org_eclat') continue;
    console.log(`Syncing products to org: ${org.name} (${org.id})`);

    // Ensure store exists for this org
    let store = await prisma.store.findFirst({ where: { organisationId: org.id } });

    for (const prod of allEclatProducts) {
      const existing = await prisma.product.findFirst({
        where: { organisationId: org.id, sku: prod.sku },
      });
      let targetProduct;
      if (!existing) {
        targetProduct = await prisma.product.create({
          data: {
            organisationId: org.id,
            sku: prod.sku,
            name: prod.name,
            category: prod.category,
            metal: prod.metal,
            karat: prod.karat,
            weightGrams: prod.weightGrams,
            caratWeight: prod.caratWeight,
            price: prod.price,
            availability: prod.availability,
            description: prod.description,
            imageUrl: prod.imageUrl,
            bestSeller: prod.bestSeller,
            storeId: store?.id ?? null,
          },
        });
      } else {
        targetProduct = await prisma.product.update({
          where: { id: existing.id },
          data: {
            imageUrl: prod.imageUrl,
            name: prod.name,
            category: prod.category,
            price: prod.price,
          },
        });
      }

      // Sync embedding if exists
      const srcEmb = allEmbeddings.find((e) => e.productId === prod.id);
      if (srcEmb) {
        const embExisting = await prisma.productEmbedding.findFirst({
          where: { organisationId: org.id, productId: targetProduct.id },
        });
        if (!embExisting) {
          await prisma.productEmbedding.create({
            data: {
              organisationId: org.id,
              productId: targetProduct.id,
              storeId: targetProduct.storeId,
              dinoEmbedding: srcEmb.dinoEmbedding,
              siglipEmbedding: srcEmb.siglipEmbedding,
              modelVersion: srcEmb.modelVersion,
              imageHash: srcEmb.imageHash,
            },
          });
        }
      }
    }
  }

  console.log('All orgs synced with products, photos, and embeddings!');
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
