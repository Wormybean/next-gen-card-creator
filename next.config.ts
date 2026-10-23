import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The desktop app ships a self-contained server (see desktop/ and "desktop:build").
  ...(process.env.DESKTOP_BUILD ? { output: "standalone" as const } : {}),
  // mupdf ships WebAssembly and uses top-level await; load it with plain Node instead of bundling.
  serverExternalPackages: ["mupdf"],
};

export default nextConfig;
