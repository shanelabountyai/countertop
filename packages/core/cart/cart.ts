// The cart (P0-3). Pure functions over a cart the CALLER persists — no
// database, no clock, no session. `apps/web/lib/cart.ts` is the only thing
// that knows a cart lives in a cookie.
//
// A cart line holds a COMPOSITION, not a price. The stored
// `unitPriceAtAddCents` is display-only and exists for exactly one purpose:
// detecting that the menu was repriced while the line sat there, so the
// customer confirms old → new instead of being silently re-charged (P0-3).
// Every number that reaches the database is recomputed here from the live
// menu — the server is the price authority (CLAUDE.md).
import {
  DEFAULT_LIMITS,
  validateComposition,
  type CompositionLimits,
  type CompositionViolation,
} from '../menu/composition.js';
import type { Composition, Menu } from '../menu/types.js';
import {
  priceLine,
  priceOrder,
  type OrderTotals,
  type PricedLine,
  type TaxRatePpm,
} from '../pricing/pricing.js';

export type CartLine = {
  /** Stable across edits. Caller-generated — this module never invents ids. */
  id: string;
  composition: Composition;
  /** The unit price this line was added (or last confirmed) at. Display-only. */
  unitPriceAtAddCents: number;
};

export type Cart = { lines: CartLine[] };

export const EMPTY_CART: Cart = { lines: [] };

/**
 * Everything the orderability function can refuse, plus the one thing only a
 * cart can: an edit aimed at a line that is no longer there (two tabs, or a
 * back button). Kept out of `CompositionViolation` because the composer screen
 * has no such failure and should not have to switch on it.
 */
export type CartError =
  | CompositionViolation
  | { kind: 'unknown_line'; lineId: string; message: string };

export type CartResult = { ok: true; cart: Cart } | { ok: false; errors: CartError[] };

/** Violations that mean the line references something the menu no longer has. */
const UNPRICEABLE_KINDS = new Set(['unknown_item', 'unknown_group', 'unknown_option']);

function validated(
  menu: Menu,
  composition: Composition,
  limits: CompositionLimits,
): CartError[] {
  const validity = validateComposition(menu, composition, limits);
  return validity.ok ? [] : validity.violations;
}

/**
 * Add a composed line. THE orderability function is called here — this is the
 * cart-validation call site of the three (menu view, cart, placement).
 */
export function addLine(
  menu: Menu,
  cart: Cart,
  lineId: string,
  composition: Composition,
  limits: CompositionLimits = DEFAULT_LIMITS,
): CartResult {
  const errors = validated(menu, composition, limits);
  if (errors.length > 0) return { ok: false, errors };

  return {
    ok: true,
    cart: {
      lines: [
        ...cart.lines,
        {
          id: lineId,
          composition,
          unitPriceAtAddCents: priceLine(menu, composition).unitPriceCents,
        },
      ],
    },
  };
}

/**
 * Edit a line in place (P0-3: composed items are editable).
 *
 * Re-baselines the price: an edit goes back through the composer, where the
 * customer sees today's price. Carrying the old baseline forward would prompt
 * them to confirm a change they just made themselves.
 */
export function replaceLine(
  menu: Menu,
  cart: Cart,
  lineId: string,
  composition: Composition,
  limits: CompositionLimits = DEFAULT_LIMITS,
): CartResult {
  const index = cart.lines.findIndex((line) => line.id === lineId);
  if (index === -1) {
    return {
      ok: false,
      errors: [
        { kind: 'unknown_line', lineId, message: 'That line is no longer in your cart.' },
      ],
    };
  }

  const errors = validated(menu, composition, limits);
  if (errors.length > 0) return { ok: false, errors };

  const lines = [...cart.lines];
  lines[index] = {
    id: lineId,
    composition,
    unitPriceAtAddCents: priceLine(menu, composition).unitPriceCents,
  };
  return { ok: true, cart: { lines } };
}

/** Removing a line that is already gone is success, not an error. */
export function removeLine(cart: Cart, lineId: string): Cart {
  return { lines: cart.lines.filter((line) => line.id !== lineId) };
}

export type PriceChange = { fromUnitPriceCents: number; toUnitPriceCents: number };

export type CartLineReview = {
  line: CartLine;
  /** Null when the menu no longer has the item/group/option this line names. */
  priced: PricedLine | null;
  /** 86'd item or option, over-cap quantity or note, a group that changed shape. */
  problems: CompositionViolation[];
  priceChange: PriceChange | null;
};

export type CartReview = {
  lines: CartLineReview[];
  /** Server-computed, over the lines that still price. Never the client's number. */
  totals: OrderTotals;
  /** A line must be removed or fixed (P0-3's 86-in-cart criterion). */
  needsFix: boolean;
  /** A price moved; the customer confirms old → new before placing. */
  needsPriceConfirmation: boolean;
  placeable: boolean;
};

/**
 * Re-check the whole cart against the menu as it is RIGHT NOW.
 *
 * This is what checkout renders and what placement gates on. It reports every
 * problem on every line at once — a checkout that surfaces one 86'd line per
 * attempt is the phone call this product exists to replace.
 */
export function reviewCart(
  menu: Menu,
  cart: Cart,
  ratePpm: TaxRatePpm,
  limits: CompositionLimits = DEFAULT_LIMITS,
): CartReview {
  const lines: CartLineReview[] = cart.lines.map((line) => {
    const validity = validateComposition(menu, line.composition, limits);
    const problems = validity.ok ? [] : validity.violations;
    const priceable = !problems.some((problem) => UNPRICEABLE_KINDS.has(problem.kind));
    const priced = priceable ? priceLine(menu, line.composition) : null;

    return {
      line,
      priced,
      problems,
      priceChange:
        priced && priced.unitPriceCents !== line.unitPriceAtAddCents
          ? {
              fromUnitPriceCents: line.unitPriceAtAddCents,
              toUnitPriceCents: priced.unitPriceCents,
            }
          : null,
    };
  });

  const needsFix = lines.some((line) => line.problems.length > 0);
  const needsPriceConfirmation = lines.some((line) => line.priceChange !== null);

  return {
    lines,
    totals: priceOrder(
      lines.map((line) => line.priced).filter((priced) => priced !== null),
      ratePpm,
    ),
    needsFix,
    needsPriceConfirmation,
    placeable: cart.lines.length > 0 && !needsFix && !needsPriceConfirmation,
  };
}

/**
 * The customer's "yes, I saw the new price" — re-baselining the cart to the
 * live menu. Confirmation IS the re-baseline; there is no second flag to get
 * out of step with the prices it was supposed to describe.
 *
 * Lines that no longer price keep their old baseline. They are blocked by
 * `needsFix` regardless, and inventing a price for a deleted item would be the
 * silent repricing this whole path exists to prevent.
 */
export function confirmPrices(menu: Menu, cart: Cart): Cart {
  const review = reviewCart(menu, cart, 0);
  return {
    lines: review.lines.map(({ line, priced }) =>
      priced ? { ...line, unitPriceAtAddCents: priced.unitPriceCents } : line,
    ),
  };
}
