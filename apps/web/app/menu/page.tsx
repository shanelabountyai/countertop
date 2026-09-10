// The customer menu (P0-1). A server component: the menu comes out of the
// database on the server, and the only thing that reaches the browser is what
// it renders.
import Link from 'next/link';
import {
  daypartClosure,
  formatOrderNumber,
  isTerminal,
  reviewCart,
  type MenuItem,
  type RestaurantClock,
} from '@countertop/core';
import { findOrderByStatusToken } from '@countertop/db/placement';
import { loadClock, loadMenu } from '@countertop/db/menu';
import { formatCents } from '@/lib/money';
import { currentGate } from '@/lib/checkout-gate';
import { GateNotice } from '../checkout/gate-notice';
import { LastCall } from '../checkout/last-call';
import { Lockup } from '@/lib/brand';
import { RestaurantFooter } from '@/lib/restaurant-footer';
import { readCart } from '@/lib/cart-session';
import { readRecentOrderTokens } from '@/lib/recent-orders';
import { STATUS_PROGRESS_PHRASE } from '@/lib/status-labels';

export const metadata = { title: 'Menu — Firebird Kitchen' };

// Rendered per request, never prerendered at build time. An 86 has to reach
// the menu the moment a manager taps it (P0-6) — a menu baked into the build
// output goes stale the first time the kitchen runs out of anything.
export const dynamic = 'force-dynamic';

// The same two facts `validateComposition` reads, in the same order of
// precedence (P1-1): an 86 first, then the schedule. This screen renders the
// reason; the server refuses the composition. Neither is the authority on its
// own — a daypart that greyed the link but let a hand-rolled POST through
// would be the pause-switch defect again.
//
// "Never both" is the precedence: an item that is sold out AND outside its
// window is not coming back at 16:00, and saying so would be a promise the
// kitchen has not made.
function unavailableNote(item: MenuItem, clock: RestaurantClock): string | null {
  if (!item.available) return 'Sold out';
  return daypartClosure(item, clock)?.label ?? null;
}

export default async function MenuPage() {
  const [menu, gate, clock, cart, recentTokens] = await Promise.all([
    loadMenu(),
    currentGate(),
    loadClock(),
    readCart(),
    readRecentOrderTokens(),
  ]);
  const items = Object.values(menu.items);
  // P1-2: the count is visible without a trip to the cart page. Total
  // quantity across lines, not line count — a group order is six burritos on
  // one line as often as six separate ones.
  //
  // C-083 debt: a flagged line (86'd since it was added, or referencing an
  // item/option the menu no longer has) doesn't count — the cart page won't
  // let it through either, so a number the customer can't actually check out
  // is worse than a smaller honest one. Same `reviewCart` the cart page
  // renders from; tax rate doesn't affect which lines are flagged, so 0 here
  // costs nothing.
  const cartCount = reviewCart(menu, cart, 0, clock).lines.reduce(
    (sum, { line, problems }) => (problems.length === 0 ? sum + line.composition.quantity : sum),
    0,
  );

  // P1-1 (C-082). Looked up by the same unguessable token the confirmation
  // screen printed — no lookup by name, phone or number, so this adds no
  // enumeration surface. Filtered to `!isTerminal` with the one status
  // module's own function: a picked-up, cancelled or abandoned order is not
  // a "way back" anybody needs a strip for.
  const recentOrders = (await Promise.all(recentTokens.map((token) => findOrderByStatusToken(token))))
    .filter((order): order is NonNullable<typeof order> => order !== null && !isTerminal(order.status));

  return (
    <>
      <main className="mx-auto max-w-2xl p-6">
        <header className="mb-8 flex items-center justify-between gap-4">
          {/* The primary lockup, not plain text (docs/design/README.md). The
              mark is aria-hidden, so the heading's accessible name is still
              exactly "Firebird Kitchen". */}
          <h1>
            <Lockup />
          </h1>
          <Link href="/cart" className="inline-flex min-h-12 w-fit items-center text-sm underline underline-offset-4">
            View cart{cartCount > 0 && ` (${cartCount})`}
          </Link>
        </header>

        {/* P1-1 (C-082). One line per still-open recent order — plural is
            rare (a shared browser, a customer who orders twice in a row) but
            the strip does not assume there is only ever one. */}
        {recentOrders.length > 0 && (
          <ul className="mb-8 flex flex-col gap-2" data-testid="recent-orders">
            {recentOrders.map((order) => (
              <li key={order.statusToken}>
                <Link
                  href={`/status/${order.statusToken}`}
                  className="flex min-h-12 items-center rounded-lg border border-neutral-300 px-4 text-sm hover:border-neutral-500"
                >
                  Your order {formatOrderNumber(order.seq)} is{' '}
                  {STATUS_PROGRESS_PHRASE[order.status]} — track it
                </Link>
              </li>
            ))}
          </ul>
        )}

        {/* Same gate the cart re-asks before checkout (P0-6) — surfaced here too
            so a customer finds out before building a cart, not after. */}
        <GateNotice gate={gate} className="mb-8" />
        {/* ...and the other side of the same answer: still open, but not for
            long (P0-3). One component, here and on the cart and checkout. */}
        <LastCall gate={gate} className="mb-8" />

        {/* Five categories are one long scroll on a phone (P0-4). Plain
            in-page anchors and `scroll-mt` on the sections — no scroll
            listener, no active-section state, no JS at all: the browser
            already does this, and the version that reimplements it is the
            version that fights the back button. */}
        <nav
          aria-label="Jump to a category"
          className="sticky top-0 z-10 -mx-6 mb-6 border-b border-neutral-200 bg-white px-6 py-2"
        >
          <ul className="flex flex-wrap gap-2">
            {menu.categories.map((category) => (
              <li key={category.id}>
                <a
                  href={`#category-${category.id}`}
                  className="inline-flex min-h-12 items-center rounded-full border border-neutral-300 px-4 text-sm hover:border-neutral-500"
                >
                  {category.name}
                </a>
              </li>
            ))}
          </ul>
        </nav>

        {menu.categories.map((category) => (
          /* `scroll-mt` clears the sticky strip above: without it the anchor
             lands the heading exactly under the bar it was tapped on. */
          <section key={category.id} id={`category-${category.id}`} className="mb-8 scroll-mt-20">
            <h2 className="mb-3 text-xl font-semibold">{category.name}</h2>
            <ul className="flex flex-col gap-2">
              {items
                .filter((item) => item.categoryId === category.id)
                .map((item) => {
                  const note = unavailableNote(item, clock);
                  /* Name, description and price, identical in both branches
                     below — one copy, because the sold-out row differing from
                     the orderable one by anything but its styling is how the
                     two drift apart. The description is INSIDE the tap target:
                     it is what the row is about, so it belongs in the link's
                     accessible name too, not beside it. */
                  const body = (
                    <>
                      <span className="min-w-0">
                        <span className="font-medium">
                          {item.name}
                          {note !== null && <span className="font-normal"> — {note}</span>}
                        </span>
                        {/* P0-4. The LIVE menu's sentence about the food.
                            Rendered here and in the composer, and nowhere a
                            placed order is shown — a description on a receipt
                            would be a menu join. */}
                        {item.description !== undefined && (
                          <span className="mt-0.5 block text-sm text-neutral-600">
                            {item.description}
                          </span>
                        )}
                      </span>
                      <span className="tabular-nums">{formatCents(item.basePriceCents)}</span>
                    </>
                  );

                  return (
                    <li key={item.id}>
                      {/* A sold-out item is RENDERED, not hidden (P0-6): a customer
                          who cannot find the burrito assumes the site is broken,
                          one who sees it greyed out knows the kitchen ran out. */}
                      {note === null ? (
                        <Link
                          href={`/menu/${item.id}`}
                          className="flex min-h-12 items-center justify-between gap-4 rounded-lg border border-neutral-300 px-4 py-3 hover:border-neutral-500"
                        >
                          {body}
                        </Link>
                      ) : (
                        <div
                          aria-disabled="true"
                          className="flex min-h-12 items-center justify-between gap-4 rounded-lg border border-dashed border-neutral-300 px-4 py-3 text-neutral-500"
                        >
                          {body}
                        </div>
                      )}
                    </li>
                  );
                })}
            </ul>
          </section>
        ))}
      </main>
      <RestaurantFooter />
    </>
  );
}
