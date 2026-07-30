import type { Metadata, Viewport } from "next";
import { Hanken_Grotesk, Fraunces, IBM_Plex_Mono } from "next/font/google";
import "./globals.css";

import { Providers } from "@/components/providers";
import { ServiceWorkerRegister } from "@/components/pwa/sw-register";

/**
 * Three faces, three jobs (see docs/DESIGN_SYSTEM.md):
 *  - Hanken Grotesk (--font-sans-face): the workhorse UI face for dense
 *    operational data — a premium grotesk, deliberately not the ubiquitous Inter.
 *  - Fraunces (--font-display-face): the jewellery-house serif for page titles
 *    and the single hero figure per screen. Chosen over Cormorant Garamond
 *    because it carries a genuine bold — Cormorant is delicate by design and
 *    stays wispy even at 700, which is the opposite of what a heading needs.
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

const displayFace = Fraunces({
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
  title: "CaratSense — Eclat",
  description:
    "Unified operations platform for multi-store jewelry retail: sales, inventory, finance, HR and customer management.",
  // iOS Safari ignores the web manifest for "Add to Home Screen"; these enable
  // a standalone, app-like launch with the correct name and status-bar style.
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "CaratSense",
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
  themeColor: "#0F2A1E",
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
