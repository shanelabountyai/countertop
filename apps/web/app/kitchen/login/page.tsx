// The staff sign-in (C-037).
//
// A plain form posting to a server action, with its error state in the URL —
// the same shape as the settings and menu confirms (C-015, C-023). It works
// before hydration, which matters more here than anywhere else on the site: a
// screen that cannot be signed into is a kitchen that cannot see its orders.
//
// Deliberately austere. There is no "forgot your passcode", because there is
// no account to recover — the passcode is an environment variable, and the
// person who can change it is the person who deploys.
import { staffPasscode } from '@/lib/staff-auth';
import { signIn } from './actions';

export const metadata = { title: 'Sign in — Firebird Kitchen' };

// Never prerendered: the page's own copy depends on whether the deployment has
// a passcode configured, which is read at request time.
export const dynamic = 'force-dynamic';

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string; error?: string }>;
}) {
  const { next, error } = await searchParams;
  const configured = staffPasscode() !== '';

  return (
    <main className="mx-auto max-w-sm p-6">
      <h1 className="text-3xl font-semibold">Kitchen sign-in</h1>

      {!configured ? (
        <p className="mt-6 rounded-lg border border-amber-500 bg-amber-50 p-4 text-sm">
          This deployment has no <code>STAFF_PASSCODE</code> set, so the kitchen
          screens are locked. Set it and restart the server.
        </p>
      ) : (
        <form action={signIn} className="mt-6 flex flex-col gap-4">
          {next ? <input type="hidden" name="next" value={next} /> : null}
          <label className="flex flex-col gap-1">
            <span className="text-sm font-medium">Passcode</span>
            <input
              type="password"
              name="passcode"
              autoComplete="current-password"
              autoFocus
              required
              className="min-h-12 rounded-lg border border-neutral-400 px-3 text-lg"
            />
          </label>
          {/* ≥48px, like every other control staff touch (P0-11). */}
          <button
            type="submit"
            className="min-h-12 rounded-lg bg-neutral-900 px-6 font-semibold text-white"
          >
            Sign in
          </button>
        </form>
      )}

      {error === 'wrong' ? (
        <p role="alert" className="mt-4 text-sm text-red-700">
          That passcode is not right.
        </p>
      ) : null}
      {error === 'unset' ? (
        <p role="alert" className="mt-4 text-sm text-red-700">
          No passcode is configured on this server.
        </p>
      ) : null}
    </main>
  );
}
