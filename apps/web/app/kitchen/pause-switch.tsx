'use client';

// The "pause new orders" switch (P0-6), on the screen the kitchen is already
// looking at. It reports what the GATE says, not what the switch was set to —
// so a queue that auto-paused at the threshold says so here, in the same
// place, rather than leaving staff to wonder why checkout is closed.
import { useState, useTransition } from 'react';
import type { GateResult } from '@countertop/core';
import { setOrderingPaused } from './actions';

export function PauseSwitch({ gate, paused }: { gate: GateResult; paused: boolean }) {
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  function toggle(next: boolean) {
    setError('');
    startTransition(async () => {
      const result = await setOrderingPaused(next, message);
      if (!result.ok) setError(result.message);
    });
  }

  return (
    <section className="mt-6 rounded-xl border-2 border-neutral-300 p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold">Online ordering</h2>
          <p data-testid="gate-status" className="text-lg">
            {gate.open ? (
              <span className="font-semibold text-green-800">Open — taking orders</span>
            ) : (
              <span className="font-semibold text-amber-800">Closed — {gate.message}</span>
            )}
          </p>
        </div>

        <button
          type="button"
          disabled={pending}
          onClick={() => toggle(!paused)}
          className={`min-h-14 rounded-lg px-6 text-lg font-bold text-white disabled:opacity-60 ${
            paused ? 'bg-green-800' : 'bg-amber-700'
          }`}
        >
          {paused ? 'Resume orders' : 'Pause new orders'}
        </button>
      </div>

      {!paused && (
        <label className="mt-3 flex flex-col gap-1">
          <span className="text-sm font-medium">
            Tell customers why (optional — used when you pause)
          </span>
          <input
            value={message}
            maxLength={200}
            onChange={(event) => setMessage(event.target.value)}
            placeholder="Fryer is down until 2."
            className="min-h-12 rounded-lg border border-neutral-400 px-3"
          />
        </label>
      )}

      <p aria-live="polite" className="text-sm font-medium text-red-700">
        {error}
      </p>
    </section>
  );
}
