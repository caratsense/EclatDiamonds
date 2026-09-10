import { describe, expect, it } from "vitest";

import { configuredOrgSlug, isUsableOrgSlug, normaliseOrgSlug } from "./page";

/**
 * The signup form's tenant resolution (MM4, MM3-01).
 *
 * The bug these pin: the organisation field used to open on
 * `NEXT_PUBLIC_DEFAULT_ORG_SLUG ?? "eclat"`, so every deployment with nothing
 * configured showed one jeweller's branches to whoever was signing up. The
 * rule now is that an absent or unusable configuration produces "" — which the
 * caller turns into no request at all.
 */

describe("configuredOrgSlug — absent configuration", () => {
  it("is empty when nothing is configured", () => {
    expect(configuredOrgSlug(undefined)).toBe("");
    expect(configuredOrgSlug("")).toBe("");
    expect(configuredOrgSlug("   ")).toBe("");
  });

  it("never falls back to a tenant", () => {
    // The specific regression. If this ever returns a slug, the generic
    // product is pointing new users at somebody else's organisation again.
    expect(configuredOrgSlug(undefined)).not.toBe("eclat");
    expect(configuredOrgSlug(undefined)).toHaveLength(0);
  });
});

describe("configuredOrgSlug — explicit configuration", () => {
  it("honours a real single-tenant deployment", () => {
    expect(configuredOrgSlug("eclat")).toBe("eclat");
    expect(configuredOrgSlug("sunrise-clinic-3ebcb7d2")).toBe("sunrise-clinic-3ebcb7d2");
  });

  it("normalises case and surrounding whitespace", () => {
    expect(configuredOrgSlug("  Eclat  ")).toBe("eclat");
    expect(configuredOrgSlug("SUNRISE-CLINIC")).toBe("sunrise-clinic");
  });

  it("ignores a malformed value instead of querying with it", () => {
    for (const bad of [
      "a",
      "-eclat",
      "eclat-",
      "ecl at",
      "eclat/../admin",
      "eclat?org=other",
      "https://evil.example/eclat",
      "../../etc/passwd",
      "eclat#frag",
      "e".repeat(65),
    ]) {
      expect(configuredOrgSlug(bad), `${bad} must be ignored`).toBe("");
    }
  });
});

describe("isUsableOrgSlug", () => {
  it("accepts what the server actually mints", () => {
    for (const slug of ["eclat", "mm3-clinic", "sunrise-clinic-3ebcb7d2", "a1", "x9y"]) {
      expect(isUsableOrgSlug(slug), slug).toBe(true);
    }
  });

  it("rejects empty, single-character and structurally wrong codes", () => {
    for (const bad of ["", "  ", "a", "-a", "a-", "a b", "a_b", "A B", "a/b", null, undefined]) {
      expect(isUsableOrgSlug(bad as string), String(bad)).toBe(false);
    }
  });

  it("gates the directory request — an unusable code fetches nothing", () => {
    // The page passes `slugUsable ? slug : ""`, and useSignupStores is disabled
    // below two characters. This is the contract that keeps a half-typed code
    // from hitting the public endpoint on every keystroke.
    const typing = ["", "s", "su", "sun", "sunr"];
    const requested = typing.filter((t) => isUsableOrgSlug(t));
    expect(requested).toEqual(["su", "sun", "sunr"]);
    expect(isUsableOrgSlug(typing[0])).toBe(false);
    expect(isUsableOrgSlug(typing[1])).toBe(false);
  });
});

describe("normaliseOrgSlug", () => {
  it("trims and lowercases", () => {
    expect(normaliseOrgSlug("  ECLAT ")).toBe("eclat");
  });

  it("does not invent a slug from free text", () => {
    // "Sunrise Clinic" must stay invalid rather than becoming "sunrise-clinic",
    // which could be a different, real tenant.
    expect(normaliseOrgSlug("Sunrise Clinic")).toBe("sunrise clinic");
    expect(isUsableOrgSlug("Sunrise Clinic")).toBe(false);
  });

  it("handles null and undefined without throwing", () => {
    expect(normaliseOrgSlug(null)).toBe("");
    expect(normaliseOrgSlug(undefined)).toBe("");
  });
});

describe("changing the code", () => {
  it("resolves each entry independently, so a stale tenant cannot persist", () => {
    // The component clears the selected store on every change; these assert the
    // slug side: what is queried follows the field exactly, with no memory.
    const sequence = ["eclat", "", "mm3-clinic", "  ", "MM3-CLINIC"];
    expect(sequence.map((s) => (isUsableOrgSlug(s) ? normaliseOrgSlug(s) : ""))).toEqual([
      "eclat",
      "",
      "mm3-clinic",
      "",
      "mm3-clinic",
    ]);
  });
});
