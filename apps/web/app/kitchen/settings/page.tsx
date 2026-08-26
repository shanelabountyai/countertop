// The operator's settings (C-023).
//
// Everything on this screen was already a column with a CHECK constraint and
// no way to change it short of SQL: the week's hours, the auto-pause
// threshold, the pre-close cutoff, and the two numbers the ready-time estimate
// is built from. The gate and the estimate read them on every render, so a
// save here is visible to a customer on their next navigation.
//
// Timezone and tax rate are shown and NOT editable. Changing either re-buckets
// every report and moves the business day the order numbers reset on; that is
// a migration-shaped decision, not a form field.
import Link from 'next/link';
import { formatMinuteOfDay, restaurantClock, WEEKDAY_NAMES } from '@countertop/core';
import { loadGateState } from '@countertop/db/gate';
import { formatCents } from '@/lib/money';
import { closeTodayForm, reopenTodayForm, saveHours, saveService } from './actions';

export const metadata = { title: 'Settings — Firebird Kitchen' };

// Never prerendered: this screen is about values a manager just changed.
export const dynamic = 'force-dynamic';

/** A stored minute-of-day as `<input type="time">` wants it. 1440 — midnight
 *  at the END of the day — comes back as "00:00", which is the only reading a
 *  closing time can have and the only one the input can hold. */
const timeValue = (minute: number): string => formatMinuteOfDay(minute === 1440 ? 0 : minute);

export default async function SettingsPage({
  searchParams,
}: {
  // The hours confirm carries its own fields back — `open-3`, `from-3`,
  // `to-3` — so the panel is a URL rather than client state. Same shape as the
  // menu editor's confirm (C-015): it survives a reload, works before
  // hydration, and re-reads the CURRENT hours to diff against on every render.
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const params = await searchParams;
  const { saved, error } = params;
  const state = await loadGateState();
  // Read once, here (CLAUDE.md time rules).
  const today = restaurantClock(new Date(), state.timezone).day;
  const closedToday = state.closedOnDay === today;

  const hoursByDay = new Map(state.hours.map((day) => [day.dayOfWeek, day]));

  // ---- the hours confirm ------------------------------------------------
  //
  // Closing a day is at least as consequential as repricing a burrito, and
  // only one of those was guarded (C-023's own note). The panel diffs the
  // submitted week against the CURRENT one, read fresh here — so a confirm
  // left open through someone else's edit describes the change that would
  // actually happen.
  if (params.review === 'hours') {
    const changes = WEEKDAY_NAMES.map((name, dayOfWeek) => {
      const before = hoursByDay.get(dayOfWeek);
      const wanted = params[`open-${dayOfWeek}`] === 'on';
      const from = params[`from-${dayOfWeek}`] ?? '';
      const to = params[`to-${dayOfWeek}`] ?? '';
      const after = wanted ? `${from}–${to === '00:00' ? '24:00' : to}` : null;
      const wasText = before
        ? `${timeValue(before.openMinute)}–${before.closeMinute === 1440 ? '24:00' : timeValue(before.closeMinute)}`
        : null;
      return { name, wasText, after, closing: wasText !== null && after === null };
    }).filter((change) => change.wasText !== change.after);

    return (
      <main className="mx-auto max-w-2xl p-4 sm:p-6">
        <h1 className="text-3xl font-semibold">
          {changes.length === 0 ? 'Nothing was changed' : 'Change the opening hours?'}
        </h1>

        {changes.length === 0 ? (
          <p role="alert" className="mt-4 text-lg">
            The hours you submitted are the hours already saved.
          </p>
        ) : (
          <>
            {changes.some((change) => change.closing) && (
              <p
                data-testid="closing-warning"
                className="mt-4 rounded-lg border-2 border-amber-600 bg-amber-50 p-3 text-lg font-semibold"
              >
                This CLOSES{' '}
                {changes
                  .filter((change) => change.closing)
                  .map((change) => change.name)
                  .join(', ')}
                . Online ordering will be shut on those days.
              </p>
            )}
            <dl className="mt-6 flex flex-col gap-2 text-lg">
              {changes.map((change) => (
                <div key={change.name} className="flex flex-wrap gap-2">
                  <dt className="font-semibold">{change.name}:</dt>
                  <dd className="tabular-nums">
                    <span className="text-neutral-500 line-through">
                      {change.wasText ?? 'closed'}
                    </span>{' '}
                    <span aria-hidden>→</span> <span>{change.after ?? 'closed'}</span>
                  </dd>
                </div>
              ))}
            </dl>
          </>
        )}

        <div className="mt-8 flex flex-col gap-3">
          {changes.length > 0 && (
            /* The submitted week, carried back as hidden fields and POSTed to
               the same action as before. The panel re-parses nothing and
               decides nothing: `saveHours` re-validates every value, because a
               field that made a round trip through a URL is client input. */
            <form action={saveHours}>
              {WEEKDAY_NAMES.map((_, dayOfWeek) => (
                <div key={dayOfWeek}>
                  {params[`open-${dayOfWeek}`] === 'on' && (
                    <input type="hidden" name={`open-${dayOfWeek}`} value="on" />
                  )}
                  <input
                    type="hidden"
                    name={`from-${dayOfWeek}`}
                    value={params[`from-${dayOfWeek}`] ?? ''}
                  />
                  <input
                    type="hidden"
                    name={`to-${dayOfWeek}`}
                    value={params[`to-${dayOfWeek}`] ?? ''}
                  />
                </div>
              ))}
              <button
                type="submit"
                className="min-h-14 w-full rounded-lg bg-green-800 px-5 text-xl font-bold text-white"
              >
                Save these hours
              </button>
            </form>
          )}
          {/* Cancel is a link, not a second submit: leaving without saving must
              never be one mis-tap away from saving. */}
          <Link
            href="/kitchen/settings"
            className="min-h-14 rounded-lg border-2 border-neutral-400 px-5 py-3 text-center text-xl font-bold"
          >
            Cancel
          </Link>
        </div>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-3xl p-4 sm:p-6">
      <Link href="/kitchen" className="text-lg underline underline-offset-4">
        ← Kitchen queue
      </Link>
      <h1 className="mt-4 text-3xl font-semibold">Settings</h1>

      {saved && (
        <p
          role="status"
          data-testid="settings-saved"
          className="mt-4 rounded-lg bg-green-50 p-3 text-lg font-medium text-green-900"
        >
          {saved}
        </p>
      )}
      {/* A test id as well as the role: Next renders its own `role="alert"`
          route announcer on every navigation, so the role alone is ambiguous
          the moment a screen has one of its own. */}
      {error && (
        <p
          role="alert"
          data-testid="settings-error"
          className="mt-4 rounded-lg bg-red-50 p-3 text-lg font-medium text-red-800"
        >
          {error}
        </p>
      )}

      <section className="mt-8 rounded-xl border-2 border-neutral-300 p-4">
        <h2 className="text-2xl font-semibold">Today</h2>
        <p className="mt-1 text-lg text-neutral-700">
          {closedToday
            ? 'Closed for today, whatever the hours below say.'
            : `Following the usual hours for ${today}.`}
        </p>
        <form action={closedToday ? reopenTodayForm : closeTodayForm} className="mt-3">
          <button
            type="submit"
            className="min-h-14 rounded-lg border-2 border-neutral-900 px-6 text-lg font-bold"
          >
            {closedToday ? 'Reopen today' : 'Close for today'}
          </button>
        </form>
      </section>

      <form
        method="get"
        action="/kitchen/settings"
        className="mt-8 rounded-xl border-2 border-neutral-300 p-4"
      >
        <input type="hidden" name="review" value="hours" />
        <h2 className="text-2xl font-semibold">Opening hours</h2>
        <p className="mt-1 text-lg text-neutral-700">
          Local times in {state.timezone}. A day with its box unticked is closed. A closing time
          of 00:00 means midnight at the end of that day; overnight service is not supported.
        </p>

        <ul className="mt-4 flex flex-col gap-3">
          {WEEKDAY_NAMES.map((name, dayOfWeek) => {
            const day = hoursByDay.get(dayOfWeek);
            return (
              <li key={name} className="flex flex-wrap items-center gap-3">
                <label className="flex min-h-12 w-40 items-center gap-2 text-lg">
                  <input
                    type="checkbox"
                    name={`open-${dayOfWeek}`}
                    defaultChecked={day !== undefined}
                    className="size-5"
                  />
                  {name}
                </label>
                {/* `aria-label` rather than a wrapping <label> with hidden
                    text: two labels on one control is one label too many, and
                    the visible day name is already on the checkbox beside it. */}
                <input
                  type="time"
                  name={`from-${dayOfWeek}`}
                  aria-label={`${name} opens`}
                  defaultValue={timeValue(day?.openMinute ?? 11 * 60)}
                  className="min-h-12 rounded-md border-2 border-neutral-400 px-3 text-lg"
                />
                <span aria-hidden className="text-lg">
                  to
                </span>
                <input
                  type="time"
                  name={`to-${dayOfWeek}`}
                  aria-label={`${name} closes`}
                  defaultValue={timeValue(day?.closeMinute ?? 21 * 60)}
                  className="min-h-12 rounded-md border-2 border-neutral-400 px-3 text-lg"
                />
              </li>
            );
          })}
        </ul>

        <button
          type="submit"
          className="mt-4 min-h-14 rounded-lg bg-neutral-900 px-6 text-lg font-bold text-white"
        >
          Review hours
        </button>
      </form>

      <form action={saveService} className="mt-8 rounded-xl border-2 border-neutral-300 p-4">
        <h2 className="text-2xl font-semibold">Service</h2>
        <NumberField
          name="maxOpenOrders"
          label="Pause new orders above"
          suffix="open orders"
          value={state.maxOpenOrders}
          min={1}
          max={500}
          hint="Counted over orders the kitchen still owes. Food already on the shelf does not count."
        />
        <NumberField
          name="cutoffMinutes"
          label="Stop taking orders"
          suffix="minutes before close"
          value={state.cutoffMinutes}
          min={0}
          max={720}
          hint="So the last ticket of the night can actually be made."
        />
        <NumberField
          name="prepBaseMinutes"
          label="A ticket takes"
          suffix="minutes with an empty queue"
          value={state.prepBaseMinutes}
          min={0}
          max={240}
          hint="The floor of every estimate. Customers are shown a range around it, never a point."
        />
        <NumberField
          name="prepPerOrderMinutes"
          label="Add"
          suffix="minutes per order already open"
          value={state.prepPerOrderMinutes}
          min={0}
          max={60}
          hint="The same open-order count the pause threshold reads, so 'busy' means one thing."
        />
        <button
          type="submit"
          className="mt-4 min-h-14 rounded-lg bg-neutral-900 px-6 text-lg font-bold text-white"
        >
          Save service settings
        </button>
      </form>

      <section className="mt-8 rounded-xl border-2 border-neutral-200 p-4">
        <h2 className="text-2xl font-semibold">Not editable here</h2>
        <dl className="mt-2 flex flex-col gap-2 text-lg">
          <div className="flex justify-between gap-4">
            <dt>Timezone</dt>
            <dd className="font-semibold">{state.timezone}</dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt>Tax rate</dt>
            <dd className="font-semibold tabular-nums">
              {(state.taxRatePpm / 10_000).toFixed(3)}%
            </dd>
          </div>
        </dl>
        <p className="mt-2 text-base text-neutral-600">
          Changing the timezone moves the day order numbers reset on and re-buckets every past
          report; changing the tax rate changes what the next order is charged, and never what a
          placed one was — every order carries the rate it was placed under. Both are deliberate
          decisions rather than form fields. An order at {formatCents(1000)} is taxed{' '}
          {formatCents(Math.round((1000 * state.taxRatePpm) / 1_000_000))} today.
        </p>
      </section>
    </main>
  );
}

function NumberField({
  name,
  label,
  suffix,
  value,
  min,
  max,
  hint,
}: {
  name: string;
  label: string;
  suffix: string;
  value: number;
  min: number;
  max: number;
  hint: string;
}) {
  return (
    <div className="mt-4">
      <label className="flex flex-wrap items-center gap-2 text-lg">
        {label}
        <input
          type="number"
          name={name}
          defaultValue={value}
          min={min}
          max={max}
          step={1}
          required
          className="min-h-12 w-24 rounded-md border-2 border-neutral-400 px-3 text-lg tabular-nums"
        />
        {suffix}
      </label>
      <p className="mt-1 text-base text-neutral-600">{hint}</p>
    </div>
  );
}
