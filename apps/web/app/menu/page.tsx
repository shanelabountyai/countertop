// The customer menu (P0-1). A server component: the menu comes out of the
// database on the server, and the only thing that reaches the browser is what
// it renders.
import Link from 'next/link';
import { loadMenu } from '@countertop/db/menu';
import { formatCents } from '@/lib/money';
import { currentGate } from '@/lib/checkout-gate';
import { GateNotice } from '../checkout/gate-notice';
import { Lockup } from '@/lib/brand';

export const metadata = { title: 'Menu — Firebird Kitchen' };

// Rendered per request, never prerendered at build time. An 86 has to reach
// the menu the moment a manager taps it (P0-6) — a menu baked into the build
// output goes stale the first time the kitchen runs out of anything.
export const dynamic = 'force-dynamic';

export default async function MenuPage() {
  const [menu, gate] = await Promise.all([loadMenu(), currentGate()]);
  const items = Object.values(menu.items);

  return (
    <main className="mx-auto max-w-2xl p-6">
      <header className="mb-8 flex items-center justify-between gap-4">
        {/* The primary lockup, not plain text (docs/design/README.md). The
            mark is aria-hidden, so the heading's accessible name is still
            exactly "Firebird Kitchen". */}
        <h1>
          <Lockup />
        </h1>
        <Link href="/cart" className="inline-flex min-h-12 w-fit items-center text-sm underline underline-offset-4">
          View cart
        </Link>
      </header>

      {/* Same gate the cart re-asks before checkout (P0-6) — surfaced here too
          so a customer finds out before building a cart, not after. */}
      <GateNotice gate={gate} className="mb-8" />

      {menu.categories.map((category) => (
        <section key={category.id} className="mb-8">
          <h2 className="mb-3 text-xl font-semibold">{category.name}</h2>
          <ul className="flex flex-col gap-2">
            {items
              .filter((item) => item.categoryId === category.id)
              .map((item) => (
                <li key={item.id}>
                  {/* A sold-out item is RENDERED, not hidden (P0-6): a customer
                      who cannot find the burrito assumes the site is broken,
                      one who sees it greyed out knows the kitchen ran out. */}
                  {item.available ? (
                    <Link
                      href={`/menu/${item.id}`}
                      className="flex min-h-12 items-center justify-between gap-4 rounded-lg border border-neutral-300 px-4 py-3 hover:border-neutral-500"
                    >
                      <span className="font-medium">{item.name}</span>
                      <span className="tabular-nums">{formatCents(item.basePriceCents)}</span>
                    </Link>
                  ) : (
                    <div
                      aria-disabled="true"
                      className="flex min-h-12 items-center justify-between gap-4 rounded-lg border border-dashed border-neutral-300 px-4 py-3 text-neutral-500"
                    >
                      <span className="font-medium">
                        {item.name} <span className="font-normal">— Sold out</span>
                      </span>
                      <span className="tabular-nums">{formatCents(item.basePriceCents)}</span>
                    </div>
                  )}
                </li>
              ))}
          </ul>
        </section>
      ))}
    </main>
  );
}
