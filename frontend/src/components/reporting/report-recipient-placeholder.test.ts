import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * MM4-04 — the recipient hint in the two report dialogs must not name a
 * customer's own company.
 *
 * `owner@eclatdiamonds.in` was a real jeweller's domain shown as the example
 * address to every tenant. A source assertion is the right shape here: the
 * placeholder is a literal in the JSX with no logic around it, so rendering the
 * dialog (jsdom, a testing library, a query client, a session) would add a great
 * deal of machinery to check a string that never varies.
 */

const DIALOGS = ["daily-report-send-dialog.tsx", "send-report-dialog.tsx"];

const read = (file: string) =>
  readFileSync(fileURLToPath(new URL(file, import.meta.url)), "utf8");

describe.each(DIALOGS)("%s", (file) => {
  const source = read(file);

  it("names no real company in the recipient placeholder", () => {
    expect(source).not.toMatch(/eclatdiamonds/i);
  });

  it("uses a neutral, non-deliverable example address", () => {
    // Matched loosely on purpose: the assertion is about which address the
    // placeholder offers, not about how the ternary happens to be formatted.
    expect(source).toMatch(/placeholder=\{\s*isEmail\s*\?\s*"reports@example\.com"/);
  });

  it("still validates and sends exactly as before", () => {
    // The change was a placeholder only — these are the neighbours it must not
    // have disturbed.
    expect(source).toContain("aria-invalid={recipientError}");
    expect(source).toContain('type={isEmail ? "email" : "tel"}');
  });
});
