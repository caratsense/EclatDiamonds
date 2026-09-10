"use client";

import { usePublicIndustries } from "@/lib/queries/auth";

/**
 * The industry packs, from the server that actually has them.
 *
 * This list used to be sixteen strings typed into the landing page, under a
 * heading that said "Sixteen starting points." Add or retire a pack and the
 * public site kept stating the old list and the old count — confidently, and to
 * exactly the people deciding whether the product covers them. The sign-in
 * screen on the same site was already reading the real thing from
 * `/auth/industries`; this now reads it too.
 *
 * The failure mode is silence, not a guess. If the packs cannot be fetched the
 * section renders its heading and nothing under it, because a hardcoded
 * fallback list is the bug this replaces, one layer down.
 */
export function IndustryGrid() {
  const industries = usePublicIndustries();
  const packs = industries.data?.packs ?? [];

  return (
    <>
      <p className="mt-4 max-w-2xl text-sm leading-relaxed text-[var(--l-ivory-70)]">
        {industries.isPending
          ? "Loading the list of industry packs…"
          : packs.length
            ? `${packs.length} starting points. A pack sets vocabulary, the default pipeline and the qualification questions — your team can edit any of it afterwards, and changing industry later never overwrites wording somebody chose.`
            : "The list of industry packs could not be loaded just now. Sign in or get in touch and we will tell you whether yours is covered."}
      </p>

      {packs.length ? (
        <ul className="mt-10 grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-[var(--l-hairline)] bg-[var(--l-hairline)] sm:grid-cols-3 lg:grid-cols-4">
          {packs.map((p) => (
            <li
              key={p.code}
              className="bg-[var(--l-surface)] px-4 py-4 text-xs font-medium text-[var(--l-ivory)]"
            >
              {p.name}
            </li>
          ))}
        </ul>
      ) : null}
    </>
  );
}
