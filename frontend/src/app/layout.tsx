import type { Metadata, Viewport } from "next";
import { Hanken_Grotesk, Plus_Jakarta_Sans, IBM_Plex_Mono } from "next/font/google";
import "./globals.css";

import { Providers } from "@/components/providers";
import { ServiceWorkerRegister } from "@/components/pwa/sw-register";

/**
 * Three faces, three jobs (see docs/DESIGN_SYSTEM.md):
 *  - Hanken Grotesk (--font-sans-face): the workhorse UI face for dense
 *    operational data — a premium grotesk, deliberately not the ubiquitous Inter.
 *  - Plus Jakarta Sans (--font-display-face): page titles and the single hero
 *    figure per screen. This slot used to hold Fraunces, a jewellery-house
 *    serif — which was right when this was one jeweller's system and wrong the
 *    moment it became a universal operations platform. A bookish serif on a
 *    clinic's roster or a mill's stock ledger reads as dated rather than
 *    considered, and it fought the dense grotesk beside it on every screen.
 *    Jakarta is a geometric sans with real weight at 700 and slightly more
 *    character than the grotesk under it, so the two pair without competing.
 *
 *    The VARIABLE NAME is deliberately unchanged. Forty-six call sites reach
 *    for `--font-display-face` or the `font-display` utility; renaming the slot
 *    would have meant touching every one of them to change one typeface, and
 *    the slot's job ("the display face") has not changed at all.
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
  title: "CaratOS",
  description:
    "Unified operations platform: customers, catalogue, attendance, finance and team across every branch.",
  // iOS Safari ignores the web manifest for "Add to Home Screen"; these enable
  // a standalone, app-like launch with the correct name and status-bar style.
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "CaratOS",
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
