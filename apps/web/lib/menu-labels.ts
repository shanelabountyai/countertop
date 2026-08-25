// How one selected option reads to a human.
//
// The negation comes back flagged rather than pre-styled, because the two
// screens that render it emphasise it differently: the cart says "NO onions"
// in the line, the kitchen card (P0-11) has to make it impossible to miss at
// arm's length. Both need the same words; neither should invent them.
import type { Intensity } from '@countertop/core/menu';

export type SelectionLabel = { text: string; negated: boolean };

/**
 * Takes the option's NAME, not the option: the cart reads it off the live
 * menu, the kitchen card reads it off the order's own snapshot, and a snapshot
 * is deliberately not a menu row (CLAUDE.md, the snapshot rule).
 */
export function describeSelection(
  name: string,
  intensity: Intensity | null | undefined,
): SelectionLabel {
  switch (intensity) {
    case 'none':
      return { text: `NO ${name.toLowerCase()}`, negated: true };
    case 'light':
      return { text: `Light ${name.toLowerCase()}`, negated: false };
    case 'extra':
      return { text: `Extra ${name.toLowerCase()}`, negated: false };
    default:
      return { text: name, negated: false };
  }
}
