import { ComingSoon } from "@/components/section/coming-soon";
import { SectionHeader } from "@/components/section/section-header";
import { getNavItem } from "@/lib/navigation";

/**
 * Phase-1 placeholder body shared by every module page.
 * Pass the route slug; pulls title/purpose/CTA from the nav config so the
 * 17 pages stay one-liners and consistent.
 */
export function SectionPlaceholder({ slug }: { slug: string }) {
  const item = getNavItem(slug);
  if (!item) return null;

  return (
    <>
      {/* role/store-scoped — Phase 2 swaps placeholder for real screens. */}
      <SectionHeader
        title={item.title}
        purpose={item.purpose}
        primaryAction={item.primaryAction}
      />
      <ComingSoon module={item.module} title={item.title} />
    </>
  );
}
