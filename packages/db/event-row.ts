// The one shape an `OrderEvent` row is written in.
//
// EXTRACTED FROM `placement.ts` AT C-118, for a structural reason and not a
// tidying one. `placeOrder` grew a caller into `loyalty.ts` that session — a
// checkout redemption's `redeem` row has to be written in the same transaction
// as the order carrying its `discountCents` — and `loyalty.ts` already reaches
// `placement.ts` through `adjustment.ts` for exactly this function. That is an
// import cycle, and the fix is that a row-builder shared by every writer of the
// append-only log was never `placeOrder`'s to own: placement, the queue's
// transitions, adjustments, payments, refunds, authorizations, remakes and the
// history reader all spell a row through here, and none of them is the others'
// dependency.
import type { OrderEventDraft } from '@countertop/core';
import type { Prisma } from './index';

/** One `OrderEvent` row from an engine draft. Exported because every writer of
 *  the append-only log — placement here, the queue's transitions in
 *  `transitions.ts` — must spell a row the same way. */
export const eventRow = (draft: OrderEventDraft, staffId?: string | null) => ({
  at: draft.at,
  kind: draft.kind,
  fromStatus: draft.fromStatus,
  toStatus: draft.toStatus,
  actor: draft.actor,
  // Null rather than absent, so the CHECK sees what it is meant to: money
  // events carry an amount and nothing else may.
  amountCents: draft.amountCents ?? null,
  providerRef: draft.providerRef ?? null,
  // The order this event points at (C-066). Null on everything but a `remake`.
  relatedOrderId: draft.relatedOrderId ?? null,
  // The refund request this attempt was made against (C-071). Null on
  // everything but a `refund` or a `refund_failed`, and the CHECK says so.
  refundRequestId: draft.refundRequestId ?? null,
  // The hold this event settles (C-069). Null on everything but a `capture` or
  // an `authorization_voided`, and the CHECK says so in both directions.
  authorizationId: draft.authorizationId ?? null,
  // WHICH staff member, where `actor` says what KIND (C-086). Stamped ONLY on
  // an event the engine attributes to staff: the customer's placement and the
  // system's refund are not somebody's tap, and putting the cook who cancelled
  // an order onto the refund the engine wrote would be a name on a row that
  // person did not write. The refund's actor is the seam where that gets
  // revisited, and PRD 3 is where it belongs.
  staffId: draft.actor === 'staff' ? (staffId ?? null) : null,
  reason: draft.reason,
  ...(draft.detail === undefined ? {} : { detail: draft.detail as Prisma.InputJsonObject }),
});
