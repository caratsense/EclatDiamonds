/**
 * Check the rendered PDF, not the HTML that produced it.
 *
 *   node docs/usermanual/src/verify.mjs
 *
 * The HTML is already known good by the time it is written — what can still go
 * wrong happens in the render: a screen dropped, a glyph substituted, text
 * re-encoded into mojibake. So this reads the text back out of the PDF and
 * checks it against the application's own navigation.
 */
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readNavigation } from "./nav.mjs";

const here = (rel) => fileURLToPath(new URL(rel, import.meta.url));
const pdfParse = createRequire(pathToFileURL(here("../../../backend/package.json")))("pdf-parse");

const screens = readNavigation(here("../../../frontend/src/lib/navigation.ts"));
const { numpages, text } = await pdfParse(readFileSync(here("../CaratSense-Operations-Manual.pdf")));

let failures = 0;
const check = (label, ok, detail = "") => {
  if (!ok) failures += 1;
  console.log(`${ok ? "  ok  " : " FAIL "} ${label}${detail ? `  ${detail}` : ""}`);
};

console.log(`pages: ${numpages}   words: ${text.split(/\s+/).filter(Boolean).length}\n`);

const noTitle = screens.filter((s) => !text.includes(s.title));
const noSlug = screens.filter((s) => !text.includes(`/${s.slug}`));
check(`all ${screens.length} screen titles present`, !noTitle.length, noTitle.map((s) => s.title).join(", "));
check(`all ${screens.length} screen paths present`, !noSlug.length, noSlug.map((s) => s.slug).join(", "));

// The exact sequences PowerShell's re-encoding produced when it corrupted
// source files before — mojibake that reached customers once already.
const MOJIBAKE = ["â‚¹", "Ã©", "Ã¨", "â€”", "â€™", "Â·", "ï¿½"];
const seen = MOJIBAKE.filter((b) => text.includes(b));
check("no mojibake", !seen.length, seen.join(" "));

for (const g of ["₹", "É", "È", "—", "·"]) check(`glyph ${g} renders`, text.includes(g));

// Facts the client acts on. Each was verified against the code or a live check
// before being written, so a missing one means the render lost it.
const FACTS = [
  "72080 17690", "72089 12616", "wa.me/917208017690", "wa.me/917208912616",
  "eclat-diamonds-pi.vercel.app", "24 hours", "10 minutes", "5 minutes",
  "Click-to-WhatsApp", "nine", "twenty", "Settings → Stores",
  // The advert addresses the client hands out; a broken one is worse than none.
  "fb.me/2mtHMsKeUcTN8Ih", "fb.me/2jDp44BRWvLmQ4m",
  "instagram.com/p/DdwKr6isgcO/", "instagram.com/p/DdwKr8wM4h5/",
  "posts/1293013417234982", "posts/1293013430568314",
];
for (const f of FACTS) check(`"${f}"`, text.includes(f));

console.log(`\n${failures ? `${failures} FAILURES` : "all checks passed"}`);
process.exit(failures ? 1 : 0);
