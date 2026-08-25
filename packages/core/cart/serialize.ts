// The cart's trust boundary.
//
// A cart arrives from OUTSIDE the server on every request — out of a cookie
// the customer can edit, or as a server-action argument a client wrote. Both
// are strings until proven otherwise, so both come through here, and nothing
// in this file trusts a field it has not checked.
//
// It deliberately checks SHAPE, not menu truth: ids, quantities and caps are
// judged against the live menu by `validateComposition`, which is the one
// place allowed to answer that. Duplicating a cap here would be a second
// answer to drift from the first.
import { INTENSITIES, type Composition, type Intensity, type OptionSelection } from '../menu/types';
import { EMPTY_CART, type Cart, type CartLine } from './cart';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseSelection(raw: unknown): OptionSelection | null {
  if (!isRecord(raw)) return null;
  const { groupId, optionId, intensity } = raw;
  if (typeof groupId !== 'string' || typeof optionId !== 'string') return null;
  if (intensity !== undefined && !INTENSITIES.includes(intensity as Intensity)) return null;

  // Spread rather than `intensity: undefined`: an absent intensity and an
  // explicit undefined are different values to `exactOptionalPropertyTypes`,
  // and only one of them round-trips through JSON.
  return {
    groupId,
    optionId,
    ...(intensity === undefined ? {} : { intensity: intensity as Intensity }),
  };
}

/** Shape-checks one composed line from an untrusted source. Null = reject it. */
export function parseComposition(raw: unknown): Composition | null {
  if (!isRecord(raw)) return null;
  const { itemId, quantity, selections, note } = raw;
  if (typeof itemId !== 'string' || itemId === '') return null;
  if (typeof quantity !== 'number' || !Number.isInteger(quantity)) return null;
  if (!Array.isArray(selections)) return null;
  if (note !== undefined && typeof note !== 'string') return null;

  const parsed: OptionSelection[] = [];
  for (const selection of selections) {
    const one = parseSelection(selection);
    if (one === null) return null;
    parsed.push(one);
  }

  return { itemId, quantity, selections: parsed, ...(note === undefined ? {} : { note }) };
}

function parseLine(raw: unknown): CartLine | null {
  if (!isRecord(raw)) return null;
  const { id, unitPriceAtAddCents } = raw;
  if (typeof id !== 'string' || id === '') return null;
  if (typeof unitPriceAtAddCents !== 'number' || !Number.isInteger(unitPriceAtAddCents)) {
    return null;
  }
  const composition = parseComposition(raw.composition);
  if (composition === null) return null;

  return { id, composition, unitPriceAtAddCents };
}

export function serializeCart(cart: Cart): string {
  return JSON.stringify(cart);
}

/**
 * Anything unreadable becomes an empty cart, and an unreadable LINE is dropped
 * rather than taking the rest of the cart with it. A customer whose cookie got
 * mangled loses food they can re-add; one whose whole cart vanishes at
 * checkout leaves.
 *
 * A tampered `unitPriceAtAddCents` is harmless by construction: it is the
 * baseline for the "price changed" prompt, never an input to a total. The
 * worst a customer can do to themselves with it is suppress their own
 * confirmation dialog and be charged the real menu price.
 */
export function parseCart(raw: string | null | undefined): Cart {
  if (!raw) return EMPTY_CART;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return EMPTY_CART;
  }

  if (!isRecord(parsed) || !Array.isArray(parsed.lines)) return EMPTY_CART;
  return { lines: parsed.lines.map(parseLine).filter((line) => line !== null) };
}
