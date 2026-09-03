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
  LOYALTY_REWARD_REASON,
  cutoffDaysBefore,
  loyaltyBalance,
  loyaltyLiability,
  normalizePhone,
  orderBalance,
  planRedemption,
  pointsForOrder,
  redemptionRate,
  type LoyaltyEventKind,
  type LoyaltyLiability,
  type LoyaltyTerms,
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

      await tx.loyaltyMember.update({ where: { id: member.id }, data: { lastActivityAt: now } });
      return { ok: true as const, pointsSpent: plan.pointsSpent, amountCents: plan.amountCents };
    });
  } catch (error) {
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
   *  and a magnitude would hide a program being propped up by hand. */
  pointsAdjusted: number;
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

  const [members, balances, byKind] = await Promise.all([
    prisma.loyaltyMember.count(),
    prisma.loyaltyEvent.groupBy({ by: ['memberId'], _sum: { points: true } }),
    prisma.loyaltyEvent.groupBy({
      by: ['kind'],
      where: { at: { gte: since } },
      _sum: { points: true, amountCents: true },
      _count: { _all: true },
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
      pointsAdjusted: of('adjust')?._sum.points ?? 0,
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
