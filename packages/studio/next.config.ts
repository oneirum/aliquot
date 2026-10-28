import { withPayload } from "@payloadcms/next/withPayload";
import type { NextConfig } from "next";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dirname = path.dirname(fileURLToPath(import.meta.url));

const nextConfig: NextConfig = {
  turbopack: { root: path.resolve(dirname, "../..") },
  agentRules: false,
  // A scripted run builds into its own folder so it never fights a studio already running in dev.
  distDir: process.env.LABH_STUDIO_DIST_DIR ?? ".next",
};

export default withPayload(nextConfig, { devBundleServerPackages: false });
