/**
 * Read the application's navigation as data.
 *
 * Regex rather than importing the module: navigation.ts is TypeScript with
 * Lucide icon imports, so loading it would mean a bundler and a React runtime
 * to read four string fields. The shape it is parsed from is checked below —
 * a field that stops matching fails the build rather than quietly dropping a
 * screen out of the manual.
 */
import { readFileSync } from "node:fs";

/**
 * One field, allowing the `//` comments that sit between a field name and its
 * value throughout navigation.ts.
 *
 * The value is matched as "no quote until the closing one", which assumes no
 * field contains an escaped quote. That is asserted rather than handled: a
 * pattern clever enough to cope would be harder to read than the check.
 */
const field = (name) => `${name}:\\s*(?:\\s*//[^\\n]*\\n\\s*)*"([^"]*)"`;
const one = (name, block) => block.match(new RegExp(field(name)))?.[1] ?? null;

const tidy = (s) => s.replace(/\s+/g, " ").trim();

export function readNavigation(path) {
  const src = readFileSync(path, "utf8");

  if (/(?:slug|title|purpose|group):\s*(?:\s*\/\/[^\n]*\n\s*)*"[^"]*\\"/.test(src)) {
    throw new Error("a navigation field contains an escaped quote — the parser cannot read it");
  }

  // Split on the slug declarations rather than matching whole objects: `group`
  // is absent on screens the app opens for you instead of listing (the
  // attendance punch screen), and one pattern covering both would match across
  // an object boundary and borrow the next screen's group.
  const starts = [...src.matchAll(/slug:\s*"([^"]*)"/g)];
  if (!starts.length) {
    throw new Error("found no screen declarations — has navigation.ts changed shape?");
  }

  const items = starts.map((m, i) => {
    const block = src.slice(m.index, starts[i + 1]?.index ?? src.length);
    const title = one("title", block);
    const purpose = one("purpose", block);
    if (!title || !purpose) {
      throw new Error(`screen "${m[1]}" has no ${!title ? "title" : "purpose"}`);
    }
    return {
      slug: m[1],
      title: tidy(title),
      purpose: tidy(purpose),
      // Null is meaningful: the screen is real but sits outside the menu.
      group: one("group", block),
    };
  });

  const slugs = new Set(items.map((f) => f.slug));
  if (slugs.size !== items.length) throw new Error("navigation declares a duplicate slug");

  return items;
}
