// Runs once when the server starts (Next's instrumentation hook). Scorecard
// K11: validate the environment here, so a bad value fails the boot by name
// instead of failing the first request that happens to read it.
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { parseEnv } = await import('./lib/env');
    parseEnv(process.env);
  }
}
