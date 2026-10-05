/**
 * Flag content that overflows the printable area.
 *
 *   node docs/usermanual/src/measure.mjs
 *
 * Each `.page` is meant to be exactly one sheet, and each feature-map
 * `section` is meant to stay whole (`page-break-inside: avoid`). When one grows
 * past the printable height it splits anyway, leaving a near-empty sheet after
 * it — a fault that a page count and a text search both pass straight over.
 *
 * The feature map's own `.page` is expected to overflow: it is a reference
 * table that deliberately runs across sheets. Its sections are not.
 */
import { createRequire } from "node:module";
import { pathToFileURL, fileURLToPath } from "node:url";

const from = process.env.PLAYWRIGHT_FROM;
if (!from) {
  throw new Error("set PLAYWRIGHT_FROM to a directory whose node_modules has playwright");
}
const { chromium } = createRequire(pathToFileURL(`${from}/package.json`))("playwright");

const here = (rel) => fileURLToPath(new URL(rel, import.meta.url));
const MM = 96 / 25.4;
// A4 less the margins render.mjs sets.
const limitPx = (297 - 15 - 17) * MM;
const widthPx = Math.round((210 - 32) * MM);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: widthPx, height: 1200 } });
await page.goto(pathToFileURL(here("../CaratSense-Operations-Manual.html")).href, {
  waitUntil: "networkidle",
});
await page.emulateMedia({ media: "print" });

const rows = await page.evaluate(() =>
  [...document.querySelectorAll(".page, .divider, .cover, section")].map((el, i) => {
    const h = el.querySelector("h1, h2, h3");
    return {
      i: i + 1,
      kind: el.tagName === "SECTION" ? "section" : "sheet",
      label: h ? h.textContent.replace(/\s+/g, " ").trim().slice(0, 46) : el.className || "page",
      h: Math.round(el.getBoundingClientRect().height),
    };
  }),
);
await browser.close();

console.log(`printable height: ${Math.round(limitPx)} px\n`);
for (const r of rows) {
  const over = r.h > limitPx;
  console.log(
    `${over ? "OVER " : "  ok "} ${String(r.i).padStart(2)}  ${String(r.h).padStart(5)} px  ` +
      `${r.kind.padEnd(7)} ${r.label}`,
  );
}
const over = rows.filter((r) => r.h > limitPx);
console.log(`\n${over.length} of ${rows.length} overflow`);
