import { createHash } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { ROTATED_OUT_PASSCODE } from './auth-file';

// The staff boundary (C-037).
//
// The ONE spec file that runs signed OUT — everything it asserts is about what
// happens without the cookie every other file is handed by global setup.
test.use({ storageState: { cookies: [], origins: [] } });

const PASSCODE = process.env.STAFF_PASSCODE ?? '';

test.describe('signed out', () => {
  test('the queue redirects to the sign-in, remembering where it was going', async ({ page }) => {
    await page.goto('/kitchen/settings');
    await expect(page).toHaveURL('/kitchen/login?next=%2Fkitchen%2Fsettings');
    await expect(page.getByRole('heading', { name: 'Kitchen sign-in' })).toBeVisible();
  });

  // The one that matters. A redirect on the GET is cosmetic if the writes are
  // still reachable — a server action is a POST to the page's own path, and
  // this asserts the boundary catches it as such.
  test('the event feed is behind the same door (C-161)', async ({ request }) => {
    const response = await request.get('/kitchen/events?after=0', { maxRedirects: 0 });
    expect(response.status()).toBe(307);
  });

  test('a POST to a kitchen route is refused outright', async ({ request }) => {
    for (const path of ['/kitchen', '/kitchen/menu', '/kitchen/settings']) {
      const response = await request.post(path, { data: {} });
      expect(response.status(), path).toBe(401);
    }
  });

  test('the customer surfaces are untouched', async ({ page }) => {
    await page.goto('/menu');
    await expect(page.getByRole('heading', { name: /Firebird Kitchen/ })).toBeVisible();
  });

  test('a wrong passcode says so and stays locked', async ({ page }) => {
    await page.goto('/kitchen/login');
    await page.getByLabel('Passcode').fill('not-the-passcode');
    await page.getByRole('button', { name: 'Sign in' }).click();
    // By text, not by role: Next's route announcer is itself a role="alert"
    // live region, so getByRole('alert') is a strict-mode violation on every
    // page in the app.
    await expect(page.getByText('That passcode is not right.')).toBeVisible();

    await page.goto('/kitchen');
    await expect(page).toHaveURL(/\/kitchen\/login/);
  });

  // `next` arrives from whoever crafted the link, so it is a trust boundary:
  // an off-site target must not survive the round trip.
  test('an off-site next lands on the queue, not off-site', async ({ page }) => {
    await page.goto('/kitchen/login?next=https%3A%2F%2Fexample.com%2F');
    await signIn(page);
    await expect(page).toHaveURL('/kitchen');
  });
});

test.describe('signing in', () => {
  test('the right passcode opens the queue, and sign out closes it again', async ({ page }) => {
    await page.goto('/kitchen/login?next=%2Fkitchen%2Fsettings');
    await signIn(page);
    await expect(page).toHaveURL('/kitchen/settings');

    await page.goto('/kitchen');
    await page.getByRole('button', { name: 'Sign out' }).click();
    await expect(page).toHaveURL('/kitchen/login');

    await page.goto('/kitchen');
    await expect(page).toHaveURL(/\/kitchen\/login/);
  });
});

// PRD 6 P1-4 (C-158): a tablet signed in under the passcode being rotated away
// from stays signed in, and walks away holding a cookie for the new one.
test('a tablet signed in under the old passcode is moved to the new one, not signed out', async ({
  page,
  context,
  baseURL,
}) => {
  const token = (passcode: string) =>
    createHash('sha256').update(`countertop-staff:${passcode}`).digest('hex');
  await context.addCookies([
    { name: 'ct_staff', value: token(ROTATED_OUT_PASSCODE), url: `${baseURL}/kitchen` },
  ]);

  await page.goto('/kitchen');
  await expect(page).toHaveURL('/kitchen');
  const cookie = (await context.cookies()).find((c) => c.name === 'ct_staff');
  expect(cookie?.value).toBe(token(PASSCODE));
});

/** The passcode comes from the environment the app was started with — a
 *  literal here would pass against the wrong server. */
async function signIn(page: Page): Promise<void> {
  expect(PASSCODE, 'STAFF_PASSCODE must be set for the e2e run').not.toBe('');
  await page.getByLabel('Passcode').fill(PASSCODE);
  await page.getByRole('button', { name: 'Sign in' }).click();
}
