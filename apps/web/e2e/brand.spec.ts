// The brand assets are the kind of thing that stays "fine" while quietly not
// rendering — a font that failed to load, an SVG the bundler dropped, a
// heading whose accessible name changed when the plain text became a lockup.
// These are the three assertions that would fail if any of that happened.
import { test, expect } from '@playwright/test';

test.describe('the Firebird lockup', () => {
  test('the menu heading is the lockup, and still reads "Firebird Kitchen"', async ({ page }) => {
    await page.goto('/menu');

    // The name has to survive the change from plain text to a two-part
    // wordmark with a decorative mark beside it — auth.spec.ts asserts the
    // same name, and it is what a screen reader announces.
    const heading = page.getByRole('heading', { name: /Firebird Kitchen/ });
    await expect(heading).toBeVisible();

    // The mark is drawn, decorative, and is the FLAME version — at 56px it is
    // above the 48px floor where the sheet drops the flame for the monogram.
    const mark = heading.locator('svg');
    await expect(mark).toHaveAttribute('aria-hidden', 'true');
    await expect(mark.locator('polygon')).toHaveCount(1);

    // The wordmark is set in the display serif, never the UI sans — the second
    // of the sheet's four don'ts, and the only one a stylesheet can regress.
    const wordmark = heading.getByText('Firebird', { exact: true });
    const family = await wordmark.evaluate((el) => getComputedStyle(el).fontFamily);
    expect(family).toContain('Zilla Slab');
  });

  test('the favicon is the monogram, served', async ({ page }) => {
    await page.goto('/menu');
    const href = await page.locator('link[rel="icon"]').first().getAttribute('href');
    expect(href).toBeTruthy();

    const response = await page.request.get(href!);
    expect(response.status()).toBe(200);
    const svg = await response.text();
    // Below 48px the flame drops out and only the F survives.
    expect(svg).toContain('>F<');
    expect(svg).not.toContain('<polygon');
  });
});
