import path from "node:path";
import type { NextConfig } from "next";

// The dashboard links @tracewright/run-diff from ../packages, so Turbopack and file
// tracing must treat the repository root as the project root.
const repoRoot = path.join(import.meta.dirname, "..");

const nextConfig: NextConfig = {
  cacheComponents: true,
  partialPrefetching: true,
  outputFileTracingRoot: repoRoot,
  // Don't have `next dev` write an AGENTS.md into the project; nothing in Next requires it.
  agentRules: false,
  turbopack: {
    root: repoRoot,
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
