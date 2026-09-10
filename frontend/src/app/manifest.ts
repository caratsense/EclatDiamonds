import type { MetadataRoute } from "next";

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
    name: "CaratSense",
    short_name: "CaratSense",
    description:
      "Unified operations platform for multi-branch businesses — customers, catalogue, attendance, finance and team, in one place.",
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
