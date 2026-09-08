import Link from 'next/link';
import { RestaurantFooter } from '@/lib/restaurant-footer';

// Never prerendered, now that the footer reads the restaurant's own details
// (C-077). Left static, this page would have shipped whatever address was in
// the database on the build machine — and thrown at build time on a database
// that had no settings row at all. Every other customer route already says
// this, for the same class of reason.
export const dynamic = 'force-dynamic';

export default function Home() {
  return (
    <>
      <main className="mx-auto flex min-h-[80vh] max-w-2xl flex-col justify-center gap-4 p-8">
        <h1 className="text-3xl font-semibold">Countertop</h1>
        <p className="text-neutral-600 dark:text-neutral-300">
          Pickup ordering for Firebird Kitchen.
        </p>
        <Link
          href="/menu"
          className="flex min-h-14 w-fit items-center rounded-lg bg-neutral-900 px-6 text-lg font-semibold text-white"
        >
          Order pickup
        </Link>
      </main>
      <RestaurantFooter />
    </>
  );
}
