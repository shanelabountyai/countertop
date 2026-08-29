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

  it('trims surrounding whitespace before deciding', () => {
    expect(historyWhere('  047  ')).toEqual({
      OR: [{ seq: 47 }, { customerName: { contains: '047', mode: 'insensitive' } }],
    });
  });
});
