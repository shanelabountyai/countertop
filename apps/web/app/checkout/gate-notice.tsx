// The customer-facing half of the gate (P0-6).
//
// One component for all five reasons, because they are one requirement. The
// MESSAGE is composed in `packages/core` — "we open at 11:00", "we stop taking
// online orders at 20:45" — so a screen cannot invent a different sentence for
// a trigger it happens to know about.
import type { GateResult } from '@countertop/core';

export function GateNotice({
  gate,
  className = '',
}: {
  gate: GateResult;
  className?: string;
}) {
  if (gate.open) return null;

  return (
    <div
      data-testid="gate-notice"
      data-reason={gate.reason}
      role="status"
      className={`rounded-lg border-2 border-amber-600 bg-amber-50 p-4 ${className}`}
    >
      <p className="text-lg font-semibold text-amber-900">Online ordering is closed</p>
      <p className="mt-1 text-amber-900">{gate.message}</p>
      {gate.transient && (
        // Only where waiting is actually the answer. Offering "check again" to
        // someone told "we open on Saturday" is an invitation to keep tapping.
        <p className="mt-2 text-sm text-amber-800">
          Reload this page to check again.
        </p>
      )}
    </div>
  );
}
