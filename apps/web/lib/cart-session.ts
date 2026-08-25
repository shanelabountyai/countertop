// Where the cart lives: one httpOnly cookie, holding compositions.
//
// No cart table, because there is nothing to store that the customer's own
// browser cannot hold — prices are recomputed from the live menu on every
// read, so the cookie carries no authority, only intent. A cart becomes rows
// when it becomes an order (C-006).
//
// Session cookie deliberately (no maxAge): "cart persists per session" is what
// P0-3 asks for, and a week-old cart full of 86'd food is worse than an empty
// one.
// `next/headers` is itself the server-only guard: importing this from a client
// component fails the build, with no extra dependency to declare.
import { cookies } from 'next/headers';
import { parseCart, serializeCart, type Cart } from '@countertop/core';

const COOKIE = 'ct_cart';

// ponytail: browsers drop a cookie over ~4KB silently — a cart that vanished
// at 4097 bytes would look like a lost order. Refusing the add is the honest
// failure. If real carts ever get near this, the upgrade is a cart table
// keyed by a session id, not a bigger cookie.
const MAX_COOKIE_BYTES = 3_900;

export async function readCart(): Promise<Cart> {
  return parseCart((await cookies()).get(COOKIE)?.value);
}

/** False means the cart is too big to store — the caller must not claim it saved. */
export async function writeCart(cart: Cart): Promise<boolean> {
  const value = serializeCart(cart);
  if (Buffer.byteLength(value) > MAX_COOKIE_BYTES) return false;

  (await cookies()).set(COOKIE, value, {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    secure: process.env.NODE_ENV === 'production',
  });
  return true;
}

export async function clearCart(): Promise<void> {
  (await cookies()).delete(COOKIE);
}
