import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { STAFF_AUTH_FILE } from './auth-file';
import { card, reseed } from './fixtures';

// C-008: the kitchen queue (P0-4, P0-11).
//
// The four seeded orders are placed through the real `placeOrder` and moved
// with the real `applyOrderAction` (see packages/db/seed.ts):
//
//   #001 Dana Reyes   placed 2m ago   — 2× burrito, NO onions, a line note
//   #002 Morgan Ellis preparing, 22m  — past the 15-minute flag
//   #003 Priya Shah   ready, 25m      — past the second no-show mark
//   #004 Sam Okafor   accepted        — five lines, none hidden

const heightOf = async (locator: Locator): Promise<number> => {
  const box = await locator.boundingBox();
  expect(box).not.toBeNull();
  return box?.height ?? 0;
};

test('groups the queue by state, with a count on each section', async ({ page }) => {
  await page.goto('/kitchen');
  await expect(page.getByRole('heading', { name: 'New (1)' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Accepted (1)' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Preparing (1)' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Ready for pickup (1)' })).toBeVisible();
});

test('a card carries everything the line cook needs, with the negation unmistakable', async ({
  page,
}) => {
  await page.goto('/kitchen');
  const dana = card(page, 'Dana Reyes');

  await expect(dana.getByRole('heading', { name: /^#\d{3}$/ })).toBeVisible();
  await expect(dana.getByText('2× Burrito')).toBeVisible();
  // Never truncated, never behind a hover.
  await expect(dana.getByText('Wrap it tight, it is going in a bike bag')).toBeVisible();

  // A removal must not read like an addition. The additive option is plain
  // text; the negation is not.
  const negation = dana.getByText('NO onions');
  const addition = dana.getByText('Guacamole');
  await expect(negation).toBeVisible();
  const negationStyle = await negation.evaluate((element) => {
    const style = getComputedStyle(element);
    return { background: style.backgroundColor, weight: style.fontWeight };
  });
  const additionBackground = await addition.evaluate(
    (element) => getComputedStyle(element).backgroundColor,
  );
  expect(negationStyle.background).not.toBe(additionBackground);
  expect(Number(negationStyle.weight)).toBeGreaterThanOrEqual(700);
});

test('item lines are legible at arm\'s length and every tap target clears 48px', async ({
  page,
}) => {
  await page.goto('/kitchen');
  const dana = card(page, 'Dana Reyes');

  const fontSize = await dana
    .getByText('2× Burrito')
    .evaluate((element) => Number.parseFloat(getComputedStyle(element).fontSize));
  expect(fontSize).toBeGreaterThanOrEqual(18);

  // Open the cancel disclosure first: a control nobody can see yet has no tap
  // target to measure, and the ones behind it have to clear the bar too.
  await dana.getByText('Cancel…').click();
  const controls = await dana.locator('button:visible, summary:visible, input:visible').all();
  expect(controls.length).toBeGreaterThan(3);
  const heights = await Promise.all(controls.map(heightOf));
  for (const height of heights) expect(height).toBeGreaterThanOrEqual(48);

  // The advance is the biggest control on the card (P0-4).
  const advance = await heightOf(dana.getByRole('button', { name: 'Accept' }));
  const others = heights.filter((height) => height !== advance);
  expect(advance).toBeGreaterThan(Math.max(...others));

  // The header nav links carry the same bar (P0-11): "Availability" is the
  // page a cook 86's an item from mid-rush, not a rarely-tapped exception.
  const navLinks = await page
    .locator('a', { hasText: /^(Availability|Edit menu|Settings|Sales|Customer menu)$/ })
    .all();
  expect(navLinks.length).toBe(5);
  // Both dimensions. A 48px-tall link 35px wide is still a 35px-wide target,
  // and "Sales" is the shortest label on the header.
  for (const link of navLinks) {
    const box = await link.boundingBox();
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(48);
    expect(box?.width ?? 0).toBeGreaterThanOrEqual(48);
  }
});

// Every staff screen's way back, in one loop. This exact miss has now
// happened three times — the header nav (height only), the two order-history
// links, and these four — each time on a page whose own controls were fine,
// because nothing had ever measured a `<Link>` that was not on the queue.
test('every staff screen\'s back link is a real tap target', async ({ page }) => {
  for (const path of [
    '/kitchen/availability',
    '/kitchen/menu',
    '/kitchen/settings',
    '/kitchen/report',
    '/kitchen/orders',
  ]) {
    await page.goto(path);
    const back = page.getByRole('link', { name: /^←/ }).first();
    const box = await back.boundingBox();
    expect(box?.height ?? 0, `back link on ${path}`).toBeGreaterThanOrEqual(48);
  }
});

test('flags a late ticket and a no-show taking shape', async ({ page }) => {
  await page.goto('/kitchen');
  await expect(card(page, 'Morgan Ellis').getByText(/running late/)).toBeVisible();
  await expect(card(page, 'Priya Shah').getByText(/On the shelf \d+ min — no-show\?/)).toBeVisible();
});

test('renders every line of the largest order', async ({ page }) => {
  await page.goto('/kitchen');
  await expect(card(page, 'Sam Okafor').locator('ul > li')).toHaveCount(5);
});

test('finds an order by name, and by the number printed on its own card', async ({ page }) => {
  await page.goto('/kitchen');

  await page.getByRole('searchbox').fill('Priya');
  await page.getByRole('button', { name: 'Find' }).click();
  await expect(card(page, 'Priya Shah')).toBeVisible();
  await expect(page.getByText('Dana Reyes')).toHaveCount(0);

  // The number a cook reads off the screen is the number they type in.
  const number = await card(page, 'Priya Shah').getByRole('heading').first().innerText();
  await page.getByRole('link', { name: 'Show all' }).click();
  await page.getByRole('searchbox').fill(number);
  await page.getByRole('button', { name: 'Find' }).click();
  await expect(card(page, 'Priya Shah')).toBeVisible();
  await expect(page.getByText('Sam Okafor')).toHaveCount(0);
});

test('the kitchen queue has no detectable accessibility violations', async ({ page }) => {
  await page.goto('/kitchen');
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  expect(results.violations).toEqual([]);
});

// These move orders. Reseeding first keeps them from depending on each other
// (or on a retry running against a queue a previous attempt already advanced).
test.describe('taking action on a card', () => {
  test.beforeEach(() => {
    reseed();
  });

  test('advancing moves the card and offers an undo that survives the re-render', async ({
    page,
  }) => {
    await page.goto('/kitchen');
    await card(page, 'Dana Reyes').getByRole('button', { name: 'Accept' }).click();

    await expect(page.getByRole('heading', { name: 'New (0)' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Accepted (2)' })).toBeVisible();

    const undo = card(page, 'Dana Reyes').getByRole('button', { name: /^Undo/ });
    await expect(undo).toBeVisible();
    await undo.click();

    await expect(page.getByRole('heading', { name: 'New (1)' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Accepted (1)' })).toBeVisible();
  });

  // The two advances that take a card OFF the queue. Their undo is real in the
  // engine (`STATUS_FACTS.picked_up.previous`) and was unreachable on the
  // screen until the "Just finished" strip existed: the tap that starts the
  // five-second countdown was the same tap that stopped the card being drawn.
  test('the advance that empties the queue still leaves its undo somewhere to live', async ({
    page,
  }) => {
    await page.goto('/kitchen');
    const strip = page.getByRole('region', { name: /Just finished/ });

    await card(page, 'Priya Shah').getByRole('button', { name: 'Picked up' }).click();
    await expect(page.getByRole('heading', { name: 'Ready for pickup (0)' })).toBeVisible();
    await expect(strip.getByText('Priya Shah')).toBeVisible();
    await strip.getByRole('button', { name: /^Undo/ }).click();
    await expect(page.getByRole('heading', { name: 'Ready for pickup (1)' })).toBeVisible();

    // Same hole, the other exit: a no-show closed out by mistake.
    await card(page, 'Priya Shah').getByRole('button', { name: 'No-show' }).click();
    await expect(page.getByRole('heading', { name: 'Ready for pickup (0)' })).toBeVisible();
    await strip.getByRole('button', { name: /^Undo/ }).click();
    await expect(page.getByRole('heading', { name: 'Ready for pickup (1)' })).toBeVisible();
  });

  // Two screens open on the same board is the ordinary case in a kitchen, not
  // the exotic one, and the poll is five seconds wide. Until this test existed
  // the card sent no target, so a tap from a stale screen advanced the order
  // from wherever it had got to in the meantime: "Start cooking" on a screen
  // five seconds behind marked an order picked up, and the bag sat on the pass
  // while the customer was told it had been collected. The engine has had the
  // `unexpected_target` refusal since C-004; the screen had never asked for it.
  test('a tap from a screen that has fallen behind is refused, not applied', async ({
    browser,
  }) => {
    const context = await browser.newContext({ storageState: STAFF_AUTH_FILE });
    const stale = await context.newPage();
    const live = await context.newPage();
    // Freeze the stale screen: block its poll so it keeps the board it drew.
    // Without this the test races the five-second cursor and proves nothing.
    await stale.route('**/api/updates**', (route) => route.abort());

    await stale.goto('/kitchen');
    await live.goto('/kitchen');
    const accept = card(stale, 'Dana Reyes').getByRole('button', { name: 'Accept' });
    await expect(accept).toBeVisible();

    // The other screen moves her on. The stale card still says "Accept".
    await card(live, 'Dana Reyes').getByRole('button', { name: 'Accept' }).click();
    await expect(live.getByRole('heading', { name: 'Accepted (2)' })).toBeVisible();

    await accept.click();

    // Refused BY REASON — the message names both states — and, the part that
    // matters, she did not skip to `preparing`.
    await expect(
      card(stale, 'Dana Reyes').getByText(/is accepted; the next state is preparing/),
    ).toBeVisible();
    await live.reload();
    await expect(live.getByRole('heading', { name: 'Accepted (2)' })).toBeVisible();
    await expect(live.getByRole('heading', { name: 'Preparing (1)' })).toBeVisible();

    await context.close();
  });

  test('cancelling asks for a reason, and a no-show is closed out as its own thing', async ({
    page,
  }) => {
    await page.goto('/kitchen');
    // A <summary> is a disclosure, not a button: target it the way it reads.
    await card(page, 'Morgan Ellis').getByText('Cancel…').click();
    await card(page, 'Morgan Ellis').getByRole('button', { name: 'Out of an item' }).click();
    await expect(page.getByRole('heading', { name: 'Preparing (0)' })).toBeVisible();
    await expect(page.getByText('Morgan Ellis')).toHaveCount(0);

    // `abandoned`, not `cancelled` — the no-show rate is its own signal.
    await card(page, 'Priya Shah').getByRole('button', { name: 'No-show' }).click();
    await expect(page.getByRole('heading', { name: 'Ready for pickup (0)' })).toBeVisible();
  });
});

// C-009: polling with a server-issued cursor (P0-5).
test.describe('the queue keeps itself fresh', () => {
  test.beforeEach(() => {
    reseed();
  });

  test('a change made on another screen arrives without anyone reloading', async ({
    page,
    context,
  }) => {
    await page.goto('/kitchen');
    await expect(page.getByRole('heading', { name: 'New (1)' })).toBeVisible();
    // Survives a re-render; does not survive a page load. What tells the two
    // apart at the end of the test.
    await page.evaluate(() => {
      (window as Window & { __neverReloaded?: boolean }).__neverReloaded = true;
    });

    // The second screen in the kitchen — the expo's, not this cook's.
    const other = await context.newPage();
    await other.goto('/kitchen');
    await card(other, 'Dana Reyes').getByRole('button', { name: 'Accept' }).click();
    await expect(other.getByRole('heading', { name: 'Accepted (2)' })).toBeVisible();
    await other.close();

    // Nobody touched this page. One poll interval plus room for the render.
    await expect(page.getByRole('heading', { name: 'New (0)' })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole('heading', { name: 'Accepted (2)' })).toBeVisible();
    expect(
      await page.evaluate(() => (window as Window & { __neverReloaded?: boolean }).__neverReloaded),
    ).toBe(true);
  });

  test('a backgrounded tab asks nothing at all', async ({ context }) => {
    const hidden = await context.newPage();
    await hidden.addInitScript(() => {
      Object.defineProperty(document, 'hidden', { get: () => true });
    });

    let polls = 0;
    await hidden.route('**/api/updates**', async (route) => {
      polls += 1;
      await route.continue();
    });

    await hidden.goto('/kitchen');
    await expect(hidden.getByRole('heading', { name: 'Kitchen queue' })).toBeVisible();
    // Longer than one interval: a tab that polls would have polled by now.
    await hidden.waitForTimeout(8_000);
    expect(polls).toBe(0);
    await hidden.close();
  });
});

// C-010: the new-order alert (P0-12).
//
// "An order arriving silently is a test failure" is an acceptance criterion,
// so the chime is asserted, not assumed. Counting real sound is not something
// a browser will tell us, so the AudioContext is stubbed in the page and the
// oscillators it would have played are counted. Nothing test-only ships in the
// component — it builds a normal AudioContext and this replaces the class.
const countChimes = `
  window.__chimes = 0;
  class CountingAudioContext {
    state = 'running';
    currentTime = 0;
    destination = {};
    resume() { return Promise.resolve(); }
    createGain() {
      return {
        gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} },
        connect: (node) => node,
      };
    }
    createOscillator() {
      window.__chimes += 1;
      return {
        type: '',
        frequency: { setValueAtTime() {} },
        connect: (node) => node,
        start() {}, stop() {},
      };
    }
  }
  window.AudioContext = CountingAudioContext;
`;

const chimes = (page: Page): Promise<number> =>
  page.evaluate(() => (window as Window & { __chimes?: number }).__chimes ?? 0);

test.describe('a new order announces itself', () => {
  test.beforeEach(() => {
    reseed();
  });

  test('chimes, and keeps chiming, until someone accepts', async ({ page }) => {
    await page.addInitScript(countChimes);
    await page.goto('/kitchen');

    // The seeded #001 is `placed`: the screen should be shouting on arrival,
    // with no gesture and nothing having "happened" while the page was open.
    await expect(page.getByText('1 new order — tap Accept to acknowledge')).toBeVisible();
    await expect.poll(() => chimes(page)).toBeGreaterThanOrEqual(1);

    // Repeating, not a single ding somebody can be washing a pan through.
    await expect.poll(() => chimes(page), { timeout: 15_000 }).toBeGreaterThanOrEqual(2);

    await card(page, 'Dana Reyes').getByRole('button', { name: 'Accept' }).click();
    await expect(page.getByTestId('new-order-alert')).toHaveCount(0);

    // Acknowledged means silent. Wait out more than one interval and prove it.
    const afterAck = await chimes(page);
    await page.waitForTimeout(8_000);
    expect(await chimes(page)).toBe(afterAck);
  });

  test('the alert survives a reload, because it is derived from state', async ({ page }) => {
    await page.addInitScript(countChimes);
    await page.goto('/kitchen');
    await expect(page.getByText('1 new order — tap Accept to acknowledge')).toBeVisible();

    // A client-side "an order arrived" event dies here. A count derived from
    // `needsAcknowledgment` does not — that is the whole requirement.
    await page.reload();
    await expect(page.getByText('1 new order — tap Accept to acknowledge')).toBeVisible();
    await expect.poll(() => chimes(page)).toBeGreaterThanOrEqual(1);
  });

  test('an un-acknowledged card is distinct from every other card', async ({ page }) => {
    await page.goto('/kitchen');
    const unacked = card(page, 'Dana Reyes');
    await expect(unacked.getByText('New — not yet accepted')).toBeVisible();

    const style = (locator: Locator) =>
      locator.evaluate((element) => {
        const computed = getComputedStyle(element);
        return { border: computed.borderColor, background: computed.backgroundColor };
      });

    const isNew = await style(unacked);
    // Against a plain card AND against a late one: "distinct from every other
    // state" means the red aging flag is not close enough either.
    for (const name of ['Sam Okafor', 'Morgan Ellis']) {
      const other = await style(card(page, name));
      expect(isNew.border).not.toBe(other.border);
      expect(isNew.background).not.toBe(other.background);
    }
  });

  test('a lookup filtering the card off screen does not silence the alert', async ({ page }) => {
    await page.addInitScript(countChimes);
    await page.goto('/kitchen');

    // Searching for somebody else hides #001 — and would hide the fact that
    // nobody has accepted it, if the count were taken off the filtered list.
    await page.getByRole('searchbox').fill('Priya');
    await page.getByRole('button', { name: 'Find' }).click();
    await expect(page.getByText('Dana Reyes')).toHaveCount(0);

    await expect(page.getByText('1 new order — tap Accept to acknowledge')).toBeVisible();
    await expect.poll(() => chimes(page)).toBeGreaterThanOrEqual(1);
  });

  test('the alerting queue has no detectable accessibility violations', async ({ page }) => {
    await page.goto('/kitchen');
    await expect(page.getByText('1 new order — tap Accept to acknowledge')).toBeVisible();
    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    expect(results.violations).toEqual([]);
  });
});
