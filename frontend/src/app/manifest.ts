import type { MetadataRoute } from "next";

/**
 * Web app manifest for the CaratSense PWA (installable on phones and
 * in-store terminals). Served by Next.js at /manifest.webmanifest and linked
 * automatically from every page's <head>.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "CaratSense — Éclat Diamonds",
    short_name: "CaratSense",
    description:
      "Unified operations platform for Éclat Diamonds stores — sales, inventory, finance, HR and customers, in one place.",
    start_url: "/",
    scope: "/",
    display: "standalone",
    orientation: "portrait",
    background_color: "#0F2A1E",
    theme_color: "#0F2A1E",
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
