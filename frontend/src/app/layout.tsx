import type { Metadata, Viewport } from "next";
import { Hanken_Grotesk, Cormorant_Garamond, IBM_Plex_Mono } from "next/font/google";
import "./globals.css";

import { Providers } from "@/components/providers";

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
const sans = Hanken_Grotesk({
  variable: "--font-sans",
  subsets: ["latin"],
  display: "swap",
  weight: ["400", "500", "600", "700"],
});

const displayFace = Cormorant_Garamond({
  variable: "--font-display",
  subsets: ["latin"],
  display: "swap",
  weight: ["500", "600", "700"],
});

const mono = IBM_Plex_Mono({
  variable: "--font-mono",
  subsets: ["latin"],
  display: "swap",
  weight: ["400", "500", "600"],
});

export const metadata: Metadata = {
  title: "CaratSense — Eclat",
  description:
    "Unified operations platform for multi-store jewelry retail: sales, inventory, finance, HR and customer management.",
};

export const viewport: Viewport = { width: "device-width", initialScale: 1 };

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
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
