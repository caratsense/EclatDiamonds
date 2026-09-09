import { cn } from "@/lib/utils";

/**
 * The brand lockup at the top of the sidebar and on the sign-in screen.
 *
 * ## Why this is not simply an image any more
 *
 * It used to render `/eclat-logo.svg` unconditionally — a gold "ED" monogram
 * and an ECLAT DIAMONDS wordmark — at the top of every page of every tenant. A
 * pharmacy, a clinic and a factory all ran an application that announced itself
 * as a jeweller they have no relationship with.
 *
 * ## What it does instead
 *
 * The Eclat organisation keeps its own mark, byte for byte: same file, same alt
 * text, same size. Every other tenant gets their own name set in the product's
 * display face. That is a deliberate stopping point — this phase does not build
 * logo upload or storage, and a tenant's NAME is something the product already
 * knows from signup, so it can be shown honestly today without inventing an
 * asset pipeline.
 *
 * Pre-authentication (the sign-in screen) there is no tenant to ask, so the
 * neutral product name is used. That is the honest answer to "whose app is
 * this?" before anyone has said who they are.
 */
export function Logo({
  className,
  /** The tenant's own name. Absent => the neutral product lockup. */
  name,
  /** True only for the organisation that owns the Eclat artwork. */
  isEclat = false,
  alt,
}: {
  className?: string;
  name?: string | null;
  isEclat?: boolean;
  alt?: string;
}) {
  if (isEclat) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src="/eclat-logo.svg"
        alt={alt ?? "Éclat Diamonds"}
        className={cn("h-9 w-auto select-none", className)}
        draggable={false}
      />
    );
  }

  return (
    <span
      aria-label={alt ?? name ?? "CaratSense"}
      className={cn(
        "flex select-none items-center font-display text-[17px] font-semibold leading-none tracking-tight",
        className,
      )}
    >
      <span className="truncate">{name?.trim() || "CaratSense"}</span>
    </span>
  );
}
