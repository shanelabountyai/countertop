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
//
// C-109: and rows can be picked and killed together (P0-3). The GRAIN of that
// batch is an arbitrary selection, NOT a category — decided here against the
// PRD's own open question, because the case it was written for ("the fryer is
// down") spans Sides, Plates and Sweets in this menu and excludes non-fried
// food inside each of them. A category-level 86 could not express it, and
// would take rice and paletas off the menu to do it — the reverse-case failure
// the PRD calls worse than the one it is fixing. A category keeps a "select
// these N" link, which seeds a selection rather than being a second way to
// kill.
//
// C-112: and a STATION seeds one too, which is the case a category could not
// express. "The fryer is down" is five items spread across Sides, Plates and
// Sweets, each of which also holds food no fryer touches — so the station row
// below is the tap that C-109 said would need nothing unbuilt, and it needed
// nothing unbuilt. It seeds; it does not kill. What a station deliberately
// does NOT do is change the estimate or the auto-pause threshold: see
// docs/WRITEUP.md for why the per-station open weight was written down rather
// than built.
//
// The selection lives in the URL beside `q`, so the whole screen is still a
// GET that works unhydrated, a second tablet can be opened on the same
// selection, and a filter changing underneath a selection cannot silently drop
// half of it — every link is rebuilt from the URL, not from the DOM.
import Link from 'next/link';
import {
  itemsUsingGroup,
  searchMenu,
  selectionReach,
  STATION_LABELS,
  STATIONS,
} from '@countertop/core';
import type { MenuItem } from '@countertop/core';
import { loadMenu } from '@countertop/db/menu';
import { formatCents, formatDeltaCents } from '@/lib/money';
import { setBulkAvailable, setItemAvailable, setOptionAvailable } from '../actions';

export const metadata = { title: 'Availability — Firebird Kitchen' };

// Never prerendered: this screen IS the live state of the kitchen's stock.
export const dynamic = 'force-dynamic';

// How many item names fit on a phone row before the list stops being readable
// at arm's length. Above this the row shows the first few AND the count of
// what it left out — never a bare "shared", which is the thing the cook
// already knows and cannot act on.
const MAX_NAMED_ITEMS = 4;

/** The one wording of reach, shared by a single row and by the batch preview.
 *  Two copies would eventually disagree about what a tap costs. */
function usedOnLine(usedOn: string[]): string {
  if (usedOn.length === 0) return 'Not used on any item.';
  const named = usedOn.slice(0, MAX_NAMED_ITEMS).join(', ');
  const rest = usedOn.length - MAX_NAMED_ITEMS;
  return `Used on: ${named}${rest > 0 ? ` +${rest} more` : ''}`;
}

/** One row: what it is, what it costs, who it stops, and the tap that flips it. */
function Row({
  name,
  price,
  available,
  usedOn,
  selected,
  selectHref,
  action,
}: {
  name: string;
  price: string;
  available: boolean;
  usedOn?: string[];
  selected: boolean;
  selectHref: string;
  action: () => Promise<void>;
}) {
  return (
    <li
      className={`flex flex-wrap items-center justify-between gap-3 rounded-lg border-2 p-3 ${
        selected ? 'border-blue-700 bg-blue-50' : available ? 'border-neutral-300' : 'border-red-500 bg-red-50'
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

      <span className="flex flex-wrap items-center gap-2">
        {/* A link, not a checkbox: one tap is one navigation, the selection is
            already in the URL, and there is no second submit to reach for at
            the top of a page a cook has scrolled down. It also means picking a
            row immediately redraws the batch preview above — the blast radius
            grows in front of them rather than after the last tap. */}
        <Link
          href={selectHref}
          className={`flex min-h-12 items-center rounded-lg border-2 px-4 text-lg font-semibold ${
            selected ? 'border-blue-700 bg-blue-700 text-white' : 'border-neutral-400'
          }`}
        >
          {selected ? 'Selected' : 'Select'}
          <span className="sr-only"> {name}</span>
        </Link>

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
      </span>

      {/* Full-width, so it wraps under the name and the tap target rather than
          squeezing either. `basis-full` inside the wrapping flex row. */}
      {usedOn && <p className="basis-full text-lg text-neutral-700">{usedOnLine(usedOn)}</p>}
    </li>
  );
}

export default async function AvailabilityPage({
  searchParams,
}: {
  searchParams: Promise<{
    q?: string;
    item?: string | string[];
    opt?: string | string[];
    done?: string;
  }>;
}) {
  const menu = await loadMenu();
  const items = Object.values(menu.items);
  const params = await searchParams;

  const query = params.q ?? '';
  const searching = query.trim() !== '';
  const shown = searchMenu(menu, query);

  // A repeated query param arrives as a string when there is one of it, which
  // is the single-row case and the one it would be easiest to get wrong.
  const readIds = (value?: string | string[]) =>
    value === undefined ? [] : Array.isArray(value) ? value : [value];
  const pickedItemIds = readIds(params.item);
  const pickedOptionIds = readIds(params.opt);
  const selectedItems = new Set(pickedItemIds);
  const selectedOptions = new Set(pickedOptionIds);

  // Resolved against the live menu, so ids that no longer exist drop out of
  // the preview AND out of every link built below. A selection cannot rot.
  const picked = selectionReach(menu, selectedItems, selectedOptions);
  const pickedCount = picked.items.length + picked.options.length;
  // Set after a bulk write: 'off' marked sold out, 'on' put back on. The
  // selection the action redirected with is exactly the rows it flipped, so
  // the report and the undo below both name that and nothing wider.
  const done = params.done === 'off' ? 'off' : params.done === 'on' ? 'on' : null;

  // Rebuilt from the RESOLVED selection, not from the raw params: an id the
  // menu no longer has is dropped once, here, and every link below is clean.
  const liveItemIds = picked.items.map((row) => row.id);
  const liveOptionIds = picked.options.map((row) => row.id);

  /** Every link on this page is the whole board state, rebuilt. */
  const boardHref = (itemIds: string[], optionIds: string[], keepQuery = true) => {
    const next = new URLSearchParams();
    if (searching && keepQuery) next.set('q', query);
    for (const id of itemIds) next.append('item', id);
    for (const id of optionIds) next.append('opt', id);
    const qs = next.toString();
    return qs === '' ? '/kitchen/availability' : `/kitchen/availability?${qs}`;
  };

  const toggled = (ids: string[], id: string) =>
    ids.includes(id) ? ids.filter((other) => other !== id) : [...ids, id];

  /** The rows a "Select these N" link would ADD: on screen, and not already
   *  picked. One rule for both grains (C-112) — a category link and a station
   *  link that disagreed about what a filter hides would be two answers to the
   *  question this page exists to answer honestly. Selecting what a search is
   *  hiding is how a batch takes food off the menu nobody looked at. */
  const seedable = (rows: MenuItem[]) =>
    rows.filter((item) => shown.itemIds.has(item.id) && !selectedItems.has(item.id));

  // Only the stations this menu actually staffs, in the engine's order. A
  // station with nothing on screen renders nothing rather than a dead "0".
  const stations = STATIONS.map((station) => ({
    station,
    seeds: seedable(items.filter((item) => item.station === station)),
  })).filter((entry) => entry.seeds.length > 0);

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
          hit — and the result is a URL a second screen can be opened on.

          The selection rides through it as hidden inputs, so searching again
          narrows the board without dropping rows already picked. */}
      <form className="mt-4 flex flex-wrap gap-2">
        {liveItemIds.map((id) => (
          <input key={id} type="hidden" name="item" value={id} />
        ))}
        {liveOptionIds.map((id) => (
          <input key={id} type="hidden" name="opt" value={id} />
        ))}
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
            href={boardHref(liveItemIds, liveOptionIds, false)}
            className="mt-6 flex min-h-12 items-center rounded-lg px-4 underline underline-offset-4"
          >
            Show all
          </Link>
        )}
      </form>

      {/* The stations (P1-3, C-112). A row of links, not a filter and not a
          second kill: each one ADDS its items to the selection below, so the
          fryer going down is one tap and then one look at what that costs.
          They cut ACROSS the categories underneath on purpose — that crossing
          is the whole reason this row exists rather than a category tap. */}
      {stations.length > 0 && (
        <section aria-label="Stations" className="mt-4">
          <h2 className="text-sm font-medium">Select a whole station</h2>
          <ul className="mt-2 flex flex-wrap gap-2">
            {stations.map(({ station, seeds }) => (
              <li key={station}>
                <Link
                  href={boardHref(
                    [...liveItemIds, ...seeds.map((item) => item.id)],
                    liveOptionIds,
                  )}
                  className="flex min-h-12 items-center rounded-lg border-2 border-neutral-400 px-4 text-lg font-semibold"
                >
                  {STATION_LABELS[station]}
                  <span className="ml-2 font-normal text-neutral-600 tabular-nums">
                    {seeds.length}
                  </span>
                  <span className="sr-only"> items — select them</span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* The batch (P0-3). It names every item and option it will affect
          BEFORE it applies — the same courtesy C-107 gave a single row, at the
          size where it matters more — and after it applies the same panel is
          the report and the undo. */}
      {pickedCount > 0 && (
        <section
          aria-label="Selection"
          className="mt-4 rounded-lg border-2 border-blue-700 bg-blue-50 p-4"
        >
          <h2 className="text-xl font-semibold">
            {done === 'off'
              ? `Marked ${pickedCount} sold out.`
              : done === 'on'
                ? `Put ${pickedCount} back on.`
                : `${pickedCount} selected. This will stop:`}
          </h2>
          <ul className="mt-2 flex flex-col gap-1 text-lg">
            {picked.items.map((row) => (
              <li key={row.id}>
                {row.name}
                {!row.available && <span className="font-semibold text-red-700"> — sold out</span>}
              </li>
            ))}
            {picked.options.map((row) => (
              <li key={row.id}>
                {row.name}
                {!row.available && <span className="font-semibold text-red-700"> — sold out</span>}
                {/* FULL reach, never the visible subset: an option stops the
                    items it stops whether or not a filter is showing them. */}
                <span className="block text-neutral-700">{usedOnLine(row.usedOn)}</span>
              </li>
            ))}
          </ul>

          <form action={setBulkAvailable} className="mt-3 flex flex-wrap gap-2">
            <input type="hidden" name="q" value={query} />
            {liveItemIds.map((id) => (
              <input key={id} type="hidden" name="item" value={id} />
            ))}
            {liveOptionIds.map((id) => (
              <input key={id} type="hidden" name="opt" value={id} />
            ))}
            <button
              type="submit"
              name="available"
              value="false"
              className="min-h-12 rounded-lg bg-red-700 px-5 text-lg font-bold text-white"
            >
              Mark all {pickedCount} sold out
            </button>
            <button
              type="submit"
              name="available"
              value="true"
              className="min-h-12 rounded-lg bg-green-800 px-5 text-lg font-bold text-white"
            >
              Put all {pickedCount} back on
            </button>
            <Link
              href={boardHref([], [])}
              className="flex min-h-12 items-center rounded-lg px-4 text-lg underline underline-offset-4"
            >
              Clear selection
            </Link>
          </form>
        </section>
      )}

      {/* A batch that flipped nothing is not a batch that failed, and silence
          here would read as one. */}
      {pickedCount === 0 && done !== null && (
        <p className="mt-4 text-lg font-semibold">
          Nothing changed — those rows were already{' '}
          {done === 'off' ? 'sold out' : 'on the menu'}.
        </p>
      )}

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
        const unpicked = seedable(inCategory);
        return (
          <section key={category.id} className="mt-8">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-xl font-semibold">{category.name}</h2>
              {/* Seeds a selection; it does not kill anything. Same `seedable`
                  rule as the station row above — one answer to "what would
                  this add", for both grains. */}
              {unpicked.length > 0 && (
                <Link
                  href={boardHref(
                    [...liveItemIds, ...unpicked.map((item) => item.id)],
                    liveOptionIds,
                  )}
                  className="flex min-h-12 items-center rounded-lg border-2 border-neutral-400 px-4 text-lg font-semibold"
                >
                  Select these {unpicked.length}
                  <span className="sr-only"> in {category.name}</span>
                </Link>
              )}
            </div>
            <ul className="mt-3 flex flex-col gap-2">
              {inCategory.map((item) => (
                <Row
                  key={item.id}
                  name={item.name}
                  price={formatCents(item.basePriceCents)}
                  available={item.available}
                  selected={selectedItems.has(item.id)}
                  selectHref={boardHref(toggled(liveItemIds, item.id), liveOptionIds)}
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
                  selected={selectedOptions.has(option.id)}
                  selectHref={boardHref(liveItemIds, toggled(liveOptionIds, option.id))}
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
