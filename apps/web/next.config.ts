import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The workspace packages ship TypeScript SOURCE, not a build output — that
  // is what keeps packages/core directly runnable by vitest and readable by
  // tsc. Next has to transpile them itself.
  //
  // Their relative imports are EXTENSIONLESS for the same reason: Turbopack
  // does not map a `./x.js` specifier onto the `x.ts` beside it, so the whole
  // build fails the moment a page actually pulls packages/core in. Nothing
  // here runs as plain Node ESM — vitest, tsx and tsc all resolve
  // extensionless TypeScript — so the extension bought nothing and cost the
  // production build.
  transpilePackages: ["@countertop/core", "@countertop/db"],

  // C-045. Prisma must NOT be bundled: a bundled client cannot find its own
  // query engine `.so` at runtime, which is a deploy-only failure (locally the
  // file is simply already beside the build). Next's defaults already include
  // this package; naming it here means the deployment does not depend on that
  // staying true.
  serverExternalPackages: ["@prisma/client"],
};

export default nextConfig;
