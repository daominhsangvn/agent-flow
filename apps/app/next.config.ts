import path from "node:path";
import { config, withAnalyzer } from "@repo/next-config";
import { withLogging } from "@repo/observability/next-config";
import type { NextConfig } from "next";
import { env } from "@/env";
import { resolveDatadogRumBuildVersion } from "@/lib/datadog-rum/build-version";

let nextConfig: NextConfig = withLogging(config);

// ISS-5133: do not type-check inside the build. `next build` ran `tsc` in a
// jest-worker child that needs >2 GB of V8 heap (measured: it dies at a 2048 MB
// cap), inside a Vercel build container that affords each worker a ~2240 MB
// default heap on an 8 GB box. Sitting that close to the ceiling, the worker's
// GC thrash pushed the container over its cgroup limit and the container
// SIGKILLed it — 33 times in the 30 days to 2026-08-05, all on `app-stage`,
// always in the "Running TypeScript" phase and never during compile. Note the
// cap is NOT the lever: raising it lets the worker grow further (an explicit
// `--max-old-space-size=4096` yields a 4288 MB limit in that container), and
// lowering it turns the intermittent SIGKILL into a deterministic heap OOM.
//
// The type-check itself is not lost — it MOVED to the required `typecheck` CI
// job, which has the headroom for it. That job now runs `next typegen` first
// (see apps/app/package.json), so the generated `.next/types/validator.ts`
// route-signature checks this build used to own are covered there instead.
// Removing the typegen step would silently drop that coverage, which is why
// __tests__/typecheck-owns-route-types.test.ts pins the two together.
nextConfig.typescript = { ignoreBuildErrors: true };

if (env.ANALYZE === "true") {
  nextConfig = withAnalyzer(nextConfig);
}

// FEA-2133: opt into Next standalone output ONLY for the containerized E2E
// image build, which sets E2E_STANDALONE_BUILD=1 in apps/app/Dockerfile.
// Vercel builds never set this flag, so their output behaviour is unchanged.
if (process.env.E2E_STANDALONE_BUILD === "1") {
  nextConfig.output = "standalone";
  // Trace deps from the monorepo root so the standalone bundle includes the
  // pnpm-linked @repo/* workspace packages, not just files under apps/app.
  nextConfig.outputFileTracingRoot = path.join(import.meta.dirname, "..", "..");
}

// Better Auth lives in apps/api. Serving its endpoints from this origin keeps
// the session cookie first-party to the web app; server code exchanges it for
// a JWT at the API (packages/auth/session-token.ts).
const authApiOrigin =
  process.env.AUTH_API_URL ??
  process.env.NEXT_PUBLIC_API_URL ??
  "http://localhost:3002";
const baseRewrites = nextConfig.rewrites;
nextConfig.rewrites = async () => {
  const existing = baseRewrites ? await baseRewrites() : [];
  const authRewrite = {
    source: "/api/auth/:path*",
    destination: `${authApiOrigin}/api/auth/:path*`,
  };
  if (Array.isArray(existing)) {
    return { beforeFiles: [authRewrite], afterFiles: existing, fallback: [] };
  }
  return {
    ...existing,
    beforeFiles: [authRewrite, ...(existing.beforeFiles ?? [])],
  };
};

nextConfig.env = {
  ...nextConfig.env,
  NEXT_PUBLIC_DATADOG_RUM_BUILD_VERSION: resolveDatadogRumBuildVersion(
    process.env
  ),
  // Expose Vercel's per-deployment environment to the browser so RUM env
  // tagging (apps/app/lib/environment.ts) can distinguish preview/e2e
  // deployments from real prod/stage (FEA-1466). VERCEL_ENV is a server-only
  // system var; inline it here as NEXT_PUBLIC_* so it reaches client code.
  NEXT_PUBLIC_VERCEL_ENV: process.env.VERCEL_ENV ?? "",
};

export default nextConfig;
