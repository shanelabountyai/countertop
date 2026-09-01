import { describe, expect, it } from 'vitest';
import { historyWhere } from './history';

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
