'use server';

// The server surface of the cart. Thin on purpose: every rule lives in
// packages/core, and every argument here is untrusted input that goes through
// `parseComposition` before anything else looks at it.
import { randomUUID } from 'node:crypto';
import { revalidatePath } from 'next/cache';
import {
  addLine,
  removeLine,
  replaceLine,
  confirmPrices,
  parseComposition,
  reviewCart,
  DEFAULT_LIMITS,
  type CartError,
  type CartReview,
} from '@countertop/core';
import { loadClock, loadMenu, loadSettings } from '@countertop/db/menu';
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

  const [menu, cart, clock] = await Promise.all([loadMenu(), readCart(), loadClock()]);
  const result = addLine(menu, cart, randomUUID(), composition, clock);
  return result.ok ? save(result.cart) : { ok: false, errors: result.errors };
}

export async function updateCartLine(lineId: string, raw: unknown): Promise<ActionResult> {
  const composition = parseComposition(raw);
  if (!composition) return MALFORMED;

  const [menu, cart, clock] = await Promise.all([loadMenu(), readCart(), loadClock()]);
  const result = replaceLine(menu, cart, lineId, composition, clock);
  return result.ok ? save(result.cart) : { ok: false, errors: result.errors };
}

export async function removeCartLine(lineId: string): Promise<ActionResult> {
  return save(removeLine(await readCart(), lineId));
}

/** The customer's "yes, I saw the new price" (P0-3: no silent repricing). */
export async function confirmCartPrices(): Promise<ActionResult> {
  const [menu, cart, clock] = await Promise.all([loadMenu(), readCart(), loadClock()]);
  return save(confirmPrices(menu, cart, clock));
}

/** What checkout renders, and what C-006's placement gates on. */
export async function getCartReview(): Promise<CartReview> {
  const [menu, settings, cart, clock] = await Promise.all([
    loadMenu(),
    loadSettings(),
    readCart(),
    loadClock(),
  ]);
  return reviewCart(menu, cart, settings.taxRatePpm, clock);
}

// Form-shaped wrappers, for the cart screen's `<form action={...}>` buttons.
// A plain form posts without JavaScript, so the cart stays editable while the
// page is still hydrating — and there is no client component to write.
export async function removeCartLineForm(lineId: string): Promise<void> {
  await removeCartLine(lineId);
  revalidatePath('/cart');
}

/**
 * The −/+ steppers (P1-2): a tap, not a trip back into the composer. Goes
 * through `updateCartLine` — the same server-price-authority path a composer
 * save uses — so a stepper cannot become a second place quantity gets priced.
 * Clamped here so a spammed tap at either end is a no-op, not a write.
 */
export async function stepCartLineForm(lineId: string, delta: number): Promise<void> {
  const cart = await readCart();
  const line = cart.lines.find((l) => l.id === lineId);
  if (line) {
    const quantity = Math.min(
      Math.max(line.composition.quantity + delta, 1),
      DEFAULT_LIMITS.maxQuantity,
    );
    if (quantity !== line.composition.quantity) {
      await updateCartLine(lineId, { ...line.composition, quantity });
    }
  }
  revalidatePath('/cart');
}

export async function confirmCartPricesForm(): Promise<void> {
  await confirmCartPrices();
  revalidatePath('/cart');
}
