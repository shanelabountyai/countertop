// Safe menu editing (P0-13).
//
// THE DEVICE IS A PHONE. This screen gets used one-handed, between rushes, by
// someone standing at a prep table — so every row stacks rather than scrolls
// sideways, every control clears 48px, and nothing hides behind a hover.
//
// THE TWO GUARDS, and why neither is a dialog:
//
//   1. A price edit confirms first, showing old → new. The $1.50 → $15.00
//      fat-finger is a perfectly VALID price, so no parser can catch it; the
//      only defence is showing the manager the number they are about to
//      publish beside the one they are replacing.
//   2. Editing or deleting a modifier group names every item that shares it.
//      One "Salsa" group serves the burrito and the bowl — that reuse is the
//      point of P0-1, and it is also how a two-second edit silently changes an
//      item nobody was looking at.
//
// The confirm step is a URL (`?edit=…`), not client state. It survives a
// reload, works before hydration, and cannot get out of step with the row it
// came from — the panel re-reads the CURRENT price from the database on every
// render, so a confirm screen left open through someone else's edit shows the
// real old value rather than a stale one captured at click time.
import Link from 'next/link';
import { parsePriceInput, type Menu } from '@countertop/core';
import { loadMenu } from '@countertop/db/menu';
import { formatCents, formatDeltaCents } from '@/lib/money';
import {
  deleteGroup,
  saveExtraSurcharge,
  saveGroup,
  saveItemPrice,
  saveOptionPrice,
} from './actions';

export const metadata = { title: 'Edit menu — Firebird Kitchen' };

// Never prerendered: this screen edits the live menu, and the confirm panel
// reads the current value at render time.
export const dynamic = 'force-dynamic';

type Params = {
  edit?: string;
  price?: string;
  name?: string;
  min?: string;
  max?: string;
  saved?: string;
  error?: string;
};

/** Items that would feel a change to this group, in menu order. This is the
 *  whole content of the shared-group warning, and it is derived from the same
 *  `loadMenu` every other surface reads — never a second, drifting query. */
function itemsUsing(menu: Menu, groupId: string): string[] {
  return Object.values(menu.items)
    .filter((item) => item.modifierGroupIds.includes(groupId))
    .map((item) => item.name);
}

const dollars = (cents: number) => (cents / 100).toFixed(2);

export default async function MenuEditorPage({
  searchParams,
}: {
  searchParams: Promise<Params>;
}) {
  const params = await searchParams;
  const menu = await loadMenu();
  const items = Object.values(menu.items);
  const groups = Object.values(menu.groups);

  // "item:<id>" → ["item", "<id>"]. Split on the FIRST colon only; an id is
  // opaque and gets to contain whatever it contains.
  const edit = params.edit ?? '';
  const colon = edit.indexOf(':');
  const kind = colon === -1 ? '' : edit.slice(0, colon);
  const id = colon === -1 ? '' : edit.slice(colon + 1);

  // ---- the confirm step -------------------------------------------------

  // The "extra" surcharge has its own panel: it is the only price on this
  // screen that can be BLANK, and blank means something ("extra is free")
  // rather than being a value nobody typed (C-027).
  if (kind === 'extra') {
    const option = groups.flatMap((group) => group.options).find((o) => o.id === id);
    if (!option) return <Rejected message="That option no longer exists." />;

    const raw = (params.price ?? '').trim();
    const toCents = raw === '' ? null : parsePriceInput(raw);
    if (raw !== '' && (toCents === null || toCents < 0)) {
      return (
        <Rejected message="An extra surcharge is never negative. Type it like 0.75, or leave it blank to make extra free." />
      );
    }
    const fromCents = option.extraPriceDeltaCents ?? null;
    const surcharge = (cents: number | null) => (cents === null ? 'free' : formatCents(cents));

    return (
      <Confirm
        title={`Change what "extra ${option.name.toLowerCase()}" costs?`}
        action={saveExtraSurcharge.bind(null, option.id, raw, fromCents)}
        submitLabel={`Save extra surcharge for ${option.name}`}
      >
        <p className="mt-6 flex flex-wrap items-baseline gap-3 text-3xl font-bold tabular-nums">
          <span className="text-neutral-500 line-through">{surcharge(fromCents)}</span>
          <span aria-hidden>→</span>
          <span>{surcharge(toCents)}</span>
        </p>
        <p className="mt-2 text-lg text-neutral-700">
          Was {surcharge(fromCents)}, will be {surcharge(toCents)}. This is added ON TOP of{' '}
          {formatDeltaCents(option.priceDeltaCents) || '$0.00'} when a customer picks extra.
        </p>
      </Confirm>
    );
  }

  if (kind === 'item' || kind === 'option') {
    const target =
      kind === 'item'
        ? menu.items[id]
        : groups.flatMap((group) => group.options).find((option) => option.id === id);
    const fromCents =
      target && ('basePriceCents' in target ? target.basePriceCents : target.priceDeltaCents);
    const toCents = parsePriceInput(params.price ?? '');

    // A price that will not parse, or a negative one on an ITEM, never reaches
    // a confirm panel — there is nothing to confirm, only something to retype.
    if (!target || fromCents === undefined || toCents === null || (kind === 'item' && toCents < 0)) {
      return <Rejected message="That is not a price. Type it like 12.50 and try again." />;
    }

    const format = kind === 'item' ? formatCents : (c: number) => formatDeltaCents(c) || '$0.00';
    return (
      <Confirm
        title={`Change the price of ${target.name}?`}
        action={
          kind === 'item'
            ? saveItemPrice.bind(null, target.id, params.price ?? '', fromCents)
            : saveOptionPrice.bind(null, target.id, params.price ?? '', fromCents)
        }
        submitLabel={`Save new price for ${target.name}`}
      >
        {/* Old → new, side by side and large. This IS the guard. */}
        <p className="mt-6 flex flex-wrap items-baseline gap-3 text-3xl font-bold tabular-nums">
          <span className="text-neutral-500 line-through">{format(fromCents)}</span>
          <span aria-hidden>→</span>
          <span>{format(toCents)}</span>
        </p>
        <p className="mt-2 text-lg text-neutral-700">
          Was {format(fromCents)}, will be {format(toCents)}.
        </p>
        {toCents === fromCents && (
          <p className="mt-2 text-lg text-neutral-700">That is the price it is already.</p>
        )}
      </Confirm>
    );
  }

  if (kind === 'group' || kind === 'delete-group') {
    const group = menu.groups[id];
    if (!group) return <Rejected message="That modifier group no longer exists." />;
    const affected = itemsUsing(menu, group.id);
    const deleting = kind === 'delete-group';
    const min = Number(params.min);
    const max = Number(params.max);
    const name = (params.name ?? '').trim();

    // Only the MIN is bounded by the option count: a min nobody can reach makes
    // the item unorderable, while a max above it is harmless slack.
    if (
      !deleting &&
      (name === '' ||
        !Number.isInteger(min) ||
        !Number.isInteger(max) ||
        max < min ||
        max < 1 ||
        min > group.options.length)
    ) {
      return (
        <Rejected
          message={`Choose a name, a "choose at least" no higher than ${group.options.length}, and a "choose at most" that is not below it.`}
        />
      );
    }

    return (
      <Confirm
        title={deleting ? `Delete ${group.name}?` : `Change ${group.name}?`}
        action={
          deleting
            ? deleteGroup.bind(null, group.id)
            : saveGroup.bind(null, group.id, name, params.min ?? '', params.max ?? '', {
                name: group.name,
                min: group.min,
                max: group.max,
              })
        }
        submitLabel={deleting ? `Delete ${group.name} and remove it from the menu` : `Save changes to ${group.name}`}
        destructive={deleting}
      >
        {deleting ? (
          <p className="mt-6 text-lg">
            {group.options.length} option{group.options.length === 1 ? '' : 's'} go with it:{' '}
            {group.options.map((option) => option.name).join(', ')}.
          </p>
        ) : (
          <dl className="mt-6 text-lg">
            <Change label="Name" from={group.name} to={name} />
            <Change label="Choose at least" from={String(group.min)} to={String(min)} />
            <Change label="Choose at most" from={String(group.max)} to={String(max)} />
            {group.min === 0 && min > 0 && (
              <p className="mt-3 font-semibold">
                This makes the group REQUIRED — every item below will refuse to be ordered without
                a choice from it.
              </p>
            )}
          </dl>
        )}

        {/* The shared-group warning. Always the full list, never a count: the
            manager has to recognise the item they had forgotten about. */}
        <div
          className={`mt-6 rounded-lg border-2 p-4 ${
            affected.length > 1 ? 'border-amber-600 bg-amber-50' : 'border-neutral-300'
          }`}
        >
          <p className="text-lg font-semibold">
            {affected.length === 0
              ? 'No items use this group.'
              : affected.length === 1
                ? `Affects 1 item: ${affected[0]}.`
                : `Shared — affects ${affected.length} items:`}
          </p>
          {affected.length > 1 && (
            <ul className="mt-2 list-disc pl-6 text-lg">
              {affected.map((itemName) => (
                <li key={itemName}>{itemName}</li>
              ))}
            </ul>
          )}
        </div>
      </Confirm>
    );
  }

  // ---- the list ---------------------------------------------------------

  return (
    <main className="mx-auto max-w-3xl p-4 sm:p-6">
      <Link href="/kitchen" className="text-lg underline underline-offset-4">
        ← Kitchen queue
      </Link>
      <h1 className="mt-4 text-3xl font-semibold">Edit menu</h1>
      <p className="mt-1 text-lg text-neutral-700">
        Every change is shown to you before it is saved. Orders already placed never change — they
        keep the prices they were placed at.
      </p>

      {params.saved && (
        <p role="status" className="mt-4 rounded-lg border-2 border-green-700 bg-green-50 p-3 text-lg font-semibold">
          Saved — {params.saved}
        </p>
      )}
      {params.error && (
        <p
          role="alert"
          data-testid="menu-error"
          className="mt-4 rounded-lg border-2 border-red-600 bg-red-50 p-3 text-lg font-semibold"
        >
          {params.error === '1'
            ? 'That change was not saved. Check the value and try again.'
            : params.error}
        </p>
      )}

      {menu.categories.map((category) => (
        <section key={category.id} className="mt-8">
          <h2 className="text-xl font-semibold">{category.name}</h2>
          <ul className="mt-3 flex flex-col gap-3">
            {items
              .filter((item) => item.categoryId === category.id)
              .map((item) => (
                <li key={item.id} className="rounded-lg border-2 border-neutral-300 p-3">
                  <PriceForm
                    editValue={`item:${item.id}`}
                    name={item.name}
                    defaultPrice={dollars(item.basePriceCents)}
                  />
                </li>
              ))}
          </ul>
        </section>
      ))}

      <h2 className="mt-10 text-2xl font-semibold">Modifier groups</h2>
      <p className="mt-1 text-lg text-neutral-700">
        One group can serve several items. Changing or deleting a shared group is confirmed against
        the list of items it touches.
      </p>

      {groups.map((group) => {
        const affected = itemsUsing(menu, group.id);
        return (
          <section key={group.id} className="mt-6 rounded-lg border-2 border-neutral-300 p-3">
            {/* One form, two submit buttons: the button's own name/value picks
                which confirm panel opens. No nested forms, no JavaScript. */}
            <form method="get" action="/kitchen/menu" className="flex flex-col gap-3">
              <Field label={`Name of the ${group.name} group`} visible="Group name">
                <input
                  name="name"
                  defaultValue={group.name}
                  maxLength={60}
                  className="min-h-12 w-full rounded-lg border-2 border-neutral-400 px-3 text-lg"
                />
              </Field>
              <div className="flex flex-wrap gap-3">
                <Field label={`Choose at least, ${group.name}`} visible="Choose at least">
                  <input
                    name="min"
                    type="number"
                    min={0}
                    max={group.options.length}
                    defaultValue={group.min}
                    className="min-h-12 w-24 rounded-lg border-2 border-neutral-400 px-3 text-lg"
                  />
                </Field>
                <Field label={`Choose at most, ${group.name}`} visible="Choose at most">
                  <input
                    name="max"
                    type="number"
                    min={1}
                    max={20}
                    defaultValue={group.max}
                    className="min-h-12 w-24 rounded-lg border-2 border-neutral-400 px-3 text-lg"
                  />
                </Field>
              </div>
              <p className="text-base text-neutral-700">
                {affected.length === 0
                  ? 'Used by no items.'
                  : `Used by ${affected.length === 1 ? '1 item' : `${affected.length} items`}: ${affected.join(', ')}.`}
              </p>
              <div className="flex flex-wrap gap-3">
                <button
                  type="submit"
                  name="edit"
                  value={`group:${group.id}`}
                  className="min-h-12 flex-1 rounded-lg bg-neutral-900 px-5 text-lg font-bold text-white"
                >
                  Review changes to {group.name}
                </button>
                <button
                  type="submit"
                  name="edit"
                  value={`delete-group:${group.id}`}
                  className="min-h-12 rounded-lg border-2 border-red-700 px-5 text-lg font-bold text-red-700"
                >
                  Delete {group.name}
                </button>
              </div>
            </form>

            <ul className="mt-4 flex flex-col gap-3 border-t-2 border-neutral-200 pt-3">
              {group.options.map((option) => (
                <li key={option.id} className="flex flex-col gap-2">
                  <PriceForm
                    editValue={`option:${option.id}`}
                    name={option.name}
                    defaultPrice={dollars(option.priceDeltaCents)}
                  />
                  {/* Only inside an intensity group: an "extra" surcharge on a
                      group with no `extra` to choose is a price nothing can
                      ever apply (C-027). Blank means extra is free, which is
                      what most options are. */}
                  {group.intensityEnabled && (
                    <PriceForm
                      editValue={`extra:${option.id}`}
                      name={option.name}
                      what="Extra surcharge"
                      visible="+extra $"
                      defaultPrice={
                        option.extraPriceDeltaCents === undefined
                          ? ''
                          : dollars(option.extraPriceDeltaCents)
                      }
                    />
                  )}
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </main>
  );
}

// ---- pieces -------------------------------------------------------------

/** A price row: the current value, editable, and the button that opens the
 *  confirm panel. GET, because opening a confirm panel is a navigation.
 *
 *  `what` names which price this row is — an option has two, its delta and its
 *  "extra" surcharge (C-027) — and every accessible name on the row is built
 *  from it, so the two rows for one option are never ambiguous to a screen
 *  reader or to a test. */
function PriceForm({
  editValue,
  name,
  defaultPrice,
  what = 'Price',
  visible = '$',
}: {
  editValue: string;
  name: string;
  defaultPrice: string;
  what?: string;
  visible?: string;
}) {
  return (
    <form method="get" action="/kitchen/menu" className="flex flex-wrap items-end gap-3">
      <input type="hidden" name="edit" value={editValue} />
      <span className="w-full text-lg font-semibold sm:w-auto sm:flex-1">
        {what === 'Price' ? name : `${name} — extra`}
      </span>
      <Field label={`${what} for ${name}`} visible={visible}>
        <input
          name="price"
          inputMode="decimal"
          defaultValue={defaultPrice}
          className="min-h-12 w-28 rounded-lg border-2 border-neutral-400 px-3 text-lg tabular-nums"
        />
      </Field>
      <button
        type="submit"
        className="min-h-12 rounded-lg bg-neutral-900 px-5 text-lg font-bold text-white"
      >
        Review {what.toLowerCase()} for {name}
      </button>
    </form>
  );
}

/** A labelled input. The visible text is short enough for a phone; the
 *  accessible name is the one that says which row it belongs to. */
function Field({
  label,
  visible,
  children,
}: {
  label: string;
  visible: string;
  children: React.ReactNode;
}) {
  return (
    <label className="flex items-center gap-2 text-lg">
      <span aria-hidden className="font-semibold">
        {visible}
      </span>
      <span className="sr-only">{label}</span>
      {children}
    </label>
  );
}

function Change({ label, from, to }: { label: string; from: string; to: string }) {
  return (
    <div className={`flex flex-wrap gap-2 ${from === to ? 'text-neutral-500' : 'font-semibold'}`}>
      <dt>{label}:</dt>
      <dd>
        {from === to ? (
          <>{to} (unchanged)</>
        ) : (
          <>
            <span className="line-through">{from}</span> → {to}
          </>
        )}
      </dd>
    </div>
  );
}

/** The confirm panel, alone on the screen. Nothing else to tap by accident. */
function Confirm({
  title,
  action,
  submitLabel,
  destructive = false,
  children,
}: {
  title: string;
  action: () => Promise<void>;
  submitLabel: string;
  destructive?: boolean;
  children: React.ReactNode;
}) {
  return (
    <main className="mx-auto max-w-2xl p-4 sm:p-6">
      <h1 className="text-3xl font-semibold">{title}</h1>
      {children}
      <div className="mt-8 flex flex-col gap-3">
        <form action={action}>
          <button
            type="submit"
            className={`min-h-14 w-full rounded-lg px-5 text-xl font-bold text-white ${
              destructive ? 'bg-red-700' : 'bg-green-800'
            }`}
          >
            {submitLabel}
          </button>
        </form>
        {/* Cancel is a link, not a second submit: leaving without saving must
            never be one mis-tap away from saving. */}
        <Link
          href="/kitchen/menu"
          className="min-h-14 rounded-lg border-2 border-neutral-400 px-5 py-3 text-center text-xl font-bold"
        >
          Cancel
        </Link>
      </div>
    </main>
  );
}

function Rejected({ message }: { message: string }) {
  return (
    <main className="mx-auto max-w-2xl p-4 sm:p-6">
      <h1 className="text-3xl font-semibold">Nothing was changed</h1>
      <p role="alert" className="mt-4 text-lg">
        {message}
      </p>
      <Link
        href="/kitchen/menu"
        className="mt-8 block min-h-14 rounded-lg border-2 border-neutral-400 px-5 py-3 text-center text-xl font-bold"
      >
        Back to the menu
      </Link>
    </main>
  );
}
