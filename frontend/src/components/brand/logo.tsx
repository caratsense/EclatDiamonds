import * as React from "react";
import Image from "next/image";
import { PRODUCT_NAME, TENANT_NAME } from "@/lib/brand";
import { cn } from "@/lib/utils";

/**
 * The comp sets the platform name as two words ("CARAT SPACE") while
 * PRODUCT_NAME stays one token, because every other consumer of it — the page
 * title, the manifest, running prose — wants the single word. Splitting at the
 * camel hump keeps lib/brand.ts the only place the name is written down, and
 * is a no-op for a one-word name.
 */
const WORDMARK = PRODUCT_NAME.replace(/([a-z])([A-Z])/g, "$1 $2");

/**
 * The Carat Space mark — the supplied artwork, not a redraw.
 *
 * This was traced into SVG first and the proportions were never right: the gap
 * in the ring, where the diamond sits, is cut at angles that a dash array
 * cannot reproduce. The brand sheet ships two versions for exactly this reason,
 * so both are used — an ink ring for light surfaces and a bone one for dark —
 * and the browser swaps them on the `.dark` class rather than JavaScript, so
 * the right mark is painted on the first frame with no flash of the wrong one.
 *
 * `priority` is deliberate: this sits in the sidebar header on every route, so
 * it should never be the thing that pops in late.
 */
export function CaratIcon({ className }: { className?: string }) {
  return (
    <>
      <Image
        src="/brand/carat-mark-on-light.png"
        alt=""
        aria-hidden
        width={158}
        height={169}
        priority
        className={cn("h-7 w-7 shrink-0 object-contain dark:hidden", className)}
      />
      <Image
        src="/brand/carat-mark-on-dark.png"
        alt=""
        aria-hidden
        width={219}
        height={206}
        priority
        className={cn("hidden h-7 w-7 shrink-0 object-contain dark:block", className)}
      />
    </>
  );
}

/**
 * The brand lockup: the platform wordmark over the client it is running for.
 * A tenant name supplied by the API takes the top line instead, with the
 * platform demoted to the small line beneath it.
 */
export function Logo({
  className,
  name,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  isEclat,
  alt,
  showIcon = true,
  markOnly = false,
}: {
  className?: string;
  name?: string | null;
  isEclat?: boolean;
  alt?: string;
  showIcon?: boolean;
  /** Mark without the words — for the collapsed rail, where 96px clips them. */
  markOnly?: boolean;
}) {
  // Any legacy or null tenant name resolves directly to the product brand
  const isDefaultBrand =
    !name ||
    /^(eclat|éclat|caratsense)/i.test(name.trim());

  const displayName = isDefaultBrand ? PRODUCT_NAME : name.trim();

  return (
    <div
      aria-label={alt ?? displayName}
      className={cn(
        "flex select-none items-center gap-2.5 font-display transition-opacity",
        className,
      )}
    >
      {showIcon && (
        <CaratIcon className="h-7 w-7 shrink-0" />
      )}
      {markOnly ? null : isDefaultBrand ? (
        /*
         * The CLIENT leads and the software signs underneath: "Nibhana" over
         * "by CARAT SPACE". Nibhana is the jeweller whose staff open this every
         * morning; CaratSpace is the platform we built for them, and a vendor
         * name above a client's own is the wrong way round on their shop
         * floor. (Built the other way first — corrected 29 Oct.)
         *
         * The name reads from --sidebar-primary so it tracks the rail it sits
         * on. 15px bold is below the large-text threshold, so it owes the full
         * 4.5:1: 4.81:1 light, 4.77:1 dark. It is also what keeps the two lines
         * inside the rail's 32px brand row — 20px would overflow it.
         */
        <div className="flex min-w-0 flex-col leading-none">
          <span className="font-display text-[0.9375rem] font-bold uppercase tracking-[0.08em] text-[var(--sidebar-primary)]">
            {TENANT_NAME}
          </span>
          <span className="mt-1 text-[9.5px] font-medium tracking-wide text-muted-foreground">
            by {WORDMARK}
          </span>
        </div>
      ) : (
        <div className="flex flex-col min-w-0 leading-tight">
          <span className="truncate text-base font-bold tracking-tight text-slate-900 dark:text-white">
            {displayName}
          </span>
          <span className="text-[9.5px] font-semibold tracking-wider uppercase text-slate-500 dark:text-slate-400">
            {PRODUCT_NAME}
          </span>
        </div>
      )}
    </div>
  );
}
