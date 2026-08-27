'use server';

// The operator's settings (C-023). Hours, the auto-pause threshold, the
// pre-close cutoff and the two estimate numbers.
//
// Every rule enforced here is ALSO a CHECK constraint in the database (C-011,
// C-013, C-022). That is deliberate and it is the house pattern: the
// constraint is what makes the rule true, this is what makes it readable. A
// manager who types 900 into "minutes per prep point" should be told the ceiling is
// 60, not handed a Postgres error string.
//
// Plain `<form action={...}>` posts, so the screen works before it hydrates —
// same reasoning as the cart's Remove button.
import { formatMinuteOfDay, restaurantClock, WEEKDAY_NAMES } from '@countertop/core';
import { prisma } from '@countertop/db';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';

/** Every surface the gate's answer reaches. The customer screens all read it
 *  on render and are `force-dynamic`, so they pick a change up on the next
 *  navigation or poll. */
function revalidateGateSurfaces(): void {
  revalidatePath('/kitchen');
  revalidatePath('/kitchen/settings');
  revalidatePath('/cart');
  revalidatePath('/checkout');
  revalidatePath('/menu');
}

function done(saved: string): never {
  revalidateGateSurfaces();
  redirect(`/kitchen/settings?saved=${encodeURIComponent(saved)}`);
}

/** Back with the REASON, not a generic failure. The whole point of validating
 *  in front of a constraint is that the message can name the bound. */
function rejected(why: string): never {
  redirect(`/kitchen/settings?error=${encodeURIComponent(why)}`);
}

/** "11:30" → 690. Null on anything else — including "24:00", which no time
 *  input produces and which the close-at-midnight rule below covers. */
function parseTimeOfDay(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const match = /^(\d{2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
}

/** A whole number inside a range, or null. */
function parseBounded(value: unknown, low: number, high: number): number | null {
  if (typeof value !== 'string' || value.trim() === '') return null;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < low || parsed > high) return null;
  return parsed;
}

// NOTE: a 'use server' file may only export async functions. The weekday
// names live in packages/core — which is where they belonged anyway, since the
// gate's "we open on Thursday" message indexes the same array by the same
// number. Exporting them from here compiled, type-checked and lint-passed, and
// failed at BUILD time; see C-007 in the write-up for the last time that
// happened.

/**
 * The week, saved as a week.
 *
 * A day with its "Open" box unticked has NO row — a missing day is a closed
 * day (the schema says so), so a week is configured by listing what opens and
 * a deleted row can never leave a door open by accident.
 *
 * Closing time 00:00 means midnight at the END of the day, stored as 1440.
 * `<input type="time">` cannot express 24:00, and the constraint that a close
 * must be after its open makes the reading unambiguous: nothing can close at
 * the start of its own day.
 */
export async function saveHours(formData: FormData): Promise<void> {
  const rows: { dayOfWeek: number; openMinute: number; closeMinute: number }[] = [];

  for (const [dayOfWeek, name] of WEEKDAY_NAMES.entries()) {
    if (formData.get(`open-${dayOfWeek}`) !== 'on') continue;

    const openMinute = parseTimeOfDay(formData.get(`from-${dayOfWeek}`));
    const parsedClose = parseTimeOfDay(formData.get(`to-${dayOfWeek}`));
    if (openMinute === null || parsedClose === null) {
      rejected(`${name} needs an opening and a closing time.`);
    }
    const closeMinute = parsedClose === 0 ? 1440 : parsedClose;
    if (closeMinute <= openMinute) {
      rejected(
        `${name} closes at ${formatMinuteOfDay(closeMinute)}, which is not after it opens at ${formatMinuteOfDay(openMinute)}. Overnight service is not supported.`,
      );
    }
    rows.push({ dayOfWeek, openMinute, closeMinute });
  }

  // Replace the week wholesale, in one transaction: a partial write would
  // leave the restaurant open on days the manager just closed.
  await prisma.$transaction([
    prisma.storeHours.deleteMany(),
    prisma.storeHours.createMany({ data: rows }),
  ]);

  done(
    rows.length === 0
      ? 'Hours saved — the restaurant is now closed every day.'
      : `Hours saved — open ${rows.length} ${rows.length === 1 ? 'day' : 'days'} a week.`,
  );
}

/**
 * The four service numbers. Each range below is the same range its CHECK
 * constraint carries; the numbers are repeated rather than imported because
 * the constraint is SQL and cannot export anything, and a comment naming its
 * migration is the honest way to say so.
 */
export async function saveService(formData: FormData): Promise<void> {
  // CHECK "maxOpenWeight" > 0 (checkout_gate, renamed in prep_weight). The
  // upper bound is this screen's own: a threshold above 500 is a threshold
  // that never fires, and a manager who wants that should use the pause
  // switch. Units are prep weight now, not orders (P1-7).
  const maxOpenWeight = parseBounded(formData.get('maxOpenWeight'), 1, 500);
  if (maxOpenWeight === null) rejected('Pause above must be a whole number of prep points, 1 to 500.');

  // CHECK "cutoffMinutes" BETWEEN 0 AND 720 (checkout_gate).
  const cutoffMinutes = parseBounded(formData.get('cutoffMinutes'), 0, 720);
  if (cutoffMinutes === null) {
    rejected('Last order before close must be a whole number of minutes, 0 to 720.');
  }

  // CHECK "prepBaseMinutes" BETWEEN 0 AND 240 (ready_time_estimate).
  const prepBaseMinutes = parseBounded(formData.get('prepBaseMinutes'), 0, 240);
  if (prepBaseMinutes === null) {
    rejected('Base prep time must be a whole number of minutes, 0 to 240.');
  }

  // CHECK "prepPerWeightMinutes" BETWEEN 0 AND 60 (ready_time_estimate,
  // renamed in prep_weight).
  const prepPerWeightMinutes = parseBounded(formData.get('prepPerWeightMinutes'), 0, 60);
  if (prepPerWeightMinutes === null) {
    rejected('Added per prep point must be a whole number of minutes, 0 to 60.');
  }

  await prisma.restaurantSettings.update({
    where: { id: 'singleton' },
    data: { maxOpenWeight, cutoffMinutes, prepBaseMinutes, prepPerWeightMinutes },
  });
  done('Service settings saved.');
}

/**
 * The one-tap "we are not opening today" override (P0-6).
 *
 * The date is computed HERE from the restaurant's own clock, never taken from
 * the form: a browser in another timezone would otherwise close the wrong day,
 * and "today" is the only date this control can mean.
 */
export async function setClosedToday(closed: boolean): Promise<void> {
  const settings = await prisma.restaurantSettings.findUniqueOrThrow({
    where: { id: 'singleton' },
  });
  const today = restaurantClock(new Date(), settings.timezone).day;

  await prisma.restaurantSettings.update({
    where: { id: 'singleton' },
    data: { closedOnDay: closed ? today : null },
  });
  done(closed ? `Closed for ${today}.` : 'Reopened — today follows the usual hours.');
}

export const closeTodayForm = async (): Promise<void> => setClosedToday(true);
export const reopenTodayForm = async (): Promise<void> => setClosedToday(false);
