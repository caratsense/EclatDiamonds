import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { signupStoresRequest, type SignupStore } from "@/lib/queries/auth";

import { transferDestinations } from "./create-transfer-dialog";

/**
 * MM4-01 — the stock-transfer destination picker must belong to the signed-in
 * tenant.
 *
 * The bug: `useSignupStores(organisationCode = "eclat")` was called with no
 * argument here, so every tenant's "transfer to" list was one jeweller's
 * branches. Two things had to hold to close it, and each is pinned below — the
 * request side (no tenant, no request; never a substitute tenant) and the render
 * side (no tenant, no rows; a previous tenant's rows cannot survive the switch).
 */

const ECLAT: SignupStore[] = [
  { id: "surat-main", name: "Surat — Main", city: "Surat" },
  { id: "mumbai-borivali", name: "Mumbai — Borivali", city: "Mumbai" },
];

const OTHER: SignupStore[] = [
  { id: "jaipur-mi-road", name: "Jaipur — MI Road", city: "Jaipur" },
];

describe("the directory request", () => {
  it("makes no request while the tenant is unresolved", () => {
    // Bootstrap has not answered yet: `?? ""` is what reaches the hook.
    for (const unresolved of ["", "   ", null, undefined]) {
      const req = signupStoresRequest(unresolved);
      expect(req.enabled, String(unresolved)).toBe(false);
      expect(req.org, String(unresolved)).toBe("");
    }
  });

  it("never substitutes a tenant when none is given", () => {
    // The specific regression: if this is ever "eclat" again, every other
    // tenant is being shown Eclat's branches.
    expect(signupStoresRequest(undefined).org).not.toBe("eclat");
    expect(signupStoresRequest("").org).toHaveLength(0);
  });

  it("asks for exactly the tenant it was given", () => {
    expect(signupStoresRequest("eclat").org).toBe("eclat");
    expect(signupStoresRequest("kalyan-jewellers").org).toBe("kalyan-jewellers");
    expect(signupStoresRequest("  eclat  ").org).toBe("eclat");
  });

  it("keys the cache per tenant, so one tenant's list is never served to another", () => {
    const eclat = signupStoresRequest("eclat");
    const other = signupStoresRequest("kalyan-jewellers");
    expect(eclat.queryKey).toEqual(["signup-stores", "eclat"]);
    expect(other.queryKey).toEqual(["signup-stores", "kalyan-jewellers"]);
    expect(eclat.queryKey).not.toEqual(other.queryKey);
    // An unresolved tenant is its own key too — not a hit on anybody's list.
    expect(signupStoresRequest("").queryKey).toEqual(["signup-stores", ""]);
  });

  it("stays disabled below two characters, so a half-typed code fetches nothing", () => {
    expect(signupStoresRequest("e").enabled).toBe(false);
    expect(signupStoresRequest("ec").enabled).toBe(true);
  });
});

describe("the destination picker", () => {
  it("offers nothing while the tenant is unresolved", () => {
    expect(transferDestinations(undefined, "", "surat-main")).toEqual([]);
  });

  it("cannot be populated by a stale list once the tenant is unresolved", () => {
    // Even handed Eclat's rows outright, an unresolved tenant renders none.
    expect(transferDestinations(ECLAT, "", "surat-main")).toEqual([]);
  });

  it("shows Eclat its own branches, minus the source", () => {
    const rows = transferDestinations(ECLAT, "eclat", "surat-main");
    expect(rows.map((s) => s.id)).toEqual(["mumbai-borivali"]);
  });

  it("shows a second jewellery tenant only its own branches", () => {
    const rows = transferDestinations(OTHER, "kalyan-jewellers", "jaipur-mi-road");
    expect(rows).toEqual([]);
    expect(
      transferDestinations(OTHER, "kalyan-jewellers", "surat-main").map((s) => s.id),
    ).toEqual(["jaipur-mi-road"]);
  });

  it("renders nothing between tenants — the switch has no window of Eclat rows", () => {
    // The query is keyed by slug, so the moment the slug changes the data for
    // the new key is `undefined`, not the previous tenant's array.
    expect(transferDestinations(undefined, "kalyan-jewellers", "")).toEqual([]);
  });

  it("never lists the source store as its own destination", () => {
    for (const source of ["surat-main", "mumbai-borivali"]) {
      expect(
        transferDestinations(ECLAT, "eclat", source).some((s) => s.id === source),
      ).toBe(false);
    }
  });
});

describe("the wiring, not just the helpers", () => {
  /*
   * The two helpers above can both be perfect while the component still passes
   * a literal "eclat" to the directory — which is exactly the bug. These
   * assertions read the component and pin the one link the pure tests cannot
   * reach: that the slug handed to useSignupStores comes from the authenticated
   * bootstrap. A rendered test would need jsdom, a query client and a session
   * provider to assert the same sentence.
   */
  const source = readFileSync(
    fileURLToPath(new URL("./create-transfer-dialog.tsx", import.meta.url)),
    "utf8",
  );

  it("names no tenant anywhere in the component", () => {
    expect(source).not.toMatch(/["']eclat["']/i);
  });

  it("takes the tenant from the authenticated bootstrap", () => {
    expect(source).toContain("useConfigBootstrap()");
    expect(source).toMatch(/organisationSlug\s*=\s*\n?\s*useConfigBootstrap\(\)\.data\?\.organisation\.slug\s*\?\?\s*""/);
  });

  it("passes that slug — and nothing else — to the directory query", () => {
    expect(source).toContain("useSignupStores(organisationSlug)");
    // One call site, so there is no second, unguarded one.
    expect(source.match(/useSignupStores\(/g)).toHaveLength(1);
  });

  it("gates the rendered list on the same slug", () => {
    expect(source).toMatch(/transferDestinations\(\s*\n?\s*directory,\s*\n?\s*organisationSlug,/);
  });

  it("reads the tenant from no other source", () => {
    // The work item ruled these out by name.
    expect(source).not.toMatch(/location\.hostname|window\.location|localStorage|sessionStorage|document\.cookie/);
  });
});

describe("what the form would submit", () => {
  // Mirrors the component's derived `toStore`: a selection is only real while
  // it is still on offer for the resolved tenant.
  const stillOffered = (
    directory: SignupStore[] | undefined,
    slug: string,
    source: string,
    picked: string,
  ) =>
    transferDestinations(directory, slug, source).some((s) => s.id === picked)
      ? picked
      : "";

  it("keeps a valid choice", () => {
    expect(stillOffered(ECLAT, "eclat", "surat-main", "mumbai-borivali")).toBe(
      "mumbai-borivali",
    );
  });

  it("drops a choice carried over from another tenant", () => {
    expect(
      stillOffered(OTHER, "kalyan-jewellers", "jaipur-mi-road", "mumbai-borivali"),
    ).toBe("");
  });

  it("drops any choice while the tenant is unresolved", () => {
    expect(stillOffered(ECLAT, "", "surat-main", "mumbai-borivali")).toBe("");
  });
});
