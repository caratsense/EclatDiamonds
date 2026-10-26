import * as React from "react";
import { PRODUCT_NAME } from "@/lib/brand";
import { cn } from "@/lib/utils";

/**
 * The lockup renders the product name in two tones, split after "Carat"
 * (e.g. "Carat" + "Space"). Derived from PRODUCT_NAME so a rename stays a
 * one-line change in lib/brand.ts.
 */

/**
 * Modern faceted diamond prism icon for CaratOS.
 * Renders an ultra-clean, jewel-inspired isometric vector mark.
 */
export function CaratIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 32 32"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={cn("h-7 w-7 shrink-0", className)}
      aria-hidden="true"
    >
      <defs>
        <linearGradient id="carat-brand-grad-a" x1="4" y1="4" x2="28" y2="28" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#e6c48a" />
          <stop offset="50%" stopColor="#b98c49" />
          <stop offset="100%" stopColor="#167969" />
        </linearGradient>
        <linearGradient id="carat-brand-grad-b" x1="16" y1="4" x2="16" y2="28" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#d9ad65" />
          <stop offset="100%" stopColor="#033b33" />
        </linearGradient>
      </defs>
      {/* Faceted gemstone prism */}
      <path
        d="M9 5L23 5L28 12L16 28L4 12L9 5Z"
        fill="url(#carat-brand-grad-a)"
        fillOpacity="0.2"
        stroke="url(#carat-brand-grad-a)"
        strokeWidth="1.8"
        strokeLinejoin="round"
      />
      <path
        d="M9 5L16 12L23 5"
        stroke="url(#carat-brand-grad-b)"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
      <path
        d="M4 12L28 12"
        stroke="url(#carat-brand-grad-a)"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
      <path
        d="M16 12L16 28"
        stroke="url(#carat-brand-grad-a)"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
      <path
        d="M9 5L4 12L16 28L28 12L23 5"
        stroke="url(#carat-brand-grad-b)"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/**
 * Official CaratOS brand lockup.
 * Replaces the legacy Éclat Diamonds / CaratSense branding across the entire app.
 */
export function Logo({
  className,
  name,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  isEclat,
  alt,
  showIcon = true,
}: {
  className?: string;
  name?: string | null;
  isEclat?: boolean;
  alt?: string;
  showIcon?: boolean;
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
        <CaratIcon className="h-7 w-7 shrink-0 text-primary drop-shadow-[0_0_12px_rgba(185,140,73,0.35)]" />
      )}
      {isDefaultBrand ? (
        /*
         * One word, one colour. The lockup used to split the name on "Carat"
         * and set the second half in an indigo-to-cyan gradient; now the whole
         * wordmark is simply champagne gold against
         * the emerald rail — the house pairing, and the only place the display
         * serif and the accent meet.
         */
        <span className="font-display text-xl font-bold tracking-tight text-[var(--sidebar-primary)]">
          {PRODUCT_NAME}
        </span>
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
