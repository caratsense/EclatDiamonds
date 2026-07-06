import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // 'standalone' emits a self-contained server in .next/standalone, enabling a small
  // Docker image if the frontend is hosted on Railway instead of Vercel. Vercel ignores
  // this (uses its own adapter) and local `next dev` / `next start` are unaffected.
  output: "standalone",
};

export default nextConfig;
