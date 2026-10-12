import type { MetadataRoute } from "next";

import { PRODUCT_NAME } from "@/lib/brand";

/**
 * Web app manifest for the CaratSense PWA (installable on phones and
 * in-store terminals). Served by Next.js at /manifest.webmanifest and linked
 * automatically from every page's <head>.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    // One manifest is served to every tenant, so it names the product. A
    // pharmacy installing this on its counter tablet was getting a home-screen
    // icon labelled after a jeweller.
    name: PRODUCT_NAME,
    short_name: PRODUCT_NAME,
    description: `Unified operations platform for multi-branch businesses — ${PRODUCT_NAME}.`,
    start_url: "/",
    scope: "/",
    display: "standalone",
    orientation: "portrait",
    background_color: "#0f172a",
    theme_color: "#0f172a",
    icons: [
      {
        src: "/icon-192.png",
        sizes: "192x192",
        type: "image/png",
        purpose: "any",
      },
      {
        src: "/icon-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "any",
      },
      {
        src: "/icon-maskable-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
    ],
  };
}
