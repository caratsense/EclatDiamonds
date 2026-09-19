// ============================================================================
// Eclat / CaratSense — seed metal-tinted catalogue cover images
// ----------------------------------------------------------------------------
// Real product photos live on the client's APRS image server (not available
// here). Until those are migrated, this generates one elegant, metal-accurate
// SVG "cover" per MetalKind, writes them into the SAME object-storage dir the
// app serves (`<UPLOAD_DIR>/covers`, exposed at /uploads/covers/<metal>.svg),
// and points each product's imageUrl at its metal's cover — but ONLY where
// imageUrl is empty, so any real uploaded photo is never overwritten.
//
// This proves the photo pipeline end-to-end (file in storage -> URL in DB ->
// rendered in the catalogue) with visibly varied, premium imagery.
//
// RUN: node scripts/seed-cover-images.mjs   (from backend/)
// ============================================================================

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

/** What the file-writing version left behind, and the only thing safe to replace. */
const STALE_COVER_PREFIX = "/uploads/covers/";

// Metal -> premium gradient + gem/label colour (visually accurate to the metal).
const METALS = {
  gold_24k: { c1: "#6a4e16", c2: "#b8893a", ink: "#f6e6b6", label: "24K GOLD" },
  gold_22k: { c1: "#5e441a", c2: "#a87c2f", ink: "#f1dda3", label: "22K GOLD" },
  gold_18k: { c1: "#574322", c2: "#977033", ink: "#eed89c", label: "18K GOLD" },
  rose_gold_18k: { c1: "#6b3b34", c2: "#a8645a", ink: "#f4cdc3", label: "18K ROSE GOLD" },
  platinum: { c1: "#2b3340", c2: "#5a6675", ink: "#e8eef6", label: "PLATINUM" },
  silver: { c1: "#3a3d42", c2: "#70757c", ink: "#eef0f2", label: "SILVER" },
};

function svg({ c1, c2, ink, label }) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400" width="400" height="400">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${c1}"/><stop offset="1" stop-color="${c2}"/>
    </linearGradient>
    <radialGradient id="gl" cx="0.5" cy="0.30" r="0.75">
      <stop offset="0" stop-color="#ffffff" stop-opacity="0.20"/>
      <stop offset="1" stop-color="#ffffff" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect width="400" height="400" fill="url(#bg)"/>
  <rect width="400" height="400" fill="url(#gl)"/>
  <g fill="none" stroke="${ink}" stroke-width="3.5" stroke-linejoin="round" stroke-linecap="round" opacity="0.95">
    <path d="M200 118 L264 170 L200 258 L136 170 Z"/>
    <path d="M136 170 L264 170"/>
    <path d="M200 118 L175 170"/>
    <path d="M200 118 L225 170"/>
    <path d="M175 170 L200 258"/>
    <path d="M225 170 L200 258"/>
  </g>
  <text x="200" y="312" text-anchor="middle" font-family="Inter, system-ui, sans-serif" font-size="21" font-weight="600" letter-spacing="3" fill="${ink}">${label}</text>
  <text x="200" y="340" text-anchor="middle" font-family="Inter, system-ui, sans-serif" font-size="11" letter-spacing="4" fill="${ink}" opacity="0.6">CARATSENSE</text>
</svg>`;
}

/**
 * The cover travels in the row, not on a disk.
 *
 * This used to write four SVGs into <UPLOAD_DIR>/covers and point imageUrl at
 * /uploads/covers/<metal>.svg. On Railway that silently produced ten products
 * whose pictures all 404: the pre-deploy command runs in its OWN container, so
 * the files landed on a filesystem that is thrown away before the app starts,
 * and the app's own /app/uploads — a persistent volume — never saw them.
 *
 * A generated cover is a few hundred bytes of markup. Inlining it as a data URI
 * removes the filesystem from the problem entirely: no volume, no static route,
 * no ordering between the writer and the server, and it works the same on a
 * laptop, in CI and on Railway. A real photograph from the media sync is still
 * an ordinary URL and is still never overwritten.
 */
function dataUri(cfg) {
  return `data:image/svg+xml;base64,${Buffer.from(svg(cfg), "utf8").toString("base64")}`;
}

async function run() {
  // An earlier run of this script pointed products at files that were thrown
  // away with the pre-deploy container. Those rows are not empty, so the fill
  // below would skip them and the catalogue would stay broken. Clear exactly
  // those and nothing else — a real photo never has this prefix.
  const stale = await prisma.product.updateMany({
    where: { imageUrl: { startsWith: STALE_COVER_PREFIX } },
    data: { imageUrl: null },
  });
  if (stale.count) console.log(`  cleared ${stale.count} dead cover link(s)`);

  let total = 0;
  for (const [metal, cfg] of Object.entries(METALS)) {
    const res = await prisma.product.updateMany({
      where: { metal, OR: [{ imageUrl: null }, { imageUrl: "" }] },
      data: { imageUrl: dataUri(cfg) },
    });
    if (res.count) console.log(`  ${metal.padEnd(14)} -> ${res.count} products`);
    total += res.count;
  }
  console.log(`\nAssigned covers to ${total} products (existing photos untouched).`);
}

run()
  .catch((e) => {
    console.error("seed-cover-images FAILED:", e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
