#!/usr/bin/env node
/**
 * Visual-search retrieval bench: exact in-process ranker vs pgvector ANN.
 *
 *   node scripts/similarity-bench.mjs [--org <id>] [--queries 50] [--synthetic 10000]
 *
 * Reads ProductEmbedding rows of ACTIVE pictures from DATABASE_URL (read-only).
 * `--synthetic N` pads the set with N random 768-dim vectors held in memory
 * only (never written), to measure latency at a catalogue size the local
 * database does not have. Queries are real rows with a little noise added.
 *
 * Prints p50/p95 per query for:
 *   exact — what JewelrySimilarityService does without pgvector: both cosines
 *           (dot products of unit vectors) for every candidate, then the two
 *           top-40 recall lists (mirrors rankCandidates' heavy part);
 *   ann   — the HNSW queries (one per model, LIMIT 50), when the extension and
 *           the indexes from migration 20260918160000_pgvector_ann_768 exist;
 * and recall@10 of ANN against exact (per model, over real rows only).
 */
import { PrismaClient } from '@prisma/client';

const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : def;
};
const ORG = arg('org', null);
const QUERIES = Number(arg('queries', 50));
const SYNTHETIC = Number(arg('synthetic', 0));
const DIM = 768;
const RECALL = 40;

const prisma = new PrismaClient();

function unit(v) {
  let n = 0;
  for (const x of v) n += x * x;
  n = Math.sqrt(n) || 1;
  return Float32Array.from(v, (x) => x / n);
}
function dot(a, b) {
  let d = 0;
  for (let i = 0; i < a.length; i++) d += a[i] * b[i];
  return d;
}
/** Mirrors topK in jewelry-ranking.service.ts. */
function topK(xs, k) {
  const out = [];
  for (let i = 0; i < xs.length; i++) {
    const x = xs[i];
    if (out.length === k && x <= xs[out[k - 1]]) continue;
    let j = out.length;
    while (j > 0 && xs[out[j - 1]] < x) j--;
    out.splice(j, 0, i);
    if (out.length > k) out.pop();
  }
  return out;
}
const randVec = () => Array.from({ length: DIM }, () => Math.random() * 2 - 1);
const noisy = (v) => Array.from(v, (x) => x + (Math.random() * 2 - 1) * 0.02);
const pct = (xs, p) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)] : 0;
};
const fmt = (xs) => `p50 ${pct(xs, 50).toFixed(1)} ms · p95 ${pct(xs, 95).toFixed(1)} ms (n=${xs.length})`;

async function annAvailable() {
  const [row] = await prisma.$queryRawUnsafe(`
    SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector') AS ext,
           (SELECT count(*)::int FROM pg_indexes
             WHERE indexname IN ('ProductEmbedding_dino768_hnsw','ProductEmbedding_siglip768_hnsw')) AS idx`);
  return { ext: row.ext, idx: row.idx };
}

async function main() {
  const rows = await prisma.productEmbedding.findMany({
    where: { productImage: { status: 'active' }, ...(ORG ? { organisationId: ORG } : {}) },
    select: { id: true, organisationId: true, dinoEmbedding: true, siglipEmbedding: true },
  });
  const real = rows.filter((r) => r.dinoEmbedding.length === DIM && r.siglipEmbedding.length === DIM);
  const cands = real.map((r) => ({ id: r.id, dino: unit(r.dinoEmbedding), siglip: unit(r.siglipEmbedding) }));
  for (let i = 0; i < SYNTHETIC; i++) cands.push({ id: `syn-${i}`, dino: unit(randVec()), siglip: unit(randVec()) });
  console.log(`candidates: ${real.length} real (768/768) + ${SYNTHETIC} synthetic = ${cands.length}`);
  if (!cands.length) {
    console.log('Nothing to rank. Index some pictures, or pass --synthetic N.');
    return;
  }

  const source = real.length ? real : cands.map((c) => ({ organisationId: null, dinoEmbedding: [...c.dino], siglipEmbedding: [...c.siglip] }));
  const queries = Array.from({ length: QUERIES }, (_, i) => {
    const r = source[(i * 7919) % source.length];
    return { org: r.organisationId, dino: noisy(r.dinoEmbedding), siglip: noisy(r.siglipEmbedding) };
  });

  // --- exact
  const exactMs = [];
  const exactTop = [];
  for (const q of queries) {
    const t = performance.now();
    const qd = unit(q.dino);
    const qs = unit(q.siglip);
    const rd = new Float64Array(cands.length);
    const rs = new Float64Array(cands.length);
    for (let i = 0; i < cands.length; i++) {
      rd[i] = dot(qd, cands[i].dino);
      rs[i] = dot(qs, cands[i].siglip);
    }
    const byD = topK(rd, RECALL).map((i) => cands[i].id);
    const byS = topK(rs, RECALL).map((i) => cands[i].id);
    exactMs.push(performance.now() - t);
    exactTop.push({ d: byD.filter((id) => !id.startsWith('syn-')).slice(0, 10), s: byS.filter((id) => !id.startsWith('syn-')).slice(0, 10) });
  }
  console.log(`exact ranker : ${fmt(exactMs)}`);

  // --- ann
  const { ext, idx } = await annAvailable();
  if (!ext || idx < 2) {
    console.log(
      `ann          : unavailable — pgvector ${ext ? 'installed' : 'NOT installed'}, ANN indexes ${idx}/2. ` +
        'Recall@10 needs pgvector; exact-ranker numbers only.',
    );
    return;
  }
  if (!real.length) {
    console.log('ann          : no real 768-dim rows in the database to query.');
    return;
  }
  const annMs = [];
  let hitD = 0, hitS = 0, totD = 0, totS = 0;
  for (const [i, q] of queries.entries()) {
    const got = {};
    const t = performance.now();
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET LOCAL hnsw.ef_search = 200');
      await tx.$executeRawUnsafe('SET LOCAL hnsw.iterative_scan = relaxed_order');
      for (const [col, vec, key] of [['dinoEmbedding', q.dino, 'd'], ['siglipEmbedding', q.siglip, 's']]) {
        const res = await tx.$queryRawUnsafe(
          `SELECT e.id FROM "ProductEmbedding" e
             JOIN "ProductImage" i ON i.id = e."productImageId" AND i.status = 'active'
            WHERE e."organisationId" = $1 AND array_length(e."${col}", 1) = ${DIM}
            ORDER BY (e."${col}"::vector(${DIM})) <=> $2::vector(${DIM}) LIMIT 50`,
          q.org,
          `[${vec.join(',')}]`,
        );
        got[key] = res.map((r) => r.id).slice(0, 10);
      }
    });
    annMs.push(performance.now() - t);
    const ex = exactTop[i];
    hitD += ex.d.filter((id) => got.d.includes(id)).length;
    hitS += ex.s.filter((id) => got.s.includes(id)).length;
    totD += ex.d.length;
    totS += ex.s.length;
  }
  console.log(`ann (pgvector): ${fmt(annMs)}  [2 HNSW queries per query vector]`);
  console.log(`recall@10 ANN vs exact: dino ${(hitD / (totD || 1)).toFixed(3)} · siglip ${(hitS / (totS || 1)).toFixed(3)}`);
}

main()
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
