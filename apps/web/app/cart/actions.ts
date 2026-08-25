'use server';

// The server surface of the cart. Thin on purpose: every rule lives in
// packages/core, and every argument here is untrusted input that goes through
// `parseComposition` before anything else looks at it.
import { randomUUID } from 'node:crypto';
import {
  addLine,
  removeLine,
  replaceLine,
  confirmPrices,
  parseComposition,
  reviewCart,
  type CartError,
  type CartReview,
} from '@countertop/core';
import { loadMenu, loadSettings } from '@countertop/db/menu';
import { readCart, writeCart } from '@/lib/cart-session';

type ActionError = CartError | { kind: 'malformed_request' | 'cart_full'; message: string };
type ActionResult = { ok: true } | { ok: false; errors: ActionError[] };

const MALFORMED: ActionResult = {
  ok: false,
  errors: [{ kind: 'malformed_request', message: 'That order could not be read. Try again.' }],
};

const CART_FULL: ActionResult = {
  ok: false,
  errors: [
    { kind: 'cart_full', message: 'This cart is full — place it and start another.' },
  ],
};

async function save(cart: Parameters<typeof writeCart>[0]): Promise<ActionResult> {
  return (await writeCart(cart)) ? { ok: true } : CART_FULL;
}

export async function addToCart(raw: unknown): Promise<ActionResult> {
  const composition = parseComposition(raw);
  if (!composition) return MALFORMED;

  const result = addLine(await loadMenu(), await readCart(), randomUUID(), composition);
  return result.ok ? save(result.cart) : { ok: false, errors: result.errors };
}

export async function updateCartLine(lineId: string, raw: unknown): Promise<ActionResult> {
  const composition = parseComposition(raw);
  if (!composition) return MALFORMED;

  const result = replaceLine(await loadMenu(), await readCart(), lineId, composition);
  return result.ok ? save(result.cart) : { ok: false, errors: result.errors };
}

export async function removeCartLine(lineId: string): Promise<ActionResult> {
  return save(removeLine(await readCart(), lineId));
}

/** The customer's "yes, I saw the new price" (P0-3: no silent repricing). */
export async function confirmCartPrices(): Promise<ActionResult> {
  return save(confirmPrices(await loadMenu(), await readCart()));
}

/** What checkout renders, and what C-006's placement gates on. */
export async function getCartReview(): Promise<CartReview> {
  const [menu, settings, cart] = await Promise.all([loadMenu(), loadSettings(), readCart()]);
  return reviewCart(menu, cart, settings.taxRatePpm);
}
