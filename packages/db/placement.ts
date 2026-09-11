// Placing an order (P0-3, P0-8, P0-9, P0-10). The one write path that turns a
// cart into rows.
//
// Everything it decides, it decides with packages/core: the prices come from
// the price engine, the validity from THE orderability function, the business
// day from the restaurant's timezone, the `placed` event from the ONE status
// module. This file's own job is the three things only a database can do —
// take the next order number without racing, refuse a second order for the
// same idempotency key, and write the snapshot and its event atomically.
import { createHash, randomBytes } from 'node:crypto';
import {
  availableSlots,
  buildOrderSnapshot,
  businessDayOf,
  canBookSlot,
  cartPrepWeight,
  checkClientTotal,
  totalTampering,
  normalizeIdentity,
  normalizePhone,
  authorizationEvent,
  placementEvent,
  readyEstimate,
  reviewCart,
  zonedTimeToInstant,
  type Cart,
  type CartError,
  checkoutGate,
  restaurantClock,
  type CartReview,
  type GateReason,
  type IdentityViolation,
  type OrderEventDraft,
  type TotalMismatch,
  type VerifiedPhoneLogOutcome,
} from '@countertop/core';
import { Prisma, prisma } from './index';
import { eventRow } from './event-row';
import { loadGateState } from './gate';
import { loadMenu } from './menu';
import {
  confirmCheckoutRedemption,
  hasLoyaltyPepper,
  phoneDigest,
  planCheckoutReward,
  writeCheckoutRedemption,
  type PlannedCheckoutRedemption,
  type RedemptionConfirmRefusal,
} from './loyalty';
import { verifiedPhoneFromToken } from './verification';

/**
 * Everything a receipt, a confirmation and a kitchen ticket render — and
 * nothing from a menu table. Exported so every reader of a placed order uses
 * the same shape; the day one of them adds a menu `include` is the day the
 * snapshot rule quietly stops holding.
 */
export const ORDER_RECEIPT = {
  /**
   * Where the bag is, structurally out of reach (PRD 2 P0-5, C-062).
   *
   * `shelfLocation` is the one mutable column on `Order` and the requirement
   * says it never appears on a customer-facing receipt. "Nobody renders it" is
   * a convention that lasts until the next person adds a field to a receipt;
   * omitting it here means the TYPE does not have it, so the customer's status
   * page, the staff receipt and the placement confirmation cannot render it
   * even by accident — and the snapshot regression test's byte-identical
   * assertion goes on holding across a shelf edit by construction rather than
   * by remembering to check.
   *
   * `QUEUE_ORDER` spreads only `.include`, so the kitchen card — the one
   * screen that is about where the food physically is — still gets it.
   */
  omit: { shelfLocation: true },
  include: {
    lines: {
      orderBy: { lineNumber: 'asc' },
      include: { options: { orderBy: { sortOrder: 'asc' } } },
    },
    // The money events, so any holder of a receipt can ask `orderBalance` what
    // is still owed (C-064). Four scalars per event, not the whole row: a
    // receipt has no business carrying the actor or the detail payload, and
    // this is the shape `MoneyEvent` and `RefundEvent` between them ask for.
    //
    // `id` and `refundRequestId` joined the two money scalars in C-071, and
    // they are structure rather than content: `pendingRefunds` places each
    // attempt against the request it was made for, which is a question about
    // the SHAPE of the log. The customer's status page reads the same select
    // and renders one boolean off it — the `detail` payload that carries the
    // provider's words and the counter's notes is still structurally out of
    // its reach, which is the property this select exists to keep.
    // `authorizationId` joined them in C-069, and it is structure in the same
    // way `refundRequestId` is: `heldAuthorization` asks which hold is unspent,
    // which is a question about the shape of the log. The customer's status
    // page reads this same select and renders a payment line off it — the
    // `detail` payload is still structurally out of its reach.
    events: {
      select: {
        id: true,
        kind: true,
        amountCents: true,
        refundRequestId: true,
        authorizationId: true,
      },
    },
  },
} as const satisfies Prisma.OrderDefaultArgs;

export type OrderReceipt = Prisma.OrderGetPayload<typeof ORDER_RECEIPT>;

export type PlacementError =
  | IdentityViolation
  | CartError
  | { kind: 'empty_cart'; message: string }
  | { kind: 'idempotency_key_required'; message: string }
  | { kind: 'price_changed'; message: string }
  // The checkout gate refusing the order (P0-6). Carries the trigger, so the
  // screen can say "we open at 11:00" rather than a generic failure — and so
  // the seeded rush can assert WHICH gate bounced an order.
  | { kind: 'ordering_closed'; reason: GateReason; message: string }
  // The P1-2 sibling gate refusing a REQUESTED slot: the feature is off, the
  // minute was never offered, or it filled in the moment between the
  // customer's screen rendering and this request landing. Never `reason`-typed
  // like the ASAP gate — none of those three is a customer-facing distinction
  // worth naming, they are all "pick a different time".
  | { kind: 'slot_unavailable'; message: string }
  /**
   * A checkout submission asked to spend a reward and could not (PRD 7 P1-1,
   * C-118).
   *
   * REFUSED, NEVER SILENTLY PLACED AT THE UNDISCOUNTED PRICE, and that is the
   * decision in this kind existing at all. The customer pressed a button
   * reading "Place order — $13.51"; charging them $23.51 because their
   * verification expired between typing a code and typing a name is precisely
   * the "a precise wrong number is worse than an honest range" failure this
   * product has a rule about. The refusal carries the reason so the screen can
   * say which of the several things went wrong, and the form keeps everything
   * typed so re-submitting without the reward is one tap.
   */
  | { kind: 'reward_unavailable'; reason: RewardRefusal; message: string };

/** Everything that can stop a reward at checkout: the token's own refusals
 *  (C-116) and the ledger's (C-104/C-118), under one name so a screen renders
 *  one set of words. */
export type RewardRefusal = RedemptionConfirmRefusal | VerifiedPhoneLogOutcome;

export type PlacementInput = {
  cart: Cart;
  /** Client-generated, unique-constrained (P0-10). The constraint is the
   *  mechanism; the disabled submit button is UX. */
  idempotencyKey: string;
  /** The instant of placement. Passed in, never read here — the engine takes
   *  `now` as a parameter and so does its caller. */
  now: Date;
  customerName?: string | null | undefined;
  customerPhone?: string | null | undefined;
  orderNote?: string | null | undefined;
  /** What the browser thought the total was. Input to a mismatch LOG, never
   *  to the database (P0-2). */
  clientTotalCents?: number;
  /** P1-8. The mock provider took the money at checkout; false (and absent) is
   *  "pay at pickup", which is what the kitchen card flags. A BOOLEAN, not a
   *  `PaymentState`: `refunded` is something that happens to an order later,
   *  never something a checkout request may ask for. */
  paidNow?: boolean;
  /** P1-2. The local minute-of-day the customer picked off `availableSlots`,
   *  or absent for an ASAP order — the two kinds are told apart by whether
   *  this is present, the same way `Order.requestedFor` tells them apart
   *  afterward. Never trusted as a slot's VALIDITY; re-checked here against a
   *  fresh `availableSlots` read, the same discipline `reviewCart` applies to
   *  a cart. */
  requestedForMinute?: number;
  /**
   * The bearer string a confirmed phone verification minted for THIS checkout
   * attempt (C-116), spent here (C-118).
   *
   * NOT AN AMOUNT, and it never becomes one on the way in. The token proves a
   * phone; `planCheckoutReward` reads the program's own `rewardValueCents` off
   * the settings row and bounds it against the subtotal THIS function priced.
   * There is no field on this type, or on the request behind it, through which
   * a client can name a discount — the same rule that makes `clientTotalCents`
   * evidence for a log rather than an input to a column.
   */
  verifiedPhoneToken?: string | null;
};

export type PlacementResult =
  | {
      ok: true;
      order: OrderReceipt;
      replayed: boolean;
      /**
       * What the submission's verified-phone token did (C-116, spent C-118).
       *
       * Returned rather than logged here for the same reason `mismatch` is:
       * this function has several callers and only one of them is behind a
       * request. Null when no token was presented, which is the ordinary case.
       */
      verifiedPhone: VerifiedPhoneLogOutcome | null;
    }
  | {
      ok: false;
      errors: PlacementError[];
      review: CartReview;
      /**
       * P0-2's evidence on the path that used to swallow it (C-084).
       *
       * The mismatch is computed inside the write path below, which means a
       * request that tampered with the total AND failed validation returned
       * from here before anything looked at the client's number — recorded
       * nowhere at all. Returned rather than logged here because this function
       * has four callers and only one of them is behind a request; the
       * boundary decides what reaches a log.
       */
      mismatch: TotalMismatch | null;
    };

/**
 * How many order numbers to try before giving up. Each retry means another
 * placement won that number in the microseconds since we read the maximum, so
 * this is a concurrency depth, not a delay — 25 simultaneous checkouts is
 * already a harder rush than the throttle (P0-6, default 60 units of open prep
 * weight — roughly 22 orders of the seeded menu) lets happen.
 */
const MAX_SEQ_ATTEMPTS = 25;

/** ≥128 bits, so order numbers cannot be walked into someone else's status
 *  page (P0-8, hardened in P1-5). 24 bytes = 192 bits.
 *
 *  Exported at C-066: a remake is a real order and its customer watches it on
 *  a real status link, so it needs a real token. One generator, because "how
 *  many bits is a status token" must have exactly one answer. */
export const newStatusToken = (): string => randomBytes(24).toString('base64url');

/** The unique constraint a P2002 names, or null if it was some other error. */
function uniqueViolationTarget(error: unknown): string | null {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') {
    return null;
  }
  // `target` is the field list for a Prisma-generated index and the index name
  // for a hand-written one; both spell the column, so match on the text.
  return JSON.stringify(error.meta?.target ?? '');
}

/**
 * Take the next order number for a business day, contending on the UNIQUE
 * CONSTRAINT rather than on a check-then-write (CLAUDE.md's database rule).
 *
 * Extracted at C-066, when a remake became a second thing that needs an order
 * number. It is deliberately not left inline and copied: the whole point of
 * the rule is that nothing reads the maximum and then trusts it, and a second
 * hand-written copy of a retry loop is the obvious place for that to be got
 * subtly wrong. One loop, two callers — the same discipline as the one status
 * module and the one orderability function.
 *
 * `create` is handed a candidate number and does the insert. A collision on
 * `seq` or `statusToken` is the retry this exists to force; the maximum is
 * re-read on every attempt, because a retry only happens when somebody else
 * took the number and a cached maximum would collide again.
 *
 * `recover` is for a unique violation that is NOT a number collision and is
 * not an error either — placement's idempotency replay is the only one. It
 * returns a value to stop with, or null to rethrow.
 */
export async function takingNextOrderNumber<T>(
  businessDay: string,
  create: (seq: number) => Promise<T>,
  recover?: (target: string) => Promise<T | null>,
): Promise<T> {
  for (let attempt = 0; attempt < MAX_SEQ_ATTEMPTS; attempt += 1) {
    // Read the maximum fresh on every attempt: a retry only happens because
    // someone else took the number, so a cached maximum would collide again.
    const highest = await prisma.order.aggregate({
      where: { businessDay },
      _max: { seq: true },
    });

    try {
      return await create((highest._max.seq ?? 0) + 1);
    } catch (error) {
      const target = uniqueViolationTarget(error);
      if (target === null) throw error;

      if (recover) {
        const recovered = await recover(target);
        if (recovered !== null) return recovered;
      }

      // A seq or a statusToken collision: take the next number and a new
      // token. This is the retry the unique constraint exists to force —
      // never a check-then-write, which has a window between the two.
      if (!target.includes('seq') && !target.includes('statusToken')) throw error;
    }
  }

  throw new Error(
    `Could not take an order number for ${businessDay} in ${MAX_SEQ_ATTEMPTS} attempts`,
  );
}

export const findOrderByIdempotencyKey = (idempotencyKey: string): Promise<OrderReceipt | null> =>
  prisma.order.findUnique({ where: { idempotencyKey }, ...ORDER_RECEIPT });

/**
 * A UUID derived from a name, for the scripts (C-052, defect D3).
 *
 * The seed and the rush cannot use `randomUUID()`: the rush's key is load-
 * bearing logic — a retry must get a NEW key because it is a different order,
 * and the double-submit must get the SAME one — and a seed that writes
 * different keys every run stops being a fixture. They wrote `seed-order-0`
 * and `rush-Dana-11` instead, which is a guessable read handle on a real
 * database, and the deployed demo has a table full of them.
 *
 * Name-based, like a UUIDv5, so the same name always yields the same UUID and
 * two different names never collide in practice. SHA-256 rather than the
 * RFC's SHA-1 because it costs nothing here and is one less thing to defend;
 * the version nibble still says 5, which is the truthful one — this value is
 * derived from a name, not random, and pretending it is a v4 would be a lie
 * told to a regex.
 *
 * This is NOT a way to make a public key safe. It is how a trusted script
 * writes rows that look like every other row.
 */
export function derivedIdempotencyKey(name: string): string {
  const hex = createHash('sha256').update(`countertop:idempotency:${name}`).digest('hex');
  const variant = ((parseInt(hex.slice(16, 17), 16) & 0x3) | 0x8).toString(16);
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `5${hex.slice(13, 16)}`,
    `${variant}${hex.slice(17, 20)}`,
    hex.slice(20, 32),
  ].join('-');
}

/**
 * The customer's status page (C-014, P0-5, P0-8).
 *
 * The token is the ONLY handle on an order from outside the building: the
 * UUID never appears in a URL, and the order NUMBER deliberately is not a key
 * here — #047 is guessable, and a page keyed on it would let anyone read
 * today's orders by counting. Same `ORDER_RECEIPT` shape as the confirmation,
 * so the status page renders from the snapshot with zero menu joins.
 */
export const findOrderByStatusToken = (statusToken: string): Promise<OrderReceipt | null> =>
  prisma.order.findUnique({ where: { statusToken }, ...ORDER_RECEIPT });

/**
 * A reward that stopped being spendable after this placement was priced
 * (C-119).
 *
 * An Error because that is what rolls a Prisma interactive transaction back,
 * and the rollback is the point: the order row, its lines, its options and
 * its `placed` event all go with it, so a customer whose reward evaporated
 * gets no order rather than an order at a price they never saw. It never
 * escapes `placeOrder`, which turns it back into the ordinary
 * `reward_unavailable` refusal the screen already renders.
 */
class RewardLost extends Error {
  constructor(
    readonly reason: RewardRefusal,
    message: string,
  ) {
    super(message);
    this.name = 'RewardLost';
  }
}

/**
 * Check the token, then ask the ledger what it may spend (PRD 7 P1-1, C-118).
 *
 * THE SIGNATURE IS CHECKED BEFORE THE BALANCE IS LOOKED UP, and the phone it
 * is checked against is the one snapshotted onto THIS order — not the one the
 * token claims. `verifiedPhoneFromToken` compares the two and refuses
 * `phone_mismatch`, so a token minted for a number with a reward behind it
 * cannot be presented on an order placed under a different number. Its other
 * two refusals close the rest: `wrong_order` binds it to this attempt's
 * idempotency key, and `expired` to its ten minutes.
 *
 * ONE OUTCOME WORD ON EVERY PATH, refusal or not, because C-116 established
 * that "the token checked out" and "it did not" is the log line support reads
 * when a customer says their reward did not come off.
 */
async function resolveCheckoutReward(
  token: string,
  /** The order's OWN phone, as `normalizeIdentity` trimmed it. */
  customerPhone: string | null,
  idempotencyKey: string,
  subtotalCents: number,
  now: Date,
): Promise<
  | { ok: true; plan: PlannedCheckoutRedemption; outcome: VerifiedPhoneLogOutcome }
  | { ok: false; error: PlacementError; outcome: VerifiedPhoneLogOutcome }
> {
  const refuse = (reason: RewardRefusal, message: string) =>
    ({ ok: false as const, error: { kind: 'reward_unavailable' as const, reason, message }, outcome: reason });

  if (!hasLoyaltyPepper()) {
    return refuse('loyalty_pepper_unset', 'The loyalty program is not configured.');
  }
  const normalized = normalizePhone(customerPhone);
  if (!normalized) {
    // The customer cleared or changed the phone field after verifying it.
    return refuse(
      'phone_not_enrollable',
      'Add back the phone number you verified, or place the order without the reward.',
    );
  }

  const read = verifiedPhoneFromToken(token, {
    idempotencyKey,
    phoneDigest: phoneDigest(normalized.digits),
    now,
  });
  if (!read.ok) return refuse(read.reason, read.message);

  const reward = await planCheckoutReward({ phone: customerPhone, subtotalCents });
  if (!reward.ok) return refuse(reward.reason, reward.message);
  return { ok: true, plan: reward.plan, outcome: 'verified' };
}

/**
 * Place the cart.
 *
 * Order of operations matters and is deliberate:
 *
 *   1. The idempotency key FIRST. A retry returns the original order even if
 *      the menu has since changed under it — the customer's second tap must
 *      not be told their food is sold out when it is already being made
 *      (P0-10).
 *   2. Then re-price and re-validate against the live menu. This is the
 *      placement call site of the orderability function, and the second of the
 *      two server-side price computations P0-2 requires.
 *   3. Then one `create`: order, lines, options and the `placed` event in a
 *      single statement, so a snapshot can never exist without the event that
 *      says it was placed.
 */
export async function placeOrder(input: PlacementInput): Promise<PlacementResult> {
  const { cart, idempotencyKey, now } = input;

  // Before anything else, and before the menu is even read: a retry answers
  // out of the orders table, not out of today's menu.
  if (idempotencyKey !== '') {
    const existing = await findOrderByIdempotencyKey(idempotencyKey);
    // NO TOKEN IS READ ON A REPLAY, deliberately, and it matters more since
    // C-118 than it did before: the reward is already snapshotted onto the
    // order this returns, so re-checking a ten-minute token here would refuse
    // a second tap — with the reward correctly applied on the row — the moment
    // a customer took eleven minutes over the payment radio.
    // `verifiedPhone: null` and not a word, because no token was read to have
    // one — which is the honest log line for a replay and not an omission.
    if (existing) return { ok: true, order: existing, replayed: true, verifiedPhone: null };
  }

  // `loadMenu(now)` and not `loadMenu()`: a staged price is resolved against
  // the restaurant's calendar day (P1-2), and placement's whole discipline is
  // that ONE instant answers every time question it asks. A default `new
  // Date()` here would also price the seeded rush and the seed's backdated
  // orders against today rather than against the minute they were placed.
  const [menu, settings] = await Promise.all([loadMenu(now), loadGateState(now)]);
  // ONE wall-clock reading for the whole placement: the daypart check inside
  // `reviewCart` and the store-hours check inside `checkoutGate` below are
  // asked about the same instant. Two readings could refuse a line for being
  // past 16:00 and open the door for being before it.
  const clock = restaurantClock(now, settings.timezone);
  const businessDay = businessDayOf(now, settings.timezone);
  const review = reviewCart(menu, cart, settings.taxRatePpm, clock);
  const identity = normalizeIdentity(input);
  const errors: PlacementError[] = identity.ok ? [] : [...identity.violations];

  // The gate, asked HERE and not only by the screen (P0-6). A pause that stops
  // the button but not the POST is not a pause — and this is the same function
  // the cart page calls, so the two can never disagree about why.
  //
  // Deliberately AFTER the idempotency replay above: a retry of an order that
  // is already on the grill must return that order, not be told the restaurant
  // has since closed. The gate is asked about NEW orders only.
  //
  // A REQUESTED slot (P1-2) asks a sibling question instead, and does not ask
  // this one at all: `availableSlots` already refuses the manual pause and a
  // closed-today override on its own, and a scheduled promise for later today
  // is not "too busy right now" or "closing soon" — those are about the ASAP
  // queue this order is deliberately skipping.
  let requestedFor: Date | null = null;
  if (input.requestedForMinute === undefined) {
    const gate = checkoutGate(settings, clock);
    if (!gate.open) {
      errors.push({ kind: 'ordering_closed', reason: gate.reason, message: gate.message });
    }
  } else if (!settings.scheduledOrdersEnabled) {
    // Not a customer-facing distinction: the checkout screen never sends this
    // field unless the settings row that also controls it said yes.
    errors.push({
      kind: 'slot_unavailable',
      message: 'That pickup time is no longer available. Pick another.',
    });
  } else {
    const schedule = availableSlots(settings, settings.scheduleConfig, settings.weightBySlot, clock);
    if (!schedule.open) {
      errors.push({ kind: 'ordering_closed', reason: schedule.reason, message: schedule.message });
    } else if (!canBookSlot(schedule.slots, input.requestedForMinute, cartPrepWeight(menu, cart))) {
      // A stale list, not a customer's typo: the picker only ever renders
      // minutes `availableSlots` itself generated, so this means the slot
      // filled — or the clock moved past the lead time — in the gap between
      // that render and this request.
      errors.push({
        kind: 'slot_unavailable',
        message: 'That pickup time is no longer available. Pick another.',
      });
    } else {
      requestedFor = zonedTimeToInstant(businessDay, input.requestedForMinute, settings.timezone);
    }
  }

  if (idempotencyKey === '') {
    errors.push({
      kind: 'idempotency_key_required',
      message: 'That order could not be read. Try again.',
    });
  }
  if (cart.lines.length === 0) {
    errors.push({ kind: 'empty_cart', message: 'Your cart is empty.' });
  }
  for (const line of review.lines) errors.push(...line.problems);
  if (review.needsPriceConfirmation) {
    errors.push({
      kind: 'price_changed',
      message: 'A price changed while you were ordering. Check the new total before placing.',
    });
  }

  if (errors.length > 0 || !identity.ok) {
    return { ok: false, errors, review, mismatch: totalTampering(review, input.clientTotalCents) };
  }

  // ponytail: the re-check above and the write below are not one transaction,
  // so an 86 landing in the milliseconds between them is snapshotted anyway.
  // Deliberate: that order is indistinguishable from one placed a second
  // before the 86, which no isolation level can prevent either, and the
  // operational answer already exists — staff cancel it with reason
  // `out_of_item` (C-004). Locking the menu rows for every checkout would buy
  // a millisecond of a window that stays open for minutes regardless.
  //
  // PRICED TWICE, ON PURPOSE, when a reward is in play. The first call is the
  // undiscounted truth and its `subtotalCents` is what bounds the reward —
  // taking that bound from `review.totals` instead would tie a database CHECK
  // (`discountCents <= subtotalCents`) to a number computed by a different
  // function, and the day the two drifted the symptom would be a 500 at
  // checkout rather than a test. Both calls are pure and read the same menu.
  const undiscounted = buildOrderSnapshot(menu, cart, settings.taxRatePpm);

  // The reward (PRD 7 P1-1, C-118), decided here and nowhere else: the token
  // is checked, the member is looked up, and the AMOUNT comes off the settings
  // row. `redemption` is null on every checkout that did not present a token,
  // which is every checkout this product placed before this session.
  let redemption: PlannedCheckoutRedemption | null = null;
  let verifiedPhone: VerifiedPhoneLogOutcome | null = null;
  if (input.verifiedPhoneToken) {
    const reward = await resolveCheckoutReward(
      input.verifiedPhoneToken,
      identity.identity.customerPhone,
      idempotencyKey,
      undiscounted.subtotalCents,
      now,
    );
    verifiedPhone = reward.outcome;
    if (!reward.ok) {
      return {
        ok: false,
        errors: [reward.error],
        review,
        mismatch: totalTampering(review, input.clientTotalCents),
      };
    }
    redemption = reward.plan;
  }

  const snapshot = redemption
    ? buildOrderSnapshot(menu, cart, settings.taxRatePpm, redemption.amountCents)
    : undiscounted;

  // What we are promising this customer (P1-4), off the SAME `settings` read
  // the gate above used — so the quote stored on the order is the one the
  // checkout screen showed, not a second reading of a queue that moved in
  // between. `openWeight` here excludes this order, which is right: the wait
  // is the work already in front of it.
  //
  // Null for a scheduled order (P1-2): its promise IS `requestedFor`, not a
  // range against a live queue it is deliberately skipping — the same "no
  // record" honesty `quotedLowMinutes` already uses for orders placed before
  // C-042 ever quoted anything.
  const quote = requestedFor ? null : readyEstimate(settings);

  // The server's number is the answer; the client's is evidence (P0-2).
  const mismatch =
    input.clientTotalCents === undefined
      ? null
      : checkClientTotal(snapshot.totalCents, input.clientTotalCents);
  const events: OrderEventDraft[] = [placementEvent(now)];
  // A HOLD, NOT A CHARGE (PRD 3 P1-1, C-069). C-085 wrote a `payment` here,
  // which meant the restaurant had taken the money before anybody had cooked
  // anything — and in a pickup-only shop that puts the transaction at the wrong
  // end: the customer who never comes has already been charged, so making them
  // whole costs a refund that can fail. An authorization is taken here and
  // CAPTURED at the counter (`transitions.ts`), or voided if the food never
  // leaves. Nothing about the customer's experience changes; what changes is
  // that a no-show costs a void.
  if (input.paidNow) events.push(authorizationEvent(now, snapshot.totalCents));
  if (mismatch) {
    events.push({
      at: now,
      kind: 'total_mismatch',
      fromStatus: null,
      toStatus: null,
      actor: 'customer',
      reason: 'client total did not match the server total',
      detail: { ...mismatch },
    });
  }

  const rewardRefused = (error: RewardLost): PlacementResult => ({
    ok: false,
    errors: [{ kind: 'reward_unavailable', reason: error.reason, message: error.message }],
    review,
    mismatch: totalTampering(review, input.clientTotalCents),
  });

  try {
    return await takingNextOrderNumber(
    businessDay,
    async (seq) => {
      // ONE TRANSACTION, and C-118 is what made it one. Before this session
      // placement was a single `create` and needed no wrapper; a checkout
      // redemption adds a second row in a different table, and an `Order`
      // carrying `discountCents: 1000` with no `redeem` beside it is ten
      // dollars given away with nothing on the ledger to explain it — C-104's
      // "either half alone is a defect somebody finds at close", one layer
      // earlier. The P2002 the retry loop above catches still propagates out
      // of here unchanged; what changes is that the losing attempt takes its
      // ledger row down with it.
      const order = await prisma.$transaction(async (tx) => {
      // BEFORE `Order.create`, and that ordering is the point (C-119).
      //
      // The balance this reward was planned against was read outside any
      // transaction, which made it a read-then-write: two checkouts for one
      // member, in flight at once, each saw 100 points and each wrote a
      // `redeem`, leaving the member at −100 with two $10 rewards for one.
      // The per-order unique index cannot catch it — it is per ORDER, and
      // these are two orders. `confirmCheckoutRedemption` takes the member's
      // row lock and re-asks the SAME plan function against what is behind
      // it; the second checkout blocks here and then sees the points gone.
      //
      // First rather than after the order, because a refusal rolls this
      // transaction back and rolling back an `Order.create` leaves a GAP in
      // the day's numbers — #005 then #007, with nothing in between and
      // nobody able to say why. Locking first costs nothing.
      if (redemption) {
        const confirmed = await confirmCheckoutRedemption(tx, redemption, now);
        if (!confirmed.ok) throw new RewardLost(confirmed.reason, confirmed.message);
      }
      const created = await tx.order.create({
        data: {
          businessDay,
          seq,
          ...identity.identity,
          status: 'placed',
          placedAt: now,
          statusChangedAt: now,
          subtotalCents: snapshot.subtotalCents,
          discountCents: snapshot.discountCents,
          taxCents: snapshot.taxCents,
          taxRatePpm: snapshot.taxRatePpm,
          totalCents: snapshot.totalCents,
          prepWeight: snapshot.prepWeight,
          quotedLowMinutes: quote?.lowMinutes ?? null,
          quotedHighMinutes: quote?.highMinutes ?? null,
          quotedOpenWeight: quote ? settings.openWeight : null,
          requestedFor,
          // `authorized` and not `paid` (C-069): the card is held and nothing
          // has been taken. The column is a cache over the log either way —
          // `derivePaymentState` returns exactly this for an order carrying one
          // `authorization` and nothing else, and the seeded-rush agreement
          // test is what holds the two together.
          paymentState: input.paidNow ? 'authorized' : 'unpaid',
          statusToken: newStatusToken(),
          idempotencyKey,
          lines: {
            create: snapshot.lines.map((line) => ({
              lineNumber: line.lineNumber,
              menuItemId: line.menuItemId,
              itemName: line.itemName,
              categoryName: line.categoryName,
              basePriceCents: line.basePriceCents,
              quantity: line.quantity,
              unitPriceCents: line.unitPriceCents,
              lineTotalCents: line.lineTotalCents,
              note: line.note,
              options: { create: line.options },
            })),
          },
          // Not point-free: `eventRow` takes a second argument now (C-086's
          // staff id) and `map` would hand it the index. Every event written
          // here is the customer's own — a placement, its charge, its
          // mismatch — so none of them is stamped anyway.
          events: { create: events.map((draft) => eventRow(draft)) },
        },
        ...ORDER_RECEIPT,
      });
      // AFTER the order exists and inside its transaction, so the points and
      // the price they bought commit together or not at all. The check that
      // this is still allowed happened above, under the lock this transaction
      // is still holding.
      if (redemption) await writeCheckoutRedemption(tx, created.id, redemption, now);
      return created;
      });
      return { ok: true, order, replayed: false, verifiedPhone } as PlacementResult;
    },
    // Two double-taps racing: the loser reads the winner's order and returns
    // it, which is the same answer the fast path gives. Null means "not this
    // constraint" and lets the retry loop go on doing its job.
    async (target) => {
      if (!target.includes('idempotencyKey')) return null;
      const winner = await findOrderByIdempotencyKey(idempotencyKey);
      return winner
        ? ({ ok: true, order: winner, replayed: true, verifiedPhone } as PlacementResult)
        : null;
    },
    );
  } catch (error) {
    // The one throw this function answers rather than propagates. Everything
    // else — a price engine refusing an unknown id, a socket dying — is still
    // the boundary's to catch, which is where `logPlacement` can name it.
    if (error instanceof RewardLost) return rewardRefused(error);
    throw error;
  }
}
