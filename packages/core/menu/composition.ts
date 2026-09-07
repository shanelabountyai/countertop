// THE orderability function (CLAUDE.md, "One orderability function").
//
// "Can this composition be ordered right now?" has exactly one answer, given
// here. The menu view, cart validation, and placement all call this — three
// call sites, one answer. Grow a second one and they will disagree, quietly,
// in the direction of taking money for food that cannot be made.
//
// The daypart check (P1-1) lives in THIS file rather than beside it, and that
// is the point: an item that knows what time it is is a third input to the one
// answer, not a fourth call site with its own.
import { formatMinuteOfDay, type RestaurantClock } from '../orders/business-day';
import type { Composition, GroupId, Menu, MenuItem, OptionId } from './types';

/** Server-enforced caps (P0-3). Configurable; these are the defaults. */
export type CompositionLimits = {
  maxQuantity: number;
  maxNoteLength: number;
};

export const DEFAULT_LIMITS: CompositionLimits = {
  maxQuantity: 20,
  maxNoteLength: 140,
};

/**
 * Why a composition was refused. Carries the reason, not just the failure —
 * the UI needs to say "Choose your protein", and a test that only asserts
 * "invalid" would pass against a function refusing everything.
 */
export type CompositionViolation =
  | { kind: 'unknown_item'; message: string }
  | { kind: 'item_unavailable'; message: string }
  | { kind: 'item_outside_daypart'; message: string }
  | { kind: 'quantity_out_of_range'; quantity: number; maxQuantity: number; message: string }
  | { kind: 'note_too_long'; length: number; maxNoteLength: number; message: string }
  | { kind: 'unknown_group'; groupId: GroupId; message: string }
  | { kind: 'unknown_option'; groupId: GroupId; optionId: OptionId; message: string }
  | { kind: 'duplicate_option'; groupId: GroupId; optionId: OptionId; message: string }
  | { kind: 'option_unavailable'; groupId: GroupId; optionId: OptionId; message: string }
  | { kind: 'intensity_not_supported'; groupId: GroupId; optionId: OptionId; message: string }
  | { kind: 'group_required'; groupId: GroupId; message: string }
  | { kind: 'below_min'; groupId: GroupId; min: number; selected: number; message: string }
  | { kind: 'above_max'; groupId: GroupId; max: number; selected: number; message: string };

export type CompositionValidity =
  | { ok: true }
  | { ok: false; violations: CompositionViolation[] };

/**
 * Why an item is not being served right now, in the two lengths its readers
 * need. `null` means it IS served — which is what an item with no schedule
 * always is (P1-1).
 *
 * Two renderings of one answer, computed together, because the alternative is
 * two functions that can disagree — and the one that disagreed would be the
 * one on the screen. The menu row sits directly under the item's own name and
 * wants `label`; a cart line, a checkout refusal and a placement error appear
 * next to nothing and want `message`, which names the item.
 */
export type DaypartClosure = {
  /** "Served 16:00–21:00", or "Not on today's menu". No item name. */
  label: string;
  /** "Chilaquiles are served 16:00–21:00." A whole sentence. */
  message: string;
};

/**
 * Is this item outside its serving hours at this wall-clock reading?
 *
 * Precedence against an 86 is settled by the CALLER and only goes one way —
 * see `validateComposition`. This function does not know about `available`,
 * and a reader that needs both must ask both.
 *
 * A window is `[startMinute, endMinute)`: half-open, so 11:00–16:00 and
 * 16:00–21:00 abut without the 16:00 minute belonging to both. That is the 4pm
 * changeover this feature exists for, and an inclusive end would make it the
 * one minute of the day when lunch and dinner are both on.
 */
export function daypartClosure(item: MenuItem, clock: RestaurantClock): DaypartClosure | null {
  if (!item.windows || item.windows.length === 0) return null;

  const today = item.windows
    .filter((window) => window.dayOfWeek === clock.weekday)
    .sort((a, b) => a.startMinute - b.startMinute);

  // A day with no window is a day the item is not served — absence as the
  // closed signal, the same rule `checkoutGate` applies to a missing
  // `StoreHours` row, so a deleted row cannot leave an item on the menu.
  if (today.length === 0) {
    return {
      label: "Not on today's menu",
      message: `${item.name} is not on today's menu.`,
    };
  }

  const served = today.some(
    (window) => clock.minuteOfDay >= window.startMinute && clock.minuteOfDay < window.endMinute,
  );
  if (served) return null;

  // The windows themselves, not "come back later": a customer told the actual
  // hours can plan, and a published range is a fact rather than the kind of
  // precise wrong number the estimate rules ban.
  const hours = today
    .map((window) => `${formatMinuteOfDay(window.startMinute)}–${endLabel(window.endMinute)}`)
    .join(' and ');
  return { label: `Served ${hours}`, message: `${item.name} is served ${hours}.` };
}

/** 1440 is the last minute boundary of the day; "24:00" is not a time anyone
 *  reads. Local to the daypart label rather than folded into
 *  `formatMinuteOfDay`, whose other caller is the gate's closing time. */
function endLabel(minuteOfDay: number): string {
  return minuteOfDay === 1440 ? 'midnight' : formatMinuteOfDay(minuteOfDay);
}

/**
 * Can this composition be ordered right now?
 *
 * Reports EVERY reason at once rather than the first — a composer screen that
 * surfaces one problem per submit makes the customer play twenty questions
 * with the form.
 */
export function validateComposition(
  menu: Menu,
  composition: Composition,
  clock: RestaurantClock,
  limits: CompositionLimits = DEFAULT_LIMITS,
): CompositionValidity {
  const item = menu.items[composition.itemId];
  if (!item) {
    return {
      ok: false,
      violations: [{ kind: 'unknown_item', message: `No such item: ${composition.itemId}.` }],
    };
  }

  const violations: CompositionViolation[] = [];

  // 86 first, daypart second, and never both. They are two different reasons
  // and only one of them is true in the useful sense: an item that is both
  // sold out and out of its window is not "back at 16:00", it is gone until
  // someone restocks it. Telling a customer the schedule would be a promise
  // the kitchen has not made — the same precedence discipline `checkoutGate`
  // applies to a pause over a closing time.
  const closure = daypartClosure(item, clock);
  if (!item.available) {
    violations.push({ kind: 'item_unavailable', message: `${item.name} is sold out.` });
  } else if (closure !== null) {
    violations.push({ kind: 'item_outside_daypart', message: closure.message });
  }

  const { quantity } = composition;
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > limits.maxQuantity) {
    violations.push({
      kind: 'quantity_out_of_range',
      quantity,
      maxQuantity: limits.maxQuantity,
      message: `Choose a quantity between 1 and ${limits.maxQuantity}.`,
    });
  }

  const noteLength = composition.note?.length ?? 0;
  if (noteLength > limits.maxNoteLength) {
    violations.push({
      kind: 'note_too_long',
      length: noteLength,
      maxNoteLength: limits.maxNoteLength,
      message: `Keep special instructions to ${limits.maxNoteLength} characters.`,
    });
  }

  // Counts only selections that are actually asking FOR something. A negation
  // is not one of your three picks, and — the one that would ship food wrong —
  // "no chicken" must never satisfy a required protein group.
  const selectedPerGroup = new Map<GroupId, number>();
  const seen = new Set<string>();

  for (const selection of composition.selections) {
    const { groupId, optionId } = selection;
    const group = menu.groups[groupId];
    if (!group || !item.modifierGroupIds.includes(groupId)) {
      violations.push({
        kind: 'unknown_group',
        groupId,
        message: `${item.name} has no ${groupId} choices.`,
      });
      continue;
    }

    const option = group.options.find((o) => o.id === optionId);
    if (!option) {
      violations.push({
        kind: 'unknown_option',
        groupId,
        optionId,
        message: `${group.name} has no option "${optionId}".`,
      });
      continue;
    }

    const key = `${groupId}:${optionId}`;
    if (seen.has(key)) {
      violations.push({
        kind: 'duplicate_option',
        groupId,
        optionId,
        message: `${option.name} is selected twice.`,
      });
      continue;
    }
    seen.add(key);

    if (selection.intensity !== undefined && !group.intensityEnabled) {
      violations.push({
        kind: 'intensity_not_supported',
        groupId,
        optionId,
        message: `${group.name} does not offer light/regular/extra.`,
      });
    }

    // A negation is only a negation where the group actually offers intensity;
    // elsewhere the value is rejected above and the pick counts as ordinary.
    const isNegation = group.intensityEnabled && selection.intensity === 'none';

    // Asking for NO onions when the kitchen is out of onions is trivially
    // satisfiable. Refusing it would be absurd — and a naive availability
    // check does exactly that.
    if (!isNegation && !option.available) {
      violations.push({
        kind: 'option_unavailable',
        groupId,
        optionId,
        message: `${option.name} is sold out.`,
      });
    }

    if (!isNegation) {
      selectedPerGroup.set(groupId, (selectedPerGroup.get(groupId) ?? 0) + 1);
    }
  }

  for (const groupId of item.modifierGroupIds) {
    const group = menu.groups[groupId];
    if (!group) continue;
    const selected = selectedPerGroup.get(groupId) ?? 0;

    if (selected === 0 && group.min > 0) {
      violations.push({
        kind: 'group_required',
        groupId,
        message: `Choose your ${group.name.toLowerCase()}.`,
      });
    } else if (selected < group.min) {
      violations.push({
        kind: 'below_min',
        groupId,
        min: group.min,
        selected,
        message: `Choose at least ${group.min} from ${group.name}.`,
      });
    } else if (selected > group.max) {
      violations.push({
        kind: 'above_max',
        groupId,
        max: group.max,
        selected,
        message: `Choose at most ${group.max} from ${group.name}.`,
      });
    }
  }

  return violations.length === 0 ? { ok: true } : { ok: false, violations };
}
