/**
 * Build the operations manual.
 *
 *   node docs/usermanual/src/build.mjs     # -> ../CaratOS-Operations-Manual.html
 *
 * The feature map is GENERATED from the application's own navigation
 * definition, not typed out here. A manual that lists screens by hand goes
 * stale the week one is added, and the omission is invisible — this way a new
 * screen appears in the next build, or the build fails.
 *
 * It already earned that: the first hand-written list silently missed three
 * screens, one of them the very screen the manual tells people to use for
 * password resets.
 *
 * The chapters around the map are written by hand, because "what this screen
 * is for in your business" is not something the code can say.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { readNavigation } from "./nav.mjs";

const here = (rel) => fileURLToPath(new URL(rel, import.meta.url));
const NAV = here("../../../frontend/src/lib/navigation.ts");

/** Sidebar groups, in the order the application shows them. */
const GROUP_ORDER = [
  "Today", "People", "Showroom", "Selling", "After the sale",
  "Stock", "Reports", "Team", "Setup",
];
const GROUP_NOTE = {
  "Today": "What needs attention this morning.",
  "People": "Every customer conversation, lead and follow-up.",
  "Showroom": "The shop floor — walk-ins, the counter, the catalogue.",
  "Selling": "Quoting, discounting and what happens after a sale is agreed.",
  "After the sale": "Collections, loyalty, performance and targets.",
  "Stock": "What you hold, what moves and what will not.",
  "Reports": "The numbers, for a branch and across the business.",
  "Team": "Who works here, their attendance and their pay.",
  "Setup": "Configuration, integrations and administration.",
};

/**
 * Screens that exist but carry no sidebar group, so the parser cannot place
 * them. Listed deliberately: an unplaced screen fails the build rather than
 * going undocumented, which is how /check-in — the screen that actually
 * records attendance — was missed first time round.
 */
const UNGROUPED = {
  "check-in": "Reached automatically after signing in, not from the menu.",
};
const UNGROUPED_NOTE =
  "Screens the application opens for you rather than listing in the menu.";

const esc = (s) =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const all = readNavigation(NAV);
const grouped = all.filter((f) => f.group);
const ungrouped = all.filter((f) => !f.group);

// Every group the application defines must be ordered deliberately; a new one
// nobody placed would otherwise vanish from the manual silently.
const unplaced = [...new Set(grouped.map((f) => f.group))].filter(
  (g) => !GROUP_ORDER.includes(g),
);
if (unplaced.length) throw new Error(`Unplaced nav groups: ${unplaced.join(", ")}`);

const undescribed = ungrouped.filter((f) => !UNGROUPED[f.slug]);
if (undescribed.length) {
  throw new Error(
    `Screens with no group and no entry in UNGROUPED: ${undescribed.map((f) => f.slug).join(", ")}`,
  );
}

const row = (f, extra) => `<tr>
  <td><strong>${esc(f.title)}</strong><br><code>/${esc(f.slug)}</code></td>
  <td>${esc(f.purpose)}${extra ? ` <em>${esc(extra)}</em>` : ""}</td></tr>`;

const section = (heading, note, rows, count) => `<section>
  <h3>${esc(heading)} <span class="cnt">${count} screen${count > 1 ? "s" : ""}</span></h3>
  <p class="gnote">${esc(note)}</p>
  <table class="feat">
    <tr><th style="width:46mm;">Screen</th><th>What it is for</th></tr>
    ${rows}
  </table>
</section>`;

let map = "";
let covered = 0;
for (const group of GROUP_ORDER) {
  const items = grouped.filter((f) => f.group === group);
  if (!items.length) continue;
  covered += items.length;
  map += section(group, GROUP_NOTE[group] ?? "", items.map((f) => row(f)).join(""), items.length);
}
if (ungrouped.length) {
  covered += ungrouped.length;
  map += section(
    "Outside the menu",
    UNGROUPED_NOTE,
    ungrouped.map((f) => row(f, UNGROUPED[f.slug])).join(""),
    ungrouped.length,
  );
}

if (covered !== all.length) {
  throw new Error(`Feature map covers ${covered} of ${all.length} screens`);
}

const html = `<meta charset="utf-8">
<title>CaratOS — Operations Manual</title>
<style>${readFileSync(here("./manual.css"), "utf8")}</style>
${readFileSync(here("./chapters.html"), "utf8")
  .replace("<!--FEATURE_MAP-->", map)
  .replace(/<!--COUNT-->/g, String(all.length))}`;

writeFileSync(here("../CaratOS-Operations-Manual.html"), html);
console.log(
  `CaratOS-Operations-Manual.html written — ${all.length} screens ` +
    `(${grouped.length} in ${GROUP_ORDER.filter((g) => grouped.some((f) => f.group === g)).length} menu groups, ` +
    `${ungrouped.length} outside the menu)`,
);
