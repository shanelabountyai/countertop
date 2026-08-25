// The price engine (P0-2, P0-9). Server-side authority: client prices are
// display-only, and a client-supplied total is input to a mismatch log, never
// to the database.
//
// Every value here is integer cents. There is exactly ONE rounding operation
// in the whole engine — inside `taxOn` — and it works on integers, so there is
// no floating-point rate to land a boundary cent on the wrong side.
import type { Composition, Intensity, Menu, ModifierGroup, ModifierOption } from '../menu/types';

/**
 * A tax rate in parts per million. 8.25% = 82_500.
 *
 * Integer, deliberately. A float rate makes `subtotal × rate` land a hair
 * either side of a half-cent, so the boundary cent rounds by luck. Parts per
 * million also express the rates basis points cannot: 8.875% — a real,
 * ordinary rate — is 88_750 ppm and 887.5 bp.
 */
export type TaxRatePpm = number;

const PPM = 1_000_000;

export type PricedLine = {
  unitPriceCents: number;
  quantity: number;
  lineTotalCents: number;
};

export type OrderTotals = {
  subtotalCents: number;
  taxCents: number;
  totalCents: number;
};

export type TotalMismatch = {
  clientTotalCents: number;
  serverTotalCents: number;
};

/** For config and seeds: `taxRatePpmFromPercent(8.25)` → 82_500. */
export function taxRatePpmFromPercent(percent: number): TaxRatePpm {
  return Math.round(percent * 10_000);
}

/**
 * THE rounding function. Half-up, on integers only.
 *
 * `subtotalCents * ratePpm` is an exact integer (a $100,000 order at any sane
 * rate is ~1e13, comfortably inside the 2^53 exact range). Adding half a
 * million and flooring is half-up rounding done without ever forming a
 * fractional rate. The final division cannot cross an integer boundary by
 * float error: a non-exact quotient sits at least 1e-6 from an integer, and
 * the representation error at this magnitude is ~1e-9.
 */
export function taxOn(subtotalCents: number, ratePpm: TaxRatePpm): number {
  if (!Number.isInteger(subtotalCents)) {
    throw new Error(`Subtotal must be integer cents, got ${subtotalCents}`);
  }
  if (subtotalCents < 0) {
    throw new Error(`Subtotal cannot be negative, got ${subtotalCents}`);
  }
  return Math.floor((subtotalCents * ratePpm + PPM / 2) / PPM);
}

/**
 * What one selected option adds to the unit price.
 *
 * Exported because the order snapshot stores this number per option, and the
 * options on a line must sum to exactly `unitPriceCents - basePriceCents`. A
 * second implementation for the snapshot would be a second answer to drift.
 *
 * A negation costs nothing — you are not getting it — even when the option
 * carries a delta. "Extra" costs the option's own delta PLUS its extra
 * surcharge. "Light" costs the same as "regular": a restaurant does not
 * discount light sauce, and pretending otherwise would be a pricing rule
 * nobody asked for.
 */
export function appliedDeltaCents(
  group: ModifierGroup,
  option: ModifierOption,
  intensity: Intensity | undefined,
): number {
  if (!group.intensityEnabled) return option.priceDeltaCents;
  if (intensity === 'none') return 0;
  if (intensity === 'extra') return option.priceDeltaCents + (option.extraPriceDeltaCents ?? 0);
  return option.priceDeltaCents;
}

/**
 * Line price = (base + Σ deltas) × quantity.
 *
 * The deltas are inside the multiplication. Adding them after it undercharges
 * every line with a quantity above one, by exactly the modifiers — which is
 * the kind of error that looks right on a receipt read quickly.
 *
 * Assumes a composition that `validateComposition` has already accepted;
 * unknown ids throw rather than pricing as zero, because a silent zero is how
 * a tampered request becomes free food.
 */
export function priceLine(menu: Menu, composition: Composition): PricedLine {
  const item = menu.items[composition.itemId];
  if (!item) throw new Error(`Unknown item: ${composition.itemId}`);

  let unitPriceCents = item.basePriceCents;
  for (const selection of composition.selections) {
    const group = menu.groups[selection.groupId];
    if (!group) throw new Error(`Unknown modifier group: ${selection.groupId}`);
    const option = group.options.find((o) => o.id === selection.optionId);
    if (!option) throw new Error(`Unknown option: ${selection.optionId}`);
    unitPriceCents += appliedDeltaCents(group, option, selection.intensity);
  }

  return {
    unitPriceCents,
    quantity: composition.quantity,
    lineTotalCents: unitPriceCents * composition.quantity,
  };
}

/**
 * Order total = Σ lines + tax on the subtotal.
 *
 * Tax is computed ONCE, on the subtotal — not per line and summed. Per-line
 * rounding drifts by a cent per line against every receipt a customer can
 * check with a calculator.
 */
export function priceOrder(lines: PricedLine[], ratePpm: TaxRatePpm): OrderTotals {
  const subtotalCents = lines.reduce((sum, line) => sum + line.lineTotalCents, 0);
  const taxCents = taxOn(subtotalCents, ratePpm);
  return { subtotalCents, taxCents, totalCents: subtotalCents + taxCents };
}

/**
 * Compares what the client claimed against what the server computed (P0-2).
 *
 * Returns the mismatch to be LOGGED, or null. It deliberately cannot return
 * "use the client's number" — the server total is already the answer, and this
 * exists so a tampered or stale client is visible rather than silently
 * overruled.
 */
export function checkClientTotal(
  serverTotalCents: number,
  clientTotalCents: number,
): TotalMismatch | null {
  if (serverTotalCents === clientTotalCents) return null;
  return { serverTotalCents, clientTotalCents };
}
