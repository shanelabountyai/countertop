// Enrolment, and the counter lookup (PRD 7 P0-1, C-101).
//
// THE PHONE IS NEVER STORED. `LoyaltyMember.phoneDigest` is an HMAC-SHA256 of
// the normalised number under a pepper held in the ENVIRONMENT, so a dump of
// the loyalty tables is not a customer list. `Order.customerPhone` still holds
// what was typed, in clear, and is unchanged — a different fact with a
// different retention story, deleted by PRD 6's forget path.
//
// HERE AND NOT IN `apps/web`, for the same reason `staff.ts` is: this file is
// the one thing standing between "we keep a phone number" and "we keep a
// digest of one", and `apps/web` has no unit suite to hold it to that.
import { createHmac } from 'node:crypto';
import {
  LOYALTY_RESPEND_REASON,
  LOYALTY_RETURN_REASON,
  LOYALTY_REWARD_REASON,
  cutoffDaysBefore,
  loyaltyBalance,
  loyaltyLiability,
  normalizePhone,
  orderBalance,
  planCheckoutRedemption,
  planRedemption,
  pointsForOrder,
  redemptionRate,
  redemptionStateFor,
  salesRoleOf,
  settleRedemption,
  type LoyaltyEventKind,
  type LoyaltyLiability,
  type LoyaltyTerms,
  type OrderStatus,
  type RedemptionRefusalReason,
} from '@countertop/core';
import { adjustOrder } from './adjustment';
import { Prisma, prisma } from './index';

const PEPPER_VAR = 'LOYALTY_PHONE_PEPPER';

/**
 * The pepper, or the empty string.
 *
 * AN ENV SECRET, WHERE THE STAFF PIN'S SALT IS A CONSTANT, and the difference
 * is the whole reason this file exists. `staff.ts` admits its salt is a
 * constant and that anybody holding that table can recover every four-digit
 * PIN in a second; that is acceptable there because the PIN is a stamp behind
 * a passcode, not a credential. A phone number has a keyspace of about ten
 * billion and a plausible one has far less — an unpeppered digest of one is
 * decorative, brute-forced from a stolen table in minutes. The pepper is the
 * thing that is not in the backup.
 *
 * ROTATING IT ORPHANS EVERY MEMBER, exactly the way rotating `STAFF_PASSCODE`
 * ends every shift: the digests no longer match anything a customer types, so
 * balances become unreachable rather than wrong. That is a real operational
 * constraint and it is the price of the phone not being in the table.
 */
export const loyaltyPepper = (): string => process.env[PEPPER_VAR] ?? '';

/** Whether enrolment can happen at all. Read by the checkout screen too: a
 *  program switched on with no pepper configured must not render a checkbox
 *  that cannot do anything. */
export const hasLoyaltyPepper = (): boolean => loyaltyPepper() !== '';

/**
 * The stored value. THROWS on an unset pepper, deliberately.
 *
 * The alternative — hashing under an empty key — produces a perfectly stable
 * digest that becomes wrong the moment the pepper is configured, silently
 * orphaning every member enrolled before it. A throw is louder than a
 * migration nobody knows they need. Every caller checks `hasLoyaltyPepper`
 * first and refuses by name, so this is a programmer error, not a request one.
 */
export function phoneDigest(digits: string): string {
  const pepper = loyaltyPepper();
  if (pepper === '') throw new Error(`${PEPPER_VAR} is not set`);
  return createHmac('sha256', pepper).update(`countertop-loyalty-phone:${digits}`).digest('hex');
}

/** Why an enrolment did not happen. Named rather than silent — a customer who
 *  ticked the box and was not enrolled is a support call, and "it failed" is
 *  not an answer to it. */
export type EnrolmentRefusal =
  | 'loyalty_disabled'
  | 'loyalty_pepper_unset'
  | 'phone_not_enrollable';

export type EnrolmentResult =
  | { ok: true; memberId: string }
  | { ok: false; reason: EnrolmentRefusal };

/**
 * Enrol, or find the member who is already there (P0-1).
 *
 * An UPSERT on the digest, so the same phone typed two ways across two orders
 * is one member — and so two checkouts racing produce one row rather than one
 * row and a unique violation. `update: {}` on a hit: a returning member keeps
 * the name and the instant they enrolled under, and `lastActivityAt` is moved
 * by an earn or a redeem (C-102, C-104), never by ordering again under a
 * different name.
 *
 * The settings row is read HERE rather than trusted from the caller: this is
 * the write, and `loyaltyEnabled: false` has to mean no ledger row exists no
 * matter which screen asked.
 */
export async function enrolMember(input: {
  /** As typed. Normalised and digested here; never written anywhere. */
  phone: string | null | undefined;
  /** The name off the placed order, already trimmed and length-checked by
   *  `normalizeIdentity`. Copied at enrolment, like every other snapshot. */
  displayName: string;
  now: Date;
}): Promise<EnrolmentResult> {
  const settings = await prisma.restaurantSettings.findUniqueOrThrow({
    where: { id: 'singleton' },
    select: { loyaltyEnabled: true },
  });
  if (!settings.loyaltyEnabled) return { ok: false, reason: 'loyalty_disabled' };
  if (!hasLoyaltyPepper()) return { ok: false, reason: 'loyalty_pepper_unset' };

  const phone = normalizePhone(input.phone);
  if (!phone) return { ok: false, reason: 'phone_not_enrollable' };

  const digest = phoneDigest(phone.digits);
  const member = await prisma.loyaltyMember.upsert({
    where: { phoneDigest: digest },
    update: {},
    create: {
      phoneDigest: digest,
      phoneLast4: phone.last4,
      displayName: input.displayName,
      enrolledAt: input.now,
      lastActivityAt: input.now,
    },
    select: { id: true },
  });
  return { ok: true, memberId: member.id };
}

/** What the counter sees about a member. The last four and a name, because
 *  "the one ending 2233, Ivy" is what a person confirms out loud — and the
 *  balance, because that is the question being asked. Never the digest. */
export type LoyaltyMemberView = {
  id: string;
  displayName: string;
  phoneLast4: string;
  balance: number;
  enrolledAt: Date;
  lastActivityAt: Date;
};

/**
 * The counter lookup (P0-1). Hashes the typed number and matches the digest,
 * so THE PLAINTEXT NEVER REACHES A `where` — the same discipline `staffByPin`
 * applies, and here it is load-bearing: a `contains` on a phone column is the
 * query that turns a loyalty program into a searchable customer index.
 *
 * The balance is summed by the pure function over the member's own rows, not
 * read from a column, because there is no balance column and P0-2 says why.
 */
export async function memberByPhone(phone: string): Promise<LoyaltyMemberView | null> {
  if (!hasLoyaltyPepper()) return null;
  const normalized = normalizePhone(phone);
  if (!normalized) return null;

  const member = await prisma.loyaltyMember.findUnique({
    where: { phoneDigest: phoneDigest(normalized.digits) },
    select: {
      id: true,
      displayName: true,
      phoneLast4: true,
      enrolledAt: true,
      lastActivityAt: true,
      events: { select: { kind: true, points: true } },
    },
  });
  if (!member) return null;

  const { events, ...rest } = member;
  return { ...rest, balance: loyaltyBalance(events) };
}

/** The program as configured, for the screens that have to describe it before
 *  anybody has earned anything. */
export type LoyaltyOffer = {
  /** Both halves of "can we offer this": the switch, and a pepper to hash
   *  under. One boolean, so a screen cannot check a different pair than the
   *  writer does. */
  offered: boolean;
  terms: LoyaltyTerms;
  expiryDays: number;
};

// --- Earning at pickup (P0-3, C-102) ---------------------------------------

/** What happened to an order's points. Named for the same reason enrolment's
 *  refusals are: "no points appeared" is a support call, and the answer is one
 *  of these words. */
export type EarnOutcome =
  | 'earned'
  /** The revert-and-re-advance. The INDEX said so, not a check-then-write. */
  | 'already_earned'
  | 'loyalty_disabled'
  | 'loyalty_pepper_unset'
  /** Nobody enrolled under this order's phone — the ordinary case. */
  | 'not_a_member'
  /** Under a dollar of subtotal. An `earn` of zero would fail the sign CHECK,
   *  correctly: a ledger row worth nothing is noise in a balance. */
  | 'nothing_to_earn';

/**
 * Write the one `earn` an order gets (P0-3).
 *
 * INSIDE THE CALLER'S TRANSACTION, unlike enrolment. The two look similar and
 * are not: enrolment hangs off a placement and must never fail it, because a
 * punch card that did not start must not cost a customer their food. The earn
 * hangs off a status change, and a `picked_up` that committed without its
 * ledger row is a customer who handed over money, took the food, and earned
 * nothing with no second chance — there is no later moment to retry from.
 *
 * THE CONSTRAINT IS THE MECHANISM. `skipDuplicates` is `ON CONFLICT DO
 * NOTHING`, and the partial unique index on `(orderId) WHERE kind = 'earn'`
 * (C-100) is what it lands on. The state machine PERMITS a revert, so
 * `ready → picked_up` twice on one order is a supported operation and not an
 * edge case; a check-then-write in front of this would be two cooks' taps away
 * from a double earn. Same discipline as placement's idempotency key.
 *
 * The points come from the order's SNAPSHOTTED subtotal. No menu row is read,
 * nothing is recomputed, and tax earns nothing.
 */
export async function earnForOrder(
  tx: Prisma.TransactionClient,
  order: { id: string; customerPhone: string | null; subtotalCents: number },
  now: Date,
): Promise<EarnOutcome> {
  const settings = await tx.restaurantSettings.findUniqueOrThrow({
    where: { id: 'singleton' },
    select: {
      loyaltyEnabled: true,
      pointsPerDollar: true,
      rewardThresholdPoints: true,
      rewardValueCents: true,
    },
  });
  if (!settings.loyaltyEnabled) return 'loyalty_disabled';
  if (!hasLoyaltyPepper()) return 'loyalty_pepper_unset';

  const phone = normalizePhone(order.customerPhone);
  if (!phone) return 'not_a_member';
  const member = await tx.loyaltyMember.findUnique({
    where: { phoneDigest: phoneDigest(phone.digits) },
    select: { id: true },
  });
  if (!member) return 'not_a_member';

  const points = pointsForOrder(order.subtotalCents, settings);
  if (points <= 0) return 'nothing_to_earn';

  const written = await tx.loyaltyEvent.createMany({
    data: [{ memberId: member.id, orderId: order.id, at: now, kind: 'earn', points }],
    skipDuplicates: true,
  });
  if (written.count === 0) return 'already_earned';

  // Moved by the earn and not by enrolling again (C-101), because this is what
  // P0-5 counts twelve months of inactivity from.
  await tx.loyaltyMember.update({ where: { id: member.id }, data: { lastActivityAt: now } });
  return 'earned';
}

// --- Redeeming at the counter (P0-4, C-104) --------------------------------

/** Why a reward was not spent. The four the engine decides, plus the three
 *  only a database can: no such order, no pepper, nobody enrolled. Named, so
 *  "the button did nothing" is never the answer a customer gets. */
export type RedemptionRefusal =
  | RedemptionRefusalReason
  | 'loyalty_pepper_unset'
  | 'order_not_found'
  | 'not_a_member';

export type RedeemResult =
  | { ok: true; pointsSpent: number; amountCents: number }
  | { ok: false; reason: RedemptionRefusal; message: string };

/**
 * Spend one reward against one order (P0-4).
 *
 * TWO ROWS, ONE TRANSACTION, and that is the requirement rather than a
 * tidiness preference: a `redeem` on the ledger with no `adjustment` beside it
 * takes a customer's points and charges them anyway, and an `adjustment` with
 * no `redeem` gives ten dollars away for free. Either half alone is a defect
 * somebody finds at close, from the till.
 *
 * NO NEW MONEY MECHANISM. The money side is PRD 3 P0-3's adjustment, written
 * by `adjustOrder` through the same validation every comp goes through — the
 * transaction is handed DOWN to it rather than the rule being copied in here.
 * So `subtotalCents`, `taxCents` and `totalCents` are untouched, exactly as
 * they are for a comp, and the snapshot regression covers this path for free.
 *
 * THE AMOUNT IS THE PROGRAM'S, NOT THE SCREEN'S. `rewardValueCents` is read
 * from the settings row here; nothing about the reward arrives from a client.
 * The order id is the only input, which is what leaves nothing to tamper with.
 *
 * REFUSED, NEVER CLAMPED, against an order that owes less than the reward is
 * worth — `planRedemption` decides that, and it is the SAME function the panel
 * asks before it renders the button, so the screen and the write cannot
 * disagree about what is offerable.
 */
export async function redeemReward(
  orderId: string,
  now: Date,
  /** Who spent it (C-086). A redemption is a counter decision like a comp. */
  staffId?: string | null,
): Promise<RedeemResult> {
  const settings = await prisma.restaurantSettings.findUniqueOrThrow({
    where: { id: 'singleton' },
    select: {
      loyaltyEnabled: true,
      pointsPerDollar: true,
      rewardThresholdPoints: true,
      rewardValueCents: true,
    },
  });
  if (!settings.loyaltyEnabled) {
    return refuseRedemption('loyalty_disabled', 'The loyalty program is switched off.');
  }
  if (!hasLoyaltyPepper()) {
    return refuseRedemption('loyalty_pepper_unset', 'The loyalty program is not configured.');
  }

  const order = await prisma.order.findUnique({
    where: { id: orderId },
    select: {
      customerPhone: true,
      totalCents: true,
      events: { select: { kind: true, amountCents: true } },
      // The ledger side of THIS order. One query, and the answer feeds the
      // refusal by name; the unique index below is what makes it true under a
      // double tap.
      loyaltyEvents: { where: { kind: 'redeem' }, select: { id: true } },
    },
  });
  if (!order) {
    return refuseRedemption('order_not_found', 'That order could not be found.');
  }

  const phone = normalizePhone(order.customerPhone);
  const member = phone
    ? await prisma.loyaltyMember.findUnique({
        where: { phoneDigest: phoneDigest(phone.digits) },
        select: { id: true, events: { select: { kind: true, points: true } } },
      })
    : null;
  if (!member) {
    return refuseRedemption('not_a_member', 'Nobody is on the punch card for this order.');
  }

  const plan = planRedemption({
    enabled: settings.loyaltyEnabled,
    balance: loyaltyBalance(member.events),
    // AFTER TAX, against what is still OWED — not against the total and not
    // against what is left to adjust. An order already collected in full owes
    // nothing, and a reward against it would be money the restaurant hands
    // back at the counter with no refund path to hand it back through.
    outstandingCents: orderBalance(order).outstandingCents,
    alreadyRedeemed: order.loyaltyEvents.length > 0,
    terms: settings,
  });
  if (!plan.ok) return { ok: false, reason: plan.reason, message: plan.message };

  try {
    return await prisma.$transaction(async (tx) => {
      // THE LOCK, FIRST (C-119). The read above is UX — it is what lets this
      // function refuse by name instead of throwing — and it is not a
      // mechanism: two staff redeeming for the same member on two different
      // orders both saw a balance of 100 and both wrote, leaving the member
      // at −100. The per-order unique index cannot catch that; it is per
      // ORDER, and these are two orders. `lockMemberBalance` moves
      // `lastActivityAt` — which a redeem has to move anyway — and the row
      // lock that UPDATE takes is what serialises the second attempt behind
      // the first, which then re-reads and sees the points are gone.
      const balance = await lockMemberBalance(tx, member.id, now);
      const confirmed = planRedemption({
        enabled: settings.loyaltyEnabled,
        balance,
        outstandingCents: orderBalance(order).outstandingCents,
        // Still the read's answer, and that is correct: `alreadyRedeemed` is
        // the one input the per-order index DOES hold, and a second tap on
        // THIS order lands on it below as a P2002 rather than here.
        alreadyRedeemed: order.loyaltyEvents.length > 0,
        terms: settings,
      });
      if (!confirmed.ok) {
        // Thrown, not returned: this is inside the transaction and a returned
        // refusal would commit whatever preceded it — here, the
        // `lastActivityAt` the lock moved.
        throw new RedemptionLost(confirmed.reason, confirmed.message);
      }

      await tx.loyaltyEvent.create({
        data: {
          memberId: member.id,
          orderId,
          at: now,
          kind: 'redeem',
          points: plan.pointsSpent,
          // The ledger's OWN copy of what the reward was worth, so the two
          // rows reconcile to the cent without a join deciding which is right.
          amountCents: plan.amountCents,
          staffId: staffId ?? null,
        },
      });

      const adjusted = await adjustOrder(
        orderId,
        { kind: 'partial', amountCents: plan.amountCents, reason: LOYALTY_REWARD_REASON },
        now,
        staffId,
        tx,
      );
      // Cannot happen — `planRedemption` bounded the amount by what is owed,
      // which is never more than what is adjustable — but a money write that
      // refused must not leave its ledger row committed beside it.
      if (!adjusted.ok) throw new Error(`redemption adjustment refused: ${adjusted.reason}`);

      // `lastActivityAt` was moved by `lockMemberBalance` at the top — moving
      // it is what took the lock — so there is nothing left to write here.
      return { ok: true as const, pointsSpent: plan.pointsSpent, amountCents: plan.amountCents };
    });
  } catch (error) {
    // The balance moved under this redemption while it held the lock (C-119).
    // Thrown to roll the transaction back, caught here to become the same
    // named refusal every other path returns.
    if (error instanceof RedemptionLost) {
      return refuseRedemption(error.reason, error.message);
    }
    // Two taps racing on one order. THE INDEX is the mechanism — the read
    // above is UX — so the loser reads as the refusal it actually is rather
    // than as a crash.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      return refuseRedemption(
        'already_redeemed_on_this_order',
        'A reward has already been used on this order.',
      );
    }
    throw error;
  }
}

/** A refusal that has to unwind a transaction to be delivered (C-119). An
 *  Error because that is what rolls a Prisma interactive transaction back;
 *  it never escapes `redeemReward`, which turns it straight back into the
 *  named refusal every caller already handles. */
class RedemptionLost extends Error {
  constructor(
    readonly reason: RedemptionRefusal,
    message: string,
  ) {
    super(message);
    this.name = 'RedemptionLost';
  }
}

const refuseRedemption = (reason: RedemptionRefusal, message: string): RedeemResult => ({
  ok: false,
  reason,
  message,
});

// --- Expiry (P0-5, C-105) --------------------------------------------------

/**
 * Zero every balance that has sat untouched for `loyaltyExpiryDays` (P0-5).
 *
 * WHY THIS EXISTS AT ALL, in the PRD's own words: an immortal balance is an
 * unbounded liability, and — worse — it is the argument for keeping a named
 * person's purchase history forever. Decision 10 made this program the thing
 * that drives this product's retention policy; expiry is what stops that
 * policy growing without limit.
 *
 * ONE `expire` ROW PER MEMBER, worth exactly minus the balance, so the ledger
 * still explains itself: the balance is a plain sum and the row that zeroed it
 * is visible beside the earns it cancelled. Nothing is deleted — this is the
 * one path in this file that could have been an UPDATE to a balance column and
 * there is no balance column, deliberately (C-100).
 *
 * IT DOES NOT READ `loyaltyEnabled`, and that is the decision here rather than
 * an omission. The switch controls whether the program is OFFERED — enrolment,
 * earning and redeeming all check it. Gating expiry behind it would mean
 * switching the program off makes every outstanding balance immortal, which is
 * the exact failure this requirement exists to prevent.
 *
 * IT DOES NOT MOVE `lastActivityAt`. Expiring is something done TO a member,
 * not something they did; moving the clock would keep resetting the window
 * that eventually deletes the row (`forgetInactiveMembers`).
 *
 * IDEMPOTENT WITHOUT A CONSTRAINT, unlike the earn: a second run finds the
 * balance already at zero and writes nothing, because `points <= 0` is
 * skipped — a zero-point row would fail C-100's sign CHECK anyway. A member
 * who earns again after expiring is inside the window again and is not
 * selected at all.
 */
export async function expireInactiveBalances(
  now: Date,
): Promise<{ expiryDays: number; members: number; points: number }> {
  const { loyaltyExpiryDays } = await prisma.restaurantSettings.findUniqueOrThrow({
    where: { id: 'singleton' },
    select: { loyaltyExpiryDays: true },
  });

  const stale = await prisma.loyaltyMember.findMany({
    where: { lastActivityAt: { lt: cutoffDaysBefore(now, loyaltyExpiryDays) } },
    select: { id: true, events: { select: { kind: true, points: true } } },
  });

  const rows = stale
    .map((member) => ({ memberId: member.id, points: -loyaltyBalance(member.events) }))
    // A negative balance cannot happen — `planRedemption` refuses below zero
    // and the CHECKs hold the signs — but a staff `adjust` is the one row a
    // person types, so the guard is a filter and not an assumption.
    .filter((row) => row.points < 0)
    .map((row) => ({ ...row, at: now, kind: 'expire' as const }));

  if (rows.length === 0) return { expiryDays: loyaltyExpiryDays, members: 0, points: 0 };

  await prisma.loyaltyEvent.createMany({ data: rows });
  return {
    expiryDays: loyaltyExpiryDays,
    members: rows.length,
    points: rows.reduce((sum, row) => sum - row.points, 0),
  };
}

// --- The program's own screen (P1-2, C-106) --------------------------------

/** What one window of the ledger did. Points are POSITIVE here even where the
 *  rows are negative — this is a report, and "302 points redeemed" is the
 *  sentence; the sign is the ledger's business and stays there. */
export type LoyaltyWindow = {
  pointsEarned: number;
  pointsRedeemed: number;
  pointsExpired: number;
  /** SIGNED, alone among these — a staff correction genuinely goes both ways
   *  and a magnitude would hide a program being propped up by hand.
   *
   *  STAFF ONLY, and that qualifier is C-118's. This screen labels the number
   *  "Staff corrections", and a checkout redemption handed back on a cancelled
   *  order is written as an `adjust` too — so summing the kind would have put
   *  the system's own bookkeeping under a heading that names a person, which
   *  is a false sentence rather than an imprecise one. The two system reasons
   *  are subtracted out and reported below. */
  pointsAdjusted: number;
  /** Rewards handed back because the order they were spent on died, net of any
   *  re-spent when a no-show was reverted and picked up after all (C-118).
   *  Its own number: an owner asking "is the punch card costing me anything"
   *  needs cancelled redemptions separated from staff typing in a balance. */
  pointsReturned: number;
  redemptions: number;
  /** What the rewards spent in this window actually cost, off the ledger's own
   *  copy of each amount. */
  redeemedCents: number;
  /** Redeemed over earned, or null when nothing was issued. */
  rate: number | null;
};

export type LoyaltyProgramReport = {
  /** The switch, as stored — NOT `offered`. The screen has to be able to say
   *  "switched on, but no pepper is configured", which one boolean cannot. */
  enabled: boolean;
  pepperConfigured: boolean;
  terms: LoyaltyTerms;
  expiryDays: number;
  retentionDays: number;
  members: number;
  liability: LoyaltyLiability;
  window: LoyaltyWindow;
};

/**
 * Every number on the loyalty screen (P1-2).
 *
 * THREE AGGREGATES, NOT A `findMany`. The liability needs each member's own
 * balance — whole rewards and the negative-balance floor are both per-member
 * questions — but it does not need their rows, and pulling a year of ledger
 * into memory to sum it is the kind of thing that works fine until the seeded
 * rush is a real restaurant.
 *
 * MEMBERS ARE COUNTED SEPARATELY from the balance grouping, deliberately: a
 * customer who enrolled and has not been back has no ledger rows at all, so
 * the group-by cannot see them. They are a member with nothing, not a missing
 * member, and the count on this screen is the count of people who handed over
 * a phone number.
 *
 * The liability is ALL TIME and the rest of it is the window, which is the
 * only reading either can have: what the shop owes is what it owes today, and
 * "$390 of liability in the last 7 days" is not a number that means anything.
 */
export async function loadLoyaltyProgram(since: Date): Promise<LoyaltyProgramReport> {
  const settings = await prisma.restaurantSettings.findUniqueOrThrow({
    where: { id: 'singleton' },
    select: {
      loyaltyEnabled: true,
      pointsPerDollar: true,
      rewardThresholdPoints: true,
      rewardValueCents: true,
      loyaltyExpiryDays: true,
      retentionDays: true,
    },
  });

  const [members, balances, byKind, systemAdjustments] = await Promise.all([
    prisma.loyaltyMember.count(),
    prisma.loyaltyEvent.groupBy({ by: ['memberId'], _sum: { points: true } }),
    prisma.loyaltyEvent.groupBy({
      by: ['kind'],
      where: { at: { gte: since } },
      _sum: { points: true, amountCents: true },
      _count: { _all: true },
    }),
    // A FOURTH AGGREGATE (C-118), not a fourth pass over rows in memory. The
    // settlement's own `adjust` rows are the system's, not a person's, and the
    // screen names the other number after a person.
    prisma.loyaltyEvent.aggregate({
      where: {
        at: { gte: since },
        kind: 'adjust',
        reason: { in: [LOYALTY_RETURN_REASON, LOYALTY_RESPEND_REASON] },
      },
      _sum: { points: true },
    }),
  ]);

  const of = (kind: LoyaltyEventKind) => byKind.find((row) => row.kind === kind);
  const pointsEarned = of('earn')?._sum.points ?? 0;
  // Negated at the boundary, once. The rows are negative because the sign is
  // the direction on this ledger; a screen saying "−302 points redeemed" is
  // reading the storage out loud.
  const pointsRedeemed = -(of('redeem')?._sum.points ?? 0);

  return {
    enabled: settings.loyaltyEnabled,
    pepperConfigured: hasLoyaltyPepper(),
    terms: settings,
    expiryDays: settings.loyaltyExpiryDays,
    retentionDays: settings.retentionDays,
    members,
    liability: loyaltyLiability(
      balances.map((row) => row._sum.points ?? 0),
      settings,
    ),
    window: {
      pointsEarned,
      pointsRedeemed,
      pointsExpired: -(of('expire')?._sum.points ?? 0),
      // The kind's total LESS the system's own, so "Staff corrections" counts
      // only corrections a member of staff actually made.
      pointsAdjusted: (of('adjust')?._sum.points ?? 0) - (systemAdjustments._sum.points ?? 0),
      pointsReturned: systemAdjustments._sum.points ?? 0,
      redemptions: of('redeem')?._count._all ?? 0,
      redeemedCents: of('redeem')?._sum.amountCents ?? 0,
      rate: redemptionRate(pointsEarned, pointsRedeemed),
    },
  };
}

/**
 * The switch (P1-2's other half). The one loyalty setting this screen writes.
 *
 * A BOOLEAN AND NOTHING ELSE, and the omissions are the decision. The reward
 * terms and the two windows are shown on that screen and are not editable
 * there: changing `rewardValueCents` restates the liability of every point
 * already earned, changing `rewardThresholdPoints` can take a reward away from
 * somebody who has one, and shrinking `loyaltyExpiryDays` destroys balances
 * with no preview of what it would destroy. Each of those is a migration-
 * shaped decision with a dry run in front of it, exactly as the settings
 * screen says of the timezone and the tax rate — and C-105 recorded that a
 * control for the expiry window may not ship without one.
 *
 * Switching OFF is not destructive and that is worth stating: enrolment,
 * earning and redeeming all stop, and every outstanding balance stays exactly
 * where it is — including expiring on schedule, which `expireInactiveBalances`
 * deliberately does with the program off (C-105).
 */
export async function setLoyaltyEnabled(enabled: boolean): Promise<void> {
  await prisma.restaurantSettings.update({
    where: { id: 'singleton' },
    data: { loyaltyEnabled: enabled },
  });
}

// --- Redeeming at CHECKOUT, before tax (P1-1, C-118) -----------------------

/** Why a reward could not be spent at checkout, plus the two only a database
 *  can answer. `already_redeemed_on_this_order` and
 *  `reward_exceeds_balance_owed` cannot occur here — there is no order yet to
 *  have redeemed against, and nothing is owed on a cart — but the reason type
 *  is shared so a screen renders one set of words. */
export type CheckoutRedemptionRefusal =
  | RedemptionRefusalReason
  | 'loyalty_pepper_unset'
  | 'not_a_member';

/** A reward the server has decided to grant, with everything the write needs.
 *  The AMOUNT IS THE PROGRAM'S: `rewardValueCents` is read from the settings
 *  row inside this function, exactly as `redeemReward` reads it — nothing
 *  about a discount arrives from a client, at any point in this path. */
export type PlannedCheckoutRedemption = {
  memberId: string;
  pointsSpent: number;
  amountCents: number;
  /** The subtotal the plan was bounded against (C-119). Carried so the
   *  re-check under the lock can ask `planCheckoutRedemption` the SAME
   *  question rather than a thinner one of its own — a second, simpler rule
   *  inside the transaction is exactly the "two answers that can disagree"
   *  shape this repo keeps out of the money path. */
  subtotalCents: number;
};

export type CheckoutRedemptionResult =
  | { ok: true; plan: PlannedCheckoutRedemption }
  | { ok: false; reason: CheckoutRedemptionRefusal; message: string };

/**
 * What reward, if any, the phone behind a verified token may spend on a cart
 * of this size (P1-1).
 *
 * A READ, with no write in it. The `redeem` row is written by `placeOrder`
 * inside the same transaction as the order itself, because a snapshot
 * carrying `discountCents` with no ledger row beside it is ten dollars given
 * away for free — C-104's "either half alone is a defect somebody finds at
 * close", one layer earlier. So this returns the decision and the member it
 * belongs to, and the caller commits both halves or neither.
 *
 * THE DIGEST, NOT THE NUMBER, is what looks the member up — the same rule
 * `memberByPhone` keeps and for the same reason: a plaintext phone must never
 * reach a `where`.
 */
export async function planCheckoutReward(input: {
  /** The order's own phone, as `normalizeIdentity` trimmed it. */
  phone: string | null;
  /** The SERVER's sum of the priced lines. */
  subtotalCents: number;
}): Promise<CheckoutRedemptionResult> {
  const settings = await prisma.restaurantSettings.findUniqueOrThrow({
    where: { id: 'singleton' },
    select: {
      loyaltyEnabled: true,
      pointsPerDollar: true,
      rewardThresholdPoints: true,
      rewardValueCents: true,
    },
  });
  if (!settings.loyaltyEnabled) {
    return refuseCheckout('loyalty_disabled', 'The loyalty program is switched off.');
  }
  if (!hasLoyaltyPepper()) {
    return refuseCheckout('loyalty_pepper_unset', 'The loyalty program is not configured.');
  }

  const phone = normalizePhone(input.phone);
  const member = phone
    ? await prisma.loyaltyMember.findUnique({
        where: { phoneDigest: phoneDigest(phone.digits) },
        select: { id: true, events: { select: { kind: true, points: true } } },
      })
    : null;
  if (!member) {
    return refuseCheckout('not_a_member', 'That number is not on the punch card.');
  }

  const plan = planCheckoutRedemption({
    enabled: settings.loyaltyEnabled,
    balance: loyaltyBalance(member.events),
    subtotalCents: input.subtotalCents,
    terms: settings,
  });
  if (!plan.ok) return { ok: false, reason: plan.reason, message: plan.message };

  return {
    ok: true,
    plan: {
      memberId: member.id,
      pointsSpent: plan.pointsSpent,
      amountCents: plan.amountCents,
      subtotalCents: input.subtotalCents,
    },
  };
}

const refuseCheckout = (
  reason: CheckoutRedemptionRefusal,
  message: string,
): CheckoutRedemptionResult => ({ ok: false, reason, message });

/**
 * Write the `redeem` row a checkout redemption is (P1-1).
 *
 * IN THE CALLER'S TRANSACTION, always — there is no default client here,
 * unlike `adjustOrder`'s. `placeOrder` is the only caller and the whole point
 * is atomicity with the order row that carries the `discountCents`; a version
 * of this that could be called on its own would be a way to write half a
 * redemption, which is the defect the transaction exists to make impossible.
 *
 * NO `adjustment` EVENT, and that is the difference from `redeemReward`. The
 * counter's reward is money taken off an order that was already priced, so it
 * has to be an append-only adjustment against the snapshot. This one is IN the
 * snapshot — `discountCents`, and a tax base computed on it — so writing an
 * adjustment beside it would take the ten dollars off twice.
 */
/**
 * Take the member's row lock, and hand back the balance as it stands behind
 * it (PRD 7 P1-1, C-119).
 *
 * THE UPDATE IS THE LOCK, and that is the whole mechanism. `lastActivityAt`
 * has to move on a redemption anyway — C-102 and C-104 both say so — so this
 * writes it FIRST rather than last, and Postgres's row-level lock on an
 * UPDATE does the rest: a second checkout for the same member blocks on this
 * statement until the first transaction commits, and then, under READ
 * COMMITTED, the SELECT below sees the `redeem` that first transaction wrote.
 * No `FOR UPDATE` raw query, no new column, no CHECK — a reorder of two
 * statements that both already existed.
 *
 * WHAT IT DOES NOT DO IS DECIDE. It returns a number; each caller re-runs its
 * OWN plan function against it, because the counter and checkout ask
 * different questions of the same balance (`planRedemption` bounds by what an
 * order owes, `planCheckoutRedemption` by what the food costs) and a shared
 * re-check would have to pick one.
 *
 * ONE LOCK, TAKEN FIRST, AND NEVER A SECOND. Both callers take exactly this
 * one row at the top of their transaction, so there is no pair of locks to
 * acquire in two different orders and no deadlock to construct. It is held
 * for the few milliseconds the rest of the transaction takes, and only
 * against another redemption for the SAME member.
 *
 * THE ORDER OF THESE TWO STATEMENTS IS THE WHOLE FIX, and swapping them is
 * silent: the UPDATE still runs, `lastActivityAt` still moves, every
 * placement-level concurrency test in `loyalty.test.ts` still passes, and the
 * balance is read in front of the lock instead of behind it. The one test
 * that catches it is `reads the balance BEHIND the member lock, not in front
 * of it`, which holds a transaction open on purpose to make the ordering
 * deterministic. Do not reorder these without reading it.
 */
export async function lockMemberBalance(
  tx: Prisma.TransactionClient,
  memberId: string,
  now: Date,
): Promise<number> {
  await tx.loyaltyMember.update({ where: { id: memberId }, data: { lastActivityAt: now } });
  const member = await tx.loyaltyMember.findUniqueOrThrow({
    where: { id: memberId },
    select: { events: { select: { kind: true, points: true } } },
  });
  return loyaltyBalance(member.events);
}

/** The re-check's own refusal, beside the ones the plan already names. The
 *  owner edited the reward's cash value between this checkout being priced
 *  and being written, so the order's snapshotted `discountCents` no longer
 *  matches what the program is worth. Rare — C-106 deliberately ships no
 *  control for those numbers — and refused rather than written at a value
 *  nothing agrees on. */
export type RedemptionConfirmRefusal = CheckoutRedemptionRefusal | 'reward_terms_changed';

export type RedemptionConfirmation =
  | { ok: true }
  | { ok: false; reason: RedemptionConfirmRefusal; message: string };

/**
 * Confirm a planned checkout reward is still spendable, under the lock
 * (C-119).
 *
 * CALLED BEFORE THE ORDER ROW EXISTS, deliberately. A refusal here rolls the
 * whole transaction back, and rolling back an `Order.create` would leave a gap
 * in the day's order numbers — `takingNextOrderNumber` reads the maximum, so
 * #005 would be followed by #007 with nothing in between and nobody able to
 * say why. Locking first costs nothing and the board stays readable.
 *
 * Re-reads the SETTINGS too, not only the balance: a program switched off
 * mid-checkout is a different race than the one this exists for, it is one
 * more query inside a transaction that is already open, and the alternative
 * is writing a reward the settings row says is not on offer.
 */
export async function confirmCheckoutRedemption(
  tx: Prisma.TransactionClient,
  plan: PlannedCheckoutRedemption,
  now: Date,
): Promise<RedemptionConfirmation> {
  const balance = await lockMemberBalance(tx, plan.memberId, now);
  const settings = await tx.restaurantSettings.findUniqueOrThrow({
    where: { id: 'singleton' },
    select: {
      loyaltyEnabled: true,
      pointsPerDollar: true,
      rewardThresholdPoints: true,
      rewardValueCents: true,
    },
  });

  const confirmed = planCheckoutRedemption({
    enabled: settings.loyaltyEnabled,
    balance,
    subtotalCents: plan.subtotalCents,
    terms: settings,
  });
  if (!confirmed.ok) return { ok: false, reason: confirmed.reason, message: confirmed.message };
  if (confirmed.amountCents !== plan.amountCents) {
    return {
      ok: false,
      reason: 'reward_terms_changed',
      message: 'The reward changed while you were ordering. Check the new total.',
    };
  }
  return { ok: true };
}

/**
 * Write the `redeem` row a checkout redemption is (P1-1).
 *
 * IN THE CALLER'S TRANSACTION, always — there is no default client here,
 * unlike `adjustOrder`'s. `placeOrder` is the only caller and the whole point
 * is atomicity with the order row that carries the `discountCents`; a version
 * of this that could be called on its own would be a way to write half a
 * redemption, which is the defect the transaction exists to make impossible.
 *
 * AND ONLY AFTER `confirmCheckoutRedemption` HAS RUN in that same transaction
 * (C-119). This function does not check anything — it is the second half of a
 * pair, and the first half is what holds the lock the balance was read under.
 *
 * NO `adjustment` EVENT, and that is the difference from `redeemReward`. The
 * counter's reward is money taken off an order that was already priced, so it
 * has to be an append-only adjustment against the snapshot. This one is IN the
 * snapshot — `discountCents`, and a tax base computed on it — so writing an
 * adjustment beside it would take the ten dollars off twice.
 *
 * `lastActivityAt` is NOT moved here: `lockMemberBalance` already moved it,
 * because moving it is what takes the lock.
 */
export async function writeCheckoutRedemption(
  tx: Prisma.TransactionClient,
  orderId: string,
  plan: PlannedCheckoutRedemption,
  now: Date,
): Promise<void> {
  await tx.loyaltyEvent.create({
    data: {
      memberId: plan.memberId,
      orderId,
      at: now,
      kind: 'redeem',
      points: plan.pointsSpent,
      // The ledger's own copy of the reward's cash value, as at the counter —
      // so the two reconcile to the cent without a join deciding which is
      // right. Here it is also what `settleRedemptionForOrder` hands back.
      amountCents: plan.amountCents,
      // No staff id: nobody at the counter decided this one.
      staffId: null,
    },
  });
}

/**
 * Whether this order has already spent a reward (C-118).
 *
 * ASKED OF THE LEDGER, which is the only place that knows. The staff panel
 * used to infer it from the MONEY side — an `adjustment` carrying
 * `LOYALTY_REWARD_REASON` — and that was correct for exactly as long as
 * `redeemReward` was the only way to spend one: it writes both rows in one
 * transaction, so either answered the question. A CHECKOUT redemption writes
 * NO adjustment (the reward is inside the snapshot), so the money side now
 * reads "no reward used" on an order that plainly carries one, and the panel
 * would offer a button whose write the unique index then refuses.
 *
 * "A button that renders is a button that works" is C-104's own rule for that
 * panel; this is what keeps it true with two ways to redeem.
 */
export const orderHasRedemption = async (orderId: string): Promise<boolean> =>
  (await prisma.loyaltyEvent.count({ where: { orderId, kind: 'redeem' } })) > 0;

/** What a settlement did, for the caller's log line. */
export type RedemptionSettlement = 'no_redemption' | 'unchanged' | 'returned' | 'respent';

/**
 * Give a checkout redemption back when the order it was spent on dies — and
 * take it again if that order comes back (C-118).
 *
 * THE CASE THE COUNTER FLOW NEVER HAD. `redeemReward` is a tap on an order
 * somebody is standing in front of; a checkout redemption is committed at
 * placement and then has to survive whatever happens next. Cancel that order
 * and the customer has paid a punch card for food they never received, and
 * C-069 has already voided their card hold — so the money went back and,
 * without this, the points did not.
 *
 * AN `adjust` ROW, NEVER A DELETE. The ledger is append-only in spirit even
 * where the trigger permits a delete for P0-5's forget path: a balance that
 * moved has a row saying so, and "where did my hundred points go" is answered
 * by reading the ledger rather than by inferring an absence.
 *
 * IN THE CALLER'S TRANSACTION, for the same reason the earn is: a status
 * change that committed without its ledger row has no later moment to retry
 * from.
 *
 * IDEMPOTENT BY ARITHMETIC rather than by a constraint — `settleRedemption`
 * reconciles what is already written against what should be — because unlike
 * the earn there is no one-per-order shape to hang a unique index on: the same
 * order legitimately carries a return AND a later re-spend when a no-show is
 * reverted and picked up after all.
 */
export async function settleRedemptionForOrder(
  tx: Prisma.TransactionClient,
  orderId: string,
  status: OrderStatus,
  now: Date,
): Promise<RedemptionSettlement> {
  const rows = await tx.loyaltyEvent.findMany({
    where: { orderId, kind: { in: ['redeem', 'adjust'] } },
    select: { memberId: true, kind: true, points: true, reason: true },
  });
  const redeemed = rows.find((row) => row.kind === 'redeem');
  if (!redeemed) return 'no_redemption';

  const target = redemptionStateFor(salesRoleOf(status));
  const points = settleRedemption({
    redeemedPoints: redeemed.points,
    // ONLY this settlement's own rows. A staff `adjust` correcting somebody's
    // balance by hand is a different fact and must not be read as a reward
    // coming back — which is what makes the two reasons constants rather than
    // free text.
    compensations: rows
      .filter(
        (row) =>
          row.kind === 'adjust' &&
          (row.reason === LOYALTY_RETURN_REASON || row.reason === LOYALTY_RESPEND_REASON),
      )
      .map((row) => row.points),
    target,
  });
  if (points === null) return 'unchanged';

  await tx.loyaltyEvent.create({
    data: {
      memberId: redeemed.memberId,
      orderId,
      at: now,
      kind: 'adjust',
      points,
      // Null, and the CHECK insists: `amountCents` is non-null exactly on a
      // `redeem`. The cash value of what came back is on that row already.
      reason: points > 0 ? LOYALTY_RETURN_REASON : LOYALTY_RESPEND_REASON,
      staffId: null,
    },
  });
  // NOT `lastActivityAt`. A cancellation is something that happened TO this
  // member, not something they did — the same call `expireInactiveBalances`
  // makes, and for the same reason: an order that died must not quietly
  // restart the twelve-month clock.
  return points > 0 ? 'returned' : 'respent';
}
