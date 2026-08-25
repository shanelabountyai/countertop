// THE orderability function (CLAUDE.md, "One orderability function").
//
// "Can this composition be ordered right now?" has exactly one answer, given
// here. The menu view, cart validation, and placement all call this — three
// call sites, one answer. Grow a second one and they will disagree, quietly,
// in the direction of taking money for food that cannot be made.
import type { Composition, GroupId, Menu, OptionId } from './types';

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
 * Can this composition be ordered right now?
 *
 * Reports EVERY reason at once rather than the first — a composer screen that
 * surfaces one problem per submit makes the customer play twenty questions
 * with the form.
 */
export function validateComposition(
  menu: Menu,
  composition: Composition,
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

  if (!item.available) {
    violations.push({ kind: 'item_unavailable', message: `${item.name} is sold out.` });
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
