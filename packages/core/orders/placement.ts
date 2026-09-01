// Placement (P0-3, P0-8, P0-9): turning a cart into the immutable COPY that a
// receipt and a kitchen ticket are rendered from.
//
// Pure. It builds the rows; `packages/db/placement.ts` writes them, assigns
// the number and enforces the idempotency key. Nothing here reads a clock, a
// database, or a request.
//
// THE SNAPSHOT RULE (CLAUDE.md): every name and every price below is COPIED
// out of the menu at this instant. After this function returns, the order owes
// the menu nothing — renaming an item, repricing it, 86'ing it or deleting it
// outright must be invisible to what was already placed.
import type { Cart } from '../cart/cart';
import type { Intensity, Menu } from '../menu/types';
import { appliedDeltaCents, priceLine, priceOrder, type TaxRatePpm } from '../pricing/pricing';

/** The `customerName` column width (P0-8: a name is required, 1–40 chars). */
export const MAX_CUSTOMER_NAME_LENGTH = 40;
/** The `customerPhone` column width. Optional; feeds the P1-3 stub. */
export const MAX_CUSTOMER_PHONE_LENGTH = 32;
/** The `orderNote` column width — "blue Honda out front" (P0-8). */
export const MAX_ORDER_NOTE_LENGTH = 140;

export type CustomerIdentity = {
  customerName: string;
  customerPhone: string | null;
  orderNote: string | null;
};

export type IdentityViolation =
  | { kind: 'name_required'; message: string }
  | { kind: 'name_too_long'; length: number; max: number; message: string }
  | { kind: 'phone_too_long'; length: number; max: number; message: string }
  | { kind: 'order_note_too_long'; length: number; max: number; message: string };

export type IdentityResult =
  | { ok: true; identity: CustomerIdentity }
  | { ok: false; violations: IdentityViolation[] };

const trimmed = (value: string | null | undefined): string => (value ?? '').trim();

/**
 * Checkout's identity fields, trimmed and length-checked (P0-8).
 *
 * Trimming before measuring is the point: a name of forty spaces is not a
 * name, and a phone that only differs from another by trailing whitespace is
 * the kind of value that makes two receipts look identical and sort apart.
 * Empty optional fields normalize to null so the column holds one "absent",
 * not two.
 *
 * Reports every violation at once, like `validateComposition` — a checkout
 * form that surfaces one field per submit is the form customers abandon.
 */
export function normalizeIdentity(raw: {
  // `| undefined` spelled out: under `exactOptionalPropertyTypes` a caller
  // reading these off a form has `string | undefined` values, and an optional
  // key alone would not accept them.
  customerName?: string | null | undefined;
  customerPhone?: string | null | undefined;
  orderNote?: string | null | undefined;
}): IdentityResult {
  const customerName = trimmed(raw.customerName);
  const customerPhone = trimmed(raw.customerPhone);
  const orderNote = trimmed(raw.orderNote);
  const violations: IdentityViolation[] = [];

  if (customerName === '') {
    violations.push({ kind: 'name_required', message: 'Add a name for this order.' });
  } else if (customerName.length > MAX_CUSTOMER_NAME_LENGTH) {
    violations.push({
      kind: 'name_too_long',
      length: customerName.length,
      max: MAX_CUSTOMER_NAME_LENGTH,
      message: `Keep the name to ${MAX_CUSTOMER_NAME_LENGTH} characters.`,
    });
  }

  if (customerPhone.length > MAX_CUSTOMER_PHONE_LENGTH) {
    violations.push({
      kind: 'phone_too_long',
      length: customerPhone.length,
      max: MAX_CUSTOMER_PHONE_LENGTH,
      message: `Keep the phone number to ${MAX_CUSTOMER_PHONE_LENGTH} characters.`,
    });
  }

  if (orderNote.length > MAX_ORDER_NOTE_LENGTH) {
    violations.push({
      kind: 'order_note_too_long',
      length: orderNote.length,
      max: MAX_ORDER_NOTE_LENGTH,
      message: `Keep the order note to ${MAX_ORDER_NOTE_LENGTH} characters.`,
    });
  }

  if (violations.length > 0) return { ok: false, violations };
  return {
    ok: true,
    identity: {
      customerName,
      customerPhone: customerPhone === '' ? null : customerPhone,
      orderNote: orderNote === '' ? null : orderNote,
    },
  };
}

/**
 * Is this string a UUID (C-052, defect D3)?
 *
 * The idempotency key is not only a write guard — `placeOrder` looks it up
 * FIRST and replays the whole receipt on a hit, `statusToken` included. So
 * presenting a key is presenting a read handle to somebody's order, and the
 * only thing that has ever made that safe is the browser generating it with
 * `crypto.randomUUID()`. The server enforced nothing: any non-empty string
 * was accepted, and this repo's own seed and rush scripts wrote keys like
 * `seed-order-0`. The day a second client exists — a kiosk, a QR flow, a POS
 * bridge — a well-meaning integrator writes `kiosk-2-0047` and the replay is
 * a leak from that moment.
 *
 * The canonical 8-4-4-4-12, case-insensitive because a client that upper-cases
 * a valid UUID is not the threat, with the version nibble 1-8 and the RFC
 * variant. Strict about the variant deliberately: `00000000-0000-0000-0000-
 * 000000000000` is 36 characters of nothing and would pass a shape-only check.
 *
 * A FORMAT CHECK IS A FLOOR, NOT A PROOF. It cannot tell a random v4 from a
 * hand-typed one, and it does not stop someone who has a real key from
 * replaying it. The actual answer is binding the replay to the session that
 * placed the order, which is PRD 6 E-1 and a separate item.
 */
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const isIdempotencyKey = (value: string): boolean => UUID.test(value);

/**
 * The order number as everyone says it out loud: "#047" (P0-8).
 *
 * Padded to three digits so a queue of #9 and #47 reads as a column rather
 * than a ragged list, and never truncated past it — #1047 on a busy day is
 * four digits and still correct.
 */
export const formatOrderNumber = (seq: number): string => `#${String(seq).padStart(3, '0')}`;

/** One snapshotted option — an `OrderLineOption` row, minus its ids. */
export type SnapshotOption = {
  sortOrder: number;
  /** Analytics correlation only. Never read back for display or pricing. */
  modifierGroupId: string;
  modifierOptionId: string;
  groupName: string;
  optionName: string;
  /** Null in a group without intensity. `none` is the negation. */
  intensity: Intensity | null;
  appliedDeltaCents: number;
};

/** One snapshotted line — an `OrderLine` row, minus its ids. */
export type SnapshotLine = {
  lineNumber: number;
  menuItemId: string;
  itemName: string;
  categoryName: string;
  basePriceCents: number;
  quantity: number;
  unitPriceCents: number;
  lineTotalCents: number;
  note: string | null;
  options: SnapshotOption[];
};

export type OrderSnapshot = {
  subtotalCents: number;
  taxCents: number;
  /**
   * The kitchen work this order is (P1-7): the sum of every line's item weight
   * times its quantity, COPIED here the way the money is.
   *
   * Snapshotted for the same reason the prices are (CLAUDE.md): the throttle
   * and the estimate add up the open orders' weight, and re-deriving it by
   * joining back to `MenuItem` would make re-weighting an item silently change
   * how heavy yesterday's queue was. An order weighs what it weighed when it
   * was placed.
   */
  prepWeight: number;
  /** Snapshotted with the money, or a later rate change makes this receipt
   *  arithmetically unexplainable. */
  taxRatePpm: TaxRatePpm;
  totalCents: number;
  lines: SnapshotLine[];
};

/**
 * Copy a cart into order rows, pricing every line from the menu as it is RIGHT
 * NOW (P0-2: the server is the price authority, at cart-add AND again here).
 *
 * Assumes a cart `reviewCart` has already accepted — this is the third and
 * last of the three orderability call sites, and it is the placement one. An
 * unknown id throws rather than snapshotting a zero, because a line priced at
 * zero by accident is free food that looks like a receipt.
 */
export function buildOrderSnapshot(
  menu: Menu,
  cart: Cart,
  taxRatePpm: TaxRatePpm,
): OrderSnapshot {
  const categoryNames = new Map(menu.categories.map((category) => [category.id, category.name]));

  const lines = cart.lines.map((line, index): SnapshotLine => {
    const { composition } = line;
    const item = menu.items[composition.itemId];
    if (!item) throw new Error(`Unknown item: ${composition.itemId}`);
    const categoryName = categoryNames.get(item.categoryId);
    if (categoryName === undefined) throw new Error(`Unknown category: ${item.categoryId}`);

    const priced = priceLine(menu, composition);

    const options = composition.selections.map((selection, sortOrder): SnapshotOption => {
      const group = menu.groups[selection.groupId];
      if (!group) throw new Error(`Unknown modifier group: ${selection.groupId}`);
      const option = group.options.find((candidate) => candidate.id === selection.optionId);
      if (!option) throw new Error(`Unknown option: ${selection.optionId}`);

      return {
        sortOrder,
        modifierGroupId: group.id,
        modifierOptionId: option.id,
        groupName: group.name,
        optionName: option.name,
        // Null, not `regular`, in a group without intensity: the kitchen card
        // must not print "regular cheese" for a group that never offered the
        // choice, and only a null distinguishes the two.
        intensity: group.intensityEnabled ? (selection.intensity ?? 'regular') : null,
        appliedDeltaCents: appliedDeltaCents(group, option, selection.intensity),
      };
    });

    return {
      // 1-based: this number is read by humans on a ticket, not indexed into.
      lineNumber: index + 1,
      menuItemId: item.id,
      itemName: item.name,
      categoryName,
      basePriceCents: item.basePriceCents,
      quantity: composition.quantity,
      unitPriceCents: priced.unitPriceCents,
      lineTotalCents: priced.lineTotalCents,
      note: composition.note ?? null,
      options,
    };
  });

  // Weight comes off the live menu, like every price above it, and then stops
  // moving. `quantity` multiplies it: three burritos are three burritos' work.
  const prepWeight = cart.lines.reduce((total, line) => {
    const item = menu.items[line.composition.itemId];
    if (!item) throw new Error(`Unknown item: ${line.composition.itemId}`);
    return total + item.prepWeight * line.composition.quantity;
  }, 0);

  const totals = priceOrder(
    lines.map(({ unitPriceCents, quantity, lineTotalCents }) => ({
      unitPriceCents,
      quantity,
      lineTotalCents,
    })),
    taxRatePpm,
  );

  return { ...totals, taxRatePpm, prepWeight, lines };
}
