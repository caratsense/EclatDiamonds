import type { Metadata } from "next";
import { Inter, Fraunces, Geist_Mono } from "next/font/google";
import "./globals.css";

import { Providers } from "@/components/providers";

/**
 * Three faces, three jobs (see docs/DESIGN_SYSTEM.md):
 *  - Inter (--font-sans): the workhorse UI face for dense operational data.
 *  - Fraunces (--font-display): an elegant high-contrast serif used with
 *    restraint for page titles and the single hero figure per screen.
 *  - Geist Mono (--font-mono): the "assay readout" — tabular figures for
 *    weights, carats, prices and every numeric column.
 */
const inter = Inter({
  variable: "--font-sans",
  subsets: ["latin"],
  display: "swap",
  weight: ["400", "500", "600", "700"],
});

const fraunces = Fraunces({
  variable: "--font-display",
  subsets: ["latin"],
  display: "swap",
  weight: ["400", "500", "600"],
});

const geistMono = Geist_Mono({
  variable: "--font-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "CaratSense — Eclat",
  description:
    "Unified operations platform for multi-store jewelry retail: sales, inventory, finance, HR and customer management.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${inter.variable} ${fraunces.variable} ${geistMono.variable} antialiased`}
      suppressHydrationWarning
    >
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
