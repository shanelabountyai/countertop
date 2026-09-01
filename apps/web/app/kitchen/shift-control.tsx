'use client';

// Who is on shift (C-086), on the screen the kitchen is already looking at.
//
// A PIN once per shift, not once per tap. Thirty orders in twenty minutes
// makes the per-tap version something staff would route around within a day,
// and a control everyone routes around records nothing — which is worse than
// no control, because the log would then be confidently wrong instead of
// honestly empty.
import { useState, useTransition } from 'react';
import { endShift, startShift } from './actions';

export function ShiftControl({ name }: { name: string | null }) {
  const [pending, startTransition] = useTransition();
  const [pin, setPin] = useState('');
  const [error, setError] = useState('');

  function submit(event: React.FormEvent) {
    event.preventDefault();
    setError('');
    startTransition(async () => {
      const result = await startShift(pin);
      if (result.ok) setPin('');
      else setError(result.message);
    });
  }

  if (name !== null) {
    return (
      <div
        data-testid="on-shift"
        className="flex flex-wrap items-center gap-3 rounded-lg border-2 border-neutral-300 px-4 py-2"
      >
        <p className="text-lg">
          On shift: <span className="font-bold">{name}</span>
        </p>
        <button
          type="button"
          disabled={pending}
          onClick={() => startTransition(async () => void (await endShift()))}
          className="min-h-12 min-w-12 rounded-lg border-2 border-neutral-400 px-4 text-lg font-semibold disabled:opacity-60"
        >
          End shift
        </button>
      </div>
    );
  }

  return (
    <form
      onSubmit={submit}
      data-testid="shift-signon"
      className="flex flex-wrap items-center gap-3 rounded-lg border-2 border-amber-500 bg-amber-50 px-4 py-2"
    >
      <label className="flex items-center gap-2 text-lg">
        {/* Said plainly, because the honest state is the one that needs
            explaining: work still happens with nobody signed on, and the log
            simply will not know who did it. */}
        <span>Nobody on shift — PIN</span>
        <input
          value={pin}
          onChange={(event) => setPin(event.target.value.replace(/\D/g, '').slice(0, 4))}
          // `inputMode`, not `type="number"`: a numeric keypad on a tablet
          // without the spinners, the scroll-wheel accidents, or a leading
          // zero being helpfully removed.
          inputMode="numeric"
          autoComplete="off"
          maxLength={4}
          aria-label="Staff PIN"
          className="min-h-12 w-24 rounded-lg border-2 border-neutral-400 px-3 text-lg tabular-nums"
        />
      </label>
      <button
        type="submit"
        disabled={pending || pin.length !== 4}
        className="min-h-12 min-w-12 rounded-lg bg-neutral-900 px-4 text-lg font-bold text-white disabled:opacity-60"
      >
        Start shift
      </button>
      <p aria-live="polite" className="text-lg font-medium text-red-700">
        {error}
      </p>
    </form>
  );
}
