import type { NextConfig } from "next";

// Fully static export: `bun run build` emits ./out which can be hosted on any
// static server (GitHub Pages, Netlify, itch.io, nginx, ...). No server code.
const nextConfig: NextConfig = {
  output: "export",
  reactStrictMode: false,
};

export default nextConfig;
