// The 86 board (P0-6, C-012).
//
// Availability has two grains and this screen shows both: out of avocado is
// not out of burritos. One tap per row, no dialog, no save button — a cook
// with one clean hand is not going to confirm a modal.
//
// Nothing here decides what an 86 MEANS. It flips the same `available` column
// the customer menu, `validateComposition`, `reviewCart` and placement all
// read, so all three surfaces move together and none of them can disagree.
//
// C-071: every option row names the items it will stop, BEFORE the tap. An
// option is shared — 86ing Guacamole stops it on four items at once, which is
// correct and used to be invisible. The calm menu editor has warned about
// shared groups since C-015; the screen someone reaches for mid-rush gets the
// same courtesy, and from the same `itemsUsingGroup` derivation so the two
// cannot drift apart.
//
// C-108: and it has a search box, because this page is longer than the queue —
// 25 items plus every option of every group — and is read under more pressure.
// It NARROWS, where the queue's lookup only marks: a queue card that vanishes
// is a customer standing at the counter unseen, a menu row that vanishes is a
// menu row. `searchMenu` owns the matching rule, including the part where an
// option drags in the items it stops.
import Link from 'next/link';
import { itemsUsingGroup, searchMenu } from '@countertop/core';
import { loadMenu } from '@countertop/db/menu';
import { formatCents, formatDeltaCents } from '@/lib/money';
import { setItemAvailable, setOptionAvailable } from '../actions';

export const metadata = { title: 'Availability — Firebird Kitchen' };

// Never prerendered: this screen IS the live state of the kitchen's stock.
export const dynamic = 'force-dynamic';

// How many item names fit on a phone row before the list stops being readable
// at arm's length. Above this the row shows the first few AND the count of
// what it left out — never a bare "shared", which is the thing the cook
// already knows and cannot act on.
const MAX_NAMED_ITEMS = 4;

/** One row: what it is, what it costs, who it stops, and the tap that flips it. */
function Row({
  name,
  price,
  available,
  usedOn,
  action,
}: {
  name: string;
  price: string;
  available: boolean;
  usedOn?: string[];
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

      {/* Full-width, so it wraps under the name and the tap target rather than
          squeezing either. `basis-full` inside the wrapping flex row. */}
      {usedOn && (
        <p className="basis-full text-lg text-neutral-700">
          {usedOn.length === 0
            ? 'Not used on any item.'
            : `Used on: ${usedOn.slice(0, MAX_NAMED_ITEMS).join(', ')}${
                usedOn.length > MAX_NAMED_ITEMS
                  ? ` +${usedOn.length - MAX_NAMED_ITEMS} more`
                  : ''
              }`}
        </p>
      )}
    </li>
  );
}

export default async function AvailabilityPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  const menu = await loadMenu();
  const items = Object.values(menu.items);
  const query = (await searchParams).q ?? '';
  const searching = query.trim() !== '';
  const shown = searchMenu(menu, query);
  // Built up front so the "Options" heading and the no-matches line can ask
  // whether anything survived, rather than each re-deriving it mid-JSX.
  const groups = Object.values(menu.groups)
    .map((group) => ({ group, options: group.options.filter((o) => shown.optionIds.has(o.id)) }))
    .filter((entry) => entry.options.length > 0);

  return (
    <main className="mx-auto max-w-3xl p-6">
      <Link href="/kitchen" className="inline-flex min-h-12 w-fit items-center text-lg underline underline-offset-4">
        ← Kitchen queue
      </Link>
      <h1 className="mt-4 text-3xl font-semibold">Availability</h1>
      <p className="mt-1 text-lg text-neutral-700">
        Sold-out items and options stay on the menu marked “sold out”, and any cart already
        holding one is flagged at checkout.
      </p>

      {/* A plain GET form, exactly the queue's: it works before hydration —
          which is the state a cook on a tablet at 12:40pm is most likely to
          hit — and the result is a URL a second screen can be opened on. */}
      <form className="mt-4 flex flex-wrap gap-2">
        <label className="flex flex-1 flex-col gap-1">
          <span className="text-sm font-medium">Find an item or option by name</span>
          <input
            type="search"
            name="q"
            defaultValue={query}
            placeholder="guac"
            className="min-h-12 rounded-lg border border-neutral-400 px-3 text-lg"
          />
        </label>
        <button
          type="submit"
          className="mt-6 min-h-12 rounded-lg border border-neutral-400 px-6 font-semibold"
        >
          Find
        </button>
        {searching && (
          <Link
            href="/kitchen/availability"
            className="mt-6 flex min-h-12 items-center rounded-lg px-4 underline underline-offset-4"
          >
            Show all
          </Link>
        )}
      </form>

      {/* A filtered board that matches nothing is a blank page, and a blank
          page mid-rush reads as broken rather than as empty. */}
      {searching && shown.itemIds.size === 0 && groups.length === 0 && (
        <p className="mt-4 text-lg font-semibold">
          Nothing on the menu matches &ldquo;{query.trim()}&rdquo;.
        </p>
      )}

      {menu.categories.map((category) => {
        const inCategory = items.filter(
          (item) => item.categoryId === category.id && shown.itemIds.has(item.id),
        );
        // An empty heading under a search is a row of dead furniture on the
        // screen the search exists to shorten.
        if (inCategory.length === 0) return null;
        return (
          <section key={category.id} className="mt-8">
            <h2 className="text-xl font-semibold">{category.name}</h2>
            <ul className="mt-3 flex flex-col gap-2">
              {inCategory.map((item) => (
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
        );
      })}

      {groups.length > 0 && <h2 className="mt-10 text-2xl font-semibold">Options</h2>}
      {groups.map(({ group, options }) => {
        // Per group, not per option: an option belongs to one group, so every
        // option in it reaches exactly the same items. The list is the FULL
        // reach, never trimmed to what the search is showing — "this stops
        // four items" stays true whichever four rows happen to be on screen.
        const usedOn = itemsUsingGroup(menu, group.id);
        return (
          <section key={group.id} className="mt-6">
            <h3 className="text-xl font-semibold">{group.name}</h3>
            <ul className="mt-3 flex flex-col gap-2">
              {options.map((option) => (
                <Row
                  key={option.id}
                  name={option.name}
                  price={formatDeltaCents(option.priceDeltaCents)}
                  available={option.available}
                  usedOn={usedOn}
                  action={setOptionAvailable.bind(null, option.id, !option.available)}
                />
              ))}
            </ul>
          </section>
        );
      })}
    </main>
  );
}
