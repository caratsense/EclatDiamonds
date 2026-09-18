import { Prisma, PrismaClient } from '@prisma/client';

/**
 * The default order of a design's pictures — one function, used after every
 * sync, upload, pin and tombstone. See docs/modules/05-catalogue-sources.md.
 *
 *   1. an admin-pinned picture;
 *   2. the Gati CAD (it carries the exact dimensions a customer is shown);
 *   3. website photographs, in the website's own order;
 *   4. manual uploads, inventory photos, anything else — oldest first.
 *
 * A CAD that could not be fetched or decoded is skipped, so the first valid
 * website photograph becomes the cover rather than a broken image.
 */
export interface OrderableImage {
  id: string;
  source: string;
  pinnedPrimary: boolean;
  status: string;
  sourceOrder: number;
  createdAt: Date;
  embeddingStatus?: string | null;
  embeddingError?: string | null;
  url?: string;
}

const RANK: Record<string, number> = { gati_cad: 1, website: 2, manual: 3, inventory: 4 };

/** A CAD we know is unusable: its fetch or decode failed for good. */
export function isBroken(img: OrderableImage): boolean {
  return img.embeddingStatus === 'dead' && /fetch|download|decode|not an image|too large|404|403/i.test(img.embeddingError ?? '');
}

export function orderImages<T extends OrderableImage>(images: T[]): T[] {
  const active = images.filter((i) => i.status !== 'tombstoned');
  return [...active].sort((a, b) => {
    const pa = a.pinnedPrimary ? 0 : isBroken(a) ? 9 : (RANK[a.source] ?? 5);
    const pb = b.pinnedPrimary ? 0 : isBroken(b) ? 9 : (RANK[b.source] ?? 5);
    if (pa !== pb) return pa - pb;
    if (a.sourceOrder !== b.sourceOrder) return a.sourceOrder - b.sourceOrder;
    return a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id);
  });
}

type Db = PrismaClient | Prisma.TransactionClient;

/**
 * Recompute isPrimary / sortOrder for a product's active pictures and point
 * `Product.imageUrl` at the cover. Tombstoned pictures lose primary. Only rows
 * whose position actually changes are written.
 */
export async function applyImageOrder(db: Db, productId: string): Promise<string | null> {
  const images = await db.productImage.findMany({
    where: { productId },
    select: {
      id: true,
      url: true,
      source: true,
      pinnedPrimary: true,
      status: true,
      sourceOrder: true,
      createdAt: true,
      embeddingStatus: true,
      embeddingError: true,
      isPrimary: true,
      sortOrder: true,
    },
  });
  const ordered = orderImages(images);
  const cover = ordered[0] ?? null;
  for (const [i, img] of ordered.entries()) {
    const isPrimary = i === 0;
    if (img.isPrimary !== isPrimary || img.sortOrder !== i) {
      await db.productImage.update({ where: { id: img.id }, data: { isPrimary, sortOrder: i } });
    }
  }
  for (const img of images) {
    if (img.status === 'tombstoned' && img.isPrimary) {
      await db.productImage.update({ where: { id: img.id }, data: { isPrimary: false } });
    }
  }
  await db.product.update({ where: { id: productId }, data: { imageUrl: cover?.url ?? null } });
  return cover?.id ?? null;
}
