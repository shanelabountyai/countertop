// PRD 7 P0-1's own test line (C-101): the same phone typed two ways is one
// member. The database enforces that with a unique index on the digest; this
// is the half that decides what gets digested, and it is where the "two ways"
// actually becomes "one".
import { describe, expect, it } from 'vitest';
import { isEnrollablePhone, normalizePhone } from './phone';

describe('normalizePhone', () => {
  // The PRD's pair, verbatim.
  it('reads the PRD\'s two spellings as the same number', () => {
    expect(normalizePhone('(555) 010-2233')).toEqual({ digits: '5550102233', last4: '2233' });
    expect(normalizePhone('5550102233')).toEqual({ digits: '5550102233', last4: '2233' });
  });

  it.each([
    ['555-010-2233'],
    ['555.010.2233'],
    ['+1 (555) 010-2233'],
    ['1 555 010 2233'],
    ['  555 010 2233  '],
  ])('and every other way a person types it: %s', (typed) => {
    expect(normalizePhone(typed)?.digits).toBe('5550102233');
  });

  it('takes the last four as they are, leading zeros included', () => {
    // A `Number` anywhere in this path would turn 0233 into 233 and the
    // counter would be looking for a member that does not exist.
    expect(normalizePhone('555-010-0233')?.last4).toBe('0233');
  });

  it.each([
    ['', 'empty'],
    ['555010223', 'nine digits'],
    ['25550102233', 'eleven digits that do not start with 1 — a typo, not a country code'],
    ['155501022334', 'twelve digits'],
    ['+44 20 7946 0000', 'outside the NANP'],
    ['ext. 4', 'not a phone number at all'],
  ])('refuses %s (%s)', (typed) => {
    expect(normalizePhone(typed)).toBeNull();
  });

  it('refuses an absent phone rather than inventing one', () => {
    expect(normalizePhone(null)).toBeNull();
    expect(normalizePhone(undefined)).toBeNull();
  });
});

describe('isEnrollablePhone', () => {
  // The checkbox and the writer ask the same question, so a customer cannot
  // tick a box that the enrolment then declines.
  it('agrees with normalizePhone, always', () => {
    for (const typed of ['(555) 010-2233', '5550102233', '555010223', '', '+44 20 7946 0000']) {
      expect(isEnrollablePhone(typed)).toBe(normalizePhone(typed) !== null);
    }
  });
});
