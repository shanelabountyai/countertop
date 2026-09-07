import { describe, expect, it } from 'vitest';
import { itemsUsingGroup, searchMenu, selectionReach } from './reach';
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

describe('selectionReach', () => {
  // The case P0-3 was written for, and the reason the grain is a selection
  // rather than a category: the fryer's output is spread across Sides, Plates
  // and Sweets, and each of those categories also holds food that is fine.
  const FRIED = ['chips', 'chips-guac', 'taquitos', 'nachos', 'churros'];

  it('names every selected row, in menu order rather than click order', () => {
    const picked = selectionReach(SAMPLE_MENU, [...FRIED].reverse(), []);

    expect(picked.items.map((row) => row.name)).toEqual([
      'Chips & salsa',
      'Loaded nachos',
      'Chips & guac',
      'Taquitos',
      'Churros',
    ]);
    expect(picked.options).toEqual([]);
    // Three categories, which is why a category-level 86 could not have
    // expressed "the fryer is down" without also killing rice and paletas.
    expect(new Set(FRIED.map((id) => SAMPLE_MENU.items[id]?.categoryId)).size).toBe(3);
  });

  it('gives a selected option its FULL reach, not the rows on screen', () => {
    const picked = selectionReach(SAMPLE_MENU, [], ['guacamole']);

    expect(picked.options).toEqual([
      {
        id: 'guacamole',
        name: 'Guacamole',
        available: true,
        // The same four names C-107 puts on the single row. One derivation, so
        // the batch preview and the per-row line cannot come to disagree.
        usedOn: ['Burrito', 'California burrito', 'Torta', 'Loaded nachos'],
      },
    ]);
  });

  it('carries what is already sold out, so the batch says what it will change', () => {
    const menu = {
      ...SAMPLE_MENU,
      items: {
        ...SAMPLE_MENU.items,
        churros: { ...SAMPLE_MENU.items.churros!, available: false },
      },
    };

    const picked = selectionReach(menu, ['taquitos', 'churros'], []);
    expect(picked.items).toEqual([
      { id: 'taquitos', name: 'Taquitos', available: true },
      { id: 'churros', name: 'Churros', available: false },
    ]);
  });

  it('drops ids the menu no longer has rather than throwing at a cook', () => {
    // The selection lives in a URL, so a stale link outlives the row it names.
    const picked = selectionReach(SAMPLE_MENU, ['taquitos', 'deleted-item'], ['no-such-option']);
    expect(picked.items.map((row) => row.id)).toEqual(['taquitos']);
    expect(picked.options).toEqual([]);
  });

  it('is empty for an empty selection', () => {
    expect(selectionReach(SAMPLE_MENU, [], [])).toEqual({ items: [], options: [] });
  });
});
