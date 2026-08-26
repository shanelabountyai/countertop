// The 86 board (P0-6, C-012).
//
// Availability has two grains and this screen shows both: out of avocado is
// not out of burritos. One tap per row, no dialog, no save button — a cook
// with one clean hand is not going to confirm a modal.
//
// Nothing here decides what an 86 MEANS. It flips the same `available` column
// the customer menu, `validateComposition`, `reviewCart` and placement all
// read, so all three surfaces move together and none of them can disagree.
import Link from 'next/link';
import { loadMenu } from '@countertop/db/menu';
import { formatCents, formatDeltaCents } from '@/lib/money';
import { setItemAvailable, setOptionAvailable } from '../actions';

export const metadata = { title: 'Availability — Firebird Kitchen' };

// Never prerendered: this screen IS the live state of the kitchen's stock.
export const dynamic = 'force-dynamic';

/** One row: what it is, what it costs, and the single tap that flips it. */
function Row({
  name,
  price,
  available,
  action,
}: {
  name: string;
  price: string;
  available: boolean;
  action: () => Promise<void>;
}) {
  return (
    <li
      className={`flex flex-wrap items-center justify-between gap-3 rounded-lg border-2 p-3 ${
        available ? 'border-neutral-300' : 'border-red-500 bg-red-50'
      }`}
    >
      <span className="text-lg font-semibold">
        {name}{' '}
        <span className="font-normal text-neutral-600 tabular-nums">{price}</span>
        {!available && (
          <span className="ml-2 rounded bg-red-700 px-2 py-1 text-base font-bold uppercase text-white">
            Sold out
          </span>
        )}
      </span>

      {/* A plain form, so the board works before hydration and during the
          rush that is exactly when someone reaches for it. */}
      <form action={action}>
        <button
          type="submit"
          className={`min-h-12 rounded-lg px-5 text-lg font-bold text-white ${
            available ? 'bg-red-700' : 'bg-green-800'
          }`}
        >
          {available ? `Mark ${name} sold out` : `Put ${name} back on`}
        </button>
      </form>
    </li>
  );
}

export default async function AvailabilityPage() {
  const menu = await loadMenu();
  const items = Object.values(menu.items);

  return (
    <main className="mx-auto max-w-3xl p-6">
      <Link href="/kitchen" className="text-lg underline underline-offset-4">
        ← Kitchen queue
      </Link>
      <h1 className="mt-4 text-3xl font-semibold">Availability</h1>
      <p className="mt-1 text-lg text-neutral-700">
        Sold-out items and options stay on the menu marked “sold out”, and any cart already
        holding one is flagged at checkout.
      </p>

      {menu.categories.map((category) => (
        <section key={category.id} className="mt-8">
          <h2 className="text-xl font-semibold">{category.name}</h2>
          <ul className="mt-3 flex flex-col gap-2">
            {items
              .filter((item) => item.categoryId === category.id)
              .map((item) => (
                <Row
                  key={item.id}
                  name={item.name}
                  price={formatCents(item.basePriceCents)}
                  available={item.available}
                  action={setItemAvailable.bind(null, item.id, !item.available)}
                />
              ))}
          </ul>
        </section>
      ))}

      <h2 className="mt-10 text-2xl font-semibold">Options</h2>
      {Object.values(menu.groups).map((group) => (
        <section key={group.id} className="mt-6">
          <h3 className="text-xl font-semibold">{group.name}</h3>
          <ul className="mt-3 flex flex-col gap-2">
            {group.options.map((option) => (
              <Row
                key={option.id}
                name={option.name}
                price={formatDeltaCents(option.priceDeltaCents)}
                available={option.available}
                action={setOptionAvailable.bind(null, option.id, !option.available)}
              />
            ))}
          </ul>
        </section>
      ))}
    </main>
  );
}
