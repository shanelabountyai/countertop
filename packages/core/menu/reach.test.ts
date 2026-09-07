import { describe, expect, it } from 'vitest';
import { itemsUsingGroup, searchMenu } from './reach';
import { SAMPLE_MENU } from './sample-menu';

// The two directions of reach, off the real seeded menu rather than a fixture:
// the 86 board is judged against the 25-item menu a cook actually scrolls, and
// a hand-built three-item menu would hide exactly the crowding that makes the
// search necessary.

const names = (ids: Set<string>) =>
  Object.values(SAMPLE_MENU.items)
    .filter((item) => ids.has(item.id))
    .map((item) => item.name);

const optionNames = (ids: Set<string>) =>
  Object.values(SAMPLE_MENU.groups)
    .flatMap((group) => group.options)
    .filter((option) => ids.has(option.id))
    .map((option) => option.name);

describe('itemsUsingGroup', () => {
  it('names every item carrying a shared group, in menu order', () => {
    expect(itemsUsingGroup(SAMPLE_MENU, 'addons')).toEqual([
      'Burrito',
      'California burrito',
      'Torta',
      'Loaded nachos',
    ]);
  });

  it('is empty for a group nothing carries', () => {
    expect(itemsUsingGroup(SAMPLE_MENU, 'no-such-group')).toEqual([]);
  });
});

describe('searchMenu', () => {
  it('finds the option AND the items it stops (P0-2)', () => {
    const shown = searchMenu(SAMPLE_MENU, 'guac');

    // The option is the thing being 86'd, so it has to be findable by name.
    expect(optionNames(shown.optionIds)).toEqual(['Guacamole']);
    // The four items carrying Add-ons come with it — none of them is called
    // "guac" — plus the side that is.
    expect(names(shown.itemIds)).toEqual([
      'Burrito',
      'California burrito',
      'Torta',
      'Loaded nachos',
      'Chips & guac',
    ]);
  });

  it('matches case-insensitively and ignores surrounding whitespace', () => {
    const shown = searchMenu(SAMPLE_MENU, '  GUAC ');
    expect(optionNames(shown.optionIds)).toEqual(['Guacamole']);
    expect(shown.itemIds.has('chips-guac')).toBe(true);
  });

  it('an item match does not drag in that item’s options', () => {
    const shown = searchMenu(SAMPLE_MENU, 'Loaded nachos');
    expect(names(shown.itemIds)).toEqual(['Loaded nachos']);
    // Someone typing an item name wants to 86 the item, not to be handed
    // every salsa on it. The asymmetry with the option direction is the point.
    expect(shown.optionIds.size).toBe(0);
  });

  it('shows the whole board for an empty query', () => {
    for (const query of ['', '   ']) {
      const shown = searchMenu(SAMPLE_MENU, query);
      expect(shown.itemIds.size).toBe(Object.keys(SAMPLE_MENU.items).length);
      expect(shown.optionIds.size).toBe(
        Object.values(SAMPLE_MENU.groups).reduce((n, group) => n + group.options.length, 0),
      );
    }
  });

  it('shows nothing when nothing matches, rather than falling back to everything', () => {
    const shown = searchMenu(SAMPLE_MENU, 'lobster');
    expect(shown.itemIds.size).toBe(0);
    expect(shown.optionIds.size).toBe(0);
  });
});
