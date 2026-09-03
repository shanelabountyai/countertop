// The punch card's own screen (PRD 7 P1-2, C-106).
//
// ITS OWN PAGE, not a tile on the sales report, and that is a requirement
// rather than a layout preference: P0-6 says no loyalty number appears on
// /kitchen/report, and there is a static check in packages/db/report.test.ts
// that reads the report's query path and fails if the word turns up in it.
// The two screens answer different questions — one is what the shop sold, the
// other is what the shop owes — and the sales figures must stay readable by
// somebody who has never switched this program on.
//
// THE LIABILITY IS THE POINT. An owner cannot judge whether a punch card is
// worth running without knowing what it has already promised away, and it is
// the number nobody builds: points look free because they are issued for free,
// and they are a bill that arrives later at a time the customer chooses.
//
// The window selector governs the ACTIVITY only. What is outstanding is
// outstanding today; "$390 of liability in the last 7 days" is not a number.
import Link from 'next/link';
import { instantDaysBefore } from '@countertop/core';
import { loadLoyaltyProgram } from '@countertop/db/loyalty';
import { formatCents } from '@/lib/money';
import { Section, Stat } from '@/lib/panels';
import { turnLoyaltyOff, turnLoyaltyOn } from './actions';

export const metadata = { title: 'Punch card — Firebird Kitchen' };

// Never prerendered: this screen is about a balance somebody changed a minute
// ago, and about a switch a manager just flipped.
export const dynamic = 'force-dynamic';

const WINDOWS = [1, 7, 30, 90] as const;
const DEFAULT_DAYS = 30;

/** Points, said the way a person says them. */
const points = (value: number) => `${value.toLocaleString('en-US')}`;

export default async function LoyaltyPage({
  searchParams,
}: {
  searchParams: Promise<{ days?: string; saved?: string }>;
}) {
  // Read once, here, and passed down (CLAUDE.md time rules).
  const now = new Date();
  const params = await searchParams;
  const requested = Number(params.days);
  const days = WINDOWS.includes(requested as (typeof WINDOWS)[number]) ? requested : DEFAULT_DAYS;

  const program = await loadLoyaltyProgram(instantDaysBefore(now, days));
  const { liability, window, terms } = program;

  return (
    <main className="mx-auto max-w-4xl p-4 sm:p-6">
      <Link
        href="/kitchen"
        className="inline-flex min-h-12 w-fit items-center text-lg underline underline-offset-4"
      >
        ← Kitchen queue
      </Link>
      <h1 className="mt-4 text-3xl font-semibold">Punch card</h1>
      <p className="mt-1 text-lg text-neutral-700">
        A member is a phone number and nothing else — no account, no password, no email. The
        number itself is never stored; what is kept is a one-way code and the last four digits, so
        this page can tell you what the program costs without being a customer list.
      </p>

      {params.saved && (
        <p
          role="status"
          data-testid="loyalty-saved"
          className="mt-4 rounded-lg bg-green-50 p-3 text-lg font-medium text-green-900"
        >
          {params.saved}
        </p>
      )}

      {/* The switch, above the numbers: it is the one thing on this page that
          changes something, and a control below three sections of arithmetic
          is a control nobody finds during a shift. */}
      <section className="mt-6 rounded-xl border-2 border-neutral-300 p-4">
        <h2 className="text-2xl font-semibold">The program is {program.enabled ? 'on' : 'off'}</h2>
        <p className="mt-1 text-lg text-neutral-700" data-testid="loyalty-switch-state">
          {program.enabled
            ? 'Customers are offered the punch card at checkout, points are earned at pickup, and the counter can spend a reward off what an order still owes.'
            : 'Nobody is offered the punch card, nothing is earned, and no reward can be spent. Balances already earned stay exactly where they are.'}
        </p>
        <form action={program.enabled ? turnLoyaltyOff : turnLoyaltyOn} className="mt-3">
          <button
            type="submit"
            data-testid="loyalty-toggle"
            className="min-h-14 rounded-lg border-2 border-neutral-900 px-6 text-lg font-bold"
          >
            {program.enabled ? 'Switch the punch card off' : 'Switch the punch card on'}
          </button>
        </form>
        {/* Switching off is reversible and takes nothing away, which is worth
            saying on the button's own screen — the fear is that it wipes
            everybody's points, and it is the reason a manager would never
            touch it during a bad week. */}
        {program.enabled && (
          <p className="mt-2 text-base text-neutral-600">
            Switching it off takes nobody&rsquo;s points away. It stops new ones being earned and
            stops rewards being spent; the balances below are unchanged, and they still expire on
            the schedule at the bottom of this page.
          </p>
        )}
        {program.enabled && !program.pepperConfigured && (
          <p
            role="alert"
            data-testid="loyalty-pepper-missing"
            className="mt-3 rounded-lg border-2 border-red-600 bg-red-50 p-3 text-lg font-semibold text-red-900"
          >
            The program is switched on but LOYALTY_PHONE_PEPPER is not set, so nobody can actually
            join. The checkout does not show the box. That secret is what makes a stored phone
            number unreadable, and enrolling without it would orphan every member the day it is
            configured.
          </p>
        )}
      </section>

      <Section title="What the punch card owes">
        <p className="text-lg text-neutral-700">
          Outstanding today, not for the window below — a promise made last year is still a
          promise. Points are only spendable a whole reward at a time, so the two money figures
          are genuinely different: the first is everything issued and not yet spent, the second is
          what could be handed over tomorrow.
        </p>
        <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Stat
            label="Members"
            value={points(program.members)}
            note="Phone numbers on the punch card"
            testId="loyalty-members"
          />
          <Stat
            label="Points outstanding"
            value={points(liability.points)}
            note={`${terms.rewardThresholdPoints} points is a reward`}
            testId="loyalty-points"
          />
          <Stat
            label="Accrued liability"
            value={formatCents(liability.accruedCents)}
            note="Every point at the reward rate"
            testId="loyalty-accrued"
          />
          <Stat
            label="Redeemable now"
            value={formatCents(liability.redeemableCents)}
            note={
              liability.rewardsOutstanding === 0
                ? 'Nobody has a whole reward yet'
                : `${liability.rewardsOutstanding} ${liability.rewardsOutstanding === 1 ? 'reward' : 'rewards'} across ${liability.membersWithReward} ${liability.membersWithReward === 1 ? 'member' : 'members'}`
            }
            testId="loyalty-redeemable"
          />
        </div>
        {liability.accruedCents > liability.redeemableCents && (
          <p className="mt-3 text-base text-neutral-600">
            {formatCents(liability.accruedCents - liability.redeemableCents)} of that is stranded
            in part-finished cards. It becomes spendable as those customers come back — which is
            what a punch card is for, and why the first figure is the one to provision against.
          </p>
        )}
      </Section>

      <nav aria-label="Activity window" className="mt-10 flex flex-wrap gap-2">
        {WINDOWS.map((choice) => (
          <Link
            key={choice}
            href={`/kitchen/loyalty?days=${choice}`}
            aria-current={choice === days ? 'page' : undefined}
            className={`min-h-12 rounded-lg border-2 px-5 py-3 text-lg font-bold ${
              choice === days ? 'border-neutral-900 bg-neutral-900 text-white' : 'border-neutral-400'
            }`}
          >
            {choice === 1 ? 'Last 24 hours' : `Last ${choice} days`}
          </Link>
        ))}
      </nav>

      <Section title={days === 1 ? 'The last 24 hours' : `The last ${days} days`}>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Stat
            label="Points earned"
            value={points(window.pointsEarned)}
            note="At pickup, off the subtotal"
            testId="loyalty-earned"
          />
          <Stat
            label="Rewards spent"
            value={points(window.redemptions)}
            note={
              window.redemptions === 0
                ? 'None in this window'
                : `${points(window.pointsRedeemed)} points`
            }
            testId="loyalty-redemptions"
          />
          <Stat
            label="What they cost"
            value={formatCents(window.redeemedCents)}
            note="Taken off orders as adjustments"
            testId="loyalty-cost"
          />
          <Stat
            label="Redemption rate"
            value={window.rate === null ? '—' : `${(window.rate * 100).toFixed(1)}%`}
            note={
              window.rate === null
                ? 'Nothing was earned in this window'
                : 'Points spent, over points issued'
            }
            testId="loyalty-rate"
          />
        </div>
        {window.rate !== null && window.rate > 1 && (
          <p className="mt-3 text-base text-neutral-600">
            Above 100% because customers spent points they had saved from before this window. That
            is the program working, not an error — a punch card is savings, and the rate only
            balances out over a period longer than the one people save across.
          </p>
        )}
        {(window.pointsExpired > 0 || window.pointsAdjusted !== 0) && (
          <dl className="mt-3 flex flex-col gap-2 rounded-lg border-2 border-neutral-200 p-4 text-lg">
            {window.pointsExpired > 0 && (
              <div className="flex flex-wrap justify-between gap-4">
                <dt>Points expired</dt>
                <dd className="font-semibold tabular-nums" data-testid="loyalty-expired">
                  {points(window.pointsExpired)}
                </dd>
              </div>
            )}
            {window.pointsAdjusted !== 0 && (
              <div className="flex flex-wrap justify-between gap-4">
                <dt>Staff corrections</dt>
                <dd className="font-semibold tabular-nums" data-testid="loyalty-adjusted">
                  {window.pointsAdjusted > 0 ? '+' : '−'}
                  {points(Math.abs(window.pointsAdjusted))}
                </dd>
              </div>
            )}
          </dl>
        )}
        {window.pointsExpired > 0 && (
          <p className="mt-2 text-base text-neutral-600">
            Expired points are liability that left without anybody being served. Nobody was warned
            first — there is no channel to warn them on — so a large number here is a reason to
            look at the expiry window rather than a saving.
          </p>
        )}
      </Section>

      {/* Same shape and the same reason as the settings screen's "Not editable
          here": each of these is a decision that restates numbers already
          earned, not a form field. */}
      <Section title="Not editable here">
        <dl className="flex flex-col gap-2 text-lg">
          <Term label="Points earned">
            {points(terms.pointsPerDollar)} per whole dollar of subtotal — tax earns nothing
          </Term>
          <Term label="A reward is">
            {points(terms.rewardThresholdPoints)} points, worth {formatCents(terms.rewardValueCents)}{' '}
            off what an order still owes
          </Term>
          <Term label="Points expire after">
            {points(program.expiryDays)} days without earning or spending
          </Term>
          <Term label="Customer details are kept">
            {points(program.retentionDays)} days, then stripped from the order
          </Term>
        </dl>
        <p className="mt-3 text-base text-neutral-600">
          Changing what a reward is worth restates the {formatCents(liability.accruedCents)} above,
          and raising the threshold takes a reward away from somebody who has already earned one.
          Shrinking the expiry window destroys balances on the next sweep with no preview of whose
          — so that control does not ship until it can show you what it would delete first. The
          two windows are also tied together in the database: points can never outlive the customer
          record they belong to.
        </p>
      </Section>
    </main>
  );
}

function Term({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap justify-between gap-4">
      <dt>{label}</dt>
      <dd className="font-semibold">{children}</dd>
    </div>
  );
}
