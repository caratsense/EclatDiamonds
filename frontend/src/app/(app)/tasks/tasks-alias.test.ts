import { existsSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { TASKS_CANONICAL_PATH } from "./canonical";
import { NAV_ITEMS } from "@/lib/navigation";

/**
 * `/tasks` is an alias. An alias is only useful if it lands somewhere.
 *
 * This route was created to fix a 404 from a button that pointed at `/tasks`
 * while the screen lived at `/calling`, and it was never committed — so the fix
 * existed on one machine and nowhere else. These checks are what stop it
 * becoming a 404 again: rename or move the calling screen and the second case
 * fails here rather than in someone's browser.
 */
describe("the /tasks alias", () => {
  it("points at a route that exists", () => {
    const page = resolve(
      __dirname,
      "..",
      TASKS_CANONICAL_PATH.replace(/^\//, ""),
      "page.tsx",
    );
    expect(existsSync(page)).toBe(true);
  });

  it("points at a screen the navigation knows about", () => {
    // Otherwise the alias works and the sidebar highlights nothing, so the
    // person who followed the link cannot tell where they are.
    const slug = TASKS_CANONICAL_PATH.replace(/^\//, "");
    expect(NAV_ITEMS.map((i) => i.slug)).toContain(slug);
  });
});
