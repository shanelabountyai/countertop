import { beforeEach, describe, expect, it } from 'vitest';
import { prisma } from './index.js';
import { resetDatabase } from './testing/index.js';

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
