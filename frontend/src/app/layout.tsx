import type { Metadata, Viewport } from "next";
import { Hanken_Grotesk, Plus_Jakarta_Sans, IBM_Plex_Mono } from "next/font/google";
import "./globals.css";

import { Providers } from "@/components/providers";
import { ServiceWorkerRegister } from "@/components/pwa/sw-register";
import { PRODUCT_NAME } from "@/lib/brand";

/**
 * Three faces, three jobs (see docs/DESIGN_SYSTEM.md):
 *  - Hanken Grotesk (--font-sans-face): the workhorse UI face for dense
 *    operational data — a premium grotesk, deliberately not the ubiquitous Inter.
 *  - Plus Jakarta Sans (--font-display-face): page titles and the single hero
 *    figure per screen. See the note above the loader for why this is a sans
 *    and not the jewellery-house serif it twice reverted to.
 *  - IBM Plex Mono (--font-mono-face): the "assay readout" — tabular figures for
 *    weights, carats, prices and every numeric column. Not a variable font, so
 *    its weights are listed explicitly.
 *
 * NOTE ON THE VARIABLE NAMES: these deliberately do NOT match the Tailwind theme
 * tokens (`--font-sans` and friends in globals.css). They used to, and the theme
 * token was then defined as `--font-sans: var(--font-sans), …` — a self-reference
 * that resolves to nothing, so every face silently fell back to the OS default.
 * Keeping the loader variables on their own `-face` names makes that impossible.
 */
const sans = Hanken_Grotesk({
  subsets: ["latin"],
  variable: "--font-sans-face",
  display: "swap",
});

/*
 * Page titles and the single hero figure per screen.
 *
 * This slot has been round-tripped twice and the serif lost both times. Fraunces
 * was restored on 24 Oct 2026 for one reason, stated in the commit: it paired
 * with the emerald-and-gold palette, whose reference called for "elegant serif
 * headings with a clean sans-serif for tables". That palette was replaced five
 * days later by the CaratSpace red-and-black theme, and nobody moved the
 * typeface back — so a serif chosen for a design that no longer exists was
 * still setting every page title, including the sign-in screen a client sees
 * first.
 *
 * Jakarta is a geometric sans with real weight at 700 and a little more
 * character than the grotesk beneath it, so the two pair without competing.
 * `globals.css` has described this slot as "a geometric sans" since the first
 * attempt; with Fraunces in it, that comment was describing something else.
 *
 * The VARIABLE NAME stays `--font-display-face`. Forty-six call sites reach for
 * it or for the `font-display` utility, and the slot's job has not changed.
 */
const displayFace = Plus_Jakarta_Sans({
  subsets: ["latin"],
  variable: "--font-display-face",
  display: "swap",
});

const mono = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-mono-face",
  display: "swap",
});


export const metadata: Metadata = {
  /*
   * The PRODUCT, not one of its customers.
   *
   * This is static, server-rendered metadata: it is produced before any tenant
   * is known and is identical for everyone, so naming a single customer here
   * put a jeweller's name in the browser tab and the installed-app title of
   * every clinic, factory and pharmacy on the platform. A per-tenant title would
   * need the tenant resolved at request time, which this file cannot do.
   */
  title: PRODUCT_NAME,
  description:
    "Unified operations platform: customers, catalogue, attendance, finance and team across every branch.",
  // iOS Safari ignores the web manifest for "Add to Home Screen"; these enable
  // a standalone, app-like launch with the correct name and status-bar style.
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: PRODUCT_NAME,
  },
  // Point at the pre-built PNGs in /public (192/512 for browsers and the
  // manifest fallback; apple-touch-icon for the iOS home screen).
  icons: {
    icon: [
      { url: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { url: "/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
    apple: "/apple-icon.png",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  // The obsidian canvas, so the browser chrome and the installed-app splash
  // match the first painted pixel instead of the colour the product used to be.
  themeColor: "#090B10",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${sans.variable} ${displayFace.variable} ${mono.variable} antialiased`}
      suppressHydrationWarning
    >
      <body>
        <ServiceWorkerRegister />
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
