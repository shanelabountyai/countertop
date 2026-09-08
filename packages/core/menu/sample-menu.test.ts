// What the seeded menu has to be true about itself (C-112).
//
// `SAMPLE_MENU` is the only place items are AUTHORED in this repo — the menu
// editor edits, it does not add or remove (recorded caveat C-015) — so a claim
// about every item is a claim the compiler cannot make and a database CHECK
// would only be able to make after a backfill. It gets made here instead.
import { describe, expect, it } from 'vitest';
import { SAMPLE_MENU } from './sample-menu';
import { STATION_LABELS, STATIONS } from './types';

const items = Object.values(SAMPLE_MENU.items);

describe('every item that is work belongs to a station', () => {
  // The direction that can be wrong. A dish nobody is assigned to is invisible
  // to the one thing stations are for: a cook killing a station in one tap and
  // getting all of it. The reverse — a station on a weight-0 item — is legal
  // and merely odd, so it is not asserted.
  it('gives a station to every item with prep weight', () => {
    const unstaffed = items.filter((item) => item.prepWeight > 0 && item.station === undefined);
    expect(unstaffed.map((item) => item.name)).toEqual([]);
  });

  it('leaves the items nobody makes without one', () => {
    const staffed = items.filter((item) => item.prepWeight === 0 && item.station !== undefined);
    expect(staffed.map((item) => item.name)).toEqual([]);
  });

  it('names every station it uses', () => {
    for (const item of items) {
      if (item.station !== undefined) expect(STATION_LABELS[item.station]).toBeTruthy();
    }
  });

  it('uses every station it declares', () => {
    // A station with nothing at it renders a "Select these 0" link on the 86
    // board, which the page filters out — so this is about the LIST being the
    // menu's stations rather than a wishlist.
    const used = new Set(items.map((item) => item.station));
    expect(STATIONS.filter((station) => !used.has(station))).toEqual([]);
  });
});

describe('the fryer is why stations exist', () => {
  // PRD 4's first Open Question, resolved at C-109 against the category grain
  // on exactly this evidence. If a future menu edit ever made the fryer fit
  // inside one category, the argument for this feature would have weakened and
  // somebody should know.
  it('spans more than one category, and none of them wholly', () => {
    const fried = items.filter((item) => item.station === 'fryer');
    const categories = new Set(fried.map((item) => item.categoryId));
    expect(categories.size).toBeGreaterThan(1);

    for (const categoryId of categories) {
      const unfried = items.filter(
        (item) => item.categoryId === categoryId && item.station !== 'fryer',
      );
      // The reverse-case failure the PRD calls worse than the one it fixes:
      // 86ing a category to express "the fryer is down" would have taken these
      // off the menu too.
      expect(unfried.length).toBeGreaterThan(0);
    }
  });
});
