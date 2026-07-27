import type { Metadata, Viewport } from "next";
import { Hanken_Grotesk, Cormorant_Garamond, IBM_Plex_Mono } from "next/font/google";
import "./globals.css";

import { Providers } from "@/components/providers";
import { ServiceWorkerRegister } from "@/components/pwa/sw-register";

/**
 * Three faces, three jobs (see docs/DESIGN_SYSTEM.md):
 *  - Hanken Grotesk (--font-sans): the workhorse UI face for dense operational
 *    data — a premium grotesk, deliberately not the ubiquitous Inter.
 *  - Cormorant Garamond (--font-display): the jewellery-house serif — classical
 *    high contrast, used with restraint for page titles and the single hero
 *    figure per screen.
 *  - IBM Plex Mono (--font-mono): the "assay readout" — tabular figures for
 *    weights, carats, prices and every numeric column.
 */
const sans = { variable: "font-sans" };
const displayFace = { variable: "font-display" };
const mono = { variable: "font-mono" };


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
