import { beforeEach, describe, expect, it } from 'vitest';
import { appendOrderNote, historyWhere, loadOrderActivity } from './history';
import { placeOrder } from './placement';
import {
  resetDatabase,
  seedSampleMenu,
  seedSettings,
  seedStaff,
  seedStoreHours,
} from './testing/index';
import { applyOrderAction } from './transitions';

// `historyWhere` is the one decision in the history search (name vs. order
// number) — pure, so it gets a test that never touches Postgres.
describe('historyWhere', () => {
  it('matches everything on an empty query', () => {
    expect(historyWhere('')).toEqual({});
    expect(historyWhere('   ')).toEqual({});
  });

  it('matches a bare number by seq, case-insensitively by name too', () => {
    expect(historyWhere('47')).toEqual({
      OR: [{ seq: 47 }, { customerName: { contains: '47', mode: 'insensitive' } }],
    });
  });

  it('strips a leading # before treating it as a number', () => {
    expect(historyWhere('#047')).toEqual({
      OR: [{ seq: 47 }, { customerName: { contains: '#047', mode: 'insensitive' } }],
    });
  });

  it('falls back to a name search for anything not all digits', () => {
    expect(historyWhere('Dana')).toEqual({
      customerName: { contains: 'Dana', mode: 'insensitive' },
    });
  });

  it('searches for a LIKE metacharacter rather than with it', () => {
    // `%` typed into the box was matching every order this restaurant has
    // ever taken, which is the opposite of a search.
    expect(historyWhere('%')).toEqual({
      customerName: { contains: '\\%', mode: 'insensitive' },
    });
    expect(historyWhere('a_b')).toEqual({
      customerName: { contains: 'a\\_b', mode: 'insensitive' },
    });
    // The escape character itself, or it escapes whatever follows it.
    expect(historyWhere('a\\b')).toEqual({
      customerName: { contains: 'a\\\\b', mode: 'insensitive' },
    });
  });

  it('trims surrounding whitespace before deciding', () => {
    expect(historyWhere('  047  ')).toEqual({
      OR: [{ seq: 47 }, { customerName: { contains: '047', mode: 'insensitive' } }],
    });
  });

  // The day is the answer to `seq` recurring: #047 exists on every business day
  // the restaurant took 47 orders, so a number alone is a list and a number
  // plus a day is an order.
  it('narrows a bare number to one business day without joining the OR', () => {
    expect(historyWhere('47', '2026-08-30')).toEqual({
      businessDay: '2026-08-30',
      OR: [{ seq: 47 }, { customerName: { contains: '47', mode: 'insensitive' } }],
    });
  });

  it('narrows a name search, and filters by day with no term at all', () => {
    expect(historyWhere('Dana', '2026-08-30')).toEqual({
      businessDay: '2026-08-30',
      customerName: { contains: 'Dana', mode: 'insensitive' },
    });
    expect(historyWhere('', '2026-08-30')).toEqual({ businessDay: '2026-08-30' });
  });

  it('ignores a day that is not YYYY-MM-DD rather than refusing the search', () => {
    // Only a hand-edited URL can produce these — the date input submits the
    // format or nothing — and unfiltered results beside a blank date box is
    // the coherent answer.
    for (const bad of ['', 'yesterday', '2026-8-30', '08/30/2026', '2026-08-30T00:00:00Z']) {
      expect(historyWhere('Dana', bad)).toEqual({
        customerName: { contains: 'Dana', mode: 'insensitive' },
      });
    }
  });
});

// PRD 2 P0-4: the receipt's revert, and the reader that has to show it.
//
// Database-backed, unlike everything above, because the claim is about rows
// that survive — an append-only log with nothing taken out of it — and the
// only honest way to assert "nothing was removed" is to count what is there.
describe('the revert past the queue card', () => {
  // The operator's own clock: abandoned at 19:48, discovered at 20:05. The
  // engine has no undo WINDOW — the five seconds is the queue card's UI — and
  // seventeen minutes is what proves it.
  const CLOSED = new Date(Date.UTC(2026, 6, 5, 19, 48, 0));
  const FOUND = new Date(Date.UTC(2026, 6, 5, 20, 5, 0));

  let keyCounter = 0;
  async function readyOrder(): Promise<string> {
    const result = await placeOrder({
      cart: {
        lines: [
          {
            id: 'line-1',
            unitPriceAtAddCents: 1495,
            composition: {
              itemId: 'burrito',
              quantity: 1,
              selections: [
                { groupId: 'protein', optionId: 'carnitas' },
                { groupId: 'addons', optionId: 'guacamole' },
              ],
            },
          },
        ],
      },
      customerName: 'Dana',
      idempotencyKey: `revert-${(keyCounter += 1)}`,
      now: CLOSED,
    });
    if (!result.ok) throw new Error(`placement failed: ${JSON.stringify(result.errors)}`);
    for (let step = 0; step < 3; step += 1) {
      await applyOrderAction(result.order.id, { kind: 'advance', actor: 'staff' }, CLOSED);
    }
    return result.order.id;
  }

  beforeEach(async () => {
    await resetDatabase();
    await seedSampleMenu();
    await seedSettings();
    await seedStoreHours();
  });

  it('puts a no-show back on the queue seventeen minutes later, taking nothing out of the log', async () => {
    const orderId = await readyOrder();
    await applyOrderAction(orderId, { kind: 'abandon', actor: 'staff' }, CLOSED);

    const result = await applyOrderAction(
      orderId,
      { kind: 'revert', actor: 'staff', reason: 'customer_returned', note: 'came back at 8' },
      FOUND,
    );
    expect(result.ok).toBe(true);
    expect(result.ok && result.order.status).toBe('ready');

    const activity = await loadOrderActivity(orderId);
    // Four forward transitions, the abandon, then the revert. The abandon is
    // still there, at its own instant, with the revert beside it — the append-
    // only trigger is the mechanism and this is the assertion that it held.
    expect(activity.map((entry) => [entry.kind, entry.toStatus])).toEqual([
      ['transition', 'placed'],
      ['transition', 'accepted'],
      ['transition', 'preparing'],
      ['transition', 'ready'],
      ['transition', 'abandoned'],
      ['revert', 'ready'],
    ]);

    const revert = activity.at(-1)!;
    expect(revert.at).toEqual(FOUND);
    expect(revert.fromStatus).toBe('abandoned');
    expect(revert.reason).toBe('customer_returned');
    // The typed text, out of `detail` and onto the entry the receipt renders.
    // It was written to that column since C-003 and read by nothing until now.
    expect(revert.note).toBe('came back at 8');
  });

  it('leaves the note null when nobody typed one', async () => {
    const orderId = await readyOrder();
    await applyOrderAction(orderId, { kind: 'advance', actor: 'staff' }, CLOSED);
    await applyOrderAction(
      orderId,
      { kind: 'revert', actor: 'staff', reason: 'wrong_order' },
      FOUND,
    );

    const revert = (await loadOrderActivity(orderId)).at(-1)!;
    expect(revert.toStatus).toBe('ready');
    expect(revert.note).toBeNull();
  });
});

// Somebody can write on the ticket (PRD 2 P0-6, C-092).
//
// The claim is about ROWS, so it is asserted against rows: a note is an event
// on the append-only log, which is what makes "never overwriting a previous
// note" a property of the table rather than of the code that writes it.
describe('the staff note', () => {
  const CLOSED = new Date(Date.UTC(2026, 6, 5, 19, 48, 0));
  const FIRST = new Date(Date.UTC(2026, 6, 5, 19, 52, 0));
  const SECOND = new Date(Date.UTC(2026, 6, 5, 19, 58, 0));

  let keyCounter = 0;
  async function readyOrder(): Promise<string> {
    const result = await placeOrder({
      cart: {
        lines: [
          {
            id: 'line-1',
            unitPriceAtAddCents: 1495,
            composition: {
              itemId: 'burrito',
              quantity: 1,
              selections: [
                { groupId: 'protein', optionId: 'carnitas' },
                { groupId: 'addons', optionId: 'guacamole' },
              ],
            },
          },
        ],
      },
      customerName: 'Dana',
      idempotencyKey: `note-${(keyCounter += 1)}`,
      now: CLOSED,
    });
    if (!result.ok) throw new Error(`placement failed: ${JSON.stringify(result.errors)}`);
    for (let step = 0; step < 3; step += 1) {
      await applyOrderAction(result.order.id, { kind: 'advance', actor: 'staff' }, CLOSED);
    }
    return result.order.id;
  }

  beforeEach(async () => {
    await resetDatabase();
    await seedSampleMenu();
    await seedSettings();
    await seedStoreHours();
    await seedStaff();
  });

  it('appends beside the transitions with its instant, its actor and a name', async () => {
    const orderId = await readyOrder();

    expect(await appendOrderNote(orderId, 'no answer', FIRST, 'staff-noor')).toBe(true);
    expect(await appendOrderNote(orderId, 'called, arriving 7:40', SECOND, 'staff-theo')).toBe(true);

    const activity = await loadOrderActivity(orderId);
    // The four transitions are untouched and the two notes sit after them, in
    // the order they were written. NEITHER overwrote the other, which is the
    // requirement and the reason this is an event and not a column.
    expect(activity.map((entry) => entry.kind)).toEqual([
      'transition',
      'transition',
      'transition',
      'transition',
      'note',
      'note',
    ]);

    const [first, second] = activity.slice(-2);
    expect(first).toMatchObject({
      at: FIRST,
      actor: 'staff',
      staffName: 'Noor Haddad',
      note: 'no answer',
      // Nothing moved. Both status columns null is the fact, not an omission.
      fromStatus: null,
      toStatus: null,
      amountCents: null,
    });
    expect(second).toMatchObject({ at: SECOND, staffName: 'Theo Barnes', note: 'called, arriving 7:40' });
  });

  it('stands unattributed when no shift is signed on', async () => {
    // An honest null, the C-086 rule: a note nobody signed for is still worth
    // more than a refusal at the moment somebody is typing it.
    const orderId = await readyOrder();
    expect(await appendOrderNote(orderId, 'walked off', FIRST, null)).toBe(true);

    const note = (await loadOrderActivity(orderId)).at(-1)!;
    expect(note.kind).toBe('note');
    expect(note.staffName).toBeNull();
  });

  it('answers false for an order that is not there rather than throwing', async () => {
    expect(await appendOrderNote('no-such-order', 'anything', FIRST, null)).toBe(false);
  });
});
