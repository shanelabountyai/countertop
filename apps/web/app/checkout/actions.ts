'use server';

// The server surface of checkout. Thin, like the cart's: every rule lives in
// packages/core and packages/db, and everything arriving here is untrusted
// input that is shape-checked before anything looks at it.
//
// The CART is not an argument. It comes out of the httpOnly cookie — a
// client that could hand the server its own cart could hand it a $0 one.
import {
  formatOrderNumber,
  isIdempotencyKey,
  type CartReview,
  type Intensity,
  type PaymentState,
} from '@countertop/core';
import { placeOrder, type OrderReceipt, type PlacementError } from '@countertop/db/placement';
import { clearCart, readCart } from '@/lib/cart-session';

/** What the confirmation screen renders. No UUID: customers and staff use the
 *  order number and the name (P0-8), and an id that never leaves the server
 *  cannot leak into a URL someone shares. */
export type OrderConfirmation = {
  orderNumber: string;
  customerName: string;
  /** The customer's status link (C-014 renders the page behind it). */
  statusToken: string;
  placedAt: Date;
  subtotalCents: number;
  taxCents: number;
  totalCents: number;
  /** P1-8. What the receipt has to tell the customer to bring cash for. */
  paymentState: PaymentState;
  lines: {
    itemName: string;
    quantity: number;
    unitPriceCents: number;
    lineTotalCents: number;
    note: string | null;
    options: {
      groupName: string;
      optionName: string;
      intensity: Intensity | null;
      appliedDeltaCents: number;
    }[];
  }[];
};

/** Placement's own refusals, plus the two only a request can commit: arriving
 *  in a shape our form never produces, and naming a key that cannot have come
 *  from a browser. Same kind the cart actions use. */
export type CheckoutError =
  | PlacementError
  | { kind: 'malformed_request'; message: string }
  | { kind: 'idempotency_key_invalid'; message: string };

/** C-052 / defect D3. Its own kind rather than folding into `malformed_request`
 *  because this is the one refusal aimed at a PROGRAMMER — the customer's
 *  browser cannot produce it — and until C-084 puts a log line behind it, the
 *  kind is the only name it has. The message stays customer-safe anyway: the
 *  screen renders it, and "must be a UUID" is a sentence nobody at a counter
 *  should ever have to read. */
const BAD_KEY: CheckoutResult = {
  ok: false,
  errors: [
    {
      kind: 'idempotency_key_invalid',
      message: 'That order could not be read. Try again.',
    },
  ],
  review: null,
};

export type CheckoutResult =
  | { ok: true; confirmation: OrderConfirmation }
  | { ok: false; errors: CheckoutError[]; review: CartReview | null };

const MALFORMED: CheckoutResult = {
  ok: false,
  errors: [{ kind: 'malformed_request', message: 'That order could not be read. Try again.' }],
  review: null,
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** An absent optional field reads as null; a field of the wrong type reads as
 *  `undefined`, which the caller rejects. Absent and malformed are different
 *  answers — one is a customer who left the phone box empty, the other is a
 *  request that was not written by our form. */
function optionalString(value: unknown): string | null | undefined {
  if (value === undefined || value === null) return null;
  return typeof value === 'string' ? value : undefined;
}

/** Reads the order rows back as the confirmation, dropping every id. */
const confirm = (order: OrderReceipt): OrderConfirmation => ({
  orderNumber: formatOrderNumber(order.seq),
  customerName: order.customerName,
  statusToken: order.statusToken,
  placedAt: order.placedAt,
  subtotalCents: order.subtotalCents,
  taxCents: order.taxCents,
  totalCents: order.totalCents,
  paymentState: order.paymentState,
  lines: order.lines.map((line) => ({
    itemName: line.itemName,
    quantity: line.quantity,
    unitPriceCents: line.unitPriceCents,
    lineTotalCents: line.lineTotalCents,
    note: line.note,
    options: line.options.map((option) => ({
      groupName: option.groupName,
      optionName: option.optionName,
      intensity: option.intensity,
      appliedDeltaCents: option.appliedDeltaCents,
    })),
  })),
});

/**
 * Place the cart in this session's cookie (P0-3, P0-8, P0-10).
 *
 * The idempotency key is the client's, generated once per checkout attempt and
 * resent on every retry of THAT attempt — so a double-tap, a flaky connection
 * and an impatient reload all resolve to the same order. Two taps that
 * produced two keys are two orders, correctly: that is a customer ordering
 * twice.
 */
export async function placeCartOrder(raw: unknown): Promise<CheckoutResult> {
  if (!isRecord(raw)) return MALFORMED;

  const { idempotencyKey, clientTotalCents, payNow } = raw;
  if (typeof idempotencyKey !== 'string') return MALFORMED;
  // The boundary the whole defect turns on. `placeOrder` replays a hit on this
  // key into a full receipt including `statusToken`, so an attacker-chosen key
  // is an attacker-chosen read. Checked HERE, at the only entry point a
  // request can reach — the seed, the rush and the db tests are trusted
  // callers driving the same function with no request behind them.
  if (!isIdempotencyKey(idempotencyKey)) return BAD_KEY;
  if (clientTotalCents !== undefined && typeof clientTotalCents !== 'number') return MALFORMED;
  // The mock provider (P1-8). A real one is a call that can fail, and the
  // failure — not the radio button — is what would decide the state; this is
  // the seam where that call goes.
  if (payNow !== undefined && typeof payNow !== 'boolean') return MALFORMED;

  const customerName = optionalString(raw.customerName);
  const customerPhone = optionalString(raw.customerPhone);
  const orderNote = optionalString(raw.orderNote);
  if (customerName === undefined || customerPhone === undefined || orderNote === undefined) {
    return MALFORMED;
  }

  const result = await placeOrder({
    cart: await readCart(),
    customerName,
    customerPhone,
    orderNote,
    idempotencyKey,
    // The one clock read in the whole placement path, at its outermost edge:
    // the engine and the writer both take `now` as a parameter.
    now: new Date(),
    ...(clientTotalCents === undefined ? {} : { clientTotalCents }),
    ...(payNow === undefined ? {} : { paidNow: payNow }),
  });

  if (!result.ok) return result;

  // The cart's job is done. Clearing it after the write, not before, means a
  // failed placement leaves the customer their food.
  await clearCart();
  return { ok: true, confirmation: confirm(result.order) };
}
