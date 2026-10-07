/**
 * Render the manual to PDF.
 *
 *   node docs/usermanual/src/build.mjs
 *   node docs/usermanual/src/render.mjs    # -> docs/usermanual/CaratSpace-Operations-Manual.pdf
 *
 * Chromium rather than a PDF library: the manual is a formatted document with
 * tables, callouts and page breaks, and laying that out by hand in pdf-lib
 * would mean reinventing text flow. It also renders ₹ and É natively, which
 * the standard PDF fonts cannot.
 *
 * Playwright is not a dependency of this repo — set PLAYWRIGHT_FROM to a
 * directory whose node_modules has it. Adding a browser download to the app's
 * install so a document can be rebuilt occasionally is the wrong trade.
 */
import { createRequire } from "node:module";
import { pathToFileURL, fileURLToPath } from "node:url";
import { statSync } from "node:fs";

const from = process.env.PLAYWRIGHT_FROM;
if (!from) {
  throw new Error("set PLAYWRIGHT_FROM to a directory whose node_modules has playwright");
}
const { chromium } = createRequire(pathToFileURL(`${from}/package.json`))("playwright");

const here = (rel) => fileURLToPath(new URL(rel, import.meta.url));
const src = here("../CaratSpace-Operations-Manual.html");
const out = here("../CaratSpace-Operations-Manual.pdf");

const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto(pathToFileURL(src).href, { waitUntil: "networkidle" });
await page.pdf({
  path: out,
  format: "A4",
  printBackground: true,
  displayHeaderFooter: true,
  headerTemplate: "<div></div>",
  footerTemplate:
    '<div style="width:100%;font-size:7.5pt;color:#8a94a3;padding:0 16mm;' +
    'font-family:Segoe UI,Arial,sans-serif;display:flex;justify-content:space-between;">' +
    "<span>CaratSpace &middot; Operations Manual</span>" +
    '<span>Page <span class="pageNumber"></span> of <span class="totalPages"></span></span></div>',
  // Set here rather than left to @page: Playwright's margin option overrides
  // the stylesheet's, so omitting the sides would print to the paper edge.
  margin: { top: "15mm", bottom: "17mm", left: "16mm", right: "16mm" },
});
await browser.close();

console.log(`written: ${out}`);
console.log(`size   : ${(statSync(out).size / 1024).toFixed(0)} KB`);
