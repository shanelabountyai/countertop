'use server';

// The one control on the loyalty screen (PRD 7 P1-2, C-106).
//
// ONE BOOLEAN, and the things it is not are the decision. The reward terms and
// the two windows are rendered on that page and are deliberately read-only:
// changing `rewardValueCents` restates the liability of every point already
// earned, changing `rewardThresholdPoints` can take a reward away from
// somebody who has one, and shrinking `loyaltyExpiryDays` destroys balances
// with no preview of what it would destroy — which is exactly why C-105
// recorded that a control for it may not ship without a dry run in front of
// it. Not shipping the control is the other way to satisfy that, and it is the
// one this item took. Same shape as the settings screen's timezone and tax
// rate: shown, explained, and not a form field.
//
// The write lives in packages/db, like every other loyalty write, so this file
// is a form parser and a redirect and nothing else.
import { setLoyaltyEnabled } from '@countertop/db/loyalty';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';

/** Everywhere the switch is read. The customer surfaces render the enrolment
 *  checkbox from the same settings row the gate reads, so switching the
 *  program on has to be visible on the next navigation rather than after a
 *  cache expires. */
function revalidateLoyaltySurfaces(): void {
  revalidatePath('/kitchen/loyalty');
  revalidatePath('/kitchen/orders', 'layout');
  revalidatePath('/checkout');
  revalidatePath('/cart');
  revalidatePath('/menu');
}

async function setEnabled(enabled: boolean): Promise<never> {
  await setLoyaltyEnabled(enabled);
  revalidateLoyaltySurfaces();
  redirect(
    `/kitchen/loyalty?saved=${encodeURIComponent(
      enabled
        ? 'Punch card switched on. Customers can join it at checkout.'
        : 'Punch card switched off. Nobody can join or earn, and every balance stays exactly where it is.',
    )}`,
  );
}

export const turnLoyaltyOn = async (): Promise<void> => setEnabled(true);
export const turnLoyaltyOff = async (): Promise<void> => setEnabled(false);
