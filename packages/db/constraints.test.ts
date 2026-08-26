import { beforeEach, describe, expect, it } from 'vitest';
import { prisma } from './index';
import { resetDatabase } from './testing/index';

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
      prisma.restaurantSettings.create({ data: settings({ maxOpenOrders: 0 }) }),
    ).rejects.toThrow(/max_open_orders_positive/i);
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
      prisma.restaurantSettings.create({ data: settings({ prepPerOrderMinutes: -1 }) }),
    ).rejects.toThrow(/prep_per_order_in_range/i);
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
