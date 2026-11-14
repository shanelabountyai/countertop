import type { NextConfig } from "next";

// Scorecard K7: on every response. HSTS is inert over http (localhost) and
// enforced once served over https. `frame-ancestors 'none'` is the modern
// X-Frame-Options; nothing here is meant to be embedded, the kitchen queue
// least of all (a framed queue is a clickjacked "Picked up").
export const securityHeaders = [
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
];

// Scorecard K6: the order status page is a capability link, secret only
// because its token is unguessable. The token must never leave in a Referer
// header, never be filed by a crawler, and never sit in a shared cache.
// Listed AFTER the global block, so its Referrer-Policy wins.
export const statusLinkHeaders = [
  { key: "Referrer-Policy", value: "no-referrer" },
  { key: "X-Robots-Tag", value: "noindex, nofollow" },
  { key: "Cache-Control", value: "private, no-store, max-age=0" },
];

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

  poweredByHeader: false,

  headers: async () => [
    { source: "/:path*", headers: securityHeaders },
    { source: "/status/:path*", headers: statusLinkHeaders },
  ],
};

export default nextConfig;
