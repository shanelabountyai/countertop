'use client';

// The item composer (P0-1, P0-2 display side).
//
// Every rule on this screen — what is required, what is sold out, what it
// costs — is answered by the SAME functions the cart and placement call
// (`validateComposition`, `priceLine`). Not a client-side reimplementation of
// them: a second answer here is a screen that lets a customer compose
// something checkout will refuse, or quotes a price the server disagrees with.
//
// The price shown is display-only. `addToCart` sends the COMPOSITION and the
// server prices it again from the live menu.
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useRef, useState, useTransition } from 'react';
import {
  DEFAULT_LIMITS,
  daypartClosure,
  validateComposition,
  type Composition,
  type Intensity,
  type Menu,
  type ModifierGroup,
  type OptionSelection,
} from '@countertop/core/menu';
import type { RestaurantClock } from '@countertop/core/orders';
import { appliedDeltaCents, priceLine } from '@countertop/core/pricing';
import { addToCart, updateCartLine } from '@/app/cart/actions';
import { formatCents, formatDeltaCents } from '@/lib/money';

/** What a customer can say about one option. `null` is "not selected at all". */
type Choice = null | 'plain' | Intensity;

function choose(
  selections: OptionSelection[],
  group: ModifierGroup,
  optionId: string,
  choice: Choice,
): OptionSelection[] {
  // A single-select group replaces its whole selection; a multi-select one
  // only replaces the option that was touched.
  const kept = selections.filter((selection) =>
    selection.groupId !== group.id
      ? true
      : group.max === 1
        ? false
        : selection.optionId !== optionId,
  );
  if (choice === null) return kept;
  return [
    ...kept,
    choice === 'plain'
      ? { groupId: group.id, optionId }
      : { groupId: group.id, optionId, intensity: choice },
  ];
}

function choiceOf(selections: OptionSelection[], groupId: string, optionId: string): Choice {
  const found = selections.find((s) => s.groupId === groupId && s.optionId === optionId);
  if (!found) return null;
  return found.intensity ?? 'plain';
}

/** One intensity radiogroup's identity — a group can appear on several
 *  options (P0-5), so "touched" has to be tracked per option, not per group. */
const rowKey = (groupId: string, optionId: string): string => `${groupId}:${optionId}`;

/** "Required · choose 1", "Choose up to 3", "Choose 2–4". */
function groupHint(group: ModifierGroup): string {
  if (group.min === 0) return group.max === 1 ? 'Optional · choose 1' : `Choose up to ${group.max}`;
  if (group.min === group.max) return `Required · choose ${group.min}`;
  return `Required · choose ${group.min}–${group.max}`;
}

const INTENSITY_CHOICES: { value: Intensity | ''; label: (name: string) => string }[] = [
  { value: '', label: () => 'Skip' },
  // The negation is a real selection that reaches the kitchen, not the absence
  // of one — the phone-transcription bug this product exists to kill.
  { value: 'none', label: (name) => `No ${name.toLowerCase()}` },
  { value: 'light', label: () => 'Light' },
  { value: 'regular', label: () => 'Regular' },
  { value: 'extra', label: () => 'Extra' },
];

/** The cart line this composer was opened on, if it was opened on one (C-021).
 *  Resolved server-side from the cart cookie — the composition is never taken
 *  off the URL. */
export type EditingLine = { lineId: string; composition: Composition };

export function Composer({
  menu,
  itemId,
  clock,
  editing,
}: {
  menu: Menu;
  itemId: string;
  /** The restaurant's wall clock at server-render time (P1-1). A prop, not a
   *  `new Date()` here: this screen is a preview of the server's answer, and
   *  the browser's clock is neither the restaurant's nor trustworthy. */
  clock: RestaurantClock;
  editing?: EditingLine;
}) {
  const item = menu.items[itemId]!;
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  // Pre-filled from the line when editing. `useState`'s initial value, not an
  // effect: the first render is already correct, so the screen never shows an
  // empty composer and then fills itself in under someone's thumb.
  const [selections, setSelections] = useState<OptionSelection[]>(
    editing ? [...editing.composition.selections] : [],
  );
  const [quantity, setQuantity] = useState(editing?.composition.quantity ?? 1);
  const [note, setNote] = useState(editing?.composition.note ?? '');
  // Requirements are shown as hints from the start; the red text only appears
  // once someone has actually tried to add. Nagging before the first tap is
  // how a form teaches people to ignore its errors.
  const [attempted, setAttempted] = useState(false);
  const [serverErrors, setServerErrors] = useState<string[]>([]);
  // P0-5. `choice === null` is both "never touched" and "deliberately chose
  // Skip" — `choose()` stores a negation the same way it stores nothing at
  // all. Rendering has to tell those apart even though the data doesn't, so a
  // row is only allowed to show a filled pill once THIS composer has touched
  // it. Seeded from the editing line, if there is one: a real prior choice
  // ("no onions") is not untouched just because this screen just mounted.
  const [touchedRows, setTouchedRows] = useState<Set<string>>(
    () => new Set((editing?.composition.selections ?? []).map((s) => rowKey(s.groupId, s.optionId))),
  );
  // P0-6. Fieldsets, keyed by group id, so a failed submit can move focus to
  // the first one with a violation rather than leaving the customer to find
  // it — `tabIndex={-1}` below is what makes a `<fieldset>` a valid target.
  const fieldsetRefs = useRef<Record<string, HTMLFieldSetElement | null>>({});

  const composition: Composition = {
    itemId,
    quantity,
    selections,
    ...(note === '' ? {} : { note }),
  };
  const validity = validateComposition(menu, composition, clock);
  const violations = validity.ok ? [] : validity.violations;
  const priced = priceLine(menu, composition);

  function messagesFor(groupId: string): string[] {
    return violations
      .filter((violation) => 'groupId' in violation && violation.groupId === groupId)
      .map((violation) => violation.message);
  }
  const generalMessages = violations
    .filter((violation) => !('groupId' in violation))
    .map((violation) => violation.message);
  // P0-6. The bottom summary named "the choices above" and nothing else — a
  // customer who tried once, got refused, and could not tell which of five
  // fieldsets was the problem. This is the SAME violation `submit()` sends
  // focus to, so the sentence and the landing spot always agree.
  const firstGroupViolation = violations.find(
    (violation) => 'groupId' in violation && item.modifierGroupIds.includes(violation.groupId),
  ) as { groupId: string; message: string } | undefined;
  // The GROUP's name, not its violation's own sentence — reusing that
  // sentence verbatim put "Choose your protein." on the page twice (once
  // inside the fieldset, once down here), which broke every existing
  // `getByText` locator for it, exact text being how Playwright tells one
  // occurrence from two. A distinct sentence naming the same group satisfies
  // "names the group" without colliding with the fieldset's own message.
  const firstViolatingGroupName = firstGroupViolation
    ? menu.groups[firstGroupViolation.groupId]?.name
    : undefined;

  function submit() {
    setAttempted(true);
    setServerErrors([]);
    if (!validity.ok) {
      // The SAME violation the bottom summary names — computed once, above,
      // not the first violation overall, which could be a quantity or note
      // problem with no fieldset to send anyone to.
      fieldsetRefs.current[firstGroupViolation?.groupId ?? '']?.focus();
      return;
    }

    startTransition(async () => {
      // `replaceLine` keeps the line where it was in the cart. Remove-then-add
      // would send it to the bottom, which is a different cart than the one
      // the customer was looking at.
      const result = editing
        ? await updateCartLine(editing.lineId, composition)
        : await addToCart(composition);
      if (result.ok) router.push('/cart');
      else setServerErrors(result.errors.map((error) => error.message));
    });
  }

  return (
    <main className="mx-auto max-w-2xl p-6">
      <Link
        href={editing ? '/cart' : '/menu'}
        className="inline-flex min-h-12 w-fit items-center text-sm underline underline-offset-4"
      >
        {editing ? '← Cart' : '← Menu'}
      </Link>

      <h1 className="mt-4 text-3xl font-semibold">{item.name}</h1>
      {/* P0-4, the second and last live-menu surface this appears on. Above
          the price, because someone who opened this screen is deciding what
          the food is before deciding whether to pay for it. */}
      {item.description !== undefined && (
        <p className="mt-2 text-neutral-700">{item.description}</p>
      )}
      <p className="mt-1 text-neutral-600">{formatCents(item.basePriceCents)}</p>
      {/* An 86 first, then the schedule, and never both — the same precedence
          `validateComposition` applies, because it is the same two facts
          (P1-1). "Sold out" on something that is merely out of its window
          would be a lie about the kitchen, and the schedule on something that
          is sold out would be a promise the kitchen has not made. */}
      {!item.available ? (
        <p className="mt-2 font-medium text-red-700">Sold out — the kitchen has run out.</p>
      ) : (
        daypartClosure(item, clock) && (
          <p className="mt-2 font-medium text-red-700">{daypartClosure(item, clock)!.message}</p>
        )
      )}

      {item.modifierGroupIds.map((groupId) => {
        const group = menu.groups[groupId];
        if (!group) return null;
        const messages = attempted ? messagesFor(groupId) : [];

        return (
          <fieldset
            key={group.id}
            ref={(el) => {
              fieldsetRefs.current[group.id] = el;
            }}
            // Focusable only programmatically (P0-6) — a fieldset is not
            // normally a tab stop, and it should not become one for a
            // keyboard user who has not failed a submit.
            tabIndex={-1}
            aria-describedby={messages.length > 0 ? `group-error-${group.id}` : undefined}
            className="mt-8 rounded-lg focus:outline-none focus:ring-2 focus:ring-red-700 focus:ring-offset-2"
          >
            <legend className="text-lg font-semibold">{group.name}</legend>
            <p className="text-sm text-neutral-600">{groupHint(group)}</p>
            {messages.length > 0 && (
              // ONE id for the group's messages, not one per message: the
              // fieldset's `aria-describedby` above needs a single target,
              // and a screen reader landing on the fieldset reads the legend
              // then every paragraph inside this div as its description.
              <div id={`group-error-${group.id}`}>
                {messages.map((message) => (
                  <p key={message} className="mt-1 text-sm font-medium text-red-700">
                    {message}
                  </p>
                ))}
              </div>
            )}

            <ul className="mt-3 flex flex-col gap-2">
              {group.options.map((option) => {
                const choice = choiceOf(selections, group.id, option.id);
                const touched = touchedRows.has(rowKey(group.id, option.id));
                const negated = choice === 'none';
                // The MENU's delta until it is selected, the APPLIED one after:
                // a negated option costs nothing, and showing "+$0.50" beside a
                // struck-through "Cheese" is a price the receipt will disagree
                // with.
                const deltaCents =
                  choice === null
                    ? option.priceDeltaCents
                    : appliedDeltaCents(group, option, choice === 'plain' ? undefined : choice);
                const soldOut = !option.available;

                const name = (
                  <>
                    <span className={negated ? 'font-medium text-red-800 line-through' : 'font-medium'}>
                      {option.name}
                    </span>
                    {soldOut && <span className="text-neutral-500"> — Sold out</span>}
                    <span className="ml-auto tabular-nums text-neutral-600">
                      {formatDeltaCents(deltaCents)}
                    </span>
                  </>
                );

                return (
                  <li
                    key={option.id}
                    className={`rounded-lg border ${negated ? 'border-red-300 bg-red-50' : 'border-neutral-300'}`}
                  >
                    {group.intensityEnabled ? (
                      <>
                        <p className="flex items-center gap-2 px-4 pt-3">{name}</p>
                        <div
                          role="radiogroup"
                          aria-label={option.name}
                          className="flex flex-wrap gap-1 px-4 pb-3 pt-2"
                        >
                          {INTENSITY_CHOICES.map(({ value, label }) => (
                            // The radio itself is visually hidden — the pill
                            // IS the control — so the label has to carry the
                            // focus ring, or a keyboard user tabs through this
                            // group with nothing on screen moving.
                            <label
                              key={value}
                              className={`flex min-h-12 cursor-pointer items-center rounded-md border px-3 has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-neutral-900 has-[:focus-visible]:ring-offset-2 ${
                                // P0-5: filled only once TOUCHED, never on the
                                // strength of `choice === null` alone — that is
                                // also what a fresh, unanswered row looks like.
                                touched && (value === '' ? null : value) === choice
                                  ? 'border-neutral-900 bg-neutral-900 text-white'
                                  : 'border-neutral-300'
                              }`}
                            >
                              <input
                                type="radio"
                                className="sr-only"
                                name={`${group.id}:${option.id}`}
                                // P0-5, and not styling-only: without `touched`
                                // here, Skip's `checked` was TRUE the instant
                                // the row rendered untouched (`null === null`),
                                // which is a real accessibility defect — a
                                // screen reader announcing "Skip, checked" for
                                // a choice nobody made, not merely a filled
                                // pill nobody tapped.
                                checked={touched && (value === '' ? null : value) === choice}
                                // "No onions" stays available when the kitchen
                                // is out of onions — asking for none of a thing
                                // there is none of is trivially satisfiable.
                                disabled={soldOut && value !== '' && value !== 'none'}
                                onChange={() => {
                                  setSelections((current) =>
                                    choose(current, group, option.id, value === '' ? null : value),
                                  );
                                  setTouchedRows((current) =>
                                    current.has(rowKey(group.id, option.id))
                                      ? current
                                      : new Set(current).add(rowKey(group.id, option.id)),
                                  );
                                }}
                              />
                              {label(option.name)}
                              {value === 'extra' && option.extraPriceDeltaCents
                                ? ` ${formatDeltaCents(option.extraPriceDeltaCents)}`
                                : ''}
                            </label>
                          ))}
                        </div>
                        {/* P0-5's second bullet: the absence of a choice is
                            STATED, not left to be inferred from every pill
                            looking the same as an unclicked one. */}
                        {!touched && (
                          <p className="px-4 pb-3 text-xs text-neutral-500">No choice made yet</p>
                        )}
                      </>
                    ) : (
                      <label className="flex min-h-12 cursor-pointer items-center gap-3 px-4 py-3">
                        <input
                          type={group.max === 1 ? 'radio' : 'checkbox'}
                          name={group.max === 1 ? group.id : `${group.id}:${option.id}`}
                          className="size-5 shrink-0"
                          checked={choice !== null}
                          disabled={soldOut}
                          onChange={(event) =>
                            setSelections((current) =>
                              choose(current, group, option.id, event.target.checked ? 'plain' : null),
                            )
                          }
                        />
                        {name}
                      </label>
                    )}
                  </li>
                );
              })}
            </ul>
          </fieldset>
        );
      })}

      <div className="mt-8 flex flex-col gap-4">
        <label className="flex items-center gap-3">
          <span className="font-medium">Quantity</span>
          <input
            type="number"
            min={1}
            max={DEFAULT_LIMITS.maxQuantity}
            value={quantity}
            onChange={(event) => {
              // Clamped here, not just left to `validateComposition`: an
              // unclamped 0/negative/huge quantity still flows into `priceLine`
              // for the live preview below, which would show a nonsensical
              // total (e.g. a negative price) before the customer ever taps
              // submit. min/max above are HTML hints only — typed input isn't
              // clamped by the browser.
              const value = Number(event.target.value);
              if (!Number.isInteger(value)) return;
              setQuantity(Math.min(Math.max(value, 1), DEFAULT_LIMITS.maxQuantity));
            }}
            className="min-h-12 w-24 rounded-md border border-neutral-300 px-3"
          />
        </label>

        <label className="flex flex-col gap-1">
          <span className="font-medium">Special instructions</span>
          <textarea
            value={note}
            maxLength={DEFAULT_LIMITS.maxNoteLength}
            onChange={(event) => setNote(event.target.value)}
            className="rounded-md border border-neutral-300 p-3"
            rows={2}
          />
          <span className="text-sm text-neutral-600">
            {note.length}/{DEFAULT_LIMITS.maxNoteLength}
          </span>
        </label>
      </div>

      {/* Live, and display-only: the server prices this composition again. */}
      <div aria-live="polite" className="mt-8">
        {attempted &&
          generalMessages.map((message) => (
            <p key={message} className="text-sm font-medium text-red-700">
              {message}
            </p>
          ))}
        {serverErrors.map((message) => (
          <p key={message} className="text-sm font-medium text-red-700">
            {message}
          </p>
        ))}
        {/* P0-6: names the group ("Fix Protein…"), not "the choices
            above" — and the SAME group `submit()` sent focus to, so the
            sentence and the landing spot never disagree. Rendered ONLY when a
            group violation exists: an item-level refusal (sold out, outside
            its window) has no fieldset to point at and is already stated
            above, by `generalMessages` and by the dedicated banner near the
            item name. */}
        {attempted && firstViolatingGroupName && (
          <p className="text-sm font-medium text-red-700">
            Fix {firstViolatingGroupName} before{' '}
            {editing ? 'saving this line' : 'adding this to your cart'}.
          </p>
        )}
      </div>

      <button
        type="button"
        onClick={submit}
        disabled={pending}
        className="mt-4 min-h-14 w-full rounded-lg bg-neutral-900 px-6 text-lg font-semibold text-white disabled:opacity-60"
      >
        {editing ? 'Save changes' : 'Add to cart'} ·{' '}
        <span data-testid="line-total">{formatCents(priced.lineTotalCents)}</span>
      </button>
    </main>
  );
}
