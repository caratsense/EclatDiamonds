import * as React from "react";
import { cn } from "@/lib/utils";

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
          <stop offset="0%" stopColor="#818cf8" />
          <stop offset="50%" stopColor="#6366f1" />
          <stop offset="100%" stopColor="#38bdf8" />
        </linearGradient>
        <linearGradient id="carat-brand-grad-b" x1="16" y1="4" x2="16" y2="28" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#c084fc" />
          <stop offset="100%" stopColor="#6366f1" />
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
  // Any legacy or null tenant name resolves directly to the brand CaratOS
  const isDefaultBrand =
    !name ||
    /^(eclat|éclat|caratsense)/i.test(name.trim());

  const displayName = isDefaultBrand ? "CaratOS" : name.trim();

  return (
    <div
      aria-label={alt ?? displayName}
      className={cn(
        "flex select-none items-center gap-2.5 font-display transition-opacity",
        className,
      )}
    >
      {showIcon && (
        <CaratIcon className="h-7 w-7 shrink-0 text-primary drop-shadow-[0_0_12px_rgba(99,102,241,0.35)]" />
      )}
      {isDefaultBrand ? (
        <span className="flex items-center text-xl font-extrabold tracking-tight text-inherit">
          <span className="text-slate-900 dark:text-white">Carat</span>
          <span className="ml-1 bg-gradient-to-r from-indigo-500 via-indigo-400 to-cyan-500 dark:from-indigo-400 dark:via-indigo-300 dark:to-cyan-400 bg-clip-text font-black text-transparent">
            OS
          </span>
        </span>
      ) : (
        <div className="flex flex-col min-w-0 leading-tight">
          <span className="truncate text-base font-bold tracking-tight text-slate-900 dark:text-white">
            {displayName}
          </span>
          <span className="text-[9.5px] font-semibold tracking-wider uppercase text-slate-500 dark:text-slate-400">
            CaratOS
          </span>
        </div>
      )}
    </div>
  );
}
