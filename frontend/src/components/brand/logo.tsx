import { cn } from "@/lib/utils";

/**
 * Éclat Diamonds brand lockup — the gold "ÉD" monogram + "ECLAT DIAMONDS"
 * wordmark. Single source for the logo across the app (sidebar, sign-in,
 * landing). Sized by height; width auto.
 *
 * To use the client's exact raster instead of this vector, drop the PNG at
 * `public/eclat-logo.png` and change the `src` below to "/eclat-logo.png".
 */
export function Logo({
  className,
  alt = "Éclat Diamonds",
}: {
  className?: string;
  alt?: string;
}) {
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src="/eclat-logo.svg"
      alt={alt}
      className={cn("h-9 w-auto select-none", className)}
      draggable={false}
    />
  );
}
