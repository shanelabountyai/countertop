'use client';

// The new-order alert (P0-12). "A silent queue screen is a dead queue screen."
//
// The one thing that makes this correct: it takes a COUNT derived on the
// server from `needsAcknowledgment` — never a "an order just arrived" event
// fired by the poller. A client-side event is lost by a reload, a crashed tab,
// or a screen someone plugged in five minutes late; a count derived from state
// is not. Reload the page mid-rush and it starts chiming again, because the
// order is still un-acknowledged.
//
// Acknowledging is the Accept tap on the card — `placed → accepted`. There is
// no "dismiss" here, deliberately: a mute button is how an order gets silenced
// without anyone cooking it.
import { useEffect, useRef, useState } from 'react';

/** How often it repeats while an order sits un-acknowledged. Long enough not
 *  to be a smoke alarm, short enough that walking past the pass is enough. */
export const CHIME_INTERVAL_MS = 6_000;

/**
 * Two notes on one oscillator — a doorbell, not a beep.
 *
 * Synthesised rather than shipped as an audio file: no asset to 404, no
 * decode, and nothing to load before the first order of the day can announce
 * itself. Every value is scheduled against the AudioContext's own clock, which
 * is neither the wall clock nor anything a caller passes in.
 */
function chime(ctx: AudioContext) {
  const at = ctx.currentTime;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();

  osc.type = 'triangle';
  osc.connect(gain).connect(ctx.destination);
  osc.frequency.setValueAtTime(880, at);
  osc.frequency.setValueAtTime(1318.5, at + 0.16);
  // Ramped, not switched: an instant gain change is a click on a cheap speaker.
  // `exponentialRampToValueAtTime` refuses zero, hence 0.0001.
  gain.gain.setValueAtTime(0.0001, at);
  gain.gain.exponentialRampToValueAtTime(0.35, at + 0.02);
  gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.55);

  osc.start(at);
  osc.stop(at + 0.6);
}

export function NewOrderAlert({ count }: { count: number }) {
  // One context for the life of the screen. `router.refresh()` re-renders the
  // queue without unmounting this, so a shift's worth of chimes reuses the one
  // the cook granted permission to.
  const contextRef = useRef<AudioContext | null>(null);
  const [blocked, setBlocked] = useState(false);

  // Keyed on the count, so a SECOND order arriving while the first is still
  // un-acknowledged restarts the cycle and rings immediately, rather than
  // waiting out an interval that is already half spent.
  useEffect(() => {
    if (count === 0) return;
    let stopped = false;

    const ring = async () => {
      const ctx = (contextRef.current ??= new AudioContext());
      // Browsers start an AudioContext suspended until a user gesture. On a
      // wall-mounted screen nobody has tapped yet, that is the difference
      // between an alert and the exact silence this requirement exists to
      // prevent — so a blocked context is SHOWN, not swallowed.
      if (ctx.state === 'suspended') await ctx.resume().catch(() => {});
      if (stopped) return;
      if (ctx.state !== 'running') {
        setBlocked(true);
        return;
      }
      setBlocked(false);
      chime(ctx);
    };

    void ring();
    const timer = setInterval(ring, CHIME_INTERVAL_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [count]);

  if (count === 0) return null;

  return (
    <div className="alert-pulse mb-4 rounded-xl border-2 border-sky-700 bg-sky-50 p-4">
      {/* `assertive`: the screen-reader half of the chime. An order announced
          to a sighted cook and not to anyone else is still a silent queue. */}
      <p aria-live="assertive" className="text-2xl font-bold text-sky-900">
        {count === 1 ? '1 new order' : `${count} new orders`} — tap Accept to acknowledge
      </p>

      {blocked && (
        <button
          type="button"
          onClick={() => {
            // Must be called from the gesture itself; a resume scheduled off a
            // promise or a timer is refused by the same policy.
            void contextRef.current?.resume().then(() => setBlocked(false));
          }}
          className="mt-3 min-h-12 rounded-lg border-2 border-sky-700 bg-white px-6 text-lg font-semibold text-sky-900"
        >
          Turn on the chime — this screen is muted
        </button>
      )}
    </div>
  );
}
