import { beforeEach, describe, expect, it } from 'vitest';
import { prisma } from './index';
import { resetDatabase, seedSampleMenu } from './testing/index';

// These assert the DATABASE refuses, not that the application remembers to
// check. Correctness never depends on the client behaving, and it does not
// depend on the server behaving either where a constraint can carry it.

const AT = new Date(Date.UTC(2026, 6, 4, 18, 30, 0));

let tokenCounter = 0;
const order = (overrides: Record<string, unknown> = {}) => ({
  businessDay: '2026-07-04',
  seq: 47,
  customerName: 'Dana',
  status: 'placed' as const,
  placedAt: AT,
  statusChangedAt: AT,
  subtotalCents: 1000,
  taxCents: 83,
  taxRatePpm: 82_500,
  totalCents: 1083,
  prepWeight: 2,
  statusToken: `token-${(tokenCounter += 1)}`,
  idempotencyKey: `idem-${tokenCounter}`,
  ...overrides,
});

describe('the daily order number (P0-8)', () => {
  beforeEach(resetDatabase);

  it('refuses two orders sharing a number on the same business day', async () => {
    await prisma.order.create({ data: order() });
    await expect(prisma.order.create({ data: order() })).rejects.toMatchObject({ code: 'P2002' });
  });

  // The point of the constraint: two placements racing for #47 do not both
  // win. Whichever loses gets a violation to catch and retry at seq+1 — never
  // a check-then-write, which has a window between the check and the write.
  it('lets exactly one of many concurrent placements take a number', async () => {
    const attempts = Array.from({ length: 8 }, () =>
      prisma.order.create({ data: order() }).then(
        () => 'won' as const,
        () => 'lost' as const,
      ),
    );
    const results = await Promise.all(attempts);
    expect(results.filter((r) => r === 'won')).toHaveLength(1);
    expect(await prisma.order.count()).toBe(1);
  });

  it('reuses the number on the next business day — the reset is per day', async () => {
    await prisma.order.create({ data: order() });
    await expect(
      prisma.order.create({ data: order({ businessDay: '2026-07-05' }) }),
    ).resolves.toMatchObject({ seq: 47 });
  });
});

describe('idempotent placement (P0-10)', () => {
  beforeEach(resetDatabase);

  it('refuses a second order carrying the same idempotency key', async () => {
    await prisma.order.create({ data: order({ idempotencyKey: 'double-tap' }) });
    await expect(
      prisma.order.create({ data: order({ seq: 48, idempotencyKey: 'double-tap' }) }),
    ).rejects.toMatchObject({ code: 'P2002' });
  });

  it('refuses a duplicate status token, so links cannot collide', async () => {
    await prisma.order.create({ data: order({ statusToken: 'shared' }) });
    await expect(
      prisma.order.create({ data: order({ seq: 48, statusToken: 'shared' }) }),
    ).rejects.toMatchObject({ code: 'P2002' });
  });
});

describe('the append-only event log (P0-4)', () => {
  beforeEach(resetDatabase);

  const withEvent = async () => {
    const created = await prisma.order.create({
      data: {
        ...order(),
        events: { create: { at: AT, kind: 'transition', toStatus: 'placed', actor: 'customer' } },
      },
      include: { events: true },
    });
    const [event] = created.events;
    if (!event) throw new Error('no event created');
    return event;
  };

  it('accepts inserts', async () => {
    const event = await withEvent();
    expect(event.toStatus).toBe('placed');
  });

  it('refuses an update', async () => {
    const event = await withEvent();
    await expect(
      prisma.orderEvent.update({ where: { id: event.id }, data: { toStatus: 'ready' } }),
    ).rejects.toThrow(/append-only/i);
  });

  // An undo must write a revert event. If a delete were possible, the honest
  // history of a fat-fingered advance would be the first thing erased.
  it('refuses a delete', async () => {
    const event = await withEvent();
    await expect(prisma.orderEvent.delete({ where: { id: event.id } })).rejects.toThrow(
      /append-only/i,
    );
  });

  it('refuses a cascading delete of the order that owns it', async () => {
    const event = await withEvent();
    await expect(prisma.order.delete({ where: { id: event.orderId } })).rejects.toThrow(
      /append-only/i,
    );
  });
});

// PRD 3 P0-6 (C-071). The mechanism, asserted as a mechanism: `settleRefund`
// used to guard a double-settle with a compare-and-set on `paymentState`
// going `paid` -> `refunded`, which was only ever correct because every refund
// was total. A partial one leaves the column at `paid`, so that guard silently
// stops guarding — and a duplicated `refund` row is not cosmetic, because
// `orderBalance` sums the log and would show a customer's money as having gone
// back twice.
//
// Prisma cannot express a partial index, so this constraint exists only in the
// migration and only this test and CI's `pg_class` assertion stand behind it.
describe('one settled refund per request (P0-6)', () => {
  beforeEach(resetDatabase);

  const withRequest = async () => {
    const created = await prisma.order.create({
      data: {
        ...order(),
        events: {
          create: { at: AT, kind: 'refund_requested', actor: 'staff', amountCents: 500 },
        },
      },
      include: { events: true },
    });
    const [request] = created.events;
    if (!request) throw new Error('no request created');
    return request;
  };

  const attempt = (request: { id: string; orderId: string }, kind: 'refund' | 'refund_failed') =>
    prisma.orderEvent.create({
      data: {
        orderId: request.orderId,
        at: AT,
        kind,
        actor: 'staff',
        refundRequestId: request.id,
        ...(kind === 'refund' ? { amountCents: 500 } : {}),
      },
    });

  it('refuses a second refund against the same request', async () => {
    const request = await withRequest();
    await attempt(request, 'refund');
    await expect(attempt(request, 'refund')).rejects.toThrow(/unique/i);
  });

  // PARTIAL, and this is the half that makes it so: retrying a stuck refund is
  // the ordinary case and every attempt writes its own row.
  it('accepts many failures against one request', async () => {
    const request = await withRequest();
    await attempt(request, 'refund_failed');
    await attempt(request, 'refund_failed');
    expect(
      await prisma.orderEvent.count({ where: { refundRequestId: request.id } }),
    ).toBe(2);
  });

  // The one-directional CHECK: nothing that is not an attempt may claim to be
  // one, so a `transition` can never appear in `refundAttempts` and quietly
  // settle a request.
  it('refuses a link on an event that is not a refund attempt', async () => {
    const request = await withRequest();
    await expect(
      prisma.orderEvent.create({
        data: {
          orderId: request.orderId,
          at: AT,
          kind: 'note',
          actor: 'staff',
          refundRequestId: request.id,
          detail: { note: 'not an attempt' },
        },
      }),
    ).rejects.toThrow(/order_event_refund_link_matches_kind/i);
  });

  // A request may name an amount or decline to. Both are honest: the
  // cancellation's cannot know what will be held at the moment of the attempt,
  // and a deliberate refund's is a number somebody typed.
  it('accepts a request with an amount and one without', async () => {
    const created = await prisma.order.create({
      data: {
        ...order(),
        events: {
          create: [
            { at: AT, kind: 'refund_requested', actor: 'system', reason: 'out_of_item' },
            { at: AT, kind: 'refund_requested', actor: 'staff', amountCents: 500 },
          ],
        },
      },
      include: { events: true },
    });
    expect(created.events.map((event) => event.amountCents).sort()).toEqual([500, null]);
  });

  // A reversal joined the money-bearing kinds, so the equivalence still holds
  // for it: it must carry an amount, and it must be unsigned.
  it('requires an amount on a reversal and refuses a negative one', async () => {
    const created = await prisma.order.create({ data: order() });
    await expect(
      prisma.orderEvent.create({
        data: { orderId: created.id, at: AT, kind: 'adjustment_reversed', actor: 'staff' },
      }),
    ).rejects.toThrow(/order_event_amount_matches_kind/i);
    await expect(
      prisma.orderEvent.create({
        data: {
          orderId: created.id,
          at: AT,
          kind: 'adjustment_reversed',
          actor: 'staff',
          amountCents: -100,
        },
      }),
    ).rejects.toThrow(/order_event_amount_not_negative/i);
  });
});

describe('deterministic ticket ordering', () => {
  beforeEach(resetDatabase);

  it('refuses two lines claiming the same position on the card', async () => {
    const created = await prisma.order.create({
      data: {
        ...order(),
        lines: {
          create: {
            lineNumber: 1,
            itemName: 'Burrito',
            categoryName: 'Burritos & Bowls',
            basePriceCents: 1095,
            quantity: 1,
            unitPriceCents: 1095,
            lineTotalCents: 1095,
          },
        },
      },
    });
    await expect(
      prisma.orderLine.create({
        data: {
          orderId: created.id,
          lineNumber: 1,
          itemName: 'Chips & salsa',
          categoryName: 'Sides',
          basePriceCents: 350,
          quantity: 1,
          unitPriceCents: 350,
          lineTotalCents: 350,
        },
      }),
    ).rejects.toMatchObject({ code: 'P2002' });
  });
});

describe('restaurant settings', () => {
  beforeEach(resetDatabase);

  it('accepts the singleton row', async () => {
    await expect(
      prisma.restaurantSettings.create({
        data: { id: 'singleton', timezone: 'America/Los_Angeles', taxRatePpm: 82_500 },
      }),
    ).resolves.toMatchObject({ timezone: 'America/Los_Angeles' });
  });

  // "The restaurant's timezone" must be a query with one answer. The daily
  // order-number reset and every report bucket depend on it.
  it('refuses a second settings row', async () => {
    await prisma.restaurantSettings.create({
      data: { id: 'singleton', timezone: 'America/Los_Angeles', taxRatePpm: 82_500 },
    });
    await expect(
      prisma.restaurantSettings.create({
        data: { id: 'other', timezone: 'UTC', taxRatePpm: 0 },
      }),
    ).rejects.toThrow(/restaurant_settings_singleton/i);
  });
});

// C-011: the checkout gate's numbers (P0-6). Every branch of `checkoutGate`
// assumes a window that makes sense; a settings screen is one fat finger away
// from a restaurant open 21:00–11:00, which the gate would read as "closed all
// day, forever" with no error anywhere. These make that a write-time failure.
describe('store hours', () => {
  beforeEach(resetDatabase);

  const hours = (overrides: Record<string, unknown> = {}) => ({
    dayOfWeek: 2,
    openMinute: 11 * 60,
    closeMinute: 21 * 60,
    ...overrides,
  });

  it('accepts a sane weekday window', async () => {
    await expect(prisma.storeHours.create({ data: hours() })).resolves.toMatchObject({
      dayOfWeek: 2,
    });
  });

  it('refuses a day outside 0–6', async () => {
    await expect(prisma.storeHours.create({ data: hours({ dayOfWeek: 7 }) })).rejects.toThrow(
      /store_hours_day_of_week_range/i,
    );
  });

  it('refuses minutes outside the day', async () => {
    await expect(prisma.storeHours.create({ data: hours({ openMinute: -1 }) })).rejects.toThrow(
      /store_hours_minutes_in_range/i,
    );
    await expect(prisma.storeHours.create({ data: hours({ closeMinute: 1441 }) })).rejects.toThrow(
      /store_hours_minutes_in_range/i,
    );
  });

  it('accepts midnight as a closing time', async () => {
    // 1440 is the one value above 1439 that means anything: a kitchen that
    // shuts at midnight rather than at 23:59.
    await expect(
      prisma.storeHours.create({ data: hours({ closeMinute: 1440 }) }),
    ).resolves.toMatchObject({ closeMinute: 1440 });
  });

  it('refuses a window that closes before it opens', async () => {
    // This is what forecloses overnight service (17:00–02:00). Refusing it
    // loudly beats a gate that silently reads every minute of such a day as
    // closed — recorded as a ceiling in docs/WRITEUP.md.
    await expect(
      prisma.storeHours.create({ data: hours({ openMinute: 17 * 60, closeMinute: 2 * 60 }) }),
    ).rejects.toThrow(/store_hours_closes_after_opening/i);
  });

  it('refuses a second window for the same day', async () => {
    // `dayOfWeek` is the primary key: split lunch/dinner service is not what
    // this schema models, and two conflicting rows would make the gate's
    // answer depend on row order.
    await prisma.storeHours.create({ data: hours() });
    await expect(
      prisma.storeHours.create({ data: hours({ openMinute: 17 * 60 }) }),
    ).rejects.toMatchObject({ code: 'P2002' });
  });
});

describe('the gate settings', () => {
  beforeEach(resetDatabase);

  const settings = (overrides: Record<string, unknown> = {}) => ({
    id: 'singleton',
    timezone: 'America/Los_Angeles',
    taxRatePpm: 82_500,
    ...overrides,
  });

  it('refuses a throttle threshold of zero', async () => {
    // Zero would pause ordering permanently through a code path nobody would
    // think to look at. The manual switch is how you stop taking orders.
    await expect(
      prisma.restaurantSettings.create({ data: settings({ maxOpenWeight: 0 }) }),
    ).rejects.toThrow(/max_open_weight_positive/i);
  });

  it('refuses a negative cutoff, which would extend ordering past close', async () => {
    await expect(
      prisma.restaurantSettings.create({ data: settings({ cutoffMinutes: -5 }) }),
    ).rejects.toThrow(/cutoff_in_range/i);
  });

  it('refuses prep minutes that would shorten the estimate as the queue grows', async () => {
    // A negative increment quotes a FASTER pickup the busier the kitchen gets
    // — wrong in the direction that has customers arrive early and wait.
    await expect(
      prisma.restaurantSettings.create({ data: settings({ prepPerWeightMinutes: -1 }) }),
    ).rejects.toThrow(/prep_per_weight_in_range/i);
    await expect(
      prisma.restaurantSettings.create({ data: settings({ prepBaseMinutes: -5 }) }),
    ).rejects.toThrow(/prep_base_in_range/i);
  });

  it('refuses a closed-today value that could never match a business day', async () => {
    // Compared as a string against `restaurantClock().day`. Any other shape
    // silently reads as "not closed today" — a restaurant that announced it
    // was shut and took orders anyway.
    await expect(
      prisma.restaurantSettings.create({ data: settings({ closedOnDay: '7/4/2026' }) }),
    ).rejects.toThrow(/closed_on_day_shape/i);

    await expect(
      prisma.restaurantSettings.create({ data: settings({ closedOnDay: '2026-07-04' }) }),
    ).resolves.toMatchObject({ closedOnDay: '2026-07-04' });
  });
});

// C-022: the menu's own integrity. The editor refuses these too (C-015) and
// that is where the MESSAGE belongs; this asserts the database refuses them
// whatever writes the row.
describe('menu integrity (C-022)', () => {
  beforeEach(async () => {
    await resetDatabase();
    await prisma.category.create({ data: { id: 'cat', name: 'Things', sortOrder: 0 } });
  });

  const group = (overrides: Record<string, unknown> = {}) => ({
    id: 'g',
    name: 'Group',
    min: 0,
    max: 3,
    ...overrides,
  });

  it('refuses a group nobody can pick anything from', async () => {
    await expect(prisma.modifierGroup.create({ data: group({ max: 0 }) })).rejects.toThrow();
  });

  it('refuses the unsatisfiable group: choose at least 3, at most 2', async () => {
    await expect(
      prisma.modifierGroup.create({ data: group({ min: 3, max: 2 }) }),
    ).rejects.toThrow();
  });

  it('refuses a negative minimum, and allows zero', async () => {
    await expect(prisma.modifierGroup.create({ data: group({ min: -1 }) })).rejects.toThrow();
    await expect(prisma.modifierGroup.create({ data: group({ min: 0 }) })).resolves.toBeTruthy();
  });

  it('catches an UPDATE that makes a valid group unsatisfiable', async () => {
    // The real path: a manager narrowing `max` on a group that is already
    // required. Nothing composed from it could validate afterwards.
    await prisma.modifierGroup.create({ data: group({ min: 2, max: 4 }) });
    await expect(
      prisma.modifierGroup.update({ where: { id: 'g' }, data: { max: 1 } }),
    ).rejects.toThrow();
  });

  const item = (overrides: Record<string, unknown> = {}) => ({
    id: 'i',
    categoryId: 'cat',
    name: 'Thing',
    basePriceCents: 500,
    sortOrder: 0,
    ...overrides,
  });

  it('refuses an item that pays the customer to order it, and allows a free one', async () => {
    await expect(prisma.menuItem.create({ data: item({ basePriceCents: -1 }) })).rejects.toThrow();
    await expect(
      prisma.menuItem.create({ data: item({ basePriceCents: 0 }) }),
    ).resolves.toBeTruthy();
  });

  it('allows a NEGATIVE modifier delta — "Small −$1.50" is an ordinary option', async () => {
    await prisma.modifierGroup.create({ data: group() });
    await expect(
      prisma.modifierOption.create({
        data: { id: 'o', groupId: 'g', name: 'Small', priceDeltaCents: -150, sortOrder: 0 },
      }),
    ).resolves.toBeTruthy();
  });

  it('refuses an extra surcharge that makes the food cheaper, and allows null', async () => {
    await prisma.modifierGroup.create({ data: group({ intensityEnabled: true }) });
    const option = (overrides: Record<string, unknown>) => ({
      groupId: 'g',
      name: 'Cheese',
      priceDeltaCents: 50,
      sortOrder: 0,
      ...overrides,
    });
    await expect(
      prisma.modifierOption.create({ data: option({ id: 'a', extraPriceDeltaCents: -1 }) }),
    ).rejects.toThrow();
    // Null is the common case: "extra" costs nothing on most options.
    await expect(
      prisma.modifierOption.create({ data: option({ id: 'b', extraPriceDeltaCents: null }) }),
    ).resolves.toBeTruthy();
  });

  it('accepts the whole seeded menu, which is the fixture every price test uses', async () => {
    await resetDatabase();
    await expect(seedSampleMenu()).resolves.toBeUndefined();
  });
});

describe('the quote snapshot (P1-4, C-042)', () => {
  beforeEach(resetDatabase);

  const quoted = (overrides: Record<string, unknown> = {}) =>
    order({ quotedLowMinutes: 10, quotedHighMinutes: 20, quotedOpenWeight: 0, ...overrides });

  it('accepts a whole quote, and an order that has none at all', async () => {
    await expect(prisma.order.create({ data: quoted() })).resolves.toBeTruthy();
    // Every order placed before this migration. NULL is the honest value for
    // "we have no record of what this customer was told".
    await expect(prisma.order.create({ data: order({ seq: 48 }) })).resolves.toBeTruthy();
  });

  it('refuses HALF a quote — a low end with nothing to grade it against', async () => {
    await expect(
      prisma.order.create({ data: order({ quotedLowMinutes: 10 }) }),
    ).rejects.toThrow(/order_quote_is_whole_or_absent/);
  });

  it('refuses a quote that is a point rather than a range', async () => {
    await expect(
      prisma.order.create({ data: quoted({ quotedHighMinutes: 10 }) }),
    ).rejects.toThrow(/order_quote_is_a_range/);
  });

  it('refuses a low end of zero, which reads as "now"', async () => {
    await expect(
      prisma.order.create({ data: quoted({ quotedLowMinutes: 0 }) }),
    ).rejects.toThrow(/order_quote_low_is_positive/);
  });

  it('allows an empty queue and refuses a negative one', async () => {
    await expect(prisma.order.create({ data: quoted({ quotedOpenWeight: 0 }) })).resolves.toBeTruthy();
    await expect(
      prisma.order.create({ data: quoted({ seq: 48, quotedOpenWeight: -1 }) }),
    ).rejects.toThrow(/order_quote_open_weight_not_negative/);
  });
});

// C-086. A name on a row is only worth having if the row cannot hold a blank
// one and two people cannot share the four digits that resolve to them.
describe('the staff list (PRD 6 P0-2)', () => {
  beforeEach(resetDatabase);

  const member = (overrides: Record<string, unknown> = {}) => ({
    name: 'Noor Haddad',
    pinDigest: 'a'.repeat(64),
    createdAt: AT,
    ...overrides,
  });

  it('refuses a blank name, which reads as unattributed while being the opposite', async () => {
    await expect(prisma.staffMember.create({ data: member({ name: '   ' }) })).rejects.toThrow(
      /staff_member_name_not_blank/,
    );
  });

  it('refuses anything in the digest column that is not a hex SHA-256', async () => {
    // The constraint that stops a future writer storing the PIN itself here
    // "just for now": four digits would pass any length check.
    for (const bad of ['1234', 'A'.repeat(64), 'a'.repeat(63), `${'a'.repeat(63)}g`]) {
      await expect(
        prisma.staffMember.create({ data: member({ pinDigest: bad }) }),
      ).rejects.toThrow(/staff_member_pin_digest_is_sha256_hex/);
    }
  });

  it('refuses two people sharing a PIN', async () => {
    // The CONSTRAINT is the mechanism: a second person cannot be given 1234 by
    // mistake, because every event either of them wrote would be ambiguous.
    await prisma.staffMember.create({ data: member() });
    await expect(
      prisma.staffMember.create({ data: member({ name: 'Theo Barnes' }) }),
    ).rejects.toThrow(/pinDigest/);
  });

  it('refuses two people sharing a name', async () => {
    await prisma.staffMember.create({ data: member() });
    await expect(
      prisma.staffMember.create({ data: member({ pinDigest: 'b'.repeat(64) }) }),
    ).rejects.toThrow(/name/);
  });
});

// C-110: the daypart windows (P1-1). Same discipline as store hours above and
// for a sharper reason: a window nobody can be inside is not a loud failure,
// it is an item that quietly leaves the menu forever. `daypartClosure` reads
// every nonsense row as "not served" and has no way to tell that apart from a
// schedule that meant it.
describe('item daypart windows', () => {
  beforeEach(async () => {
    await resetDatabase();
    await seedSampleMenu();
  });

  const window = (overrides: Record<string, unknown> = {}) => ({
    itemId: 'burrito',
    dayOfWeek: 5,
    startMinute: 16 * 60,
    endMinute: 21 * 60,
    ...overrides,
  });

  it('accepts a sane dinner window', async () => {
    await expect(prisma.menuItemWindow.create({ data: window() })).resolves.toMatchObject({
      dayOfWeek: 5,
    });
  });

  it('accepts two windows on the same day — this is why it is a child table', async () => {
    // Breakfast and dinner with nothing in between. `StoreHours` cannot model
    // this by design (C-011); an item must, because that is the whole feature.
    await prisma.menuItemWindow.create({ data: window() });
    await expect(
      prisma.menuItemWindow.create({ data: window({ startMinute: 7 * 60, endMinute: 11 * 60 }) }),
    ).resolves.toMatchObject({ startMinute: 420 });
  });

  it('refuses two windows starting at the same minute on the same day', async () => {
    // Either a duplicate or a contradiction, and both would make the answer
    // depend on row order.
    await prisma.menuItemWindow.create({ data: window() });
    await expect(
      prisma.menuItemWindow.create({ data: window({ endMinute: 22 * 60 }) }),
    ).rejects.toMatchObject({ code: 'P2002' });
  });

  it('refuses a day outside 0–6', async () => {
    await expect(prisma.menuItemWindow.create({ data: window({ dayOfWeek: 7 }) })).rejects.toThrow(
      /menu_item_window_day_of_week_range/i,
    );
  });

  it('refuses minutes outside the day', async () => {
    await expect(
      prisma.menuItemWindow.create({ data: window({ startMinute: -1 }) }),
    ).rejects.toThrow(/menu_item_window_minutes_in_range/i);
    await expect(
      prisma.menuItemWindow.create({ data: window({ endMinute: 1441 }) }),
    ).rejects.toThrow(/menu_item_window_minutes_in_range/i);
  });

  it('accepts 1440 as an end — served through the last minute of the day', async () => {
    await expect(
      prisma.menuItemWindow.create({ data: window({ startMinute: 22 * 60, endMinute: 1440 }) }),
    ).resolves.toMatchObject({ endMinute: 1440 });
  });

  it('refuses an overnight window', async () => {
    // 22:00–02:00 is a real thing for a late-night kitchen and NOT what this
    // schema models — the same line `store_hours_closes_after_opening` draws.
    // Two rows on two days is how you say it; the write-up records the ceiling.
    await expect(
      prisma.menuItemWindow.create({ data: window({ startMinute: 22 * 60, endMinute: 2 * 60 }) }),
    ).rejects.toThrow(/menu_item_window_ends_after_start/i);
  });

  it('goes away with its item, unlike a snapshot row', async () => {
    // Cascade, not Restrict: a window is a property of a live menu row, not a
    // record of anything that happened.
    await prisma.menuItemWindow.create({ data: window({ itemId: 'chips' }) });
    await prisma.menuItem.delete({ where: { id: 'chips' } });
    expect(await prisma.menuItemWindow.count()).toBe(0);
  });
});

// C-111 (P1-2). Every row here is read by the price authority on every menu
// render, every cart-add and every placement. A row that makes no sense throws
// nowhere — it quietly reprices the menu — so the database refuses to hold one.
describe('staged prices', () => {
  beforeEach(async () => {
    await resetDatabase();
    await seedSampleMenu();
  });

  const staged = (overrides: Record<string, unknown> = {}) => ({
    itemId: 'burrito',
    effectiveDay: '2026-09-14',
    priceCents: 1250,
    ...overrides,
  });

  it('accepts a change queued for a future day', async () => {
    await expect(prisma.stagedPrice.create({ data: staged() })).resolves.toMatchObject({
      effectiveDay: '2026-09-14',
      priceCents: 1250,
    });
  });

  it('accepts more than one change for the same row — this is why it is a child table', async () => {
    // Monday's increase and a holiday price two weeks later are both real, and
    // neither should have to wait for the other to land to be written down. A
    // `stagedPriceCents`/`stagedFrom` column pair could not hold both.
    await prisma.stagedPrice.create({ data: staged() });
    await expect(
      prisma.stagedPrice.create({ data: staged({ effectiveDay: '2026-09-28', priceCents: 1300 }) }),
    ).resolves.toMatchObject({ priceCents: 1300 });
  });

  it('refuses two prices for the same row on the same day', async () => {
    // A contradiction whose answer would depend on row order — the same rule
    // `MenuItemWindow` makes about two windows starting at the same minute.
    await prisma.stagedPrice.create({ data: staged() });
    await expect(
      prisma.stagedPrice.create({ data: staged({ priceCents: 1300 }) }),
    ).rejects.toMatchObject({ code: 'P2002' });
  });

  it('lets two different rows share a day, because the NULL target is distinct', async () => {
    // The unique is over nullable columns, so every option row has itemId NULL
    // and every item row has optionId NULL. Postgres treats those NULLs as
    // distinct, which is what keeps one unique index from serialising the whole
    // menu onto one change per day.
    await prisma.stagedPrice.create({ data: staged() });
    await prisma.stagedPrice.create({ data: staged({ itemId: 'bowl' }) });
    await prisma.stagedPrice.create({
      data: { optionId: 'guacamole', effectiveDay: '2026-09-14', priceCents: 250 },
    });
    await expect(
      prisma.stagedPrice.create({
        data: { optionId: 'carnitas', effectiveDay: '2026-09-14', priceCents: 200 },
      }),
    ).resolves.toMatchObject({ optionId: 'carnitas' });
  });

  it('refuses a row with no target', async () => {
    await expect(
      prisma.stagedPrice.create({ data: { effectiveDay: '2026-09-14', priceCents: 1250 } }),
    ).rejects.toThrow(/staged_price_one_target/i);
  });

  it('refuses a row with two targets', async () => {
    // A price for two things, whose resolution would depend on which branch
    // the mapping happened to check first.
    await expect(
      prisma.stagedPrice.create({ data: staged({ optionId: 'guacamole' }) }),
    ).rejects.toThrow(/staged_price_one_target/i);
  });

  it('refuses a day that is not a day', async () => {
    // It is compared to `restaurantClock(...).day` as a STRING, and ISO dates
    // only sort chronologically while they all look like this.
    await expect(
      prisma.stagedPrice.create({ data: staged({ effectiveDay: '14/09/2026' }) }),
    ).rejects.toThrow(/staged_price_effective_day_shape/i);
    await expect(
      prisma.stagedPrice.create({ data: staged({ effectiveDay: '2026-9-14 ' }) }),
    ).rejects.toThrow(/staged_price_effective_day_shape/i);
  });

  it('refuses a negative ITEM price but allows a negative option delta', async () => {
    // An item that pays the customer to order it is a typo every time. "Small
    // −$1.50" is an ordinary discount and always has been (C-002).
    await expect(prisma.stagedPrice.create({ data: staged({ priceCents: -1 }) })).rejects.toThrow(
      /staged_price_item_not_negative/i,
    );
    await expect(
      prisma.stagedPrice.create({
        data: { optionId: 'small', effectiveDay: '2026-09-14', priceCents: -150 },
      }),
    ).resolves.toMatchObject({ priceCents: -150 });
  });

  it('goes away with its item, unlike a snapshot row', async () => {
    // Cascade, like a daypart window: a queued price for an item that no
    // longer exists is not a record of anything that happened.
    await prisma.stagedPrice.create({ data: staged({ itemId: 'chips' }) });
    await prisma.menuItem.delete({ where: { id: 'chips' } });
    expect(await prisma.stagedPrice.count()).toBe(0);
  });

  it('goes away with its option too', async () => {
    await prisma.stagedPrice.create({
      data: { optionId: 'guacamole', effectiveDay: '2026-09-14', priceCents: 250 },
    });
    await prisma.modifierOption.delete({ where: { id: 'guacamole' } });
    expect(await prisma.stagedPrice.count()).toBe(0);
  });
});
