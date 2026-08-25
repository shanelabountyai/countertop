// How one selected option reads to a human.
//
// The negation comes back flagged rather than pre-styled, because the two
// screens that render it emphasise it differently: the cart says "NO onions"
// in the line, the kitchen card (P0-11) has to make it impossible to miss at
// arm's length. Both need the same words; neither should invent them.
import type { Intensity, ModifierOption } from '@countertop/core/menu';

export type SelectionLabel = { text: string; negated: boolean };

export function describeSelection(
  option: ModifierOption,
  intensity: Intensity | undefined,
): SelectionLabel {
  switch (intensity) {
    case 'none':
      return { text: `NO ${option.name.toLowerCase()}`, negated: true };
    case 'light':
      return { text: `Light ${option.name.toLowerCase()}`, negated: false };
    case 'extra':
      return { text: `Extra ${option.name.toLowerCase()}`, negated: false };
    default:
      return { text: option.name, negated: false };
  }
}
